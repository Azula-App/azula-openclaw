import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { shouldComputeCommandAuthorized } from "openclaw/plugin-sdk/command-detection";
import { createAgentDispatch, type ChannelRuntime } from "./agent.js";
import type { ResolvedAzulaAccount } from "./accounts.js";
import type { AzulaBridge } from "./bridge.js";
import { translateEvent, type InboundChoice, type InboundMessage } from "./inbound.js";
import type { DispatchScope } from "./lifecycle.js";
import { clearRuntimes, registerRuntime } from "./runtime.js";
import { SurfaceTracker, surfaceIdFor } from "./surfaces.js";

const account: ResolvedAzulaAccount = {
  accountId: "default",
  enabled: true,
  device: "phone",
  binary: "azula",
  session: "openclaw",
  label: "OpenClaw",
};

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

const cfg = { channels: { azula: { device: "phone" } } } as unknown as OpenClawConfig;

const warnings: string[] = [];
const debugs: string[] = [];
const logger = {
  debug: (m: string) => void debugs.push(m),
  info: () => {},
  warn: (m: string) => void warnings.push(m),
  error: () => {},
};

type Any = Record<string, any>;

/** The slice of the SDK's channel runtime the dispatcher touches, recorded. */
function fakeChannel(
  overrides: {
    dispatch?: (params: Any) => Promise<Any>;
    /** What the gateway's guarded remote loader does; default: saves a file and returns its path. */
    saveRemoteMedia?: (options: Any) => Promise<Any>;
  } = {},
) {
  const calls = {
    ingress: [] as Any[],
    context: [] as Any[],
    dispatch: [] as Any[],
    saved: [] as Any[],
    remote: [] as Any[],
  };
  const channel = {
    commands: {
      isControlCommandMessage: (text: string) => text.trimStart().startsWith("/"),
      // The gateway's own detector, not a stand-in: what a hidden button answer
      // may be is decided by what the real gateway would run as a command.
      shouldComputeCommandAuthorized,
    },
    media: {
      saveRemoteMedia: async (options: Any) => {
        calls.remote.push(options);
        if (overrides.saveRemoteMedia) return overrides.saveRemoteMedia(options);
        const path = join(tempDir("azula-agent-fetched-"), `fetched-${calls.remote.length}.png`);
        writeFileSync(path, "png");
        return { id: "r1", path, size: 3 };
      },
      saveMediaBuffer: async (
        buffer: Buffer,
        contentType: string | undefined,
        subdir: string | undefined,
        _max: number | undefined,
        name: string | undefined,
      ) => {
        calls.saved.push({ size: buffer.length, contentType, subdir, name });
        return {
          id: "m1",
          path: `/state/media/${subdir}/${name}`,
          size: buffer.length,
          contentType,
        };
      },
    },
    inbound: {
      ingress: {
        resolveStable: async (params: Any) => {
          calls.ingress.push(params);
          return {
            ingress: { admission: "dispatch" },
            commandAccess: { authorized: params.command !== undefined },
          };
        },
      },
      buildContext: (params: Any) => {
        calls.context.push(params);
        return { SessionKey: params.route.dispatchSessionKey, ...params };
      },
      dispatch:
        overrides.dispatch ??
        (async (params: Any) => {
          calls.dispatch.push(params);
          return { admission: { kind: "dispatch" }, dispatched: true };
        }),
    },
  };
  return { channel: channel as unknown as ChannelRuntime, calls };
}

const sdk = {
  resolveChannelInboundRouteEnvelope: (params: Any) => ({
    route: { agentId: "main", sessionKey: `agent:main:${params.channel}:${params.peer.id}`, accountId: params.accountId },
    buildEnvelope: (input: Any) => `[${input.channel} ${input.from}] ${input.body}`,
  }),
  toInboundMediaFacts: (media: Any[] | null | undefined) => (media ?? []).map((m) => ({ ...m })),
  formatInboundMediaUnavailableText: ({ body, notice }: { body?: string | null; notice: string }) =>
    body ? `${body}\n${notice}` : notice,
} as unknown as Parameters<typeof createAgentDispatch>[0]["sdk"];

function fakeBridge(options: { renderUiFails?: boolean } = {}) {
  const log = {
    typing: [] as boolean[],
    text: [] as string[],
    files: [] as Any[],
    ui: [] as Any[],
    /** Every send, in order, so "text first" can be asserted. */
    order: [] as string[],
  };
  const bridge = {
    running: true,
    setTyping: async (on: boolean) => void log.typing.push(on),
    sendMessage: async (text: string) => {
      log.text.push(text);
      log.order.push("text");
    },
    sendFile: async (path: string, caption?: string) => {
      log.files.push({ path, caption });
      log.order.push("file");
    },
    renderUi: async (surfaceId: string, components: unknown[]) => {
      if (options.renderUiFails) throw new Error("surface rejected");
      log.ui.push({ surfaceId, components });
      log.order.push("ui");
    },
  };
  return { bridge: bridge as unknown as AzulaBridge, log };
}

