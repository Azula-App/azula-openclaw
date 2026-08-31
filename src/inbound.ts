/**
 * Translating azula events into what the gateway dispatches.
 *
 * Translation is type-directed, never derived from parsing rendered text —
 * that is the whole reason `get_events` exists. A user who literally types
 * `ui-event: {...}` must reach the agent as that text.
 */

import type { AzulaEvent } from "./events.js";
import { choiceFromEvent, messageIdFromSurface, surfaceFromEvent } from "./surfaces.js";

/** An attachment, as ordered facts rather than parallel arrays. */
export type InboundMedia = {
  path: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  caption?: string;
};

/** A user message for the agent. */
export type InboundMessage = {
  kind: "message";
  device: string;
  text: string;
  media: InboundMedia[];
};

/** A tap on a surface, correlated back to the message that asked. */
export type InboundChoice = {
  kind: "choice";
  device: string;
  /** The chosen option's id. */
  value: string;
  /** The message whose surface this answers, when derivable. */
  replyToMessageId: string | null;
  surfaceId: string | null;
  /** The raw payload, forwarded intact. */
  event: unknown;
};

/** A liveness transition — state only, never an agent wake. */
export type InboundPresence = {
  kind: "presence";
  device: string;
  connected: boolean;
};

export type InboundItem = InboundMessage | InboundChoice | InboundPresence;

/**
 * Translate one event.
 *
 * Returns `null` only for events that carry no inbound meaning at all; every
 * recognised type produces an item, so the caller decides what to dispatch
 * rather than translation silently dropping things.
 */
export function translateEvent(event: AzulaEvent): InboundItem | null {
  switch (event.type) {
    case "message":
      return { kind: "message", device: event.device, text: event.text, media: [] };

    case "file":
      // An attachment with no text is still a message — the file *is* the
      // content. Caption becomes the text when present, so the agent sees
      // what the user actually wrote.
      return {
        kind: "message",
        device: event.device,
        text: event.caption ?? "",
        media: [
          {
            path: event.path,
            filename: event.name,
            mimeType: event.mime,
            sizeBytes: event.size,
            ...(event.caption === undefined ? {} : { caption: event.caption }),
          },
        ],
      };

    case "ui_event": {
      const surfaceId = surfaceFromEvent(event.event);
      return {
        kind: "choice",
        device: event.device,
        value: choiceFromEvent(event.event) ?? "",
        replyToMessageId: surfaceId ? messageIdFromSurface(surfaceId) : null,
        surfaceId,
        event: event.event,
      };
    }

    case "connected":
      return { kind: "presence", device: event.device, connected: true };

    case "disconnected":
      return { kind: "presence", device: event.device, connected: false };

    default:
      return null;
  }
}

/**
 * Translate a batch, preserving order and coalescing adjacent attachments.
 *
 * azula reports one `file` event per transfer, so a user sending three photos
 * produces three events. Merging consecutive ones into a single message keeps
 * their received order and gives the agent one turn with three attachments
 * rather than three turns with one each.
 */
export function translateBatch(events: AzulaEvent[]): InboundItem[] {
  const out: InboundItem[] = [];

  for (const event of events) {
    const item = translateEvent(event);
    if (!item) continue;

    const previous = out[out.length - 1];
    const mergeable =
      event.type === "file" &&
      item.kind === "message" &&
      previous?.kind === "message" &&
      previous.device === item.device &&
      previous.media.length > 0;

    if (mergeable && previous?.kind === "message" && item.kind === "message") {
      previous.media.push(...item.media);
      // Keep the first caption as the message text rather than concatenating;
      // later captions stay attached to their own media facts.
      if (!previous.text && item.text) previous.text = item.text;
      continue;
    }

    out.push(item);
  }

  return out;
}

/** The items that should actually wake the agent. */
export function agentWaking(items: InboundItem[]): Array<InboundMessage | InboundChoice> {
  return items.filter(
    (i): i is InboundMessage | InboundChoice => i.kind !== "presence",
  );
}
