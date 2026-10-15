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
import { forwardToGateway } from "./forward.js";
import { isRemoteUrl, linkNote, resolveMedia } from "./media.js";
import {
  assertSendableSize,
  canForwardToGateway,
  getRuntime,
  nextMessageId,
  requireRuntime,
  type AccountRuntime,
} from "./runtime.js";

export { localPathFor } from "./media.js";

/** The subset of the outbound context these hooks actually read. */
export type OutboundCtx = {
  /** The target as core resolved it (`azula:<device>`). */
  to?: string | undefined;
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
  const text = ctx.text ?? "";
  const runtime = runtimeOrNull(ctx);
  if (!runtime) return forwardToGateway({ ...forwardTarget(ctx), message: text, mediaUrls: [] });

  await runtime.bridge.sendMessage(text);
  return { messageId: nextMessageId(CHANNEL_ID) };
}

/**
 * The account's runtime, or null when this is a CLI process and the send should
 * go to the gateway instead (see forward.ts).
 *
 * Throws {@link NoRuntimeError} when there is nothing to send through and
 * nowhere to hand the send: the gateway's own account is waiting for a phone,
 * blocked or stopped (it must not "forward" to itself), or the core gave no
 * target to forward.
 */
export function runtimeOrNull(ctx: { accountId?: string | null | undefined; to?: string | undefined }): AccountRuntime | null {
  const runtime = getRuntime(ctx.accountId);
  if (runtime) return runtime;
  if (ctx.to && canForwardToGateway(ctx.accountId)) return null;
  return requireRuntime(ctx.accountId);
}

/** The part of a send the gateway needs to route it, from an outbound context. */
export function forwardTarget(ctx: { accountId?: string | null | undefined; to?: string | undefined }) {
  return { to: ctx.to as string, accountId: ctx.accountId };
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
  const mediaUrl = ctx.mediaUrl;
  if (!mediaUrl) {
    // Nothing to attach; fall back to the text path rather than failing, so a
    // payload that lost its media still reaches the phone.
    return sendText(ctx);
  }

  const runtime = runtimeOrNull(ctx);
  if (!runtime) {
    // A CLI process: the gateway fetches or reads the attachment and sends it.
    return forwardToGateway({ ...forwardTarget(ctx), message: ctx.text?.trim() ?? "", mediaUrls: [mediaUrl] });
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