function setup(
  channelOverrides: Parameters<typeof fakeChannel>[0] = {},
  bridgeOptions: Parameters<typeof fakeBridge>[0] = {},
) {
  const { channel, calls } = fakeChannel(channelOverrides);
  const { bridge, log } = fakeBridge(bridgeOptions);
  const surfaces = new SurfaceTracker();
  registerRuntime("default", { bridge, surfaces });
  const controller = new AbortController();
  const scope: DispatchScope = { bridge, surfaces, signal: controller.signal };
  const dispatch = createAgentDispatch({
    readConfig: () => cfg,
    account,
    channel,
    sdk,
    logger,
    now: () => 1_700_000_000_000,
  });
  return { dispatch, scope, calls, log, controller, surfaces };
}

const message = (text: string, media: InboundMessage["media"] = []): InboundMessage => ({
  kind: "message",
  device: "phone",
  text,
  media,
});

beforeEach(() => {
  warnings.length = 0;
  debugs.length = 0;
  clearRuntimes();
});
afterEach(() => clearRuntimes());

describe("delivering a user message to the agent", () => {
  it("arrives as a direct message from the device, on the account's own route", async () => {
    const { dispatch, scope, calls } = setup();
    await dispatch(message("hello agent"), scope);

    expect(calls.dispatch).toHaveLength(1);
    const ctx = calls.context[0]!;
    expect(ctx).toMatchObject({
      channel: "azula",
      accountId: "default",
      from: "azula:phone",
      sender: { id: "phone", name: "phone" },
      conversation: { kind: "direct", id: "phone" },
      route: { agentId: "main", routeSessionKey: "agent:main:azula:phone" },
      message: { rawBody: "hello agent", bodyForAgent: "hello agent" },
    });
    expect(ctx.message.body).toBe("[azula phone] hello agent");

    expect(calls.dispatch[0]).toMatchObject({
      channel: "azula",
      accountId: "default",
      route: { agentId: "main", sessionKey: "agent:main:azula:phone" },
    });
  });

  it("is admitted through the ingress gate as the one allowed sender", async () => {
    const { dispatch, scope, calls } = setup();
    await dispatch(message("hi"), scope);

    expect(calls.ingress[0]).toMatchObject({
      channelId: "azula",
      accountId: "default",
      subject: { stableId: "phone" },
      conversation: { kind: "direct", id: "phone" },
      dmPolicy: "allowlist",
      allowFrom: ["phone"],
    });
    // The result is passed on whole; participant evidence is never rebuilt.
    expect(calls.context[0]?.channelIngress).toMatchObject({ ingress: { admission: "dispatch" } });
  });

  it("lets the sender run a slash command, and says so to the context", async () => {
    const { dispatch, scope, calls } = setup();
    await dispatch(message("/status"), scope);

    expect(calls.ingress[0]?.command).toEqual({ allowTextCommands: true, hasControlCommand: true });
    expect(calls.context[0]?.access).toEqual({ commands: { authorized: true } });
  });

  it("does not claim command authority for ordinary text", async () => {
    const { dispatch, scope, calls } = setup();
    await dispatch(message("just chatting"), scope);
    expect(calls.ingress[0]?.command).toBeUndefined();
    expect(calls.context[0]?.access).toEqual({ commands: { authorized: false } });
  });

  it("gives a tap to the agent as the user's answer, tied to the question", async () => {
    const { dispatch, scope, calls } = setup();
    const tap: InboundChoice = {
      kind: "choice",
      device: "phone",
      value: "approve",
      replyToMessageId: "azula-123-1",
      surfaceId: "openclaw-azula-123-1",
      event: {},
    };
    await dispatch(tap, scope);

    expect(calls.context[0]).toMatchObject({
      message: { rawBody: "approve", bodyForAgent: "approve" },
      reply: { replyToId: "azula-123-1" },
    });
  });

  it("gives every message its own id", async () => {
    const { dispatch, scope, calls } = setup();
    await dispatch(message("one"), scope);
    await dispatch(message("two"), scope);
    expect(calls.context[0]?.messageId).not.toBe(calls.context[1]?.messageId);
  });

  it("skips an item with nothing in it", async () => {
    const { dispatch, scope, calls } = setup();
    await dispatch(message("   "), scope);
    expect(calls.dispatch).toHaveLength(0);
  });

  it("stops if the gateway declines the sender", async () => {
    const { channel, calls } = fakeChannel();
    (channel.inbound.ingress as Any)["resolveStable"] = async () => ({
      ingress: { admission: "drop" },
      commandAccess: { authorized: false },
    });
    const { bridge } = fakeBridge();
    const surfaces = new SurfaceTracker();
    const dispatch = createAgentDispatch({ readConfig: () => cfg, account, channel, sdk, logger });
    await dispatch(message("hi"), { bridge, surfaces, signal: new AbortController().signal });

    expect(calls.dispatch).toHaveLength(0);
    expect(warnings.some((w) => w.includes("declined"))).toBe(true);
  });

  /** Routing and bindings change while an account runs; each turn must see them. */
  it("reads the gateway's config afresh for every turn", async () => {
    const first = { channels: { azula: { device: "phone" } }, marker: 1 } as unknown as OpenClawConfig;
    const second = { channels: { azula: { device: "phone" } }, marker: 2 } as unknown as OpenClawConfig;
    let current = first;
    const { channel, calls } = fakeChannel();
    const { bridge } = fakeBridge();
    const surfaces = new SurfaceTracker();
    const dispatch = createAgentDispatch({ readConfig: () => current, account, channel, sdk, logger });
    const scope = { bridge, surfaces, signal: new AbortController().signal };

    await dispatch(message("one"), scope);
    current = second;
    await dispatch(message("two"), scope);

    expect(calls.dispatch.map((d) => d.cfg)).toEqual([first, second]);
    expect(calls.ingress.map((i) => i.cfg)).toEqual([first, second]);
  });

  it("ties the agent turn to the account's lifetime", async () => {
    const { dispatch, scope, calls, controller } = setup();
    await dispatch(message("hi"), scope);
    expect(calls.dispatch[0]?.replyOptions.abortSignal).toBe(controller.signal);
  });
});

