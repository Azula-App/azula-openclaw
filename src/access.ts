/**
 * Access control and pairing.
 *
 * Design D5: azula's own device pairing *is* the boundary. Only a device
 * paired with this machine can reach it at all, so a second allowlist keyed on
 * chat identifiers would add no security and could disagree with the first —
 * and a disagreement between two access lists is a bug that reads as a policy.
 */

import { configSetCommand } from "./accounts.js";
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

/** Extract just the invite URL from `start_pairing`'s output, if present. */
export function inviteUrl(invite: string): string | null {
  const match = invite.match(/https:\/\/azula\.app\/\S+/);
  return match ? match[0] : null;
}

/**
 * The invite's QR block, if `start_pairing` returned one.
 *
 * azula wraps the Unicode QR in a markdown fence. The fence is dropped (a
 * terminal prints it as noise) and the block itself is passed through
 * untouched, since its leading blanks are the QR's quiet zone.
 */
function inviteQr(invite: string): string | null {
  const block = invite.match(/```[^\n]*\n([\s\S]*?)\n?```/)?.[1];
  return block && block.trim().length > 0 ? block : null;
}

export type PairingMessageContext = {
  accountId: string;
  /** The azula session the phone pairs with. */
  session: string;
  /**
   * Phones already connected to this session. One that is already online shows
   * no change when its invite is scanned again, so the operator is told how to
   * use it directly.
   */
  alreadyPaired?: readonly string[];
};

/**
 * The pairing text an operator sees: azula's own invite, never a second code.
 *
 * `start_pairing` returns the invite URL plus a Unicode QR block. Both are
 * passed through: the URL is what you send to a phone you are holding, the QR
 * is what you scan from a phone you are not.
 */
export function pairingMessage(invite: string, context?: PairingMessageContext): string {
  const url = inviteUrl(invite);
  const qr = inviteQr(invite);
  const lines = [
    context ? `Pair a phone with azula (account '${context.accountId}', session '${context.session}').` : "Pair a phone with azula.",
    "",
  ];
  if (url && qr) {
    lines.push(url, "", qr);
  } else {
    // An invite in a shape this plugin does not know: show it whole rather than
    // guess at which part matters.
    lines.push(invite.trim());
  }
  lines.push("", 'In the azula app tap "+ connect a peer", then scan the code or open the link on the phone.');
  const known = context?.alreadyPaired ?? [];
  if (known.length > 0) {
    lines.push(
      "",
      `A phone is already connected to this session: ${known.join(", ")}.`,
      `To use it without scanning: ${configSetCommand(context?.accountId ?? "default", known[0] as string)}`,
    );
  }
  return lines.join("\n");
}
