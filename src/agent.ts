/**
 * Handing an inbound item to the agent, and the agent's replies back out.
 *
 * Built on the SDK's channel-turn pipeline rather than a hand-rolled one, so
 * the phone gets what every other channel's users get: routing and bindings,
 * session keys, command handling, queueing when a run is already active,
 * the reply pipeline, and the shared typing lifecycle.
 *
 * The flow, per item:
 *
 *  1. Route: one direct conversation per account, keyed by the device.
 *  2. Admit: the SDK's ingress resolver, with the device as the only sender.
 *     azula's pairing is the real boundary (design D5), so this is not a second
 *     allowlist — it is how the host learns who the sender is, and what a
 *     slash command from them may do.
 *  3. Build the inbound context (text, attachments as local paths, sender).
 *  4. Dispatch. Replies come back through `deliver`, which is this channel's
 *     own outbound (`sendText` / `sendMedia`), so a reply and a proactive send
 *     take one path to the phone.
 */

import { readFile } from "node:fs/promises";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import type { ResolvedAzulaAccount } from "./accounts.js";
import { MAX_FILE_BYTES } from "./bridge.js";
import { CHANNEL_ID } from "./channel-id.js";
import type { InboundMedia } from "./inbound.js";
import type { AgentDispatch } from "./lifecycle.js";
import type { Logger } from "./mcp-client.js";
import { sendMedia, sendText } from "./outbound.js";
import { nextMessageId } from "./runtime.js";
import type { Sdk } from "./sdk.js";

/** The SDK's channel runtime, as handed to a running account. */
export type ChannelRuntime = PluginRuntime["channel"];

export type AgentDispatchOptions = {
  /**
   * The gateway's current config. Read once per turn: the account outlives
   * config edits that do not restart it (routing, bindings, agents), and each
   * new turn should see them.
   */
  readConfig: () => OpenClawConfig;
  account: ResolvedAzulaAccount;
  channel: ChannelRuntime;
  sdk: Pick<
    Sdk,
    | "resolveChannelInboundRouteEnvelope"
    | "toInboundMediaFacts"
    | "formatInboundMediaUnavailableText"
  >;
  logger: Logger;
  /** Test seam. */
  now?: () => number;
  /** How often the thinking indicator is re-asserted while a turn runs. */
  typingKeepaliveMs?: number;
  /**
   * Safety net on the indicator. The SDK's default is 60 seconds, which would
   * switch the indicator off in the middle of any long turn; the phone has no
   * timeout of its own, so this is only a backstop against a turn that never
   * reports it is over.
   */
  typingMaxDurationMs?: number;
};

const DEFAULT_TYPING_MAX_DURATION_MS = 10 * 60_000;

/**
 * Copy an attachment into OpenClaw's own media store.
 *
 * azula leaves a received file wherever azula keeps them, and the gateway will
 * not read an inbound attachment from outside its allowed media roots (it logs
 * "Blocked attachment path outside allowed roots" and the agent never sees the
 * file). A channel plugin cannot widen those roots, so the supported route is
 * the one every other channel takes: hand the bytes to the media store and give
 * the agent the path it returns.
 */
async function stageAttachment(
  channel: ChannelRuntime,
  media: InboundMedia,
): Promise<{ path: string; contentType: string; fileName: string }> {
  const bytes = await readFile(media.path);
  const saved = await channel.media.saveMediaBuffer(
    bytes,
    media.mimeType,
    "inbound",
    MAX_FILE_BYTES,
    media.filename,
  );
  return {
    path: saved.path,
    contentType: saved.contentType ?? media.mimeType,
    fileName: media.filename,
  };
}

/** The text the agent is given for an item. */
function bodyFor(item: Parameters<AgentDispatch>[0]): string {
  // A tap is the user's answer to the question that put the buttons there; the
  // chosen option's id is what a text channel's button callback would carry.
  return item.kind === "choice" ? item.value : item.text;
}