describe("attachments", () => {
  function azulaFile(content = "bytes") {
    const dir = tempDir("azula-agent-test-");
    const path = join(dir, "photo.png");
    writeFileSync(path, content);
    return path;
  }

  /**
   * The gateway refuses inbound attachments outside its media roots, so the
   * file is copied into its media store and the agent is given *that* path.
   */
  it("copies a received file into the media store and hands over the stored path", async () => {
    const { dispatch, scope, calls } = setup();
    const path = azulaFile("12345");
    await dispatch(
      message("look at this", [
        { path, filename: "photo.png", mimeType: "image/png", sizeBytes: 5 },
      ]),
      scope,
    );

    expect(calls.saved).toEqual([
      { size: 5, contentType: "image/png", subdir: "inbound", name: "photo.png" },
    ]);
    const media = calls.context[0]?.media;
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({
      path: "/state/media/inbound/photo.png",
      contentType: "image/png",
      fileName: "photo.png",
    });
    // Not the path azula reported.
    expect(media[0].path).not.toBe(path);
    expect(calls.context[0]?.message.rawBody).toBe("look at this");
  });

  it("keeps attachments in the order they arrived", async () => {
    const { dispatch, scope, calls } = setup();
    const a = azulaFile("a");
    const b = azulaFile("b");
    await dispatch(
      message("", [
        { path: a, filename: "first.png", mimeType: "image/png", sizeBytes: 1 },
        { path: b, filename: "second.png", mimeType: "image/png", sizeBytes: 1 },
      ]),
      scope,
    );
    expect(calls.context[0]?.media.map((m: Any) => m.fileName)).toEqual(["first.png", "second.png"]);
  });

  it("delivers a file with no caption", async () => {
    const { dispatch, scope, calls } = setup();
    await dispatch(
      message("", [{ path: azulaFile(), filename: "photo.png", mimeType: "image/png", sizeBytes: 5 }]),
      scope,
    );
    expect(calls.dispatch).toHaveLength(1);
    expect(calls.context[0]?.message.rawBody).toBe("");
  });

  it("still delivers the message when one attachment cannot be read, and says so", async () => {
    const { dispatch, scope, calls } = setup();
    await dispatch(
      message("see attached", [
        { path: "/nonexistent/azula/photo.png", filename: "photo.png", mimeType: "image/png", sizeBytes: 5 },
      ]),
      scope,
    );

    expect(calls.dispatch).toHaveLength(1);
    expect(calls.context[0]?.media).toBeUndefined();
    expect(calls.context[0]?.message.bodyForAgent).toContain("see attached");
    expect(calls.context[0]?.message.bodyForAgent).toContain("photo.png");
    expect(calls.context[0]?.message.bodyForAgent).toContain("could not be read");
    expect(warnings.some((w) => w.includes("could not stage"))).toBe(true);
  });
});

