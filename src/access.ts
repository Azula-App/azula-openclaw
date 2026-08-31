/**
 * Access control and pairing.
 *
 * Design D5: azula's own device pairing *is* the boundary. Only a device
 * paired with this machine can reach it at all, so a second allowlist keyed on
 * chat identifiers would add no security and could disagree with the first —
 * and a disagreement between two access lists is a bug that reads as a policy.
 */

import type { AzulaEvent } from "./events.js";

/** Whether an event may be dispatched, given the account's device. */
export function isAllowed(event: AzulaEvent, allowedDevice: string): boolean {
  return event.device === allowedDevice;
}

/** Split a batch into what this account may act on and what it must ignore. */
export function partitionByDevice(
  events: AzulaEvent[],
  allowedDevice: string,
): { allowed: AzulaEvent[]; rejected: AzulaEvent[] } {
  const allowed: AzulaEvent[] = [];
  const rejected: AzulaEvent[] = [];
  for (const event of events) {
    (isAllowed(event, allowedDevice) ? allowed : rejected).push(event);
  }
  return { allowed, rejected };
}

/**
 * The pairing text an operator sees.
 *
 * `start_pairing` returns the invite URL plus a Unicode QR block. Both are
 * passed through: the URL is what you send to a phone you are holding, the QR
 * is what you scan from a phone you are not.
 */
export function pairingMessage(invite: string): string {
  const trimmed = invite.trim();
  return [
    "Pair your phone with azula to use this channel.",
    "",
    trimmed,
    "",
    "Open the link on the phone, or scan the code with the azula app.",
  ].join("\n");
}

/** Extract just the invite URL from `start_pairing`'s output, if present. */
export function inviteUrl(invite: string): string | null {
  const match = invite.match(/https:\/\/azula\.app\/\S+/);
  return match ? match[0] : null;
}
