/**
 * Outbound: what the gateway calls to put something on the phone.
 *
 * These are the `attachedResults` hooks `createChatChannelPlugin` composes
 * into the channel's outbound adapter. Each returns an
 * `OutboundDeliveryResult` minus `channel`, which the helper fills in.
 */

import { statSync } from "node:fs";
import type { AzulaBridge } from "./bridge.js";
import { CHANNEL_ID } from "./channel-id.js";
import { isRemoteUrl, linkNote, resolveMedia } from "./media.js";
import {
  assertSendableSize,
  nextMessageId,
  requireRuntime,
} from "./runtime.js";

export { localPathFor } from "./media.js";

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
  const runtime = requireRuntime(ctx.accountId);

  const text = ctx.text ?? "";
  await runtime.bridge.sendMessage(text);
  return { messageId: nextMessageId(CHANNEL_ID) };
}

/**
 * Send a local file, refusing an unreadable or oversized one up front.
 *
 * The size check happens here, before any transfer frames are written, so an
 * oversized file fails with a message naming the limit rather than part-way
 * through a chunked transfer.
 */
export async function sendLocalFile(
  bridge: Pick<AzulaBridge, "sendFile">,
  path: string,
  caption?: string,
): Promise<void> {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch (err) {
    throw new Error(`could not read '${path}': ${(err as Error).message}`);
  }
  assertSendableSize(size, path);

  const trimmed = caption?.trim();
  await bridge.sendFile(path, trimmed ? trimmed : undefined);
}

/**
 * Send an attachment.
 *
 * A remote (http/https) URL is fetched through the gateway's guarded loader and
 * the local copy sent. The caption of a remote attachment goes out first as a
 * message of its own, before the fetch, so a slow or failing host never holds
 * the words back; when the file cannot be fetched, its link follows as a short
 * message. (A local file keeps its caption: there is nothing to wait for.)
 */
export async function sendMedia(ctx: OutboundCtx): Promise<{ messageId: string }> {
  const runtime = requireRuntime(ctx.accountId);

  const mediaUrl = ctx.mediaUrl;
  if (!mediaUrl) {
    // Nothing to attach; fall back to the text path rather than failing, so a
    // payload that lost its media still reaches the phone.
    return sendText(ctx);
  }

  const caption = ctx.text?.trim();
  const remote = isRemoteUrl(mediaUrl);
  if (remote && caption) await runtime.bridge.sendMessage(caption);

  const media = await resolveMedia(mediaUrl, {
    fetchMedia: runtime.fetchMedia,
    logger: runtime.logger,
  });

  switch (media.kind) {
    case "file":
      await sendLocalFile(runtime.bridge, media.path, remote ? undefined : caption);
      break;
    case "link":
      await runtime.bridge.sendMessage(linkNote(media.url));
      break;
    case "unsupported":
      // Say what the sentence was before refusing the attachment.
      if (caption) await runtime.bridge.sendMessage(caption);
      throw new Error(media.reason);
  }
  return { messageId: nextMessageId(CHANNEL_ID) };
}
