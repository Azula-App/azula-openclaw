/**
 * One account's life: bring the bridge up, serve it in both directions, take it
 * down.
 *
 * This is the piece that turns the other modules into a running channel. It
 * owns, per account and for exactly as long as the account runs:
 *
 *  - the `azula mcp` child (through {@link AzulaBridge}), kept alive by a
 *    {@link BridgeSupervisor};
 *  - the entry in the runtime registry that outbound sends look up;
 *  - the {@link InboundPump} that long-polls `get_events` and hands each batch
 *    to {@link dispatchOnce}.
 *
 * It deliberately knows nothing about OpenClaw. The gateway glue lives in
 * `gateway.ts` and the agent hand-off in `agent.ts`; both reach this class
 * through plain seams ({@link LifecycleOptions.dispatch},
 * {@link LifecycleOptions.onStatus}), so everything here is testable with
 * fakes and no gateway.
 */

import type { ResolvedAzulaAccount } from "./accounts.js";
import {
  AzulaBridge,
  AzulaConfigError,
  type BridgeOptions,
} from "./bridge.js";
import type { InboundChoice, InboundItem, InboundMessage } from "./inbound.js";
import { dispatchOnce, type IngressDeps } from "./ingress.js";
import { McpError, type Logger } from "./mcp-client.js";
import { InboundPump } from "./pump.js";
import {
  markUnavailable,
  registerRuntime,
  unregisterRuntime,
  type AccountRuntime,
} from "./runtime.js";
import { BridgeSupervisor, type Health, type SupervisorDeps } from "./supervisor.js";
import { SurfaceTracker } from "./surfaces.js";
import { endTurn, resolveSurface } from "./turn.js";

/** Where an account is in its life, in the gateway-neutral vocabulary. */
export type AccountPhase =
  | "starting"
  | "ready"
  | "recovering"
  | "blocked"
  | "stopped";

/**
 * A status change worth publishing. Every field is a delta; the gateway glue
 * decides how each maps onto the gateway's own account snapshot.
 */
export type AccountStatus = {
  phase?: AccountPhase;
  /** What is wrong, with its fix — present for `recovering` and `blocked`. */
  error?: string;
  /** When an agent-waking item (message, file, tap) last arrived. */
  lastInboundAt?: number;
  /** When anything at all arrived, presence included. */
  lastEventAt?: number;
};

/** What a dispatcher gets besides the item itself. */
export type DispatchScope = {
  bridge: AzulaBridge;
  surfaces: SurfaceTracker;
  /** Aborts when the account stops, so an in-flight agent turn can end with it. */
  signal: AbortSignal;
};

/** Hand one agent-waking item to the agent. */
export type AgentDispatch = (
  item: InboundMessage | InboundChoice,
  scope: DispatchScope,
) => Promise<void>;

export type LifecycleOptions = {
  account: ResolvedAzulaAccount;
  logger: Logger;
  dispatch: AgentDispatch;
  /** Claim/commit/release guard keyed per item; see {@link dispatchOnce}. */
  dedupe: IngressDeps["dedupe"];
  onStatus?: (status: AccountStatus) => void;
  /** Test seam: the real one builds an {@link AzulaBridge}. */
  createBridge?: (options: BridgeOptions) => AzulaBridge;
  /** Seconds each `get_events` waits for something to arrive. */
  pollTimeoutSeconds?: number;
  /** Back-off between failed polls. */
  pumpErrorBackoffMs?: number;
  /** Reconnect pacing; see {@link BridgeSupervisor}. */
  reconnect?: Pick<
    SupervisorDeps,
    "baseBackoffMs" | "maxBackoffMs" | "maxAttempts" | "sleep"
  >;
  /**
   * How long {@link AccountLifecycle.stop} waits for an in-flight dispatch to
   * unwind once the bridge is dead. Shutdown must be prompt: the gateway gives
   * a stopping account only a few seconds, and a long agent turn must not hold
   * it. Past this the turn is abandoned to finish (or fail) on its own.
   */
  stopGraceMs?: number;
};

const DEFAULT_STOP_GRACE_MS = 1_500;

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A rejection nobody has awaited yet is not an unhandled one: `run` awaits
  // it, but may not have reached that await when the rejection lands.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

const errMessage = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

