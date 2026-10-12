/**
 * The gateway adapter: how OpenClaw starts and stops an azula account.
 *
 * `startAccount` is the account's whole lifetime. The gateway treats a settled
 * promise as "the channel exited" and schedules a restart, so it stays pending
 * until the gateway aborts it (shutdown, reload, `channels stop`) — and then
 * resolves once everything is down. `stopAccount` runs after the abort as the
 * gateway's explicit teardown hook; it shares the lifecycle's idempotent stop,
 * so whichever arrives first does the work and the other joins it.
 *
 * Failure policy, which is the part the gateway cannot decide for us:
 *
 *  - A *configuration* problem (no binary, azula too old, phone not paired) is
 *    reported as a terminal `blocked` status carrying the fix text, and
 *    `startAccount` returns. The gateway does not auto-restart a terminally
 *    blocked account, and no other channel is affected.
 *  - Anything else that stops the bridge coming up makes `startAccount` throw.
 *    The gateway's restart policy then retries on its own, much slower, schedule
 *    and shows the error as the account's health.
 */

import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { ResolvedAzulaAccount } from "./accounts.js";
import { createAgentDispatch, type ChannelRuntime } from "./agent.js";
import { AccountLifecycle, type AccountStatus, type LifecycleOptions } from "./lifecycle.js";
import type { Logger } from "./mcp-client.js";
import { loadSdk, type Sdk } from "./sdk.js";

type AzulaGateway = NonNullable<ChannelPlugin<ResolvedAzulaAccount>["gateway"]>;
type AzulaContext = ChannelGatewayContext<ResolvedAzulaAccount>;
type StatusPatch = Parameters<AzulaContext["setStatus"]>[0];

export type GatewayDeps = {
  /** Test seam: the real one imports the SDK subpaths a running account needs. */
  loadSdk?: () => Promise<Sdk>;
  /** Test seam: bridge construction. */
  createBridge?: LifecycleOptions["createBridge"];
  /** Test seam: timings. */
  lifecycle?: Pick<
    LifecycleOptions,
    "pollTimeoutSeconds" | "pumpErrorBackoffMs" | "reconnect" | "stopGraceMs"
  >;
};

/**
 * How long a dispatched item stays remembered by the in-process replay guard.
 *
 * Keys are unique to one run of one account (they embed a per-run epoch), and
 * azula's drain is destructive, so nothing is ever replayed *across* runs. The
 * guard is what stops an item being dispatched twice *within* one — a retried
 * batch, a double commit — and an hour is far longer than either takes.
 */
const DEDUPE_TTL_MS = 60 * 60_000;
const DEDUPE_MAX_ENTRIES = 2_000;

function loggerFor(ctx: AzulaContext): Logger {
  const log = ctx.log;
  return {
    debug: (m) => log?.debug?.(m),
    info: (m) => log?.info(m),
    warn: (m) => log?.warn(m),
    error: (m) => log?.error(m),
  };
}

/**
 * Translate a lifecycle status delta into the gateway's account snapshot.
 *
 * The SDK's patch helpers say `terminalDisconnect: undefined` to clear a
 * previous verdict, which this package's `exactOptionalPropertyTypes` rejects
 * for a plain optional field. The gateway merges patches key by key and reads
 * an explicit `undefined` as "clear it", so the helpers' output is passed
 * through unchanged and only the type is asserted.
 */
function toSnapshot(sdk: Sdk, accountId: string, status: AccountStatus): StatusPatch {
  const base = {
    accountId,
    ...(status.lastInboundAt === undefined ? {} : { lastInboundAt: status.lastInboundAt }),
    ...(status.lastEventAt === undefined ? {} : { lastEventAt: status.lastEventAt }),
  };
  const patch = (fields: object) => ({ ...base, ...fields }) as StatusPatch;

  if (status.phase === undefined) return patch({});

  switch (status.phase) {
    case "starting":
      return patch({ running: true, lifecycle: "starting" });
    case "ready":
      return patch(sdk.channelReadyPatch());
    case "recovering":
      // `connected: false` is what the health monitor reads as an outage; it
      // gives a recovering account a grace window before intervening.
      return patch({
        running: true,
        connected: false,
        lifecycle: "recovering",
        lastError: status.error ?? null,
      });
    case "blocked":
      return patch({
        ...sdk.channelBlockedPatch(status.error ?? "azula channel is blocked"),
        running: false,
        connected: false,
      });
    case "stopped":
      return patch(sdk.channelStoppedPatch());
  }
}

export function createGatewayAdapter(deps: GatewayDeps = {}): AzulaGateway {
  const live = new Map<string, AccountLifecycle>();

  return {
    startAccount: async (ctx) => {
      const channel = ctx.channelRuntime as unknown as ChannelRuntime | undefined;
      if (!channel?.inbound) {
        throw new Error(
          "this OpenClaw gateway did not provide a channel runtime to the azula channel (OpenClaw 2026.10.2 is required)",
        );
      }

      const sdk = await (deps.loadSdk ?? loadSdk)();
      const logger = loggerFor(ctx);
      const { account, accountId } = ctx;

      const lifecycle = new AccountLifecycle({
        account,
        logger,
        dispatch: createAgentDispatch({
          readConfig: sdk.createRuntimeConfigReader(ctx.cfg),
          account,
          channel,
          sdk,
          logger,
        }),
        dedupe: sdk.createClaimableDedupe({
          ttlMs: DEDUPE_TTL_MS,
          memoryMaxSize: DEDUPE_MAX_ENTRIES,
        }),
        onStatus: (status) => ctx.setStatus(toSnapshot(sdk, accountId, status)),
        ...(deps.createBridge ? { createBridge: deps.createBridge } : {}),
        ...deps.lifecycle,
      });

      // A previous run of this account that never finished stopping would
      // otherwise keep its child and its registry entry.
      const previous = live.get(accountId);
      if (previous) {
        logger.warn(`azula: account '${accountId}' was still running; stopping it first`);
        await previous.stop();
      }
      live.set(accountId, lifecycle);

      try {
        await lifecycle.run(ctx.abortSignal);
      } finally {
        if (live.get(accountId) === lifecycle) live.delete(accountId);
      }
    },

    stopAccount: async (ctx) => {
      await live.get(ctx.accountId)?.stop();
    },
  };
}
