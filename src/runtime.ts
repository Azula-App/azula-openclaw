/**
 * The live bridges, keyed by account.
 *
 * The outbound hooks are plain functions the gateway calls with a config and
 * an `accountId`; they need a way to reach the session that account owns. This
 * registry is that way, and is deliberately the only mutable module state in
 * the plugin.
 */

import { AzulaBridge, MAX_FILE_BYTES } from "./bridge.js";
import type { RemoteMediaFetcher } from "./media.js";
import type { Logger } from "./mcp-client.js";
import type { CommandTextDetector } from "./rich.js";
import { SurfaceTracker } from "./surfaces.js";

export type AccountRuntime = {
  bridge: AzulaBridge;
  surfaces: SurfaceTracker;
  /**
   * Where an outbound path with no turn around it (`message send`, cron) reports
   * what it could not do. Optional: a send that has nowhere to log still sends.
   */
  logger?: Logger;
  /** Fetches a remote attachment to local disk; absent, a remote link is sent as text. */
  fetchMedia?: RemoteMediaFetcher;
  /** The gateway's judgment of what text it would run as a command; see `commandTextDetector`. */
  isCommandText?: CommandTextDetector;
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

/**
 * Whether this process is the gateway.
 *
 * The outbound hooks run in two kinds of process: the gateway, which owns every
 * account's `azula mcp` session, and a CLI (`openclaw message send`), which owns
 * none and must hand the send to the gateway. OpenClaw 2026.10.2 offers a
 * plugin no signal for which one it is (the plugin registers in full mode in
 * both, and an outbound context carries nothing that says so), so the plugin
 * keeps its own: set by the only code that runs in the gateway process and not
 * in a CLI, the gateway adapter's entry points (`markGatewayProcess`) and the
 * registry writes the account lifecycle makes. It never goes back to false.
 *
 * It is what keeps a gateway whose account is waiting for a phone, blocked or
 * stopped from "forwarding" a send to itself.
 */
let inGateway = false;

/** Record that this is the gateway process. Called from gateway-only code. */
export function markGatewayProcess(): void {
  inGateway = true;
}

export function isGatewayProcess(): boolean {
  return inGateway;
}

/** Accounts with a send to the gateway in flight from this process, with how many. */
const forwarding = new Map<string, number>();

export function registerRuntime(accountId: string, runtime: AccountRuntime): void {
  inGateway = true;
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
  inGateway = true;
  unavailable.set(keyFor(accountId), reason);
}

export function unavailableReason(accountId?: string | null): string | undefined {
  return unavailable.get(keyFor(accountId));
}

export function getRuntime(accountId?: string | null): AccountRuntime | undefined {
  return runtimes.get(keyFor(accountId));
}

/**
 * Whether a send for an account with no runtime should be handed to the gateway.
 *
 * Only a CLI process may: it has no runtime because it never holds a session.
 * The gateway has none when the account is waiting for a phone, blocked or
 * stopped, and forwarding *that* to the gateway would be a send to itself, so
 * it fails with the reason instead. The in-flight check is the backstop: even if
 * this process were misjudged to be a CLI, the gateway's handling of the
 * forwarded send runs in this same process while the forward is outstanding, and
 * finds the account already forwarding, so a loop is at most one hop.
 */
export function canForwardToGateway(accountId?: string | null): boolean {
  return !inGateway && !getRuntime(accountId) && !forwarding.has(keyFor(accountId));
}

/** Run a send to the gateway, marking the account as forwarding for its duration. */
export async function whileForwarding<T>(
  accountId: string | null | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const key = keyFor(accountId);
  forwarding.set(key, (forwarding.get(key) ?? 0) + 1);
  try {
    return await run();
  } finally {
    const left = (forwarding.get(key) ?? 1) - 1;
    if (left <= 0) forwarding.delete(key);
    else forwarding.set(key, left);
  }
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

/** Forget everything, including which kind of process this is. For tests. */
export function clearRuntimes(): void {
  runtimes.clear();
  unavailable.clear();
  forwarding.clear();
  inGateway = false;
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
