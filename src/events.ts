/**
 * The event vocabulary `azula mcp`'s `get_events` returns — the same shape
 * `azula watch --json` streams, so the two stay teachable as one model.
 *
 * These mirror the Rust `WatchEvent` enum (azula-cli `src/core/watch.rs`),
 * which is internally tagged on `type`. Keep them in sync; the bridge is the
 * source of truth and a mismatch here shows up as an event silently ignored.
 */

export type AzulaEvent =
  | { type: "message"; device: string; text: string }
  | { type: "ui_event"; device: string; event: unknown }
  | {
      type: "file";
      device: string;
      name: string;
      mime: string;
      size: number;
      path: string;
      /** Present only when the sender attached one. */
      caption?: string;
    }
  | { type: "connected"; device: string }
  | { type: "disconnected"; device: string };

export type AzulaEventType = AzulaEvent["type"];

const EVENT_TYPES = new Set<string>([
  "message",
  "ui_event",
  "file",
  "connected",
  "disconnected",
]);

/**
 * Narrow an untrusted value from the bridge into an `AzulaEvent`.
 *
 * Deliberately strict about the fields each variant needs, and deliberately
 * silent (returns `null`) rather than throwing: a single malformed event must
 * not take down a long-running inbound pump, and a bridge newer than this
 * plugin may emit a `type` we have never heard of. The caller logs and skips.
 */
export function parseAzulaEvent(value: unknown): AzulaEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;

  const type = raw["type"];
  const device = raw["device"];
  if (typeof type !== "string" || !EVENT_TYPES.has(type)) return null;
  if (typeof device !== "string" || device.length === 0) return null;

  switch (type) {
    case "message": {
      const text = raw["text"];
      // Empty text is legitimate; a missing or non-string one is not.
      return typeof text === "string" ? { type, device, text } : null;
    }
    case "ui_event": {
      // The payload is passed through verbatim — its shape is A2UI's, not
      // ours, and re-validating it here would only risk dropping fields the
      // surface author cares about.
      if (!("event" in raw)) return null;
      return { type, device, event: raw["event"] };
    }
    case "file": {
      const name = raw["name"];
      const mime = raw["mime"];
      const size = raw["size"];
      const path = raw["path"];
      if (
        typeof name !== "string" ||
        typeof mime !== "string" ||
        typeof size !== "number" ||
        typeof path !== "string"
      ) {
        return null;
      }
      const caption = raw["caption"];
      return typeof caption === "string"
        ? { type, device, name, mime, size, path, caption }
        : { type, device, name, mime, size, path };
    }
    case "connected":
    case "disconnected":
      return { type, device };
    default:
      return null;
  }
}

/** Parse a `get_events` result body: a JSON array of events. */
export function parseAzulaEvents(json: string): {
  events: AzulaEvent[];
  skipped: number;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { events: [], skipped: 0 };
  }
  if (!Array.isArray(parsed)) return { events: [], skipped: 0 };

  const events: AzulaEvent[] = [];
  let skipped = 0;
  for (const item of parsed) {
    const event = parseAzulaEvent(item);
    if (event) events.push(event);
    else skipped += 1;
  }
  return { events, skipped };
}
