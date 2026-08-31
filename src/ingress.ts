/**
 * At-most-once inbound delivery.
 *
 * `get_events` is a *destructive* drain: once azula hands a batch over, it is
 * gone from the bridge. So a crash between draining and dispatching loses
 * events unless each one is claimed durably first, and a crash between
 * dispatching and recording replays them unless the claim is committed after.
 *
 * Design D6 named `createChannelIngressMonitor`/`createIngressEffectOnce` for
 * this, from the plugin docs. Those do not exist in the shipped SDK
 * (2026.7.1-2) — `createClaimableDedupe` is what it actually provides, and it
 * has exactly the claim/commit/release shape the property needs.
 */

import type { ClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import type { InboundItem } from "./inbound.js";
import type { Logger } from "./mcp-client.js";

/**
 * A stable identity for one inbound item.
 *
 * azula does not mint inbound message ids, so the key is derived from the
 * content plus its position in the batch. Two identical messages sent twice
 * are genuinely different events and must both be delivered, which is why the
 * sequence number is part of the key rather than the content alone.
 */
export function ingressKey(
  account: string,
  batchId: string,
  index: number,
  item: InboundItem,
): string {
  const kind = item.kind;
  const detail =
    item.kind === "message"
      ? `${item.text.length}:${item.media.map((m) => m.filename).join(",")}`
      : item.kind === "choice"
        ? `${item.surfaceId ?? ""}:${item.value}`
        : String(item.connected);
  return `azula/${account}/${batchId}/${index}/${kind}/${detail}`;
}

export type IngressDeps = {
  dedupe: Pick<ClaimableDedupe, "claim" | "commit" | "release">;
  logger: Logger;
  account: string;
  /** Hand one item to the agent. */
  dispatch: (item: InboundItem) => Promise<void>;
};

/**
 * Dispatch a batch exactly once each, in order.
 *
 * Ordering is preserved by awaiting each item before the next: the agent
 * seeing messages out of order would be worse than seeing them slowly.
 *
 * A claim that reports a duplicate is skipped — that is the replay case. A
 * dispatch that throws releases its claim so the item can be retried rather
 * than being silently consumed.
 */
export async function dispatchOnce(
  deps: IngressDeps,
  batchId: string,
  items: InboundItem[],
): Promise<{ dispatched: number; skipped: number; failed: number }> {
  let dispatched = 0;
  let skipped = 0;
  let failed = 0;

  for (const [index, item] of items.entries()) {
    // Presence is liveness state, not an agent wake, and has no delivery
    // guarantee to keep — claiming it would only grow the dedupe store.
    if (item.kind === "presence") continue;

    const key = ingressKey(deps.account, batchId, index, item);
    const claim = await deps.dedupe.claim(key);
    if (isDuplicate(claim)) {
      skipped += 1;
      continue;
    }

    try {
      await deps.dispatch(item);
      await deps.dedupe.commit(key);
      dispatched += 1;
    } catch (err) {
      // Release rather than commit: an item that failed to reach the agent
      // has not been delivered, and pretending otherwise loses it for good.
      deps.dedupe.release(key, { error: err });
      failed += 1;
      deps.logger.warn(
        `azula: inbound dispatch failed (${item.kind}): ${(err as Error).message}`,
      );
    }
  }

  return { dispatched, skipped, failed };
}

/**
 * Whether a claim result means "someone already has this".
 *
 * The result shape varies across SDK versions, so this reads the flags it
 * knows and treats an unrecognised shape as *not* a duplicate — delivering
 * twice is recoverable and visible; dropping silently is neither.
 */
export function isDuplicate(claim: unknown): boolean {
  if (typeof claim !== "object" || claim === null) return false;
  const raw = claim as Record<string, unknown>;
  if (raw["duplicate"] === true) return true;
  if (raw["claimed"] === false) return true;
  if (raw["status"] === "duplicate") return true;
  return false;
}
