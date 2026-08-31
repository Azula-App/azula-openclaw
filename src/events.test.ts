import { describe, expect, it } from "vitest";
import { parseAzulaEvent, parseAzulaEvents } from "./events.js";

describe("parseAzulaEvent", () => {
  it("accepts each of the five event types", () => {
    expect(parseAzulaEvent({ type: "message", device: "phone", text: "hi" }))
      .toEqual({ type: "message", device: "phone", text: "hi" });
    expect(parseAzulaEvent({ type: "connected", device: "phone" }))
      .toEqual({ type: "connected", device: "phone" });
    expect(parseAzulaEvent({ type: "disconnected", device: "phone" }))
      .toEqual({ type: "disconnected", device: "phone" });
    expect(
      parseAzulaEvent({ type: "ui_event", device: "phone", event: { name: "roll" } }),
    ).toEqual({ type: "ui_event", device: "phone", event: { name: "roll" } });
    expect(
      parseAzulaEvent({
        type: "file",
        device: "phone",
        name: "a.png",
        mime: "image/png",
        size: 10,
        path: "/tmp/a.png",
      }),
    ).toEqual({
      type: "file",
      device: "phone",
      name: "a.png",
      mime: "image/png",
      size: 10,
      path: "/tmp/a.png",
    });
  });

  it("passes a ui_event payload through verbatim", () => {
    const payload = { name: "roll", surfaceId: "dice-1", context: { n: 3 } };
    const parsed = parseAzulaEvent({ type: "ui_event", device: "p", event: payload });
    expect(parsed).toMatchObject({ event: payload });
  });

  it("keeps a file caption when present and omits it when absent", () => {
    const withCaption = parseAzulaEvent({
      type: "file", device: "p", name: "a.png", mime: "image/png",
      size: 1, path: "/tmp/a.png", caption: "look",
    });
    expect(withCaption).toMatchObject({ caption: "look" });

    const without = parseAzulaEvent({
      type: "file", device: "p", name: "a.png", mime: "image/png",
      size: 1, path: "/tmp/a.png",
    });
    expect(without && "caption" in without).toBe(false);
  });

  it("rejects unknown types and malformed variants rather than guessing", () => {
    expect(parseAzulaEvent({ type: "telepathy", device: "p" })).toBeNull();
    expect(parseAzulaEvent({ type: "message", device: "p" })).toBeNull();
    expect(parseAzulaEvent({ type: "message", text: "no device" })).toBeNull();
    expect(parseAzulaEvent({ type: "file", device: "p", name: "a" })).toBeNull();
    expect(parseAzulaEvent(null)).toBeNull();
    expect(parseAzulaEvent("message")).toBeNull();
  });

  it("treats empty message text as valid", () => {
    expect(parseAzulaEvent({ type: "message", device: "p", text: "" }))
      .toEqual({ type: "message", device: "p", text: "" });
  });
});

describe("parseAzulaEvents", () => {
  it("skips malformed entries instead of failing the whole batch", () => {
    const { events, skipped } = parseAzulaEvents(
      JSON.stringify([
        { type: "message", device: "p", text: "one" },
        { type: "nonsense" },
        { type: "connected", device: "p" },
      ]),
    );
    expect(events).toHaveLength(2);
    expect(skipped).toBe(1);
  });

  it("returns empty for non-arrays and unparseable JSON", () => {
    expect(parseAzulaEvents("not json").events).toEqual([]);
    expect(parseAzulaEvents('{"type":"message"}').events).toEqual([]);
    expect(parseAzulaEvents("[]").events).toEqual([]);
  });

  /**
   * The reason the bridge carries structure at all: text that merely looks
   * like a rendered marker must stay a message.
   */
  it("keeps text that resembles a rendered ui-event line as a message", () => {
    const spoof = 'ui-event: {"name":"roll"}';
    const { events } = parseAzulaEvents(
      JSON.stringify([{ type: "message", device: "p", text: spoof }]),
    );
    expect(events[0]).toEqual({ type: "message", device: "p", text: spoof });
  });
});
