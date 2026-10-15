import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { azulaChannelPlugin } from "./channel.js";
import { forwardToGateway, setGatewayCaller } from "./forward.js";
import { sendMedia, sendText } from "./outbound.js";
import { sendPayload } from "./reply.js";
import {
  canForwardToGateway,
  clearRuntimes,
  markGatewayProcess,
  markUnavailable,
  NoRuntimeError,
  registerRuntime,
} from "./runtime.js";
import { SurfaceTracker } from "./surfaces.js";
import { renderPresentationForDelivery } from "openclaw/plugin-sdk/interactive-runtime";

type Any = Record<string, any>;

/** Every gateway RPC this process made. */
let rpcs: Array<{ method: string; params: Any; timeoutMs: number }>;
let reply: () => Promise<Record<string, unknown>>;

function sendsThrough() {
  const log = { text: [] as string[], files: [] as string[], ui: [] as Any[] };
  registerRuntime("default", {
    bridge: {
      sendMessage: async (t: string) => void log.text.push(t),
      sendFile: async (p: string) => void log.files.push(p),
      renderUi: async (surfaceId: string, components: unknown[]) => void log.ui.push({ surfaceId, components }),
    } as never,
    surfaces: new SurfaceTracker(),
  });
  return log;
}

beforeEach(() => {
  clearRuntimes();
  rpcs = [];
  reply = async () => ({ messageId: "gw-1" });
  setGatewayCaller(async (method, params, timeoutMs) => {
    rpcs.push({ method, params: params as Any, timeoutMs });
    return reply();
  });
});
afterEach(() => {
  clearRuntimes();
  setGatewayCaller();
});

const cli = { to: "azula:phone", accountId: "default" } as const;

