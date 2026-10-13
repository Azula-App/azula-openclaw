/**
 * Noticing a phone pair.
 *
 * An account with no `device` cannot know the name its phone will have: the
 * app's hello carries none, so azula registers a newly invite-paired phone under
 * its endpoint id. The only way to learn it is to watch the session's device
 * list for a phone that has connected to this session.
 *
 * `get_events` is not used for this. It does not reliably emit `connected` for a
 * phone that has only just paired, and with no device filter it snapshots its
 * targets when called, so it can miss exactly the phone it is waiting for.
 * `list_devices` is the source of truth, and `scripts/pair.mjs` has always used
 * it the same way.
 */

import { AzulaBridge, type BridgeOptions } from "./bridge.js";
import { parseDeviceLines, type DeviceTable } from "./device-list.js";
import type { Logger } from "./mcp-client.js";

/**
 * The device a bridge is built with before any phone has paired.
 *
 * Nothing addresses a device in that state (no sends, no typing, no event
 * scoping), and {@link AzulaBridge.setDevice} replaces it the moment one is
 * adopted.
 */
export const NO_DEVICE_YET = "";

// The `list_devices` parser lives in `device-list.ts` (the bridge needs it too,
// and this module imports the bridge); it is re-exported so this stays the one
// place pairing code reads it from.
export { parseDeviceLines, type DeviceTable } from "./device-list.js";

/**
 * The device that paired with this session between two snapshots, if any.
 *
 * azula's device registry is the machine's, not the session's: a phone paired
 * with another session on the same machine (or imported with `azula pair`) is in
 * every session's list. What tells the two apart is the status. `offline` means
 * "known, but this session has never dialed or accepted it"; a phone that has
 * redeemed this session's invite is `connected`, or `disconnected` if it has
 * already dropped again. So a device counts once this session has *seen* it
 * (`connected` or `disconnected`) and had not at the last look; a row that
 * merely appears as `offline` is somebody else's.
 *
 * A device already `connected` at the start shows no change at all, which is why
 * the operator is also told how to name a device directly.
 */
export function findNewDevice(before: DeviceTable, after: DeviceTable): string | undefined {
  for (const [name, status] of after) {
    const was = before.get(name);
    if (status === "connected" && was !== "connected") return name;
    if (status === "disconnected" && was !== "connected" && was !== "disconnected") return name;
  }
  return undefined;
}

const sleepMs = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal?.addEventListener("abort", done, { once: true });
  });

export const PAIRING_POLL_MS = 2_000;

export type WatchOptions = {
  /** One `list_devices` read. May throw while the bridge is down; that skips a tick. */
  list: () => Promise<readonly string[]>;
  baseline: DeviceTable;
  /** Ends the watch early (account stopping). */
  signal?: AbortSignal;
  /** Give up after this long; unset waits until `signal`. */
  timeoutMs?: number;
  intervalMs?: number;
  /** Test seam. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
};

/** Poll `list_devices` until a phone pairs. Resolves `null` on timeout or abort. */
export async function watchForDevice(options: WatchOptions): Promise<string | null> {
  const sleep = options.sleep ?? sleepMs;
  const now = options.now ?? Date.now;
  const deadline = options.timeoutMs === undefined ? Infinity : now() + options.timeoutMs;
  const interval = options.intervalMs ?? PAIRING_POLL_MS;

  while (!options.signal?.aborted) {
    try {
      const found = findNewDevice(options.baseline, parseDeviceLines(await options.list()));
      if (found !== undefined) return found;
    } catch {
      // The bridge is restarting or mid-call; the next tick will see it.
    }
    const remaining = deadline - now();
    if (remaining <= 0) return null;
    await sleep(Math.min(interval, remaining), options.signal);
  }
  return null;
}

/**
 * A short-lived azula session held only to pair a phone.
 *
 * Used when no running account can mint the invite: the account is stopped,
 * blocked because its `device` is not paired, or being re-paired on purpose.
 * Only one process can hold an azula session at a time, so this is only ever
 * open while the account itself is down, and it is gone as soon as the phone
 * has paired (or after {@link PairingSessionOptions.ttlMs} of silence).
 */
export type PairingSessionOptions = {
  bridge: BridgeOptions;
  /** Test seam: the real one builds an {@link AzulaBridge}. */
  createBridge?: (options: BridgeOptions) => AzulaBridge;
  logger: Logger;
  /** Closes itself after this long without a `waitForDevice`. */
  ttlMs?: number;
  /** Called once the session has closed itself. */
  onExpire?: () => void;
  sleep?: WatchOptions["sleep"];
  intervalMs?: number;
};

export const PAIRING_SESSION_TTL_MS = 20 * 60_000;

export class PairingSession {
  readonly #opts: PairingSessionOptions;
  readonly #bridge: AzulaBridge;
  readonly #abort = new AbortController();
  #baseline: DeviceTable = new Map();
  #ttl: NodeJS.Timeout | null = null;
  #closed = false;

  constructor(options: PairingSessionOptions) {
    this.#opts = options;
    this.#bridge = (options.createBridge ?? ((o) => new AzulaBridge(o)))(options.bridge);
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Phones already connected to this session when it opened. */
  get alreadyPaired(): string[] {
    return [...this.#baseline].filter(([, status]) => status === "connected").map(([name]) => name);
  }

  /** Start the bridge, take the baseline and mint the invite. */
  async open(): Promise<string> {
    try {
      await this.#bridge.start();
      this.#baseline = parseDeviceLines(await this.#bridge.listDevices());
      const invite = await this.#bridge.pairingInvite();
      this.#armTtl();
      return invite;
    } catch (err) {
      await this.close();
      throw err;
    }
  }

  /** Wait for a phone to pair; `null` if none did within `timeoutMs`. */
  async waitForDevice(timeoutMs: number): Promise<string | null> {
    if (this.#closed) return null;
    this.#armTtl();
    return watchForDevice({
      list: () => this.#bridge.listDevices(),
      baseline: this.#baseline,
      signal: this.#abort.signal,
      timeoutMs,
      ...(this.#opts.intervalMs === undefined ? {} : { intervalMs: this.#opts.intervalMs }),
      ...(this.#opts.sleep ? { sleep: this.#opts.sleep } : {}),
    });
  }

  /** Release the azula session. Idempotent. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#ttl) clearTimeout(this.#ttl);
    this.#abort.abort();
    await this.#bridge.stop().catch((err) => {
      this.#opts.logger.warn(`azula: closing the pairing session failed: ${(err as Error).message}`);
    });
  }

  #armTtl(): void {
    if (this.#ttl) clearTimeout(this.#ttl);
    this.#ttl = setTimeout(() => {
      this.#opts.logger.info("azula: the pairing session timed out and was closed");
      void this.close().then(() => this.#opts.onExpire?.());
    }, this.#opts.ttlMs ?? PAIRING_SESSION_TTL_MS);
    this.#ttl.unref?.();
  }
}
