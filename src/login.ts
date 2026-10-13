/**
 * The channel's pairing affordance: how an operator gets azula's invite.
 *
 * OpenClaw's login model is WhatsApp-shaped: `openclaw channels login` runs the
 * channel's `auth.login` in the CLI process, and the gateway exposes
 * `web.login.start` / `web.login.wait`, which call the channel's
 * `gateway.loginWithQrStart` / `loginWithQrWait` inside the gateway. azula needs
 * both halves, because a phone pairs with the channel's own persistent azula
 * session and only one process can hold a session at a time:
 *
 *  - while the gateway runs the account, only that account's own bridge can mint
 *    an invite a phone can use. The CLI therefore does not open a session; it
 *    asks the gateway ({@link runLogin} → `web.login.*`);
 *  - the gateway answers from the running account ({@link LoginCoordinator}),
 *    or, when the account is down (blocked on an unpaired `device`, or stopped
 *    so a phone can be replaced), from a short-lived session it holds just for
 *    the pairing and releases the moment the phone has paired.
 *
 * Either way the invite is azula's own: its URL and QR, never a second code.
 */

import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { persistDevice } from "./adopt.js";
import {
  azulaSection,
  DEFAULT_ACCOUNT_ID,
  deviceConfigPath,
  loginCommand,
  resolveAccount,
  type ResolvedAzulaAccount,
} from "./accounts.js";
import { pairingMessage } from "./access.js";
import { AzulaConfigError } from "./bridge.js";
import { CHANNEL_ID } from "./channel-id.js";
import type { AccountLifecycle } from "./lifecycle.js";
import type { Logger } from "./mcp-client.js";
import { NO_DEVICE_YET, PairingSession, type PairingSessionOptions } from "./pairing.js";
import type { Sdk } from "./sdk.js";

type ChannelGatewayAdapter = NonNullable<ChannelPlugin["gateway"]>;
type LoginStartResult = Awaited<ReturnType<NonNullable<ChannelGatewayAdapter["loginWithQrStart"]>>>;
type LoginWaitResult = Awaited<ReturnType<NonNullable<ChannelGatewayAdapter["loginWithQrWait"]>>>;

const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

// -- gateway side ------------------------------------------------------------

export type LoginDeps = {
  /** The accounts the gateway is running right now. */
  live: ReadonlyMap<string, AccountLifecycle>;
  loadSdk: () => Promise<Sdk>;
  logger: Logger;
  /** Test seams for the temporary pairing session. */
  createBridge?: PairingSessionOptions["createBridge"];
  sessionTtlMs?: number;
  pollMs?: number;
  sleep?: PairingSessionOptions["sleep"];
};

/** Answers the gateway's `web.login.*` requests for the azula channel. */
export class LoginCoordinator {
  readonly #deps: LoginDeps;
  readonly #sessions = new Map<string, PairingSession>();

  constructor(deps: LoginDeps) {
    this.#deps = deps;
  }

  /** Mint azula's invite for an account. */
  async start(params: {
    accountId?: string | undefined;
    force?: boolean | undefined;
  }): Promise<LoginStartResult> {
    const id = params.accountId?.trim() || DEFAULT_ACCOUNT_ID;

    if (params.force) {
      // `force` is the gateway's "stop the channel and log in again from
      // scratch", and what it does next depends on a QR image azula has no use
      // for: a login that returns none gets the channel started again, which
      // would close the very session this login had just opened. So it is
      // answered, not honoured, and the channel comes back as it was.
      return {
        connected: true,
        message:
          `azula account '${id}' was restarted. \`force\` does not re-pair an account. ` +
          `To pair a different phone: openclaw config unset ${deviceConfigPath(id)}, then ${loginCommand(id)}.`,
      };
    }

    const live = this.#liveAccount(id);

    if (live) {
      if (live.device !== undefined) {
        return {
          connected: true,
          message:
            `azula account '${id}' already serves device '${live.device}'.\n` +
            `To pair a different phone: openclaw config unset ${deviceConfigPath(id)}, then ${loginCommand(id)} again.`,
        };
      }
      try {
        const { invite, alreadyPaired } = await live.pairingInvite();
        return {
          connected: false,
          sessionKey: id,
          message: pairingMessage(invite, { accountId: id, session: live.account.session, alreadyPaired }),
        };
      } catch (err) {
        throw new Error(`could not mint azula's invite for account '${id}': ${errMessage(err)}`);
      }
    }

    return this.#startDetached(id);
  }