/** `openclaw message send` in a CLI process: no runtime, never touched the gateway adapter. */
describe("a send from the CLI", () => {
  it("is handed to the gateway's send RPC, with the target, account and text", async () => {
    const result = await sendText({ ...cli, text: "build finished" });

    expect(rpcs).toHaveLength(1);
    expect(rpcs[0]!.method).toBe("send");
    expect(rpcs[0]!.params).toMatchObject({
      channel: "azula",
      to: "azula:phone",
      accountId: "default",
      message: "build finished",
    });
    // Required by the RPC; a fresh one per send.
    expect(typeof rpcs[0]!.params["idempotencyKey"]).toBe("string");
    expect(rpcs[0]!.params["idempotencyKey"].length).toBeGreaterThan(8);
    expect(rpcs[0]!.timeoutMs).toBeGreaterThanOrEqual(60_000);
    expect(result).toEqual({ messageId: "gw-1" });
  });

  it("sends only fields the RPC's closed schema allows", async () => {
    await sendText({ to: "azula:phone", text: "hi" });
    const allowed = new Set([
      "to", "message", "mediaUrl", "mediaUrls", "buffer", "filename", "contentType", "asVoice", "gifPlayback",
      "channel", "accountId", "agentId", "replyToId", "threadId", "forceDocument", "silent", "parseMode",
      "sessionKey", "idempotencyKey",
    ]);
    for (const key of Object.keys(rpcs[0]!.params)) expect(allowed.has(key)).toBe(true);
    // And leaves out what it has nothing for, rather than sending undefined.
    expect(rpcs[0]!.params).not.toHaveProperty("accountId");
    expect(rpcs[0]!.params).not.toHaveProperty("mediaUrl");
  });

  it("mints a different idempotency key for each send", async () => {
    await sendText({ ...cli, text: "one" });
    await sendText({ ...cli, text: "two" });
    expect(rpcs[0]!.params["idempotencyKey"]).not.toBe(rpcs[1]!.params["idempotencyKey"]);
  });

  it("hands an attachment and its caption to the gateway, which reads or fetches it", async () => {
    await sendMedia({ ...cli, text: "look", mediaUrl: "https://example.com/a.png" });
    expect(rpcs[0]!.params).toMatchObject({
      to: "azula:phone",
      message: "look",
      mediaUrl: "https://example.com/a.png",
      mediaUrls: ["https://example.com/a.png"],
    });
  });

  it("hands a richer payload over as text and attachments", async () => {
    await sendPayload({
      ...cli,
      payload: {
        text: "Here",
        location: { latitude: 1, longitude: 2, name: "Spot" },
        mediaUrls: ["/tmp/a.png", "/tmp/b.png"],
        channelData: { other: true },
      },
    });
    expect(rpcs[0]!.params).toMatchObject({
      message: "Here\n\nLocation: Spot (1, 2)",
      mediaUrl: "/tmp/a.png",
      mediaUrls: ["/tmp/a.png", "/tmp/b.png"],
    });
  });

  it("flattens a presentation with buttons to text, since the RPC carries no card", async () => {
    const outbound = azulaChannelPlugin.outbound!;
    const rendered = await renderPresentationForDelivery(
      {
        presentationCapabilities: outbound.presentationCapabilities!,
        renderPresentation: async (adapted, source) =>
          outbound.renderPresentation!({
            payload: adapted,
            presentation: adapted.presentation,
            sourcePresentation: source,
            ctx: { accountId: "default" } as never,
          }),
      },
      {
        text: "Deploy?",
        presentation: {
          blocks: [{ type: "buttons", buttons: [{ label: "Approve", action: { type: "callback", value: "yes" } }] }],
        },
      },
    );
    // Core's own flattening: no controls are carried to sendPayload.
    expect(rendered.channelData).toBeUndefined();
    await sendText({ ...cli, text: rendered.text });
    expect(rpcs[0]!.params["message"]).toContain("Deploy?");
    expect(rpcs[0]!.params["message"]).toContain("Approve");
  });

  it("sends nothing, and does not call the gateway, for a payload with nothing to say", async () => {
    const result = await sendPayload({ ...cli, payload: { channelData: { other: 1 } } });
    expect(rpcs).toEqual([]);
    expect(result).toMatchObject({ channel: "azula", messageId: "", outcome: "not_sent" });
  });

  it("passes the gateway's refusal on in the gateway's own words", async () => {
    reply = async () => {
      throw new Error("the azula channel has no running bridge for account 'default': waiting for a phone to pair");
    };
    await expect(sendText({ ...cli, text: "hi" })).rejects.toThrow(/waiting for a phone to pair/);
  });

  it("says plainly that the gateway is unreachable, and how to start it", async () => {
    setGatewayCaller(async () => {
      throw new Error(
        "could not reach the OpenClaw gateway (ECONNREFUSED).\nazula's session for this account lives in the running gateway, so `openclaw message send` hands the message to it. Start the gateway (`openclaw gateway`) and try again.",
      );
    });
    await expect(sendText({ ...cli, text: "hi" })).rejects.toThrow(/openclaw gateway/);
  });

  it("falls back to a generated id when the gateway does not report one", async () => {
    reply = async () => ({});
    expect((await sendText({ ...cli, text: "hi" })).messageId).toMatch(/^azula-/);
  });

  it("reads the id from a nested result", async () => {
    reply = async () => ({ result: { messageId: "nested-9" } });
    expect((await sendText({ ...cli, text: "hi" })).messageId).toBe("nested-9");
  });
});