export class AccountLifecycle {
  readonly #opts: LifecycleOptions;
  readonly #account: ResolvedAzulaAccount;
  readonly #logger: Logger;
  readonly #surfaces = new SurfaceTracker();
  /** Ends everything this account started: agent turns, waits, the pump gate. */
  readonly #abort = new AbortController();
  readonly #ended = deferred();

  #bridge: AzulaBridge | null = null;
  #supervisor: BridgeSupervisor | null = null;
  #pump: InboundPump | null = null;
  #runtime: AccountRuntime | null = null;

  #ran = false;
  #stopping = false;
  #stopPromise: Promise<void> | null = null;
  #phase: AccountPhase = "starting";

  /**
   * True once the first connect has succeeded. A child that dies *before* then
   * is a failed start, reported by the start path itself — treating it as an
   * outage too would run a second recovery alongside it.
   */
  #up = false;
  #recovering = false;

  /** Bumped on every (re)connect so a stale child's exit is recognised as stale. */
  #generation = 0;
  #lastConnectError: unknown = null;

  /**
   * Held shut while the bridge is down so the pump parks instead of failing a
   * poll every couple of seconds for the whole outage.
   */
  #gate: Promise<void> = Promise.resolve();
  #gateClosed = false;
  #openGate: () => void = () => {};

  /** Distinguishes this run's batch ids from any other run's. */
  readonly #epoch = Date.now().toString(36);
  #batchSeq = 0;

  constructor(options: LifecycleOptions) {
    this.#opts = options;
    this.#account = options.account;
    this.#logger = options.logger;
  }

  /** The supervisor's view, for diagnostics. */
  get health(): Health | undefined {
    return this.#supervisor?.health;
  }

  get phase(): AccountPhase {
    return this.#phase;
  }

  get account(): ResolvedAzulaAccount {
    return this.#account;
  }

