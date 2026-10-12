/**
 * The live bridges, keyed by account.
 *
 * The outbound hooks are plain functions the gateway calls with a config and
 * an `accountId`; they need a way to reach the session that account owns. This
 * registry is that way, and is deliberately the only mutable module state in
 * the plugin.
 */

import { AzulaBridge, MAX_FILE_BYTES } from "./bridge.js";
import { SurfaceTracker } from "./surfaces.js";

export type AccountRuntime = {
  bridge: AzulaBridge;
  surfaces: SurfaceTracker;
};

const runtimes = new Map<string, AccountRuntime>();

/**
 * Why an account has no runtime, when the lifecycle knows.
 *
 * "No running bridge" alone sends the operator hunting; the reason (binary
 * missing, phone not paired, ...) is already known to the lifecycle, so it is
 * kept here and folded into the send error.
 */
const unavailable = new Map<string, string>();

const keyFor = (accountId?: string | null) => accountId?.trim() || "default";

export function registerRuntime(accountId: string, runtime: AccountRuntime): void {
  unavailable.delete(keyFor(accountId));
  runtimes.set(accountId, runtime);
}

/**
 * Drop an account's runtime.
 *
 * Pass `expected` to remove it only if it is still the registered one. A
 * stopping lifecycle must not tear down the registration of the lifecycle that
 * replaced it — the gateway can start the successor before a slow stop has
 * finished.
 */
export function unregisterRuntime(
  accountId: string,
  expected?: AccountRuntime,
): void {
  if (expected && runtimes.get(accountId) !== expected) return;
  runtimes.delete(accountId);
}

/** Record why an account cannot currently send. Cleared by {@link registerRuntime}. */
export function markUnavailable(accountId: string, reason: string): void {
  unavailable.set(keyFor(accountId), reason);
}

export function unavailableReason(accountId?: string | null): string | undefined {
  return unavailable.get(keyFor(accountId));
}

export function getRuntime(accountId?: string | null): AccountRuntime | undefined {
  return runtimes.get(keyFor(accountId));
}

/** The runtime for an account, or a {@link NoRuntimeError} saying why there is none. */
export function requireRuntime(accountId?: string | null): AccountRuntime {
  const runtime = getRuntime(accountId);
  if (!runtime) throw new NoRuntimeError(accountId, unavailableReason(accountId));
  return runtime;
}

/** Every live account, for shutdown. */
export function allRuntimes(): Array<[string, AccountRuntime]> {
  return [...runtimes.entries()];
}

export function clearRuntimes(): void {
  runtimes.clear();
  unavailable.clear();
}

export class NoRuntimeError extends Error {
  constructor(accountId?: string | null, reason?: string) {
    super(
      `the azula channel has no running bridge for account '${accountId ?? "default"}'` +
        (reason ? `: ${reason}` : ""),
    );
    this.name = "NoRuntimeError";
  }
}

/**
 * A message id for the gateway to correlate with.
 *
 * azula's `send_message` does not mint one — it streams a reply into a
 * conversation rather than creating an addressable object. The id exists so
 * the gateway can reference the message, and so a surface can be derived from
 * it; it is unique per send and stable for that send's lifetime.
 */
let counter = 0;
export function nextMessageId(prefix = "azula"): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

/** Reject an attachment that azula would refuse anyway, before transferring. */
export function assertSendableSize(sizeBytes: number, filename: string): void {
  if (sizeBytes > MAX_FILE_BYTES) {
    throw new Error(
      `'${filename}' is ${sizeBytes} bytes, over azula's ${MAX_FILE_BYTES} byte (64 MiB) inline transfer limit`,
    );
  }
}