  /** Wait for the phone to pair. */
  async wait(params: { accountId?: string | undefined; timeoutMs?: number | undefined }): Promise<LoginWaitResult> {
    const id = params.accountId?.trim() || DEFAULT_ACCOUNT_ID;
    const timeoutMs = params.timeoutMs ?? 30_000;
    const live = this.#liveAccount(id);

    if (live) {
      if (live.device === undefined) {
        const adopted = await live.waitForAdoption(timeoutMs);
        if (adopted === null) {
          // Saving the phone makes the gateway reload the channel, which stops
          // this very account, sometimes before the wait has been told. A stop
          // that follows an adoption is the pairing working, not failing.
          if (live.device !== undefined) {
            return { connected: true, message: `Paired with device '${live.device}'. Account '${id}' is restarting with it.` };
          }
          if (live.phase === "stopped" || live.phase === "blocked") {
            throw new Error(`azula account '${id}' stopped before a phone paired; run ${loginCommand(id)} again`);
          }
          return { connected: false, message: `Still waiting for a phone to pair with account '${id}'.` };
        }
        return {
          connected: true,
          message:
            `Paired with device '${adopted.device}'.` +
            (adopted.configHint
              ? `\nIt is not saved in the config yet and will be forgotten on restart; run: ${adopted.configHint}`
              : ""),
        };
      }
      return { connected: true, message: `Account '${id}' serves device '${live.device}'.` };
    }

    const session = this.#sessions.get(id);
    if (!session || session.closed) {
      this.#sessions.delete(id);
      throw new Error(`no pairing is in progress for azula account '${id}'; run ${loginCommand(id)} again`);
    }

    const device = await session.waitForDevice(timeoutMs);
    if (device === null) {
      if (session.closed) {
        this.#sessions.delete(id);
        throw new Error(`the pairing for azula account '${id}' timed out; run ${loginCommand(id)} again`);
      }
      return { connected: false, message: `Still waiting for a phone to pair with account '${id}'.` };
    }

    // Hand the session back before the account starts: one process at a time.
    await this.release(id);
    const sdk = await this.#deps.loadSdk();
    const outcome = await persistDevice({
      sdk,
      accountId: id,
      device,
      logger: this.#deps.logger,
      // The device being replaced is, by construction, one this session is not
      // paired with (a blocked account) or one the operator chose to replace.
      replace: true,
    });
    if (outcome.persisted) {
      return {
        connected: true,
        message: `Paired with device '${device}' and saved it as ${deviceConfigPath(id)}. Starting account '${id}'.`,
      };
    }
    // The phone is paired but nothing remembers it; that needs the operator, so
    // it is an error rather than another "keep waiting".
    throw new Error(
      `paired with device '${device}', but it could not be saved to the config. ` +
        `Run: ${outcome.configHint}  then restart the azula channel (or the gateway).`,
    );
  }