describe("replies", () => {
  /** Run a dispatch whose fake pipeline delivers the given payloads. */
  function replying(...payloads: Array<[Any, string?]>) {
    return setup({
      dispatch: async (params) => {
        for (const [payload, kind] of payloads) {
          await params.delivery.deliver(payload, { kind: kind ?? "final" });
        }
        return { admission: { kind: "dispatch" }, dispatched: true };
      },
    });
  }

  it("go back to the same device through this channel's own outbound", async () => {
    const { dispatch, scope, log } = replying([{ text: "two plus two is four" }]);
    await dispatch(message("what is 2+2?"), scope);
    expect(log.text).toEqual(["two plus two is four"]);
  });

  it("sends each block of a streamed reply, in order", async () => {
    const { dispatch, scope, log } = replying(
      [{ text: "first" }, "block"],
      [{ text: "second" }, "block"],
      [{ text: "done" }],
    );
    await dispatch(message("go"), scope);
    expect(log.text).toEqual(["first", "second", "done"]);
  });

  it("sends the text first as its own message, then the attachment", async () => {
    const dir = tempDir("azula-agent-reply-");
    const path = join(dir, "chart.png");
    writeFileSync(path, "png");
    const { dispatch, scope, log } = replying([{ text: "here you go", mediaUrl: path }]);
    await dispatch(message("chart please"), scope);

    expect(log.text).toEqual(["here you go"]);
    expect(log.files).toEqual([{ path, caption: undefined }]);
    expect(log.order).toEqual(["text", "file"]);
  });

  it("sends several attachments after the text, in order", async () => {
    const dir = tempDir("azula-agent-reply-");
    const one = join(dir, "one.png");
    const two = join(dir, "two.png");
    writeFileSync(one, "1");
    writeFileSync(two, "2");
    const { dispatch, scope, log } = replying([{ text: "both", mediaUrls: [one, two] }]);
    await dispatch(message("pics"), scope);
    expect(log.order).toEqual(["text", "file", "file"]);
    expect(log.files.map((f) => f.path)).toEqual([one, two]);
  });

  it("does not send the agent's reasoning to the phone", async () => {
    const { dispatch, scope, log } = replying([{ text: "thinking about it", isReasoning: true }], [
      { text: "answer" },
    ]);
    await dispatch(message("q"), scope);
    expect(log.text).toEqual(["answer"]);
  });

  it("sends nothing for a reply with no content, and says so at debug, not warn", async () => {
    const { dispatch, scope, log } = replying([{ text: "  " }], [{}]);
    await dispatch(message("q"), scope);
    expect(log.text).toEqual([]);
    expect(log.order).toEqual([]);
    expect(debugs.filter((d) => d.includes("empty reply"))).toHaveLength(2);
    expect(warnings).toEqual([]);
  });

  it("warns, naming the payload's keys, when a reply has content azula cannot show", async () => {
    const { dispatch, scope, log } = replying([{ channelData: { someChannel: { x: 1 } } }]);
    await dispatch(message("q"), scope);
    expect(log.order).toEqual([]);
    const warning = warnings.find((w) => w.includes("nothing azula can show"));
    expect(warning).toBeDefined();
    expect(warning).toContain("channelData");
    // Names, never content.
    expect(warning).not.toContain("someChannel");
  });
});

/**
 * The reply that was lost: a streamed block whose text rode as the caption of a
 * remote image. The attachment failed ("not a local path") and took the whole
 * answer with it.
 */