export function createAgentDispatch(options: AgentDispatchOptions): AgentDispatch {
  const { account, channel, sdk, logger } = options;
  const now = options.now ?? Date.now;

  return async (item, scope) => {
    // The device is the lifecycle's to say: an account that started without one
    // learns it when a phone pairs, and `account` is only the config at start.
    const device = scope.device ?? account.device;
    if (device === undefined) {
      throw new Error("azula: an inbound item arrived before any phone was paired");
    }
    const target = `${CHANNEL_ID}:${device}`;
    const cfg = options.readConfig();
    const rawBody = bodyFor(item);
    const media = item.kind === "message" ? item.media : [];
    if (rawBody.trim() === "" && media.length === 0) {
      logger.debug("azula: ignoring an inbound item with no text and no attachment");
      return;
    }

    const peer = { kind: "direct" as const, id: device };
    const { route, buildEnvelope } = sdk.resolveChannelInboundRouteEnvelope({
      cfg,
      channel: CHANNEL_ID,
      accountId: account.accountId,
      peer,
    });

    const messageId = nextMessageId(`${CHANNEL_ID}-in`);
    const timestamp = now();

    // Is this a slash command? The ingress gate needs to know, because whether
    // the sender may run it is decided there.
    const hasControlCommand = channel.commands.isControlCommandMessage(rawBody, cfg);

    const ingress = await channel.inbound.ingress.resolveStable({
      channelId: CHANNEL_ID,
      accountId: account.accountId,
      cfg,
      identity: { key: "azula-device", entryIdPrefix: "azula-device" },
      subject: { stableId: device },
      conversation: { kind: "direct", id: device },
      contextBinding: {
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        messageId,
        inboundEventKind: "user_request",
      },
      // azula only ever delivers events from the paired device this account
      // names, so the device is the allowlist.
      dmPolicy: "allowlist",
      allowFrom: [device],
      ...(hasControlCommand
        ? { command: { allowTextCommands: true, hasControlCommand: true } }
        : {}),
    });

    if (ingress.ingress.admission !== "dispatch") {
      logger.warn(
        `azula: the gateway declined an inbound item from '${device}' (${ingress.ingress.admission})`,
      );
      return;
    }

    // One attachment failing to stage must not lose the message it came with;
    // the agent is told, in the standard words, that it is missing.
    let body = rawBody;
    const staged: Array<Awaited<ReturnType<typeof stageAttachment>>> = [];
    for (const m of media) {
      try {
        staged.push(await stageAttachment(channel, m));
      } catch (err) {
        logger.warn(
          `azula: could not stage attachment '${m.filename}': ${(err as Error).message}`,
        );
        body = sdk.formatInboundMediaUnavailableText({
          body,
          notice: `[azula attachment '${m.filename}' could not be read]`,
        });
      }
    }
    const mediaFacts = sdk.toInboundMediaFacts(
      staged.map((s) => ({
        path: s.path,
        contentType: s.contentType,
        fileName: s.fileName,
        messageId,
      })),
      { messageId },
    );

    const ctxPayload = channel.inbound.buildContext({
      channel: CHANNEL_ID,
      accountId: route.accountId ?? account.accountId,
      messageId,
      messageIdFull: messageId,
      timestamp,
      from: target,
      sender: { id: device, name: device },
      conversation: {
        kind: "direct",
        id: device,
        label: device,
        routePeer: peer,
      },
      route: {
        agentId: route.agentId,
        ...(route.dmScope ? { dmScope: route.dmScope } : {}),
        accountId: route.accountId,
        routeSessionKey: route.sessionKey,
        dispatchSessionKey: route.sessionKey,
      },
      reply: {
        to: target,
        originatingTo: target,
        ...(item.kind === "choice" && item.replyToMessageId
          ? { replyToId: item.replyToMessageId, replyToIdFull: item.replyToMessageId }
          : {}),
      },
      message: {
        body: buildEnvelope({
          channel: "azula",
          from: device,
          timestamp,
          body,
        }),
        bodyForAgent: body,
        rawBody,
        commandBody: rawBody,
      },
      ...(mediaFacts.length > 0 ? { media: mediaFacts } : {}),
      access: { commands: { authorized: ingress.commandAccess.authorized } },
      channelIngress: ingress,
    });

    try {
      const result = await channel.inbound.dispatch({
        cfg,
        channel: CHANNEL_ID,
        accountId: account.accountId,
        route: {
          agentId: route.agentId,
          ...(route.dmScope ? { dmScope: route.dmScope } : {}),
          sessionKey: route.sessionKey,
        },
        ctxPayload,
        record: {
          onRecordError: (err) =>
            logger.warn(`azula: recording the inbound session failed: ${String(err)}`),
        },
        delivery: {
          deliver: async (payload) => {
            // Reasoning and commentary are the agent thinking out loud, not a
            // reply; they belong in a debug view, not the phone's chat.
            if (payload.isReasoning === true) return;

            const urls = payload.mediaUrls?.length
              ? payload.mediaUrls
              : payload.mediaUrl
                ? [payload.mediaUrl]
                : [];
            const text = payload.text ?? "";
            const out = { accountId: account.accountId } as const;

            if (urls.length === 0) {
              if (text.trim() !== "") await sendText({ ...out, text });
              return;
            }
            // The first attachment carries the text as its caption, so a reply
            // that is a picture plus a sentence arrives as one thing.
            for (const [index, mediaUrl] of urls.entries()) {
              await sendMedia({
                ...out,
                mediaUrl,
                ...(index === 0 && text.trim() !== "" ? { text } : {}),
              });
            }
          },
          onError: (err, info) =>
            logger.warn(`azula: delivering a ${info.kind} reply failed: ${String(err)}`),
        },
        replyOptions: { abortSignal: scope.signal },
        replyPipeline: {
          typing: {
            start: () => scope.bridge.setTyping(true),
            stop: () => scope.bridge.setTyping(false),
            onStartError: (err) =>
              logger.debug(`azula: typing indicator failed: ${String(err)}`),
            ...(options.typingKeepaliveMs === undefined
              ? {}
              : { keepaliveIntervalMs: options.typingKeepaliveMs }),
            maxDurationMs: options.typingMaxDurationMs ?? DEFAULT_TYPING_MAX_DURATION_MS,
          },
        },
      });

      if (result.admission.kind !== "dispatch") {
        logger.warn(`azula: the gateway declined the turn (${result.admission.kind})`);
      } else if (!result.dispatched) {
        logger.warn("azula: the gateway accepted the turn without running it");
      }
    } finally {
      // The pipeline clears the indicator when the turn goes idle, but a turn
      // that throws is exactly when the agent looks stuck. Clearing is
      // idempotent and never throws, so do it unconditionally.
      await scope.bridge.setTyping(false);
    }
  };
}
