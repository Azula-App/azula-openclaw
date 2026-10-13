import { describe, expect, it } from "vitest";
import type { MessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import {
  adaptForAzula,
  AZULA_PRESENTATION_CAPABILITIES,
  buildControlsSurface,
  conservativeCommandText,
  formatLocation,
  hasAnswerableControls,
  MAX_SURFACE_BUTTONS,
} from "./rich.js";
import { choiceFromEvent } from "./surfaces.js";

type Any = Record<string, any>;

const surfaceFor = (presentation: MessagePresentation) => buildControlsSurface(adaptForAzula(presentation));
const byId = (components: unknown[], id: string) =>
  (components as Any[]).find((c) => c.id === id) as Any;
const buttons = (components: unknown[]) =>
  (components as Any[]).filter((c) => c.component === "Button");
const labelOf = (components: unknown[], button: Any) => byId(components, button.child)["text"];

describe("buildControlsSurface", () => {
  it("makes a surface a render_ui call accepts: one root, flat, children by id", () => {
    const surface = surfaceFor({
      blocks: [{ type: "buttons", buttons: [{ label: "Yes", value: "y" }] }],
    })!;
    const components = surface.components as Any[];
    expect(components.filter((c) => c.id === "root")).toHaveLength(1);
    expect(components[0]).toEqual({ id: "root", component: "Card", child: "column" });
    // Every id is unique, and every reference resolves.
    const ids = components.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of components) {
      for (const ref of [c.child, ...(c.children ?? [])].filter(Boolean)) {
        expect(ids).toContain(ref);
      }
      // Never nested component objects.
      expect(typeof c.child === "object").toBe(false);
    }
  });

  it("maps a callback button to a Button whose tap carries the callback value", () => {
    const surface = surfaceFor({
      blocks: [
        {
          type: "buttons",
          buttons: [{ label: "Approve", action: { type: "callback", value: "deploy:approve" }, style: "primary" }],
        },
      ],
    })!;
    const [button] = buttons(surface.components);
    expect(labelOf(surface.components, button!)).toBe("Approve");
    expect(button!["variant"]).toBe("primary");
    expect(button!["action"]).toEqual({
      event: { name: "choose", context: { choice: "deploy:approve" } },
    });
    expect(surface.choices).toEqual(["deploy:approve"]);
  });

  it("carries a legacy `value` as the callback", () => {
    const surface = surfaceFor({ blocks: [{ type: "buttons", buttons: [{ label: "Go", value: "go-now" }] }] })!;
    expect(surface.choices).toEqual(["go-now"]);
  });

  it("carries a command button's command string", () => {
    const surface = surfaceFor({
      blocks: [{ type: "buttons", buttons: [{ label: "Status", action: { type: "command", command: "/status" } }] }],
    })!;
    expect(surface.choices).toEqual(["/status"]);
  });

  it("answers a question with the option's label, and skips the custom-input control", () => {
    const surface = surfaceFor({
      blocks: [
        {
          type: "buttons",
          buttons: [
            { label: "Red", action: { type: "question", questionId: "q1", optionValue: "r" } },
            { label: "Other…", action: { type: "question", questionId: "q1", intent: "custom-input" } },
          ],
        },
      ],
    })!;
    expect(surface.choices).toEqual(["Red"]);
  });

  describe("a hidden answer never runs a command", () => {
    const presentationOf = (...buttons: Array<{ label: string; action: Any }>) =>
      ({ blocks: [{ type: "buttons", buttons }] }) as MessagePresentation;
    const callback = (label: string, value: string) => ({ label, action: { type: "callback", value } });
    const choicesOf = (presentation: MessagePresentation, detector?: (text: string) => boolean) =>
      (detector ? buildControlsSurface(presentation, detector) : buildControlsSurface(presentation))?.choices ?? [];

    it("does not mint a callback that is a slash command", () => {
      expect(choicesOf(presentationOf(callback("Show more", "/reset")))).toEqual([]);
    });

    it("does not mint a callback that is the ! host-shell shortcut", () => {
      expect(choicesOf(presentationOf(callback("List files", "!ls")))).toEqual([]);
      expect(choicesOf(presentationOf(callback("List files", "! ls -la")))).toEqual([]);
    });

    it("does not mint a callback that is a bare abort word", () => {
      expect(choicesOf(presentationOf(callback("Cancel", "stop")))).toEqual([]);
      expect(choicesOf(presentationOf(callback("Cancel", "Stop.")))).toEqual([]);
      expect(choicesOf(presentationOf(callback("Cancel", "abort")))).toEqual([]);
    });

    it("does not mint a callback with a command token inside it", () => {
      expect(choicesOf(presentationOf(callback("More", "show me /status")))).toEqual([]);
    });

    it("judges the value after trimming, as the gateway does", () => {
      expect(choicesOf(presentationOf(callback("A", "  /new"), callback("B", "\n!pwd")))).toEqual([]);
    });

    it("does not mint a legacy value, a select option or a question label that is a command", () => {
      expect(choicesOf({ blocks: [{ type: "buttons", buttons: [{ label: "A", value: "/reset" }] }] })).toEqual([]);
      expect(
        choicesOf({
          blocks: [
            {
              type: "select",
              options: [
                { label: "Hidden", value: "!reboot" },
                { label: "Fine", value: "elevated" },
              ],
            },
          ],
        }),
      ).toEqual(["elevated"]);
      expect(
        choicesOf(
          presentationOf({
            label: "stop",
            action: { type: "question", questionId: "q1", optionValue: "x" },
          }),
        ),
      ).toEqual([]);
    });

    it("mints a button labelled Stop when its hidden value is benign", () => {
      const surface = buildControlsSurface(presentationOf(callback("Stop", "job:cancel")))!;
      expect(surface.choices).toEqual(["job:cancel"]);
      expect(labelOf(surface.components, buttons(surface.components)[0]!)).toBe("Stop");
    });

    it("mints a command button, since its command is shown in the message text", () => {
      expect(
        choicesOf(presentationOf({ label: "Status", action: { type: "command", command: "/status" } })),
      ).toEqual(["/status"]);
      expect(
        choicesOf(presentationOf({ label: "Run", action: { type: "command", command: "! ls" } })),
      ).toEqual(["! ls"]);
    });

    it("mints an ordinary callback, including one with a slash inside it", () => {
      expect(
        choicesOf(
          presentationOf(callback("Go", "deploy:approve"), callback("Path", "open/src/main"), callback("More", "more")),
        ),
      ).toEqual(["deploy:approve", "open/src/main", "more"]);
    });

    it("mints the rest of a block when only some of its buttons are flagged", () => {
      const surface = buildControlsSurface(
        presentationOf(callback("Hidden", "/reset"), callback("Shown", "shown")),
      )!;
      expect(surface.choices).toEqual(["shown"]);
      expect(buttons(surface.components)).toHaveLength(1);
    });

    it("defers to the detector it is given, in place of the conservative one", () => {
      const detector = (text: string) => text === "dangerous";
      expect(choicesOf(presentationOf(callback("A", "dangerous"), callback("B", "/looks-scary")), detector)).toEqual([
        "/looks-scary",
      ]);
    });

    it("never asks the detector about a command action", () => {
      const asked: string[] = [];
      choicesOf(presentationOf({ label: "S", action: { type: "command", command: "/status" } }), (t) => {
        asked.push(t);
        return true;
      });
      expect(asked).toEqual([]);
    });
  });

  describe("conservativeCommandText", () => {
    it.each(["/reset", "  /new", "!ls", "! ls", "\n!pwd", "hey /status", "do !ls now", "stop", "Stop", "STOP.", "please stop", "esc", "abort", "halt"])(
      "flags %j",
      (text) => expect(conservativeCommandText(text)).toBe(true),
    );

    it.each(["deploy:approve", "more", "job:cancel", "open/src/main", "yes", "Stop sign", "stopwatch", "a! b", "red"])(
      "passes %j",
      (text) => expect(conservativeCommandText(text)).toBe(false),
    );
  });

  it("does not mint links, approvals or disabled buttons", () => {
    const presentation: MessagePresentation = {
      blocks: [
        {
          type: "buttons",
          buttons: [
            { label: "Docs", action: { type: "url", url: "https://example.com" } },
            { label: "App", action: { type: "web-app", url: "https://example.com/app" } },
            { label: "Allow", action: { type: "approval", approvalId: "abcd1234", approvalKind: "exec", decision: "allow-once" } },
            { label: "Off", value: "off", disabled: true },
          ],
        },
      ],
    };
    expect(hasAnswerableControls(presentation)).toBe(false);
    expect(buildControlsSurface(presentation)).toBeNull();
  });

  it("does not mint a model-picker action", () => {
    const presentation: MessagePresentation = {
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Models",
              action: { type: "model-picker", view: "providers" } as never,
            },
          ],
        },
      ],
    };
    expect(buildControlsSurface(presentation)).toBeNull();
  });

  it("returns no surface when there are no controls at all", () => {
    expect(buildControlsSurface({ title: "Hi", blocks: [{ type: "text", text: "just text" }] })).toBeNull();
  });

  it("makes a select a Column of Buttons under its placeholder", () => {
    const surface = surfaceFor({
      blocks: [
        {
          type: "select",
          placeholder: "Environment",
          options: [
            { label: "Canary", value: "env:canary" },
            { label: "Production", action: { type: "command", command: "/deploy prod" } },
          ],
        },
      ],
    })!;
    const group = (surface.components as Any[]).find((c) => c.component === "Column" && c.id.startsWith("group"))!;
    expect(group["children"]).toHaveLength(3);
    expect(byId(surface.components, group["children"][0])["text"]).toBe("Environment");
    expect(surface.choices).toEqual(["env:canary", "/deploy prod"]);
  });

  it("puts the title on top as a heading", () => {
    const surface = surfaceFor({
      title: "Deploy approval",
      blocks: [{ type: "buttons", buttons: [{ label: "Go", value: "go" }] }],
    })!;
    const column = byId(surface.components, "column");
    const first = byId(surface.components, column["children"][0]);
    expect(first).toMatchObject({ component: "Text", text: "Deploy approval", variant: "h2" });
  });

  it("keeps what sits between controls (text, context, divider), and leaves the rest to the message", () => {
    const surface = surfaceFor({
      blocks: [
        { type: "text", text: "LEADING" },
        { type: "buttons", buttons: [{ label: "One", value: "1" }] },
        { type: "text", text: "between body" },
        { type: "context", text: "between caption" },
        { type: "divider" },
        { type: "buttons", buttons: [{ label: "Two", value: "2" }] },
        { type: "text", text: "TRAILING" },
      ],
    })!;
    const texts = (surface.components as Any[]).filter((c) => c.component === "Text").map((c) => c["text"]);
    expect(texts).toContain("between body");
    expect(texts).toContain("between caption");
    expect(texts).not.toContain("LEADING");
    expect(texts).not.toContain("TRAILING");
    const caption = (surface.components as Any[]).find((c) => c["text"] === "between caption");
    expect(caption).toMatchObject({ component: "Text", variant: "caption" });
    const body = (surface.components as Any[]).find((c) => c["text"] === "between body");
    expect(body).not.toHaveProperty("variant");
    expect((surface.components as Any[]).some((c) => c.component === "Divider")).toBe(true);
  });

  it("flattens tables and charts to text before the surface, so none is built from data", () => {
    const adapted = adaptForAzula({
      blocks: [
        { type: "table", caption: "T", headers: ["A"], rows: [["1"]] },
        { type: "buttons", buttons: [{ label: "Go", value: "go" }] },
      ],
    });
    expect(adapted.blocks.some((b) => b.type === "table")).toBe(false);
    const surface = buildControlsSurface(adapted)!;
    // The flattened table preceded the first control, so it is message content.
    expect(JSON.stringify(surface.components)).not.toContain("(table)");
  });

  it("styles primary and success as the primary variant, everything else as default", () => {
    const surface = surfaceFor({
      blocks: [
        {
          type: "buttons",
          buttons: [
            { label: "A", value: "a", style: "primary" },
            { label: "B", value: "b", style: "success" },
            { label: "C", value: "c", style: "danger" },
            { label: "D", value: "d" },
          ],
        },
      ],
    })!;
    expect(buttons(surface.components).map((b) => b["variant"])).toEqual([
      "primary",
      "primary",
      "default",
      "default",
    ]);
  });

  it("round-trips every button's answer through the inbound choice path", () => {
    const surface = surfaceFor({
      blocks: [
        {
          type: "buttons",
          buttons: [
            { label: "A", value: "a" },
            { label: "B", action: { type: "command", command: "/b now" } },
          ],
        },
        { type: "select", options: [{ label: "C", value: "c with spaces & symbols" }] },
      ],
    })!;
    const answered = buttons(surface.components).map((button) =>
      choiceFromEvent({
        version: "v0.9.1",
        action: {
          name: button["action"].event.name,
          surfaceId: "openclaw-x",
          sourceComponentId: button["id"],
          context: button["action"].event.context,
        },
      }),
    );
    expect(answered).toEqual(["a", "/b now", "c with spaces & symbols"]);
  });

  it(`never puts more than ${MAX_SURFACE_BUTTONS} buttons on one surface`, () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ label: `B${i}`, value: `v${i}` }));
    // Hand it an adapted presentation that skipped core's own (smaller) limits.
    const surface = buildControlsSurface({
      blocks: [
        { type: "buttons", buttons: many.slice(0, 20) },
        { type: "select", options: many.slice(20) },
      ],
    })!;
    expect(buttons(surface.components)).toHaveLength(MAX_SURFACE_BUTTONS);
  });
});

