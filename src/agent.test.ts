import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { createAgentDispatch, type ChannelRuntime } from "./agent.js";
import type { ResolvedAzulaAccount } from "./accounts.js";
import type { AzulaBridge } from "./bridge.js";
import type { InboundChoice, InboundMessage } from "./inbound.js";
import type { DispatchScope } from "./lifecycle.js";
import { clearRuntimes, registerRuntime } from "./runtime.js";
import { SurfaceTracker } from "./surfaces.js";

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
const logger = {
  debug: () => {},
  info: () => {},
  warn: (m: string) => void warnings.push(m),
  error: () => {},
};

type Any = Record<string, any>;

/** The slice of the SDK's channel runtime the dispatcher touches, recorded. */
function fakeChannel(overrides: { dispatch?: (params: Any) => Promise<Any> } = {}) {
  const calls = {
    ingress: [] as Any[],
    context: [] as Any[],
    dispatch: [] as Any[],
    saved: [] as Any[],
  };
  const channel = {
    commands: {
      isControlCommandMessage: (text: string) => text.trimStart().startsWith("/"),
    },
    media: {
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

function fakeBridge() {
  const log = { typing: [] as boolean[], text: [] as string[], files: [] as Any[] };
  const bridge = {
    running: true,
    setTyping: async (on: boolean) => void log.typing.push(on),
    sendMessage: async (text: string) => void log.text.push(text),
    sendFile: async (path: string, caption?: string) => void log.files.push({ path, caption }),
  };
  return { bridge: bridge as unknown as AzulaBridge, log };
}

function setup(channelOverrides: Parameters<typeof fakeChannel>[0] = {}) {
  const { channel, calls } = fakeChannel(channelOverrides);
  const { bridge, log } = fakeBridge();
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
  return { dispatch, scope, calls, log, controller };
}

const message = (text: string, media: InboundMessage["media"] = []): InboundMessage => ({
  kind: "message",
  device: "phone",
  text,
  media,
});

beforeEach(() => {
  warnings.length = 0;
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

  it("sends an attachment with the text as its caption", async () => {
    const dir = tempDir("azula-agent-reply-");
    const path = join(dir, "chart.png");
    writeFileSync(path, "png");
    const { dispatch, scope, log } = replying([{ text: "here you go", mediaUrl: path }]);
    await dispatch(message("chart please"), scope);

    expect(log.files).toEqual([{ path, caption: "here you go" }]);
    expect(log.text).toEqual([]);
  });

  it("sends several attachments, captioning only the first", async () => {
    const dir = tempDir("azula-agent-reply-");
    const one = join(dir, "one.png");
    const two = join(dir, "two.png");
    writeFileSync(one, "1");
    writeFileSync(two, "2");
    const { dispatch, scope, log } = replying([{ text: "both", mediaUrls: [one, two] }]);
    await dispatch(message("pics"), scope);
    expect(log.files).toEqual([
      { path: one, caption: "both" },
      { path: two, caption: undefined },
    ]);
  });

  it("does not send the agent's reasoning to the phone", async () => {
    const { dispatch, scope, log } = replying([{ text: "thinking about it", isReasoning: true }], [
      { text: "answer" },
    ]);
    await dispatch(message("q"), scope);
    expect(log.text).toEqual(["answer"]);
  });

  it("does not send an empty reply", async () => {
    const { dispatch, scope, log } = replying([{ text: "  " }]);
    await dispatch(message("q"), scope);
    expect(log.text).toEqual([]);
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

