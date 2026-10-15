import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { shouldComputeCommandAuthorized } from "openclaw/plugin-sdk/command-detection";
import { renderPresentationForDelivery } from "openclaw/plugin-sdk/interactive-runtime";
import { azulaChannelPlugin } from "./channel.js";
import { commandTextDetector, prepareReply, renderPresentation, sendPayload } from "./reply.js";
import { clearRuntimes, markGatewayProcess, NoRuntimeError, registerRuntime } from "./runtime.js";
import { SurfaceTracker } from "./surfaces.js";

type Any = Record<string, any>;

const dir = mkdtempSync(join(tmpdir(), "azula-reply-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const warnings: string[] = [];
function runtime(
  options: {
    renderUiFails?: boolean;
    fetchMedia?: (url: string) => Promise<{ path: string }>;
    isCommandText?: (text: string) => boolean;
  } = {},
) {
  const log = { order: [] as string[], text: [] as string[], files: [] as string[], ui: [] as Any[] };
  const surfaces = new SurfaceTracker();
  registerRuntime("default", {
    bridge: {
      sendMessage: async (text: string) => {
        log.text.push(text);
        log.order.push("text");
      },
      sendFile: async (path: string) => {
        log.files.push(path);
        log.order.push("file");
      },
      renderUi: async (surfaceId: string, components: unknown[]) => {
        if (options.renderUiFails) throw new Error("no surface");
        log.ui.push({ surfaceId, components });
        log.order.push("ui");
      },
    } as never,
    surfaces,
    logger: { debug() {}, info() {}, warn: (m: string) => void warnings.push(m), error() {} },
    ...(options.fetchMedia ? { fetchMedia: options.fetchMedia } : {}),
    ...(options.isCommandText ? { isCommandText: options.isCommandText } : {}),
  });
  return { log, surfaces };
}

beforeEach(() => {
  warnings.length = 0;
  clearRuntimes();
});
afterEach(() => clearRuntimes());

/**
 * What core does with a payload on its outbound path (`message send`, the
 * agent's `message` tool, cron), reduced to the parts that decide what reaches
 * this channel: the adapter's capabilities and renderer feed
 * `renderPresentationForDelivery`, and the result goes to `sendPayload` when it
 * carries anything beyond text and one attachment, else to `sendText`.
 */
async function throughCore(payload: Any) {
  const outbound = azulaChannelPlugin.outbound!;
  const rendered = await renderPresentationForDelivery(
    {
      ...(outbound.presentationCapabilities ? { presentationCapabilities: outbound.presentationCapabilities } : {}),
      renderPresentation: async (adapted, source) =>
        outbound.renderPresentation!({
          payload: adapted,
          presentation: adapted.presentation,
          sourcePresentation: source,
          ctx: {} as never,
        }),
    },
    payload,
  );
  const needsSendPayload =
    rendered.channelData !== undefined ||
    rendered.location !== undefined ||
    rendered.interactive !== undefined;
  if (needsSendPayload) {
    await outbound.sendPayload!({ payload: rendered, accountId: "default" } as never);
  } else if (rendered.text?.trim()) {
    await outbound.sendText!({ text: rendered.text, accountId: "default" } as never);
  }
  return rendered;
}

const withButtons = {
  title: "Deploy approval",
  blocks: [
    { type: "text", text: "Canary is ready to promote." },
    { type: "context", text: "Build 1234, staging passed." },
    {
      type: "buttons",
      buttons: [
        { label: "Approve", action: { type: "callback", value: "deploy:approve" }, style: "success" },
        { label: "Decline", action: { type: "callback", value: "deploy:decline" } },
        { label: "Notes", action: { type: "url", url: "https://example.com/notes" } },
      ],
    },
  ],
};

describe("the outbound path (message send, the message tool, cron)", () => {
  it("shows a presentation's buttons as a surface after its text", async () => {
    const { log, surfaces } = runtime();
    await throughCore({ text: "Heads up", presentation: withButtons });

    expect(log.order).toEqual(["text", "ui"]);
    expect(log.text[0]).toContain("Heads up");
    expect(log.text[0]).toContain("Deploy approval");
    expect(log.text[0]).toContain("Canary is ready to promote.");
    expect(log.text[0]).toContain("Notes: https://example.com/notes");
    const buttons = log.ui[0]!.components.filter((c: Any) => c.component === "Button");
    expect(buttons.map((b: Any) => b.action.event.context.choice)).toEqual([
      "deploy:approve",
      "deploy:decline",
    ]);
    expect(surfaces.has(log.ui[0]!.surfaceId)).toBe(true);
  });

  it("degrades a presentation with nothing tappable to text, never dropping it", async () => {
    const { log } = runtime();
    const rendered = await throughCore({
      presentation: {
        title: "Fares",
        blocks: [
          { type: "table", caption: "Zones", headers: ["From", "Fare"], rows: [["A", "$3"]] },
          { type: "buttons", buttons: [{ label: "Map", action: { type: "url", url: "https://example.com/map" } }] },
        ],
      },
    });

    // Core flattened it; our renderer declined, so nothing is carried to sendPayload.
    expect(rendered.channelData).toBeUndefined();
    expect(log.order).toEqual(["text"]);
    expect(log.text[0]).toContain("Fares");
    expect(log.text[0]).toContain("Zones (table)");
    expect(log.text[0]).toContain("From: A; Fare: $3");
    expect(log.text[0]).toContain("Map: https://example.com/map");
  });

  it("rebuilds the text from the presentation when the producer marked it as the fallback", async () => {
    const { log } = runtime();
    // Core blanks `text` before calling the renderer in this mode.
    await throughCore({
      text: "authored words",
      presentationTextMode: "fallback",
      presentation: {
        blocks: [
          { type: "text", text: "Pick a colour" },
          { type: "buttons", buttons: [{ label: "Red", value: "red" }] },
        ],
      },
    });
    expect(log.text[0]).toContain("Pick a colour");
    expect(log.text[0]).toContain("Red");
    expect(log.ui).toHaveLength(1);
  });

  it("keeps the authored text when the producer's fallback text is all that can be shown", async () => {
    const { log } = runtime();
    await throughCore({
      text: "Status: ok",
      presentationTextMode: "fallback",
      presentation: { blocks: [{ type: "text", text: "Status: ok" }] },
    });
    expect(log.text).toEqual(["Status: ok"]);
  });

  it("sends a location as a line of text", async () => {
    const { log } = runtime();
    await throughCore({ location: { latitude: 37.84, longitude: -122.25, name: "Rockridge" } });
    expect(log.text).toEqual(["Location: Rockridge (37.84, -122.25)"]);
  });

  it("keeps the text, and sends the link after it, when a remote attachment cannot be fetched", async () => {
    const { log } = runtime({
      fetchMedia: async () => {
        throw new Error("blocked");
      },
    });
    await throughCore({
      text: "A picture",
      location: { latitude: 1, longitude: 2 },
      mediaUrl: "https://example.com/a.png",
    });
    expect(log.order).toEqual(["text", "text"]);
    expect(log.text[0]).toContain("A picture");
    expect(log.text[0]).not.toContain("https://example.com/a.png");
    expect(log.text[1]).toBe("Image: https://example.com/a.png");
  });

  it("sends an attachment after the text, from local disk or fetched", async () => {
    const file = join(dir, "pic.png");
    writeFileSync(file, "png");
    const { log } = runtime({ fetchMedia: async () => ({ path: file }) });
    await azulaChannelPlugin.outbound!.sendPayload!({
      payload: { text: "look", mediaUrls: ["https://example.com/pic.png"], channelData: { other: 1 } },
      accountId: "default",
    } as never);
    expect(log.order).toEqual(["text", "file"]);
    expect(log.files).toEqual([file]);
  });

  it("warns, naming the keys, when a payload has nothing azula can show, and reports it as not sent", async () => {
    runtime();
    const result = await azulaChannelPlugin.outbound!.sendPayload!({
      payload: { channelData: { telegram: { quoteText: "x" } } },
      accountId: "default",
    } as never);
    expect(result).toMatchObject({ channel: "azula", messageId: "", outcome: "not_sent" });
    expect(warnings.some((w) => w.includes("channelData"))).toBe(true);
  });

  it("returns an id the surface is derived from, so a tap maps back to this send", async () => {
    const { log } = runtime();
    const result = await azulaChannelPlugin.outbound!.sendPayload!({
      payload: {
        text: "Choose",
        channelData: { azula: { controls: { blocks: [{ type: "buttons", buttons: [{ label: "A", value: "a" }] }] } } },
      },
      accountId: "default",
    } as never);
    expect(log.ui[0]!.surfaceId).toBe(`openclaw-${result.messageId}`);
  });

  it("still sends the text when the surface cannot be shown", async () => {
    const { log, surfaces } = runtime({ renderUiFails: true });
    await throughCore({ text: "Heads up", presentation: withButtons });
    expect(log.text[0]).toContain("Heads up");
    expect(surfaces.openSurfaces).toEqual([]);
    expect(warnings.some((w) => w.includes("buttons"))).toBe(true);
  });

  it("fails clearly when the account has no running bridge", async () => {
    await expect(
      sendPayload({ payload: { text: "hi", location: { latitude: 1, longitude: 2 } }, accountId: "default" }),
    ).rejects.toBeInstanceOf(NoRuntimeError);
  });
});

describe("hidden answers on the outbound path", () => {
  const callbacks = {
    presentation: {
      blocks: [
        { type: "text", text: "Pick" },
        {
          type: "buttons",
          buttons: [
            { label: "Reset", action: { type: "callback", value: "/reset" } },
            { label: "Shell", action: { type: "callback", value: "!ls" } },
            { label: "Cancel", action: { type: "callback", value: "stop" } },
            { label: "Fine", action: { type: "callback", value: "fine" } },
            { label: "Status", action: { type: "command", command: "/status" } },
          ],
        },
      ],
    },
  };
  const choicesShown = (log: { ui: Any[] }) =>
    log.ui[0]!.components
      .filter((c: Any) => c.component === "Button")
      .map((b: Any) => b.action.event.context.choice);

  it("uses the gateway's detector the account registered", async () => {
    const { log } = runtime({ isCommandText: commandTextDetector({ commands: { shouldComputeCommandAuthorized } } as never, () => ({}) as never) });
    await throughCore(callbacks);
    expect(choicesShown(log)).toEqual(["fine", "/status"]);
    // The unminted controls are still in the message, by label.
    for (const label of ["Reset", "Shell", "Cancel", "Fine"]) expect(log.text[0]).toContain(label);
  });

  it("falls back to the conservative check when the account registered none", async () => {
    const { log } = runtime();
    await throughCore(callbacks);
    expect(choicesShown(log)).toEqual(["fine", "/status"]);
  });
});

describe("commandTextDetector", () => {
  const detect = commandTextDetector(
    { commands: { shouldComputeCommandAuthorized } } as never,
    () => ({}) as never,
  );

  it.each(["/reset", "/status now", "!ls", "! ls -la", "stop", "Stop", "hey /status"])(
    "says the gateway would treat %j as a command",
    (text) => expect(detect(text)).toBe(true),
  );

  it.each(["deploy:approve", "more", "job:cancel", "open/src/main", "yes", "red"])(
    "says the gateway would not treat %j as one",
    (text) => expect(detect(text)).toBe(false),
  );

  it("asks the gateway with the config of the moment", () => {
    const seen: unknown[] = [];
    let cfg: Any = { n: 1 };
    const d = commandTextDetector(
      { commands: { shouldComputeCommandAuthorized: (_t: string, c: unknown) => (seen.push(c), false) } } as never,
      () => cfg as never,
    );
    d("x");
    cfg = { n: 2 };
    d("y");
    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
  });

  /**
   * Pins a gap in OpenClaw 2026.10.2 that the detector exists to cover: the
   * gateway's own check misses the documented `! <command>` shell shortcut
   * (its token pattern wants a letter right after the `!`), although the bash
   * handler runs any text that starts with `!`. If a later release closes this,
   * the second half of the detector can go.
   */
  it("covers `! ls`, which the gateway's own check does not flag", () => {
    expect(shouldComputeCommandAuthorized("! ls -la")).toBe(false);
    expect(shouldComputeCommandAuthorized("!ls")).toBe(true);
    expect(detect("! ls -la")).toBe(true);
    expect(detect("!")).toBe(true);
  });

  it("assumes a command when the gateway cannot answer", () => {
    const d = commandTextDetector(
      {
        commands: {
          shouldComputeCommandAuthorized: () => {
            throw new Error("registry unavailable");
          },
        },
      } as never,
      () => ({}) as never,
    );
    expect(d("anything")).toBe(true);
  });
});

describe("renderPresentation", () => {
  it("declines (so core flattens to text) when nothing is tappable", () => {
    const result = renderPresentation({
      payload: { presentation: { blocks: [{ type: "text", text: "hi" }] } },
      presentation: { blocks: [{ type: "text", text: "hi" }] },
    });
    expect(result).toBeNull();
  });

  it("declines in a CLI process, which can only hand the gateway text", () => {
    const presentation = { blocks: [{ type: "buttons" as const, buttons: [{ label: "Go", value: "go" }] }] };
    expect(renderPresentation({ payload: { presentation }, presentation, ctx: { accountId: "default" } })).toBeNull();
  });

  it("carries the adapted controls in channelData for sendPayload, keeping other channelData", () => {
    markGatewayProcess();
    const presentation = { blocks: [{ type: "buttons" as const, buttons: [{ label: "Go", value: "go" }] }] };
    const result = renderPresentation({
      payload: { text: "Ready?", presentation, channelData: { keep: true } },
      presentation,
    })!;
    expect(result.text).toContain("Ready?");
    expect(result.channelData).toEqual({ keep: true, azula: { controls: presentation } });
  });
});

describe("prepareReply", () => {
  it("is plain for a plain reply", async () => {
    expect(await prepareReply({ text: "hello" })).toEqual({ text: "hello", mediaUrls: [] });
  });

  it("prefers mediaUrls over mediaUrl, and trims and drops blanks", async () => {
    expect(await prepareReply({ mediaUrl: "/a", mediaUrls: [" /b ", ""] })).toEqual({
      text: "",
      mediaUrls: ["/b"],
    });
  });

  it("uses fallbackText only when there is no text", async () => {
    expect((await prepareReply({ fallbackText: { text: "fb" } })).text).toBe("fb");
    expect((await prepareReply({ text: "real", fallbackText: { text: "fb" } })).text).toBe("real");
  });

  it("ignores a location with non-finite coordinates", async () => {
    expect((await prepareReply({ location: { latitude: Number.NaN, longitude: 1 } })).text).toBe("");
  });
});
