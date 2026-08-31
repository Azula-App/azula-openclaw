/**
 * Outbound: what the gateway calls to put something on the phone.
 *
 * These are the `attachedResults` hooks `createChatChannelPlugin` composes
 * into the channel's outbound adapter. Each returns an
 * `OutboundDeliveryResult` minus `channel`, which the helper fills in.
 */

import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CHANNEL_ID } from "./channel-id.js";
import {
  assertSendableSize,
  getRuntime,
  nextMessageId,
  NoRuntimeError,
} from "./runtime.js";

/** The subset of the outbound context these hooks actually read. */
export type OutboundCtx = {
  text?: string;
  mediaUrl?: string | undefined;
  accountId?: string | null | undefined;
};

/**
 * Send the agent's text.
 *
 * azula's delivery chain falls back to the identity's relay and then a local
 * queue when the phone is unreachable, and reports that as success — which it
 * is: the message will arrive. Only a rejection azula itself raises (an
 * unknown device, say) becomes a send error here.
 */
export async function sendText(ctx: OutboundCtx): Promise<{ messageId: string }> {
  const runtime = getRuntime(ctx.accountId);
  if (!runtime) throw new NoRuntimeError(ctx.accountId);

  const text = ctx.text ?? "";
  await runtime.bridge.sendMessage(text);
  return { messageId: nextMessageId(CHANNEL_ID) };
}

/**
 * Send an attachment.
 *
 * The size check happens here, before any transfer frames are written, so an
 * oversized file fails with a message naming the limit rather than part-way
 * through a chunked transfer.
 */
export async function sendMedia(ctx: OutboundCtx): Promise<{ messageId: string }> {
  const runtime = getRuntime(ctx.accountId);
  if (!runtime) throw new NoRuntimeError(ctx.accountId);

  const mediaUrl = ctx.mediaUrl;
  if (!mediaUrl) {
    // Nothing to attach; fall back to the text path rather than failing, so a
    // payload that lost its media still reaches the phone.
    return sendText(ctx);
  }

  const path = localPathFor(mediaUrl);
  if (!path) {
    throw new Error(
      `azula can only attach local files; '${mediaUrl}' is not a local path`,
    );
  }

  let size = 0;
  try {
    size = statSync(path).size;
  } catch (err) {
    throw new Error(`could not read '${path}': ${(err as Error).message}`);
  }
  assertSendableSize(size, path);

  const caption = ctx.text?.trim();
  await runtime.bridge.sendFile(path, caption ? caption : undefined);
  return { messageId: nextMessageId(CHANNEL_ID) };
}

/**
 * Resolve an outbound media reference to a local path.
 *
 * azula's `send_file` reads from the machine running the bridge, so a remote
 * URL cannot be attached — and the A2UI `Image` component deliberately will
 * not fetch one either. Returning `null` lets the caller say so plainly.
 */
export function localPathFor(mediaUrl: string): string | null {
  if (mediaUrl.startsWith("file://")) {
    try {
      return fileURLToPath(mediaUrl);
    } catch {
      return null;
    }
  }
  // Any other scheme is not something send_file can read. The scheme must be
  // two or more characters so a Windows drive letter (`C:\\...`) is still
  // treated as the local path it is. `data:` has no `//`, so matching on
  // `://` alone would let a data URI through and fail later as a missing file.
  if (/^[a-z][a-z0-9+.-]+:/i.test(mediaUrl)) return null;
  return mediaUrl;
}