  /**
   * Run the account until it is told to stop or can no longer run.
   *
   * Resolves when stopped — by `signal`, by {@link stop}, or by an
   * unrecoverable *configuration* problem, which is reported through
   * `onStatus` as `blocked` rather than thrown: nothing a retry could do would
   * fix it, and a throw would invite exactly the retry loop to avoid.
   *
   * Rejects when the bridge could not be established or re-established for a
   * reason a later attempt might cure; the caller's own (slower) restart policy
   * takes over from there.
   */
  async run(signal: AbortSignal): Promise<void> {
    if (this.#ran) throw new Error("AccountLifecycle.run() can only be called once");
    this.#ran = true;

    const onAbort = () => {
      void this.stop();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      if (signal.aborted) return;
      await this.#bringUp();
      if (this.#stopping) return;
      await this.#ended.promise;
    } finally {
      signal.removeEventListener("abort", onAbort);
      await this.stop();
    }
  }

  /**
   * Take the account down. Idempotent, and safe to call at any point —
   * including while start-up is still in flight, or from inside a reload that
   * has already started stopping it.
   */
  stop(): Promise<void> {
    this.#stopPromise ??= this.#stop();
    return this.#stopPromise;
  }

  // -- start-up ------------------------------------------------------------

  async #bringUp(): Promise<void> {
    this.#emit({ phase: "starting" });

    const { account } = this;
    const createBridge =
      this.#opts.createBridge ?? ((options: BridgeOptions) => new AzulaBridge(options));
    const bridge = createBridge({
      binary: account.binary,
      session: account.session,
      label: account.label,
      device: account.device,
      logger: this.#logger,
    });
    this.#bridge = bridge;

    const supervisor = new BridgeSupervisor({
      connect: () => this.#connect(bridge),
      disconnect: () => bridge.stop(),
      logger: this.#logger,
      ...this.#opts.reconnect,
    });
    this.#supervisor = supervisor;

    try {
      await supervisor.start();
    } catch (err) {
      // A stop that landed during the handshake killed the child under it; the
      // resulting error is the abort, not a fault.
      if (this.#stopping) return;
      if (err instanceof AzulaConfigError) {
        // Block before stopping, so the final status says why rather than
        // just "stopped".
        this.#block(err);
        await this.stop();
        return;
      }
      markUnavailable(account.accountId, errMessage(err));
      await this.stop();
      throw err;
    }

    // The handshake can finish just as a stop begins; if so, stop() has
    // already been told to take the bridge down.
    if (this.#stopping) return;
    this.#up = true;

    const runtime: AccountRuntime = { bridge, surfaces: this.#surfaces };
    this.#runtime = runtime;
    registerRuntime(account.accountId, runtime);

    const pump = new InboundPump({
      bridge: {
        getEvents: async (timeoutSeconds) => {
          await this.#gate;
          if (this.#stopping) throw new McpError("account is stopping", "closed");
          return bridge.getEvents(timeoutSeconds);
        },
      },
      logger: this.#logger,
      commit: (items) => this.#commit(items),
      ...(this.#opts.pollTimeoutSeconds === undefined
        ? {}
        : { pollTimeoutSeconds: this.#opts.pollTimeoutSeconds }),
      ...(this.#opts.pumpErrorBackoffMs === undefined
        ? {}
        : { errorBackoffMs: this.#opts.pumpErrorBackoffMs }),
    });
    this.#pump = pump;
    pump.start();

    this.#logger.info(
      `azula: account '${account.accountId}' ready (device '${account.device}', session '${account.session}')`,
    );
    this.#emit({ phase: "ready" });
  }

  /**
   * One attempt at a working bridge: spawn, handshake, and confirm the phone
   * is paired. Used for the first start and for every reconnect, so the two
   * cannot drift apart.
   */
  async #connect(bridge: AzulaBridge): Promise<void> {
    const generation = ++this.#generation;
    try {
      await bridge.start(() => this.#onBridgeExit(generation));
      if (this.#stopping) throw new McpError("account is stopping", "closed");
      await bridge.assertDeviceKnown();
    } catch (err) {
      this.#lastConnectError = err;
      // Never leave a half-built bridge running behind a failed attempt.
      await bridge.stop().catch(() => {});
      throw err;
    }
  }

  // -- the bridge going away -----------------------------------------------

  #onBridgeExit(generation: number): void {
    // Expected exits (our own stop, a reconnect tearing the old child down) and
    // exits from a child that has already been replaced are not outages.
    if (this.#stopping || generation !== this.#generation) return;
    // Before first ready, the start path owns failure. During a recovery, the
    // exit is the reconnect loop tearing down or losing its own attempt.
    if (!this.#up || this.#recovering) return;
    this.#recovering = true;

    this.#logger.warn("azula: the azula bridge process exited; reconnecting");
    this.#emit({ phase: "recovering", error: "the azula bridge process exited" });
    this.#closeGate();
    // Surfaces lived in the dead session; patching them later would act on
    // state that no longer exists, so forget them.
    this.#surfaces.drain();
    void this.#recover();
  }

  async #recover(): Promise<void> {
    const supervisor = this.#supervisor;
    if (!supervisor) return;

    let recovered: boolean;
    try {
      recovered = await supervisor.reconnect();
    } finally {
      this.#recovering = false;
    }
    if (this.#stopping) return;

    if (recovered) {
      this.#openGate();
      this.#emit({ phase: "ready" });
      return;
    }

    const health = supervisor.health;
    const reason =
      health.state === "unhealthy"
        ? health.reason
        : "the azula bridge could not be re-established";

    if (this.#lastConnectError instanceof AzulaConfigError) {
      // Something an operator must change (the phone was un-paired, the binary
      // went away). Terminal, same as at start-up.
      this.#block(this.#lastConnectError);
      this.#ended.resolve();
      return;
    }

    markUnavailable(this.#account.accountId, reason);
    this.#emit({ phase: "recovering", error: reason });
    // Hand the failure to the gateway: its restart policy backs off on a longer
    // scale than ours and reports the failure as the account's health.
    this.#ended.reject(new Error(reason));
  }

  /** Report a configuration problem that no retry will cure. */
  #block(err: AzulaConfigError): void {
    const message = `${err.full}\n  → then restart the azula channel (or the gateway) to retry`;
    this.#logger.error(
      `azula: account '${this.#account.accountId}' cannot start: ${message}`,
    );
    markUnavailable(this.#account.accountId, err.message);
    this.#emit({ phase: "blocked", error: message });
  }

  // -- inbound -------------------------------------------------------------

  async #commit(items: InboundItem[]): Promise<void> {
    const now = Date.now();
    this.#emit({ lastEventAt: now });

    for (const item of items) {
      if (item.kind === "presence") {
        this.#logger.info(
          `azula: device '${item.device}' ${item.connected ? "connected" : "disconnected"}`,
        );
      }
    }

    // `get_events` is already scoped to this account's device. Checking again is
    // cheap, and a second line of defence for an access boundary is worth it.
    const addressed = items.filter((i) => i.device === this.#account.device);
    if (addressed.length !== items.length) {
      this.#logger.warn(
        `azula: ignored ${items.length - addressed.length} inbound item(s) from a device other than '${this.#account.device}'`,
      );
    }
    if (!addressed.some((i) => i.kind !== "presence")) return;

    this.#emit({ lastInboundAt: now });
    const batchId = `${this.#epoch}-${++this.#batchSeq}`;
    const result = await dispatchOnce(
      {
        dedupe: this.#opts.dedupe,
        logger: this.#logger,
        account: this.#account.accountId,
        dispatch: (item) => this.#deliver(item),
      },
      batchId,
      addressed,
    );
    if (result.failed > 0) {
      const message = `azula: ${result.failed} inbound item(s) could not be delivered to the agent and were dropped`;
      // At shutdown this is the expected cost of cutting a batch short.
      if (this.#stopping) this.#logger.warn(message);
      else this.#logger.error(message);
    }
  }

  /** One item, to the agent. Throws on failure so {@link dispatchOnce} releases its claim. */
  async #deliver(item: InboundItem): Promise<void> {
    if (item.kind === "presence") return;
    const bridge = this.#bridge;
    if (!bridge || this.#stopping) {
      throw new McpError("account is stopping", "closed");
    }
    const turn = { bridge, surfaces: this.#surfaces };

    // A tap answers its surface; a typed reply means the user moved on, so any
    // controls still on screen are stale. Neither is a turn's concern.
    if (item.kind === "choice") {
      if (item.surfaceId) await resolveSurface(turn, item.surfaceId);
    } else if (this.#surfaces.openSurfaces.length > 0) {
      await endTurn(turn);
    }

    try {
      await this.#opts.dispatch(item, { ...turn, signal: this.#abort.signal });
    } catch (err) {
      if (!this.#stopping) {
        await this.#tellPhone(
          `OpenClaw could not process your last message: ${errMessage(err)}`,
        );
      }
      throw err;
    }
  }

  /** Best-effort note to the phone; the caller is already handling a failure. */
  async #tellPhone(text: string): Promise<void> {
    const bridge = this.#bridge;
    if (!bridge?.running) return;
    try {
      await bridge.sendMessage(text);
    } catch (err) {
      this.#logger.debug(`azula: could not notify the phone: ${errMessage(err)}`);
    }
  }

  // -- shutdown ------------------------------------------------------------

  async #stop(): Promise<void> {
    this.#stopping = true;
    // Ends in-flight agent turns and any wait that is parked on this account.
    this.#abort.abort();
    this.#openGate();

    // New sends should fail fast with a reason, not reach a dying bridge.
    if (this.#runtime) {
      unregisterRuntime(this.#account.accountId, this.#runtime);
      this.#runtime = null;
    }

    const pumpStopped = this.#pump?.stop();
    // Killing the child is what ends a 25-second get_events: it rejects the
    // poll at once. Waiting the poll out is what would make shutdown slow.
    await this.#bridge?.stop().catch((err) => {
      this.#logger.warn(`azula: stopping the bridge failed: ${errMessage(err)}`);
    });

    if (pumpStopped) {
      await Promise.race([
        pumpStopped,
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, this.#opts.stopGraceMs ?? DEFAULT_STOP_GRACE_MS);
          t.unref?.();
        }),
      ]);
    }

    // A blocked account keeps saying why it is blocked; "stopped" would bury it.
    if (this.#phase !== "blocked") this.#emit({ phase: "stopped" });
    if (this.#up) {
      this.#logger.info(`azula: account '${this.#account.accountId}' stopped`);
    }
    this.#ended.resolve();
  }

  // -- plumbing ------------------------------------------------------------

  #closeGate(): void {
    // Already shut: leave the existing promise (and its resolver) alone.
    if (this.#gateClosed) return;
    this.#gateClosed = true;
    this.#gate = new Promise<void>((resolve) => {
      this.#openGate = () => {
        this.#gateClosed = false;
        resolve();
      };
    });
  }

  #emit(status: AccountStatus): void {
    if (status.phase) this.#phase = status.phase;
    try {
      this.#opts.onStatus?.(status);
    } catch (err) {
      // A faulty status sink must not take the channel down with it.
      this.#logger.debug(`azula: status update failed: ${errMessage(err)}`);
    }
  }
}