  /**
   * The account's running lifecycle, if it has one. One that has stopped or
   * blocked is on its way out of the gateway's table and holds no azula session,
   * so a login treats it as not running.
   */
  #liveAccount(id: string): AccountLifecycle | undefined {
    const live = this.#deps.live.get(id);
    return live && live.phase !== "stopped" && live.phase !== "blocked" ? live : undefined;
  }

  /** Close any temporary pairing session for an account (it must not outlive its turn). */
  async release(accountId: string): Promise<void> {
    const session = this.#sessions.get(accountId);
    this.#sessions.delete(accountId);
    await session?.close();
  }

  /** Close every temporary session; the gateway is going away. */
  async releaseAll(): Promise<void> {
    await Promise.all([...this.#sessions.keys()].map((id) => this.release(id)));
  }

  async #startDetached(id: string): Promise<LoginStartResult> {
    const sdk = await this.#deps.loadSdk();
    const section = azulaSection(sdk.getRuntimeConfig());
    if (!section) {
      throw new Error(
        "the azula channel is not configured; run `openclaw config set channels.azula.enabled true` first",
      );
    }
    let account: ResolvedAzulaAccount;
    try {
      account = resolveAccount(section, id);
    } catch (err) {
      throw new Error(errMessage(err));
    }
    if (!account.enabled) {
      throw new Error(`azula account '${id}' is disabled; enable it before pairing a phone`);
    }

    await this.release(id);
    const session = new PairingSession({
      bridge: {
        binary: account.binary,
        session: account.session,
        label: account.label,
        device: NO_DEVICE_YET,
        logger: this.#deps.logger,
      },
      logger: this.#deps.logger,
      onExpire: () => {
        if (this.#sessions.get(id) === session) this.#sessions.delete(id);
      },
      ...(this.#deps.createBridge ? { createBridge: this.#deps.createBridge } : {}),
      ...(this.#deps.sessionTtlMs === undefined ? {} : { ttlMs: this.#deps.sessionTtlMs }),
      ...(this.#deps.pollMs === undefined ? {} : { intervalMs: this.#deps.pollMs }),
      ...(this.#deps.sleep ? { sleep: this.#deps.sleep } : {}),
    });

    let invite: string;
    try {
      invite = await session.open();
    } catch (err) {
      throw new Error(err instanceof AzulaConfigError ? err.full : errMessage(err));
    }
    this.#sessions.set(id, session);

    const replaced = account.device
      ? `\n\nThe phone that pairs will replace the configured device '${account.device}'.`
      : "";
    return {
      connected: false,
      sessionKey: id,
      message:
        pairingMessage(invite, { accountId: id, session: account.session, alreadyPaired: session.alreadyPaired }) +
        replaced,
    };
  }
}

// -- CLI side ------------------------------------------------------------------

/** One gateway RPC, as the CLI makes it. */
export type CallGateway = (
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
) => Promise<Record<string, unknown>>;

/** How long one `web.login.wait` blocks, and how long the CLI waits in all. */
const WAIT_SLICE_MS = 30_000;
const TOTAL_WAIT_MS = 15 * 60_000;
const START_TIMEOUT_MS = 60_000;

/** The real thing: the same gateway client every other CLI command uses. */
async function callGatewayViaCli(
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const gateway = await import("openclaw/plugin-sdk/gateway-runtime");
  try {
    return await gateway.callGatewayFromCli(
      method,
      { timeout: String(timeoutMs) },
      params,
      { progress: false },
    );
  } catch (err) {
    if (gateway.isGatewayTransportError(err)) {
      throw new Error(
        `could not reach the OpenClaw gateway (${errMessage(err)}).\n` +
          "`openclaw channels login` asks the running gateway for azula's invite, because a phone pairs with the " +
          "channel's own azula session and only the gateway's account can hold it. Start the gateway " +
          "(`openclaw gateway`), or pair offline with the plugin's scripts/pair.mjs (see its README).",
      );
    }
    throw err;
  }
}

export type LoginRuntime = { log: (message: string) => void };

/**
 * How long to let the gateway finish applying the saved device before looking.
 * Saving it makes the gateway reload the channel and restart the account, which
 * takes well under a second; looking sooner would find the old, about-to-be-
 * replaced instance and call it ready.
 */
const SETTLE_GRACE_MS = 1_500;
const SETTLE_BUDGET_MS = 20_000;
const SETTLE_POLL_MS = 500;

const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type AccountEntry = { accountId?: unknown; running?: unknown; lifecycle?: unknown; name?: unknown; azulaPairing?: unknown };

/**
 * Wait until the account is really serving the phone that just paired.
 *
 * Pairing ends with a config write, which the gateway answers by reloading the
 * channel. The login command finishing before that has settled would hand
 * OpenClaw's own follow-up (it asks the gateway to start the account) a channel
 * in the middle of reloading, and print an alarming error for a pairing that
 * worked. So the command waits for the end state, and says what it is. If the
 * gateway never settles within the budget it says nothing: the pairing itself
 * succeeded and `channels status` will show the rest.
 */
async function awaitReady(
  params: { accountId: string; runtime: LoginRuntime },
  deps: { call: CallGateway; now: () => number; sleep: (ms: number) => Promise<void> },
): Promise<void> {
  await deps.sleep(SETTLE_GRACE_MS);
  const deadline = deps.now() + SETTLE_BUDGET_MS;
  while (deps.now() < deadline) {
    try {
      const status = await deps.call("channels.status", { probe: false }, 15_000);
      const accounts = (status["channelAccounts"] as Record<string, unknown> | undefined)?.[CHANNEL_ID];
      const entry = Array.isArray(accounts)
        ? (accounts as AccountEntry[]).find((a) => a?.accountId === params.accountId)
        : undefined;
      if (entry && entry.running === true && entry.lifecycle === "ready" && entry.azulaPairing !== true) {
        const device = typeof entry.name === "string" ? ` for device '${entry.name}'` : "";
        params.runtime.log(`Account '${params.accountId}' is ready${device}.`);
        return;
      }
    } catch {
      // The gateway is busy reloading; the next look will find it.
    }
    await deps.sleep(SETTLE_POLL_MS);
  }
}

/** `openclaw channels login --channel azula`: show the invite, then wait for the phone. */
export async function runLogin(
  params: { accountId?: string | null | undefined; runtime: LoginRuntime },
  deps: {
    call?: CallGateway;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    totalWaitMs?: number;
    waitSliceMs?: number;
  } = {},
): Promise<void> {
  const { runtime } = params;
  const call = deps.call ?? callGatewayViaCli;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? sleepMs;
  const slice = deps.waitSliceMs ?? WAIT_SLICE_MS;
  const accountId = params.accountId?.trim() || DEFAULT_ACCOUNT_ID;

  const started = await call(
    "web.login.start",
    { channel: CHANNEL_ID, accountId, timeoutMs: START_TIMEOUT_MS },
    START_TIMEOUT_MS + 15_000,
  );
  runtime.log(String(started["message"] ?? ""));
  if (started["connected"] === true) return;

  runtime.log(`\nWaiting for the phone (up to ${Math.round((deps.totalWaitMs ?? TOTAL_WAIT_MS) / 60_000)} minutes; Ctrl-C to stop waiting)…`);
  const deadline = now() + (deps.totalWaitMs ?? TOTAL_WAIT_MS);
  while (now() < deadline) {
    const sessionKey = started["sessionKey"];
    const waited = await call(
      "web.login.wait",
      {
        channel: CHANNEL_ID,
        accountId,
        timeoutMs: slice,
        ...(typeof sessionKey === "string" ? { sessionKey } : {}),
      },
      slice + 15_000,
    );
    if (waited["connected"] === true) {
      runtime.log(`\n${String(waited["message"] ?? "")}`);
      await awaitReady({ accountId, runtime }, { call, now, sleep });
      return;
    }
  }
  runtime.log(
    `\nNo phone paired yet. The invite stays valid; ${
      accountId === DEFAULT_ACCOUNT_ID ? "" : `account '${accountId}' `
    }run \`${loginCommand(accountId)}\` again for a fresh one.`,
  );
}

/** The channel's `auth` adapter: what `openclaw channels login` calls. */
export const azulaAuth: NonNullable<ChannelPlugin["auth"]> = {
  login: async ({ accountId, runtime }) => {
    await runLogin({ accountId, runtime });
  },
};