describe("a reply with a remote image", () => {
  const ROCKRIDGE =
    "https://www.bart.gov/sites/default/files/styles/station_intro_image/public/2024-08/Rockridge%20Station.png?itok=T-N3IK5w";
  const TEXT = "Rockridge is a leafy Oakland neighborhood around College Avenue, served by BART.";

  function replyingWith(
    payload: Any,
    kind: string,
    channelOverrides: Parameters<typeof fakeChannel>[0] = {},
  ) {
    return setup({
      ...channelOverrides,
      dispatch: async (params) => {
        await params.delivery.deliver(payload, { kind });
        return { admission: { kind: "dispatch" }, dispatched: true };
      },
    });
  }

  for (const kind of ["block", "final"]) {
    it(`sends the text first, then the fetched image (${kind} reply)`, async () => {
      const { dispatch, scope, log, calls } = replyingWith(
        { text: TEXT, mediaUrl: ROCKRIDGE },
        kind,
      );
      await dispatch(message("tell me about rockridge"), scope);

      expect(log.text).toEqual([TEXT]);
      expect(log.files).toHaveLength(1);
      expect(log.files[0]!.path).toMatch(/fetched-1\.png$/);
      expect(log.files[0]!.caption).toBeUndefined();
      expect(log.order).toEqual(["text", "file"]);
      expect(warnings).toEqual([]);

      // Fetched through the gateway's guarded loader, capped at azula's limit,
      // with the URL (query string and all) passed through untouched.
      expect(calls.remote).toHaveLength(1);
      expect(calls.remote[0]).toMatchObject({
        url: ROCKRIDGE,
        maxBytes: 64 * 1024 * 1024,
        subdir: "outbound",
        originalFilename: "Rockridge Station.png",
      });
    });
  }

  /**
   * The text must not wait on the image. The fetch here only finishes when the
   * test says so, after it has checked the text is already on the phone.
   */
  it("sends the text before any fetch resolves, then the image once it does", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { dispatch, scope, log, calls } = replyingWith({ text: TEXT, mediaUrl: ROCKRIDGE }, "block", {
      saveRemoteMedia: async () => {
        await gate;
        const path = join(tempDir("azula-agent-fetched-"), "rockridge.png");
        writeFileSync(path, "png");
        return { path };
      },
    });

    const done = dispatch(message("tell me about rockridge"), scope);
    await vi.waitFor(() => expect(log.text).toEqual([TEXT]));
    // The fetch has started (it runs alongside the text) but has not finished.
    expect(calls.remote).toHaveLength(1);
    expect(log.files).toEqual([]);

    release();
    await done;
    expect(log.order).toEqual(["text", "file"]);
    expect(log.files[0]!.path).toMatch(/rockridge\.png$/);
  });

  it("sends the text first, and the link as a message of its own, when the image cannot be fetched", async () => {
    const { dispatch, scope, log } = replyingWith({ text: TEXT, mediaUrl: ROCKRIDGE }, "block", {
      saveRemoteMedia: async () => {
        throw new Error("blocked: private address");
      },
    });
    await dispatch(message("tell me about rockridge"), scope);

    // The text is exactly the agent's, with nothing appended.
    expect(log.text).toEqual([TEXT, `Image: ${ROCKRIDGE}`]);
    expect(log.files).toEqual([]);
    expect(warnings.some((w) => w.includes("blocked: private address"))).toBe(true);
    // The reply did not fail: the pipeline's error hook is never reached.
    expect(warnings.some((w) => w.includes("delivering a"))).toBe(false);
  });

  it("labels a link that is not a picture as an attachment", async () => {
    const { dispatch, scope, log } = replyingWith(
      { text: "The schedule", mediaUrl: "https://example.com/schedule.pdf" },
      "final",
      {
        saveRemoteMedia: async () => {
          throw new Error("404");
        },
      },
    );
    await dispatch(message("go"), scope);
    expect(log.text).toEqual(["The schedule", "Attachment: https://example.com/schedule.pdf"]);
  });

  it("fetches several images together but delivers them in the order given", async () => {
    const gates = new Map<string, () => void>();
    const gated = new Map<string, Promise<void>>();
    for (const name of ["first", "second", "third"]) {
      gated.set(
        name,
        new Promise<void>((resolve) => {
          gates.set(name, resolve);
        }),
      );
    }
    const { dispatch, scope, log, calls } = replyingWith(
      {
        text: TEXT,
        mediaUrls: [
          "https://example.com/first.png",
          "https://example.com/second.png",
          "https://example.com/third.png",
        ],
      },
      "block",
      {
        saveRemoteMedia: async (options) => {
          const name = new URL(options.url).pathname.slice(1).replace(".png", "");
          await gated.get(name);
          if (name === "second") throw new Error("404");
          const path = join(tempDir("azula-agent-fetched-"), `${name}.png`);
          writeFileSync(path, "png");
          return { path };
        },
      },
    );

    const done = dispatch(message("go"), scope);
    await vi.waitFor(() => expect(log.text).toEqual([TEXT]));
    // All three are in flight at once.
    await vi.waitFor(() => expect(calls.remote).toHaveLength(3));

    // They finish out of order: third, then second (which fails), then first.
    gates.get("third")!();
    gates.get("second")!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Nothing is sent ahead of the first, whichever fetch finished first.
    expect(log.order).toEqual(["text"]);

    gates.get("first")!();
    await done;
    expect(log.order).toEqual(["text", "file", "text", "file"]);
    expect(log.files[0]!.path).toMatch(/first\.png$/);
    expect(log.text[1]).toBe("Image: https://example.com/second.png");
    expect(log.files[1]!.path).toMatch(/third\.png$/);
  });

  it("sends an image with no text on its own", async () => {
    const { dispatch, scope, log } = replyingWith({ mediaUrl: ROCKRIDGE }, "final");
    await dispatch(message("go"), scope);
    expect(log.order).toEqual(["file"]);
  });

  it("keeps the text when a local attachment cannot be sent, and tells the phone", async () => {
    const { dispatch, scope, log } = replyingWith(
      { text: "see attached", mediaUrl: "/nonexistent/azula/photo.png" },
      "final",
    );
    await dispatch(message("go"), scope);

    expect(log.text[0]).toBe("see attached");
    expect(log.files).toEqual([]);
    expect(log.text[1]).toContain("Could not send an attachment");
    expect(log.text[1]).toContain("photo.png");
    expect(warnings.some((w) => w.includes("photo.png"))).toBe(true);
  });

  it("refuses an unsupported reference (a data URI) without losing the text", async () => {
    const { dispatch, scope, log } = replyingWith(
      { text: "inline picture", mediaUrl: "data:image/png;base64,AAAA" },
      "final",
    );
    await dispatch(message("go"), scope);
    expect(log.text[0]).toBe("inline picture");
    expect(log.text[1]).toContain("Could not send an attachment");
  });
});