describe("what core does with this channel's declared capabilities", () => {
  it("flattens tables and charts to text, because they are not declared", () => {
    const adapted = adaptForAzula({
      blocks: [
        { type: "table", caption: "Fares", headers: ["From", "To"], rows: [["A", "B"]] },
        { type: "chart", chartType: "pie", title: "Share", segments: [{ label: "x", value: 1 }] },
      ],
    });
    expect(adapted.blocks.map((b) => b.type)).toEqual(["context", "context"]);
  });

  it("clips a long label and drops a control whose value is too large, leaving them in text", () => {
    const adapted = adaptForAzula({
      blocks: [
        {
          type: "buttons",
          buttons: [
            { label: "L".repeat(100), value: "ok" },
            { label: "Huge", value: "v".repeat(600) },
          ],
        },
      ],
    });
    const kept = adapted.blocks.flatMap((b) => (b.type === "buttons" ? b.buttons : []));
    expect(kept).toHaveLength(1);
    expect(kept[0]!.label).toHaveLength(AZULA_PRESENTATION_CAPABILITIES.limits!.actions!.maxLabelLength!);
    // The dropped control is still named, as context text.
    expect(JSON.stringify(adapted.blocks)).toContain("Huge");
  });

  it("caps the controls per message and lists the rest", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ label: `B${i}`, value: `v${i}` }));
    const adapted = adaptForAzula({ blocks: [{ type: "buttons", buttons: many }] });
    const kept = adapted.blocks.flatMap((b) => (b.type === "buttons" ? b.buttons : []));
    expect(kept).toHaveLength(12);
    expect(JSON.stringify(adapted.blocks)).toContain("B19");
  });

  it("demotes a disabled button to text", () => {
    const adapted = adaptForAzula({
      blocks: [{ type: "buttons", buttons: [{ label: "Off", value: "off", disabled: true }] }],
    });
    expect(adapted.blocks.some((b) => b.type === "buttons")).toBe(false);
    expect(JSON.stringify(adapted.blocks)).toContain("Off");
  });
});

describe("formatLocation", () => {
  it("names the place when it has one", () => {
    expect(formatLocation({ latitude: 37.84, longitude: -122.25, name: "Rockridge", address: "Oakland, CA" })).toBe(
      "Location: Rockridge, Oakland, CA (37.84, -122.25)",
    );
  });

  it("falls back to coordinates", () => {
    expect(formatLocation({ latitude: 1, longitude: 2 })).toBe("Location: 1, 2");
  });
});
