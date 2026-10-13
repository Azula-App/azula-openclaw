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
 *
 * The same adapter answers the gateway's `web.login.*` requests
 * (`loginWithQrStart` / `loginWithQrWait`) — the gateway half of
 * `openclaw channels login`; see `login.ts`.
 */

import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { persistDevice } from "./adopt.js";
import type { ResolvedAzulaAccount } from "./accounts.js";
import { createAgentDispatch, type ChannelRuntime } from "./agent.js";
import { AccountLifecycle, type AccountStatus, type LifecycleOptions } from "./lifecycle.js";
import { LoginCoordinator, type LoginDeps } from "./login.js";
import type { Logger } from "./mcp-client.js";
import { remoteMediaFetcher } from "./media.js";
import { commandTextDetector } from "./reply.js";
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
    "pollTimeoutSeconds" | "pumpErrorBackoffMs" | "reconnect" | "stopGraceMs" | "pairingPollMs"
  >;
  /** Test seam: the temporary pairing session `loginWithQrStart` opens for a stopped account. */
  login?: Pick<LoginDeps, "createBridge" | "sessionTtlMs" | "pollMs" | "sleep">;
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

  // The plugin's own facts (see status.ts). They describe one run of the
  // account, so every transition that ends or restarts it clears them.
  const noFacts = { azulaPairing: undefined, azulaDevice: undefined, azulaConfigHint: undefined };

  if (status.phase === undefined) return patch({});

  switch (status.phase) {
    case "starting":
      return patch({ running: true, lifecycle: "starting", ...noFacts });
    case "pairing":
      // Up, with the bridge connected, but with no phone to talk to yet.
      //
      // Deliberately NOT `linked: false`. That is the gateway's word for "needs
      // the operator to log in", and it would fit; but the gateway also reads a
      // runtime `linked: false` as a reason never to start the account again, so
      // an account that stopped while waiting (a login, a reload) could not be
      // restarted until the whole gateway was. The wait is shown through
      // `collectStatusIssues` instead.
      return patch({ ...sdk.channelReadyPatch(), ...noFacts, azulaPairing: true });
    case "ready":
      return patch({
        ...sdk.channelReadyPatch(),
        ...noFacts,
        // Present only while an adopted device is unsaved.
        azulaConfigHint: status.configHint ?? undefined,
        ...(status.device === undefined ? {} : { azulaDevice: status.device }),
      });
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
        ...noFacts,
      });
    case "stopped":
      return patch({ ...sdk.channelStoppedPatch(), ...noFacts });
  }
}

export function createGatewayAdapter(deps: GatewayDeps = {}): AzulaGateway {
  const live = new Map<string, AccountLifecycle>();

  // The login RPCs carry no gateway context, so they log through whichever
  // account last started.
  let lastLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
  const login = new LoginCoordinator({
    live,
    loadSdk: deps.loadSdk ?? loadSdk,
    logger: {
      debug: (m) => lastLogger.debug(m),
      info: (m) => lastLogger.info(m),
      warn: (m) => lastLogger.warn(m),
      error: (m) => lastLogger.error(m),
    },
    ...deps.login,
  });

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
      lastLogger = logger;
      const { account, accountId } = ctx;

      // A pairing session held open for `channels login` owns the azula session;
      // the account is about to need it.
      await login.release(accountId);

      const readConfig = sdk.createRuntimeConfigReader(ctx.cfg);
      const lifecycle = new AccountLifecycle({
        account,
        logger,
        adoptDevice: (device) => persistDevice({ sdk, accountId, device, logger }),
        dispatch: createAgentDispatch({
          readConfig,
          account,
          channel,
          sdk,
          logger,
        }),
        // Sends that happen outside a turn (`message send`, cron) fetch remote
        // attachments through the same guarded loader a reply does.
        fetchMedia: remoteMediaFetcher(channel),
        isCommandText: commandTextDetector(channel, readConfig),
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

    // `web.login.start` / `web.login.wait`: the gateway half of
    // `openclaw channels login`. See login.ts.
    loginWithQrStart: (params) =>
      login.start({ accountId: params.accountId, force: params.force }),
    loginWithQrWait: (params) =>
      login.wait({ accountId: params.accountId, timeoutMs: params.timeoutMs }),
  };
}