/** The agent's replies, its `message` tool, cron and heartbeat: in the gateway, with a bridge. */
describe("a send inside the gateway, where the account is running", () => {
  it("delivers locally, with no gateway call, for text", async () => {
    const log = sendsThrough();
    await sendText({ ...cli, text: "from the agent's message tool" });
    expect(log.text).toEqual(["from the agent's message tool"]);
    expect(rpcs).toEqual([]);
  });

  it("delivers a media send locally", async () => {
    const log = sendsThrough();
    await sendMedia({ ...cli, text: "caption", mediaUrl: "https://example.com/a.png" });
    expect(log.text[0]).toBe("caption");
    expect(rpcs).toEqual([]);
  });

  /** The message tool with `presentation`: what the agent's interactive guide is. */
  it("turns a presentation's buttons into a card, with no gateway call", async () => {
    const log = sendsThrough();
    const outbound = azulaChannelPlugin.outbound!;
    const rendered = await renderPresentationForDelivery(
      {
        presentationCapabilities: outbound.presentationCapabilities!,
        renderPresentation: async (adapted, source) =>
          outbound.renderPresentation!({
            payload: adapted,
            presentation: adapted.presentation,
            sourcePresentation: source,
            ctx: { accountId: "default" } as never,
          }),
      },
      {
        presentation: {
          title: "Rockridge guide",
          blocks: [
            { type: "text", text: "Pick a topic" },
            {
              type: "buttons",
              buttons: [
                { label: "Food", action: { type: "callback", value: "food" } },
                { label: "Transit", action: { type: "callback", value: "transit" } },
              ],
            },
          ],
        },
      },
    );
    await outbound.sendPayload!({ payload: rendered, accountId: "default", to: "azula:phone" } as never);

    expect(log.text[0]).toContain("Rockridge guide");
    expect(log.ui).toHaveLength(1);
    const buttons = log.ui[0]!.components.filter((c: Any) => c.component === "Button");
    expect(buttons.map((b: Any) => b.action.event.context.choice)).toEqual(["food", "transit"]);
    expect(rpcs).toEqual([]);
  });
});

/** The gateway process, with the account waiting for a phone, blocked, or stopped. */
describe("a send inside the gateway, where the account is not running", () => {
  it("fails with the reason, without calling the gateway, when the lifecycle recorded one", async () => {
    markUnavailable("default", "waiting for a phone to pair");
    const error = await sendText({ ...cli, text: "hi" }).catch((e) => e);
    expect(error).toBeInstanceOf(NoRuntimeError);
    expect(error.message).toContain("waiting for a phone to pair");
    expect(rpcs).toEqual([]);
  });

  it("does not call the gateway once the gateway adapter has run in this process", async () => {
    // What `startAccount` / `stopAccount` / the login handlers do first.
    markGatewayProcess();
    expect(canForwardToGateway("default")).toBe(false);
    await expect(sendText({ ...cli, text: "hi" })).rejects.toBeInstanceOf(NoRuntimeError);
    await expect(sendMedia({ ...cli, mediaUrl: "/tmp/a.png" })).rejects.toBeInstanceOf(NoRuntimeError);
    await expect(sendPayload({ ...cli, payload: { text: "x", location: { latitude: 1, longitude: 2 } } })).rejects.toBeInstanceOf(
      NoRuntimeError,
    );
    expect(rpcs).toEqual([]);
  });

  it("names the account that is down", async () => {
    markGatewayProcess();
    await expect(sendText({ to: "azula:work-phone", accountId: "work", text: "hi" })).rejects.toThrow(/account 'work'/);
  });

  /**
   * The backstop. Say this process were misjudged to be a CLI (the gateway
   * adapter never ran here): the forwarded send comes back through the same
   * process, finds the account already forwarding, and stops there, so the
   * worst case is one extra hop and a clear error, not a loop.
   */
  it("cannot loop: a forwarded send that re-enters this process is refused", async () => {
    let reentered: unknown;
    setGatewayCaller(async (method, params, timeoutMs) => {
      rpcs.push({ method, params: params as Any, timeoutMs });
      // The gateway's handling of the forwarded send, in this same process.
      reentered = await sendText({ ...cli, text: "again" }).catch((e) => e);
      throw reentered;
    });

    const error = await sendText({ ...cli, text: "hi" }).catch((e) => e);
    expect(rpcs).toHaveLength(1);
    expect(reentered).toBeInstanceOf(NoRuntimeError);
    expect(error).toBeInstanceOf(NoRuntimeError);
    // And the account can be forwarded to again afterwards.
    expect(canForwardToGateway("default")).toBe(true);
  });

  it("clears the in-flight mark even when the forward fails", async () => {
    reply = async () => {
      throw new Error("boom");
    };
    await expect(forwardToGateway({ to: "azula:phone", accountId: "default", message: "x", mediaUrls: [] })).rejects.toThrow("boom");
    expect(canForwardToGateway("default")).toBe(true);
  });
});
