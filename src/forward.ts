/**
 * Handing a send to the gateway, from a process that is not the gateway.
 *
 * The channel delivers `direct`: whoever sends calls our outbound hooks in their
 * own process. In the gateway that is exactly right (the agent's replies, its
 * `message` tool, cron and heartbeat all run there, beside the account's
 * `azula mcp` session). From `openclaw message send` it is not: the CLI process
 * holds no session, so there is nothing to send through. In that one case the
 * send is handed to the running gateway over its `send` RPC, which delivers it
 * through these same hooks, now in the process that has the session.
 *
 * Why not declare the channel `gateway`-mode and let OpenClaw do the hand-off
 * (as 0.0.5 did)? Because that mode also applies inside the gateway, where the
 * agent's `message` tool then routes through the gateway's own RPC with a client
 * authority a channel-triggered turn does not have ("Gateway client authority
 * closed before dispatching send"), and flattens a presentation to text before
 * our renderer can turn its buttons into a card.
 */

import { randomUUID } from "node:crypto";
import { CHANNEL_ID } from "./channel-id.js";
import { callGatewayViaCli, type CallGateway } from "./gateway-call.js";
import { nextMessageId, whileForwarding } from "./runtime.js";

/** Long enough to move a file to the phone through the gateway. */
const SEND_TIMEOUT_MS = 120_000;

const unreachable = (cause: string) =>
  `could not reach the OpenClaw gateway (${cause}).\n` +
  "azula's session for this account lives in the running gateway, so `openclaw message send` hands the " +
  "message to it. Start the gateway (`openclaw gateway`) and try again.";

let call: CallGateway = (method, params, timeoutMs) =>
  callGatewayViaCli(method, params, timeoutMs, unreachable);

/** Test seam: replace the gateway call. Pass nothing to restore the real one. */
export function setGatewayCaller(replacement?: CallGateway): void {
  call =
    replacement ?? ((method, params, timeoutMs) => callGatewayViaCli(method, params, timeoutMs, unreachable));
}

export type ForwardedSend = {
  /** The target as core resolved it (`azula:<device>`). */
  to: string;
  accountId?: string | null | undefined;
  message: string;
  mediaUrls: string[];
};

/** The gateway's reply carries the id of what it sent, in one of two places. */
function messageIdOf(result: Record<string, unknown>): string | undefined {
  const nested = result["result"];
  const candidates = [
    result["messageId"],
    typeof nested === "object" && nested !== null ? (nested as Record<string, unknown>)["messageId"] : undefined,
  ];
  return candidates.find((c): c is string => typeof c === "string" && c.length > 0);
}

/**
 * Ask the running gateway to send this to the phone.
 *
 * Text and attachments only: the `send` RPC has no presentation, so a rich
 * reply must already be flattened to text by the caller. An error from the
 * gateway (the account is waiting for a phone, the target is not its device)
 * comes back as an error carrying the gateway's own words; an unreachable
 * gateway as one that says how to start it.
 */
export async function forwardToGateway(send: ForwardedSend): Promise<{ messageId: string }> {
  const message = send.message.trim() ? send.message : undefined;
  const params: Record<string, unknown> = {
    channel: CHANNEL_ID,
    to: send.to,
    ...(send.accountId ? { accountId: send.accountId } : {}),
    ...(message === undefined ? {} : { message }),
    ...(send.mediaUrls.length > 0 ? { mediaUrl: send.mediaUrls[0], mediaUrls: send.mediaUrls } : {}),
    // Required by the RPC, and what lets the gateway recognise a retry.
    idempotencyKey: randomUUID(),
  };
  const result = await whileForwarding(send.accountId, () => call("send", params, SEND_TIMEOUT_MS));
  return { messageId: messageIdOf(result) ?? nextMessageId(CHANNEL_ID) };
}
