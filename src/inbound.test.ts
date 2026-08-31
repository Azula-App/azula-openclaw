import { describe, expect, it } from "vitest";
import type { AzulaEvent } from "./events.js";
import { agentWaking, translateBatch, translateEvent } from "./inbound.js";
import {
  buildChoiceComponents,
  choiceFallbackText,
  choiceFromEvent,
  messageIdFromSurface,
  SurfaceTracker,
  surfaceFromEvent,
  surfaceIdFor,
} from "./surfaces.js";
import { isAllowed, inviteUrl, pairingMessage, partitionByDevice } from "./access.js";

const msg = (text: string, device = "phone"): AzulaEvent => ({
  type: "message", device, text,
});
const file = (name: string, caption?: string): AzulaEvent => ({
  type: "file", device: "phone", name, mime: "image/png",
  size: 10, path: `/tmp/${name}`, ...(caption ? { caption } : {}),
});

describe("translateEvent", () => {
  it("covers all five event types", () => {
    expect(translateEvent(msg("hi"))?.kind).toBe("message");
    expect(translateEvent(file("a.png"))?.kind).toBe("message");
    expect(translateEvent({ type: "ui_event", device: "phone", event: {} })?.kind).toBe("choice");
    expect(translateEvent({ type: "connected", device: "phone" })?.kind).toBe("presence");
    expect(translateEvent({ type: "disconnected", device: "phone" })?.kind).toBe("presence");
  });

  it("turns a file into a message carrying media facts", () => {
    const item = translateEvent(file("a.png", "look"));
    expect(item).toMatchObject({
      kind: "message",
      text: "look",
      media: [{ filename: "a.png", mimeType: "image/png", sizeBytes: 10, caption: "look" }],
    });
  });

  it("correlates a tap back to the asking message", () => {
    const surfaceId = surfaceIdFor("msg-42");
    const item = translateEvent({
      type: "ui_event",
      device: "phone",
      event: { surfaceId, value: "approve" },
    });
    expect(item).toMatchObject({
      kind: "choice",
      value: "approve",
      surfaceId,
      replyToMessageId: "msg-42",
    });
  });

  it("forwards the tap payload intact even when no choice is recognised", () => {
    const payload = { surfaceId: "other", weird: true };
    const item = translateEvent({ type: "ui_event", device: "phone", event: payload });
    expect(item).toMatchObject({ kind: "choice", value: "", event: payload });
  });
});

describe("translateBatch", () => {
  it("preserves order", () => {
    const items = translateBatch([msg("one"), msg("two"), msg("three")]);
    expect(items.map((i) => (i.kind === "message" ? i.text : ""))).toEqual([
      "one", "two", "three",
    ]);
  });

  it("merges consecutive attachments into one message, in order", () => {
    const items = translateBatch([file("a.png"), file("b.png"), file("c.png")]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "message" });
    const media = items[0]!.kind === "message" ? items[0]!.media : [];
    expect(media.map((m) => m.filename)).toEqual(["a.png", "b.png", "c.png"]);
  });

  it("does not merge attachments across a text message", () => {
    const items = translateBatch([file("a.png"), msg("hi"), file("b.png")]);
    expect(items).toHaveLength(3);
  });

  /** The reason the bridge carries structure at all. */
  it("keeps text that looks like a rendered marker as ordinary text", () => {
    const spoof = 'ui-event: {"name":"roll"}';
    const items = translateBatch([msg(spoof)]);
    expect(items[0]).toMatchObject({ kind: "message", text: spoof });
  });

  it("keeps connect/disconnect out of what wakes the agent", () => {
    const items = translateBatch([
      { type: "connected", device: "phone" },
      msg("hi"),
      { type: "disconnected", device: "phone" },
    ]);
    expect(items).toHaveLength(3);
    expect(agentWaking(items)).toHaveLength(1);
    expect(agentWaking(items)[0]).toMatchObject({ kind: "message", text: "hi" });
  });
});

