/**
 * Putting a whole reply on the phone: text, attachments, controls.
 *
 * One function, {@link deliverReply}, serves both ways a reply reaches the
 * phone: the agent's turn (`deliver` in `agent.ts`, for every block and final
 * reply) and the gateway's outbound path (`message send`, the agent's `message`
 * tool, cron), through {@link sendPayload}. Having one means a reply cannot be
 * rendered one way in a turn and another way from a tool.
 *
 * The rules, in order of importance:
 *
 *  1. **Never send nothing silently.** A payload's content can live in `text`,
 *     `presentation`, the deprecated `interactive`, `fallbackText`, `location`,
 *     or attachments. Core only flattens a presentation to text on its outbound
 *     path; on the turn path (`deliver`) that is the channel's job, and a
 *     channel that reads only `text` drops the reply (the bug this module
 *     exists to prevent). Whatever is left undeliverable is logged by name.
 *  2. **Text goes first, as its own message, and never waits on an
 *     attachment.** A remote file is fetched while the text is being sent, not
 *     before it, so a slow host costs the attachment its time and the text none.
 *     An attachment that cannot be fetched, read, or sent can then never take the
 *     text with it; a remote one that cannot be fetched is sent as a link in a
 *     short message of its own.
 *  3. **Controls go last, as a surface**, only after the text that explains
 *     them, and a surface that cannot be shown costs nothing: the text already
 *     says it all.
 */

import {
  hasReplyContent,
  legacyInteractiveReplyToPresentation,
  normalizeLegacyInteractiveReply,
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
  renderPresentationForDelivery,
  type MessagePresentation,
} from "openclaw/plugin-sdk/interactive-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { ChannelRuntime } from "./agent.js";
import type { AzulaBridge } from "./bridge.js";
import { CHANNEL_ID } from "./channel-id.js";
import type { Logger } from "./mcp-client.js";
import { linkNote, resolveMedia, type RemoteMediaFetcher } from "./media.js";
import { sendLocalFile } from "./outbound.js";
import {
  AZULA_PRESENTATION_CAPABILITIES,
  buildControlsSurface,
  conservativeCommandText,
  formatLocation,
  hasAnswerableControls,
  type CommandTextDetector,
} from "./rich.js";
import { nextMessageId, requireRuntime } from "./runtime.js";
import { surfaceIdFor, type SurfaceTracker } from "./surfaces.js";

/** Where, in `ReplyPayload.channelData`, the outbound renderer leaves the controls for {@link sendPayload}. */
const CHANNEL_DATA_KEY = "azula";

/** A reply, reduced to what azula can put on the phone. */
export type PreparedReply = {
  /** The message text: authored text, fallback text, flattened presentation, location. */
  text: string;
  mediaUrls: string[];
  /** The adapted presentation whose controls belong on a surface, when it has any. */
  controls?: MessagePresentation;
};

/**
 * The payload's presentation, with a deprecated `interactive` folded in.
 *
 * `interactive` follows its own old text rule: the payload's text wins, and the
 * interactive's text blocks only stand in when there is none. When a payload
 * carries both, the interactive's controls are appended rather than dropped.
 */
function presentationOf(payload: ReplyPayload): MessagePresentation | undefined {
  const modern = normalizeMessagePresentation(payload.presentation);
  const legacy = normalizeLegacyInteractiveReply(payload.interactive);
  const converted = legacy ? legacyInteractiveReplyToPresentation(legacy) : undefined;
  if (!converted) return modern;

  const keepText = !payload.text?.trim() && !modern;
  const blocks = converted.blocks.filter((block) => keepText || block.type !== "text");
  if (blocks.length === 0) return modern;
  return modern ? { ...modern, blocks: [...modern.blocks, ...blocks] } : { blocks };
}

/** Controls an earlier {@link renderPresentation} left in `channelData` for this payload. */
function carriedControls(payload: ReplyPayload): MessagePresentation | undefined {
  const mine = payload.channelData?.[CHANNEL_DATA_KEY];
  if (typeof mine !== "object" || mine === null) return undefined;
  return normalizeMessagePresentation((mine as Record<string, unknown>)["controls"]);
}

/**
 * Work out what a payload says, in text, attachments and controls.
 *
 * A presentation is run through core's own renderer (the same call its outbound
 * path makes), so the degrade policy is core's: tables and charts become text,
 * limits clip controls into a plain list, `presentationTextMode: "fallback"`
 * keeps the authored text rather than doubling it. The renderer hook is only
 * a tap on the way past: it records the *adapted* presentation (the one the
 * controls are built from) and declines to render, which leaves the text to
 * core's default flattening. That default keeps every control's label in the
 * text (`label: url` for links), which is what lets the message stand alone
 * when the surface is gone.
 */