describe("rich replies (presentation, interactive, fallback text, location)", () => {
  function replying(payload: Any, kind = "final", bridgeOptions: Parameters<typeof fakeBridge>[0] = {}) {
    return setup(
      {
        dispatch: async (params) => {
          await params.delivery.deliver(payload, { kind });
          return { admission: { kind: "dispatch" }, dispatched: true };
        },
      },
      bridgeOptions,
    );
  }

  const rockridge = {
    title: "Rockridge, Oakland",
    blocks: [
      { type: "text", text: "A walkable neighborhood along College Avenue." },
      { type: "context", text: "Source: city guide" },
      { type: "divider" },
      {
        type: "table",
        caption: "Getting there",
        headers: ["Mode", "Time"],
        rows: [
          ["BART", "12 min"],
          ["Bus", "25 min"],
        ],
      },
      {
        type: "buttons",
        buttons: [
          { label: "Directions", action: { type: "callback", value: "directions" }, style: "primary" },
          { label: "Website", action: { type: "url", url: "https://rockridge.example/" } },
        ],
      },
    ],
  };

  it("delivers a presentation-only reply as text instead of dropping it", async () => {
    const { dispatch, scope, log } = replying({ presentation: rockridge });
    await dispatch(message("rockridge?"), scope);

    expect(log.text).toHaveLength(1);
    const text = log.text[0]!;
    expect(text).toContain("Rockridge, Oakland");
    expect(text).toContain("A walkable neighborhood along College Avenue.");
    expect(text).toContain("Source: city guide");
    // Tables are not declared, so core flattens them to deterministic text.
    expect(text).toContain("Getting there (table)");
    expect(text).toContain("Mode: BART; Time: 12 min");
    // Links stay in the text, since an A2UI button cannot open one.
    expect(text).toContain("Website: https://rockridge.example/");
    // The buttons are in the text too, so the message stands alone.
    expect(text).toContain("Directions");
  });

  it("shows the callback button as a surface, after the text, and tracks it", async () => {
    const { dispatch, scope, log, surfaces } = replying({ presentation: rockridge });
    await dispatch(message("rockridge?"), scope);

    expect(log.order).toEqual(["text", "ui"]);
    expect(log.ui).toHaveLength(1);
    const { surfaceId, components } = log.ui[0]!;
    expect(surfaces.has(surfaceId)).toBe(true);

    const buttons = components.filter((c: Any) => c.component === "Button");
    // Only the callback is tappable; the url button is not minted.
    expect(buttons).toHaveLength(1);
    expect(buttons[0].action.event.context).toEqual({ choice: "directions" });
    expect(buttons[0].variant).toBe("primary");
    expect(components.find((c: Any) => c.id === buttons[0].child).text).toBe("Directions");
  });

  it("answers a tap through the inbound choice path, tied to the reply that asked", async () => {
    const { dispatch, scope, log, calls } = replying({ presentation: rockridge });
    await dispatch(message("rockridge?"), scope);

    const { surfaceId, components } = log.ui[0]!;
    const button = components.find((c: Any) => c.component === "Button");
    // What azula-app reports for a tap on that button.
    const tap = {
      type: "ui_event" as const,
      device: "phone",
      event: {
        version: "v0.9.1",
        action: {
          name: button.action.event.name,
          surfaceId,
          sourceComponentId: button.id,
          context: button.action.event.context,
        },
      },
    };
    const item = translateEvent(tap);
    expect(item).toMatchObject({ kind: "choice", value: "directions", surfaceId });
    expect((item as InboundChoice).replyToMessageId).toBe(surfaceId.replace(/^openclaw-/, ""));
    expect(surfaceIdFor((item as InboundChoice).replyToMessageId!)).toBe(surfaceId);

    // And it reaches the agent as the user's answer.
    await dispatch(item as InboundChoice, scope);
    expect(calls.context.at(-1)).toMatchObject({
      message: { rawBody: "directions", bodyForAgent: "directions" },
    });
  });

  it("keeps the authored text for a producer-flattened presentation (presentationTextMode fallback)", async () => {
    const { dispatch, scope, log } = replying({
      text: "Status: ok\nModel: x",
      presentationTextMode: "fallback",
      presentation: { blocks: [{ type: "text", text: "Status: ok" }] },
    });
    await dispatch(message("/status"), scope);
    expect(log.text).toEqual(["Status: ok\nModel: x"]);
    expect(log.ui).toEqual([]);
  });

  it("keeps the authored text, and still shows the buttons, in fallback mode with controls", async () => {
    const { dispatch, scope, log } = replying({
      text: "Which one?\n\nReply with the number or option text.",
      presentationTextMode: "fallback",
      presentation: {
        blocks: [
          { type: "text", text: "Which one?" },
          {
            type: "buttons",
            buttons: [
              { label: "Red", action: { type: "question", questionId: "q1", optionValue: "red" } },
              { label: "Blue", action: { type: "question", questionId: "q1", optionValue: "blue" } },
              { label: "Other…", action: { type: "question", questionId: "q1", intent: "custom-input" } },
            ],
          },
        ],
      },
    });
    await dispatch(message("ask me"), scope);

    expect(log.text[0]).toContain("Reply with the number or option text.");
    const buttons = log.ui[0]!.components.filter((c: Any) => c.component === "Button");
    // A question answers with the option's label; "Other…" has nothing to send.
    expect(buttons.map((b: Any) => b.action.event.context.choice)).toEqual(["Red", "Blue"]);
  });

  it("folds a deprecated interactive reply into text plus a surface", async () => {
    const { dispatch, scope, log } = replying({
      text: "Deploy to prod?",
      interactive: {
        blocks: [
          { type: "text", text: "Deploy to prod?" },
          {
            type: "buttons",
            buttons: [
              { label: "Approve", value: "deploy:yes", style: "success" },
              { label: "Decline", value: "deploy:no" },
            ],
          },
        ],
      },
    });
    await dispatch(message("deploy"), scope);

    // The payload's own text wins; the interactive's text block is not repeated.
    expect(log.text[0]!.match(/Deploy to prod\?/g)).toHaveLength(1);
    expect(log.text[0]).toContain("Approve");
    const buttons = log.ui[0]!.components.filter((c: Any) => c.component === "Button");
    expect(buttons.map((b: Any) => b.action.event.context.choice)).toEqual(["deploy:yes", "deploy:no"]);
    expect(buttons.map((b: Any) => b.variant)).toEqual(["primary", "default"]);
  });

  it("uses an interactive reply's own text when the payload has none", async () => {
    const { dispatch, scope, log } = replying({
      interactive: { blocks: [{ type: "text", text: "Pick one" }, { type: "buttons", buttons: [{ label: "A", value: "a" }] }] },
    });
    await dispatch(message("go"), scope);
    expect(log.text[0]).toContain("Pick one");
    expect(log.ui).toHaveLength(1);
  });

  it("sends a command button's command as the answer", async () => {
    const { dispatch, scope, log } = replying({
      presentation: {
        blocks: [
          { type: "text", text: "Allow this command?" },
          { type: "buttons", buttons: [{ label: "Allow once", action: { type: "command", command: "/approve abc123 allow-once" } }] },
        ],
      },
    });
    await dispatch(message("go"), scope);
    const button = log.ui[0]!.components.find((c: Any) => c.component === "Button");
    expect(button.action.event.context.choice).toBe("/approve abc123 allow-once");
    // A command is copyable text for a reader without the surface.
    expect(log.text[0]).toContain("`/approve abc123 allow-once`");
  });

  it("never makes a button of a hidden answer the gateway would run as a command", async () => {
    const { dispatch, scope, log } = replying({
      text: "What next?",
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "Show more", action: { type: "callback", value: "/reset" } },
              { label: "Padded", action: { type: "callback", value: "  /new" } },
              { label: "List files", action: { type: "callback", value: "!ls" } },
              { label: "Cancel", action: { type: "callback", value: "stop" } },
              { label: "Stop", action: { type: "callback", value: "job:cancel" } },
              { label: "Status", action: { type: "command", command: "/status" } },
              { label: "More", action: { type: "callback", value: "more" } },
            ],
          },
        ],
      },
    });
    await dispatch(message("go"), scope);

    const buttons = log.ui[0]!.components.filter((c: Any) => c.component === "Button");
    // "Stop" is minted: the word is only its label, and its hidden value is benign.
    expect(buttons.map((b: Any) => b.action.event.context.choice)).toEqual([
      "job:cancel",
      "/status",
      "more",
    ]);
    // The unminted controls are still in the message, by label, with no answer shown.
    for (const label of ["Show more", "Padded", "List files", "Cancel"]) {
      expect(log.text[0]).toContain(label);
    }
    for (const hidden of ["/reset", "/new", "!ls", "stop"]) expect(log.text[0]).not.toContain(hidden);
    // The command that is minted is visible in the text.
    expect(log.text[0]).toContain("`/status`");
  });

  it("shows no surface when nothing on it can be tapped (links, approvals)", async () => {
    const { dispatch, scope, log, surfaces } = replying({
      presentation: {
        blocks: [
          { type: "text", text: "Read this" },
          {
            type: "buttons",
            buttons: [
              { label: "Open", action: { type: "url", url: "https://example.com/x" } },
              { label: "Approve", action: { type: "approval", approvalId: "abcd1234", approvalKind: "exec", decision: "allow-once" } },
            ],
          },
        ],
      },
    });
    await dispatch(message("go"), scope);
    expect(log.text[0]).toContain("Open: https://example.com/x");
    expect(log.ui).toEqual([]);
    expect(surfaces.openSurfaces).toEqual([]);
  });

  it("delivers the text and warns when the surface cannot be shown, and does not track it", async () => {
    const { dispatch, scope, log, surfaces } = replying({ presentation: rockridge }, "final", {
      renderUiFails: true,
    });
    await dispatch(message("rockridge?"), scope);

    expect(log.text).toHaveLength(1);
    expect(log.text[0]).toContain("Rockridge, Oakland");
    expect(surfaces.openSurfaces).toEqual([]);
    expect(warnings.some((w) => w.includes("buttons") && w.includes("surface rejected"))).toBe(true);
    // Not a delivery failure: the pipeline's error hook is never reached.
    expect(warnings.some((w) => w.includes("delivering a"))).toBe(false);
  });

  it("sends fallbackText when that is all there is", async () => {
    const { dispatch, scope, log } = replying({ fallbackText: { text: "Structured content, as text" } });
    await dispatch(message("go"), scope);
    expect(log.text).toEqual(["Structured content, as text"]);
  });

  it("does not repeat fallbackText next to text it duplicates", async () => {
    const { dispatch, scope, log } = replying({
      text: "Same words",
      fallbackText: { text: "Same words" },
    });
    await dispatch(message("go"), scope);
    expect(log.text).toEqual(["Same words"]);
  });

  it("formats a location as a line of text", async () => {
    const { dispatch, scope, log } = replying({
      location: { latitude: 37.8444, longitude: -122.2516, name: "Rockridge BART", address: "5600 College Ave, Oakland" },
    });
    await dispatch(message("go"), scope);
    expect(log.text).toEqual(["Location: Rockridge BART, 5600 College Ave, Oakland (37.8444, -122.2516)"]);
  });

  it("puts a location line after the reply's own text", async () => {
    const { dispatch, scope, log } = replying({
      text: "Here it is",
      location: { latitude: 1.5, longitude: 2.5 },
    });
    await dispatch(message("go"), scope);
    expect(log.text).toEqual(["Here it is\n\nLocation: 1.5, 2.5"]);
  });

  it("tracks a surface for each block of a streamed reply that has buttons", async () => {
    const { dispatch, scope, surfaces } = setup({
      dispatch: async (params) => {
        for (const label of ["a", "b"]) {
          await params.delivery.deliver(
            { presentation: { blocks: [{ type: "buttons", buttons: [{ label, value: label }] }] } },
            { kind: "block" },
          );
        }
        return { admission: { kind: "dispatch" }, dispatched: true };
      },
    });
    await dispatch(message("go"), scope);
    expect(surfaces.openSurfaces).toHaveLength(2);
  });
});