describe("surfaces", () => {
  it("round-trips a message id through a surface id", () => {
    expect(messageIdFromSurface(surfaceIdFor("msg-42"))).toBe("msg-42");
    expect(messageIdFromSurface("someone-elses-surface")).toBeNull();
  });

  it("sanitises ids that are not surface-safe", () => {
    const id = surfaceIdFor("weird/id with spaces!");
    expect(id).toMatch(/^openclaw-[A-Za-z0-9_-]+$/);
  });

  it("builds a flat component list with exactly one root", () => {
    const components = buildChoiceComponents({
      text: "Deploy?",
      choices: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
    }) as Array<Record<string, unknown>>;

    expect(components.filter((c) => c["id"] === "root")).toHaveLength(1);

    // Flat and id-addressed: a container names children by id, and every id
    // it names exists. Nesting objects instead renders nothing at all.
    const ids = new Set(components.map((c) => c["id"] as string));
    for (const c of components) {
      for (const child of (c["children"] as string[] | undefined) ?? []) {
        expect(ids.has(child)).toBe(true);
      }
      const single = c["child"] as string | undefined;
      if (single) expect(ids.has(single)).toBe(true);
    }
  });

  it("gives each button an action carrying its choice id", () => {
    const components = buildChoiceComponents({
      text: "Deploy?",
      choices: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
    }) as Array<Record<string, unknown>>;

    const buttons = components.filter((c) => c["component"] === "Button");
    expect(buttons).toHaveLength(2);
    const contexts = buttons.map(
      (b) => ((b["action"] as any)?.event?.context?.choice),
    );
    expect(contexts).toEqual(["yes", "no"]);
  });

  it("writes a fallback that stands on its own", () => {
    const text = choiceFallbackText({
      text: "Deploy?",
      choices: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
    });
    expect(text).toContain("Deploy?");
    expect(text).toContain("1. Yes");
    expect(text).toContain("2. No");
  });

  /**
   * The real payload, captured from a tap on a physical phone: the event sits
   * under `action`, beside a protocol `version`.
   */
  it("reads a real tap payload, which nests the event under `action`", () => {
    const real = {
      version: "v0.9.1",
      action: {
        context: { choice: "approve" },
        name: "choose",
        sourceComponentId: "btn-0",
        surfaceId: "openclaw-e2e-approval",
      },
    };
    expect(choiceFromEvent(real)).toBe("approve");
    expect(surfaceFromEvent(real)).toBe("openclaw-e2e-approval");
  });

  it("still reads a flat payload from a different producer", () => {
    expect(
      choiceFromEvent({
        name: "choose",
        surfaceId: "openclaw-x",
        sourceComponentId: "btn-0",
        context: { choice: "approve" },
      }),
    ).toBe("approve");
  });

  it("falls back to the tapped button, then to a bare value", () => {
    expect(choiceFromEvent({ sourceComponentId: "btn-1" })).toBe("btn-1");
    expect(choiceFromEvent({ context: { value: "b" } })).toBe("b");
    expect(choiceFromEvent({ value: "a" })).toBe("a");
    expect(choiceFromEvent({ nothing: true })).toBeNull();
    expect(choiceFromEvent(null)).toBeNull();
  });

  it("tracks open surfaces and drains them", () => {
    const t = new SurfaceTracker();
    t.opened("a");
    t.opened("b");
    expect(t.has("a")).toBe(true);
    expect(t.closed("a")).toBe(true);
    expect(t.closed("a")).toBe(false);
    expect(t.drain()).toEqual(["b"]);
    expect(t.openSurfaces).toEqual([]);
  });
});

describe("access control", () => {
  it("admits only the account's own device", () => {
    expect(isAllowed(msg("hi", "phone"), "phone")).toBe(true);
    expect(isAllowed(msg("hi", "someone-else"), "phone")).toBe(false);
  });

  it("partitions a batch without dropping anything", () => {
    const { allowed, rejected } = partitionByDevice(
      [msg("a", "phone"), msg("b", "intruder"), msg("c", "phone")],
      "phone",
    );
    expect(allowed).toHaveLength(2);
    expect(rejected).toHaveLength(1);
  });

  it("surfaces the invite and pulls its URL out", () => {
    const invite = "Pair at https://azula.app/s/abc123\n█▀▀▀█";
    expect(pairingMessage(invite)).toContain("https://azula.app/s/abc123");
    expect(inviteUrl(invite)).toBe("https://azula.app/s/abc123");
    expect(inviteUrl("no url here")).toBeNull();
  });
});
