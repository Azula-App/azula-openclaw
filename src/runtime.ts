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

export function registerRuntime(accountId: string, runtime: AccountRuntime): void {
  runtimes.set(accountId, runtime);
}

export function unregisterRuntime(accountId: string): void {
  runtimes.delete(accountId);
}

export function getRuntime(accountId?: string | null): AccountRuntime | undefined {
  return runtimes.get(accountId?.trim() || "default");
}

/** Every live account, for shutdown. */
export function allRuntimes(): Array<[string, AccountRuntime]> {
  return [...runtimes.entries()];
}

export function clearRuntimes(): void {
  runtimes.clear();
}

export class NoRuntimeError extends Error {
  constructor(accountId?: string | null) {
    super(
      `the azula channel has no running bridge for account '${accountId ?? "default"}'`,
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