describe("typing indicator", () => {
  it("is switched on and off through the pipeline's own typing hooks", async () => {
    let typing: Any | undefined;
    const { dispatch, scope, log } = setup({
      dispatch: async (params) => {
        typing = params.replyPipeline.typing;
        await typing.start();
        await typing.stop();
        return { admission: { kind: "dispatch" }, dispatched: true };
      },
    });
    await dispatch(message("go"), scope);

    // on, off from the pipeline, and the unconditional final clear.
    expect(log.typing.slice(0, 2)).toEqual([true, false]);
    // The safety net outlives a long turn: the SDK's 60s default would switch
    // the indicator off mid-answer.
    expect(typing?.maxDurationMs).toBeGreaterThan(60_000);
  });

  /** A failed turn is exactly when the agent looks stuck. */
  it("is cleared when the turn throws", async () => {
    const { dispatch, scope, log } = setup({
      dispatch: async (params) => {
        await params.replyPipeline.typing.start();
        throw new Error("model exploded");
      },
    });

    await expect(dispatch(message("go"), scope)).rejects.toThrow("model exploded");
    expect(log.typing.at(-1)).toBe(false);
    expect(log.typing[0]).toBe(true);
  });

  it("is cleared even if the pipeline never reported the turn over", async () => {
    const { dispatch, scope, log } = setup({
      dispatch: async (params) => {
        await params.replyPipeline.typing.start();
        return { admission: { kind: "dispatch" }, dispatched: true };
      },
    });
    await dispatch(message("go"), scope);
    expect(log.typing).toEqual([true, false]);
  });

  it("never turns the indicator on for a message that is not dispatched", async () => {
    const { dispatch, scope, log } = setup();
    await dispatch(message("   "), scope);
    expect(log.typing).toEqual([]);
  });
});