export async function prepareReply(payload: ReplyPayload): Promise<PreparedReply> {
  let text = payload.text ?? "";
  let controls = carriedControls(payload);

  const presentation = presentationOf(payload);
  if (presentation) {
    let adapted: MessagePresentation | undefined;
    const { interactive: _folded, ...rest } = payload;
    const rendered = await renderPresentationForDelivery(
      {
        presentationCapabilities: AZULA_PRESENTATION_CAPABILITIES,
        renderPresentation: (adaptedPayload) => {
          adapted = adaptedPayload.presentation;
          return null;
        },
      },
      { ...rest, presentation },
    );
    text = rendered.text ?? "";
    controls = adapted;
  }

  // Text a producer supplied for a channel that cannot show its native content.
  if (!text.trim() && payload.fallbackText?.text.trim()) {
    text = payload.fallbackText.text;
  }

  const location = payload.location;
  if (location && Number.isFinite(location.latitude) && Number.isFinite(location.longitude)) {
    text = [text.trim(), formatLocation(location)].filter(Boolean).join("\n\n");
  }

  const mediaUrls = (payload.mediaUrls?.length ? payload.mediaUrls : [payload.mediaUrl ?? ""])
    .map((url) => url.trim())
    .filter(Boolean);

  return { text, mediaUrls, ...(controls ? { controls } : {}) };
}

export type ReplyDeps = {
  bridge: Pick<AzulaBridge, "sendMessage" | "sendFile" | "renderUi">;
  surfaces: SurfaceTracker;
  logger: Logger;
  /** Fetches a remote attachment; absent, a remote link is sent as a message. */
  fetchMedia?: RemoteMediaFetcher | undefined;
  /**
   * The gateway's judgment of what text it would run as a command, which keeps a
   * hidden button answer from doing so. Absent, a conservative one is used.
   */
  isCommandText?: CommandTextDetector | undefined;
};

/**
 * "Would the gateway treat this text as a command?", for a button's hidden answer.
 *
 * Two judgments, either of which is enough to refuse:
 *
 *  - The gateway's own, `shouldComputeCommandAuthorized`: the check it makes to
 *    decide whether an inbound message needs command authorization. It knows
 *    the command registry and the current config: control commands (including
 *    the bare words that abort a run), a command token inside the text
 *    (`hey /status`), and spaced plugin commands.
 *  - {@link conservativeCommandText}. The gateway's check has a gap that matters
 *    here: it does not recognise `! ls`, the documented form of the `!`
 *    host-shell shortcut (its token pattern wants a letter straight after the
 *    `!`), although the shell handler runs any text that starts with `!`. The
 *    conservative check refuses every `/` or `!` prefix.
 *
 * If the gateway cannot answer, the text is assumed to be a command.
 */
export function commandTextDetector(
  channel: Pick<ChannelRuntime, "commands">,
  config: () => OpenClawConfig,
): CommandTextDetector {
  return (text) => {
    if (conservativeCommandText(text)) return true;
    try {
      return channel.commands.shouldComputeCommandAuthorized(text, config());
    } catch {
      return true;
    }
  };
}

export type ReplyOutcome = {
  /** The id this reply is known by; a surface it opened is derived from it. */
  messageId: string;
  /** How many things reached the phone (text, files, a surface). */
  delivered: number;
};

/** The payload's populated keys, for a log line that must not carry content. */
function keysOf(payload: ReplyPayload): string {
  const present = Object.entries(payload)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key]) => key);
  return present.length > 0 ? present.join(", ") : "(none)";
}

/**
 * Deliver one reply: text, then attachments, then controls.
 *
 * Throws only when the *text* cannot be sent (the bridge is down, azula
 * rejected the message), because then nothing has reached the phone and the
 * caller's error path should hear about it. Once the text is out, a failure
 * is not thrown: the gateway's retry would send the text twice. An attachment
 * that cannot be sent is logged and the phone is told; controls that cannot be
 * shown are logged.
 *
 * Attachments are resolved (remote ones fetched) in parallel, starting before
 * the text is sent but never awaited by it, and are then sent one at a time in
 * the order they were given, whichever fetch finishes first.
 */