describe("failure", () => {
  it("propagates a dispatch error so the claim is released", async () => {
    const { dispatch, scope } = setup({
      dispatch: async () => {
        throw new Error("channel dispatch failed");
      },
    });
    await expect(dispatch(message("hi"), scope)).rejects.toThrow("channel dispatch failed");
  });

  it("surfaces a reply that could not be delivered, to the pipeline's error hook", async () => {
    const { dispatch, scope } = setup({
      dispatch: async (params) => {
        params.delivery.onError(new Error("bridge down"), { kind: "final" });
        return { admission: { kind: "dispatch" }, dispatched: true };
      },
    });
    await dispatch(message("hi"), scope);
    expect(warnings.some((w) => w.includes("bridge down"))).toBe(true);
  });

  it("notes a turn the gateway declined", async () => {
    const { dispatch, scope } = setup({
      dispatch: async () => ({ admission: { kind: "drop" }, dispatched: false }),
    });
    await dispatch(message("hi"), scope);
    expect(warnings.some((w) => w.includes("declined the turn"))).toBe(true);
  });

  it("notes a turn accepted but not run", async () => {
    const { dispatch, scope } = setup({
      dispatch: async () => ({ admission: { kind: "dispatch" }, dispatched: false }),
    });
    await dispatch(message("hi"), scope);
    expect(warnings.some((w) => w.includes("without running it"))).toBe(true);
  });
});