export async function deliverReply(deps: ReplyDeps, payload: ReplyPayload): Promise<ReplyOutcome> {
  const { bridge, surfaces, logger } = deps;
  const messageId = nextMessageId(CHANNEL_ID);
  const reply = await prepareReply(payload);

  // `resolveMedia` never rejects, so these cannot surface as unhandled even if
  // the text below throws and the attachments are abandoned.
  const pending = reply.mediaUrls.map((url) =>
    resolveMedia(url, { fetchMedia: deps.fetchMedia, logger }),
  );

  let delivered = 0;

  if (reply.text.trim() !== "") {
    await bridge.sendMessage(reply.text);
    delivered += 1;
  }

  // The user asked for this attachment; saying nothing would look like the bot
  // ignored them. Best effort: a note that fails is not worth an error.
  const tell = async (note: string) => {
    try {
      await bridge.sendMessage(note);
      delivered += 1;
    } catch (err) {
      logger.debug(`azula: could not tell the phone about an attachment: ${(err as Error).message}`);
    }
  };

  for (const resolving of pending) {
    const media = await resolving;
    switch (media.kind) {
      case "file":
        try {
          await sendLocalFile(bridge, media.path);
          delivered += 1;
        } catch (err) {
          // The message names the file and the limit or the cause.
          logger.warn(`azula: an attachment was not sent: ${(err as Error).message}`);
          await tell(`Could not send an attachment: ${(err as Error).message}`);
        }
        break;
      case "link":
        await tell(linkNote(media.url));
        break;
      case "unsupported":
        logger.warn(`azula: an attachment was not sent: ${media.reason}`);
        await tell(`Could not send an attachment: ${media.reason}`);
        break;
    }
  }

  if (reply.controls) {
    const surface = buildControlsSurface(reply.controls, deps.isCommandText ?? conservativeCommandText);
    if (surface) {
      const surfaceId = surfaceIdFor(messageId);
      // Tracked before it is shown, so a surface that appears while the call is
      // still returning is still cleaned up with the turn.
      surfaces.opened(surfaceId);
      try {
        await bridge.renderUi(surfaceId, surface.components);
        delivered += 1;
      } catch (err) {
        surfaces.closed(surfaceId);
        logger.warn(
          `azula: could not show the reply's buttons (the message itself was sent): ${(err as Error).message}`,
        );
      }
    }
  }

  if (delivered === 0) {
    const content = hasReplyContent({
      text: payload.text ?? null,
      mediaUrl: payload.mediaUrl ?? null,
      mediaUrls: payload.mediaUrls ?? [],
      interactive: payload.interactive,
      presentation: payload.presentation,
      hasChannelData: payload.channelData !== undefined && Object.keys(payload.channelData).length > 0,
      extraContent: payload.location != null || Boolean(payload.fallbackText?.text.trim()),
    });
    if (content) {
      logger.warn(
        `azula: a reply carried nothing azula can show, so nothing was sent (it had: ${keysOf(payload)})`,
      );
    } else {
      logger.debug("azula: skipping an empty reply");
    }
  }

  return { messageId, delivered };
}

/**
 * The outbound adapter's `renderPresentation`: core's hook for turning a
 * presentation into a payload this channel sends.
 *
 * Declines (null, so core flattens the presentation to text) unless there is a
 * button the phone can tap. When there is, the text is flattened here and the
 * controls are carried in `channelData` to {@link sendPayload}, which puts them
 * on a surface after the text.
 *
 * Core blanks the payload's text before this hook when the producer marked it
 * `presentationTextMode: "fallback"` (the text *is* the flattened
 * presentation, and a channel that renders natively must not show both). We do
 * not render the content natively, so it is rebuilt from the source
 * presentation, labels in full.
 */
export function renderPresentation(params: {
  payload: ReplyPayload;
  presentation: MessagePresentation;
  sourcePresentation?: MessagePresentation | undefined;
}): ReplyPayload | null {
  const { payload, presentation } = params;
  if (!hasAnswerableControls(presentation)) return null;

  const textIsFallback = payload.presentationTextMode === "fallback";
  const text = renderMessagePresentationFallbackText({
    ...(textIsFallback ? {} : { text: payload.text }),
    presentation: params.sourcePresentation ?? presentation,
  });
  return {
    ...payload,
    text,
    channelData: { ...payload.channelData, [CHANNEL_DATA_KEY]: { controls: presentation } },
  };
}

/**
 * The outbound adapter's `sendPayload`: core routes here anything richer than
 * text and one attachment (a payload with `channelData`, a `location`, an
 * `interactive`, or the controls {@link renderPresentation} left behind).
 */
export async function sendPayload(ctx: {
  payload: ReplyPayload;
  accountId?: string | null | undefined;
}): Promise<{ channel: string; messageId: string; outcome?: "not_sent" }> {
  const runtime = requireRuntime(ctx.accountId);
  const logger = runtime.logger ?? { debug() {}, info() {}, warn() {}, error() {} };
  const outcome = await deliverReply(
    {
      bridge: runtime.bridge,
      surfaces: runtime.surfaces,
      logger,
      fetchMedia: runtime.fetchMedia,
      isCommandText: runtime.isCommandText,
    },
    ctx.payload,
  );
  // Nothing sent is a deliberate omission, not an ambiguous send.
  return outcome.delivered === 0
    ? { channel: CHANNEL_ID, messageId: "", outcome: "not_sent" }
    : { channel: CHANNEL_ID, messageId: outcome.messageId };
}
