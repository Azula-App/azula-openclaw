import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { ResolvedAzulaAccount } from "./accounts.js";
import { AzulaConfigError, type AzulaBridge } from "./bridge.js";
import type { AzulaEvent } from "./events.js";
import { createGatewayAdapter } from "./gateway.js";
import { McpError } from "./mcp-client.js";
import { clearRuntimes, getRuntime } from "./runtime.js";

type Ctx = ChannelGatewayContext<ResolvedAzulaAccount>;
type Any = Record<string, any>;

const account: ResolvedAzulaAccount = {
  accountId: "default",
  enabled: true,
  device: "phone",
  binary: "azula",
  session: "openclaw",
  label: "OpenClaw",
};

/** The slice of `azula mcp` the channel touches, with controllable events. */
function fakeBridge(options: { startError?: unknown } = {}) {
  const state = { running: false, starts: 0, stops: 0, sent: [] as string[], typing: [] as boolean[] };
  const parked: Array<{ resolve: (e: AzulaEvent[]) => void; reject: (e: Error) => void }> = [];
  const bridge = {
    get running() {
      return state.running;
    },
    async start() {
      state.starts += 1;
      if (options.startError) throw options.startError;
      state.running = true;
    },
    async stop() {
      state.stops += 1;
      state.running = false;
      for (const p of parked.splice(0)) p.reject(new McpError("stopped", "closed"));
    },
    async assertDeviceKnown() {},
    getEvents: () =>
      state.running
        ? new Promise<AzulaEvent[]>((resolve, reject) => parked.push({ resolve, reject }))
        : Promise.reject(new McpError("not running", "closed")),
    setTyping: async (on: boolean) => void state.typing.push(on),
    sendMessage: async (text: string) => void state.sent.push(text),
    deleteUi: async () => {},
  };
  return {
    bridge: bridge as unknown as AzulaBridge,
    state,
    push: (...events: AzulaEvent[]) => parked.shift()?.resolve(events),
    get parked() {
      return parked.length;
    },
  };
}

/** A channel runtime whose dispatch behaves like a turn that answers once. */
function fakeChannelRuntime(reply = "four") {
  const dispatched: Any[] = [];
  const channelRuntime = {
    commands: { isControlCommandMessage: () => false },
    media: { saveMediaBuffer: async () => ({ id: "m", path: "/m", size: 0 }) },
    inbound: {
      ingress: {
        resolveStable: async () => ({
          ingress: { admission: "dispatch" },
          commandAccess: { authorized: false },
        }),
      },
      buildContext: (params: Any) => params,
      dispatch: async (params: Any) => {
        dispatched.push(params);
        await params.replyPipeline.typing.start();
        await params.delivery.deliver({ text: reply }, { kind: "final" });
        await params.replyPipeline.typing.stop();
        return { admission: { kind: "dispatch" }, dispatched: true };
      },
    },
    // Real routing needs a populated config; the SDK pieces this test cares about
    // are loaded for real, but routing is not what it is about.
    routing: {},
  };
  return { channelRuntime, dispatched };
}

function context(overrides: Partial<Ctx> & { channelRuntime?: unknown } = {}) {
  const controller = new AbortController();
  const statuses: Any[] = [];
  const logLines: string[] = [];
  const base = {
    cfg: { channels: { azula: { device: "phone" } } },
    accountId: "default",
    account,
    runtime: {},
    abortSignal: controller.signal,
    log: {
      info: (m: string) => void logLines.push(`info ${m}`),
      warn: (m: string) => void logLines.push(`warn ${m}`),
      error: (m: string) => void logLines.push(`error ${m}`),
      debug: (m: string) => void logLines.push(`debug ${m}`),
    },
    getStatus: () => ({}) as never,
    setStatus: (s: Any) => void statuses.push(s),
    channelRuntime: fakeChannelRuntime().channelRuntime,
    ...overrides,
  };
  return { ctx: base as unknown as Ctx, controller, statuses, logLines };
}

/**
 * The SDK pieces under test are real (`loadSdk` is not faked): the status
 * patches and the dedupe are exactly what the gateway will hand this adapter.
 * Only routing, which needs a populated gateway config, is stubbed.
 */
async function adapterWith(fake: ReturnType<typeof fakeBridge>) {
  const { loadSdk } = await import("./sdk.js");
  const sdk = await loadSdk();
  return createGatewayAdapter({
    loadSdk: async () => ({
      ...sdk,
      resolveChannelInboundRouteEnvelope: ((params: Any) => ({
        route: { agentId: "main", sessionKey: `agent:main:azula:${params.peer.id}` },
        buildEnvelope: (input: Any) => input.body,
      })) as unknown as typeof sdk.resolveChannelInboundRouteEnvelope,
    }),
    createBridge: () => fake.bridge,
    lifecycle: {
      reconnect: { baseBackoffMs: 1, maxBackoffMs: 1, sleep: async () => {} },
      stopGraceMs: 100,
      pumpErrorBackoffMs: 1,
    },
  });
}

beforeEach(() => clearRuntimes());
afterEach(() => clearRuntimes());

describe("startAccount", () => {
  it("stays pending for the account's whole life, then resolves when aborted", async () => {
    const fake = fakeBridge();
    const gateway = await adapterWith(fake);
    const { ctx, controller, statuses } = context();

    let settled = false;
    const running = gateway.startAccount!(ctx).then(() => (settled = true));

    await vi.waitFor(() => expect(getRuntime("default")).toBeDefined());
    // A settled promise would read as "the channel exited" and be restarted.
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);

    controller.abort();
    await running;
    expect(settled).toBe(true);
    expect(fake.state.stops).toBeGreaterThanOrEqual(1);
    expect(getRuntime("default")).toBeUndefined();
    expect(statuses.at(-1)).toMatchObject({ accountId: "default", running: false, lifecycle: "stopped" });
  });

  it("reports itself ready in the gateway's own vocabulary", async () => {
    const fake = fakeBridge();
    const gateway = await adapterWith(fake);
    const { ctx, controller, statuses } = context();
    const running = gateway.startAccount!(ctx);

    await vi.waitFor(() => expect(statuses.some((s) => s.lifecycle === "ready")).toBe(true));
    expect(statuses[0]).toMatchObject({ accountId: "default", running: true, lifecycle: "starting" });
    expect(statuses.find((s) => s.lifecycle === "ready")).toMatchObject({
      accountId: "default",
      running: true,
      connected: true,
      lifecycle: "ready",
      lastError: null,
    });

    controller.abort();
    await running;
  });

  /**
   * End to end through the adapter: the phone's message reaches the agent once,
   * and the agent's answer goes back out through the bridge.
   */
  it("carries a message from the phone to the agent and the answer back", async () => {
    const fake = fakeBridge();
    const gateway = await adapterWith(fake);
    const { channelRuntime, dispatched } = fakeChannelRuntime("two plus two is four");
    const { ctx, controller } = context({ channelRuntime });
    const running = gateway.startAccount!(ctx);

    await vi.waitFor(() => expect(fake.parked).toBe(1));
    fake.push({ type: "message", device: "phone", text: "what is 2+2?" });

    await vi.waitFor(() => expect(fake.state.sent).toEqual(["two plus two is four"]));
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.ctxPayload.message.rawBody).toBe("what is 2+2?");
    // Typing on while the agent works, off after.
    expect(fake.state.typing[0]).toBe(true);
    expect(fake.state.typing.at(-1)).toBe(false);

    controller.abort();
    await running;
  });

  it("reports a configuration error as blocked and returns, so the gateway does not restart it", async () => {
    const fake = fakeBridge({
      startError: new AzulaConfigError("the azula binary could not be run ('azula')", "install it"),
    });
    const gateway = await adapterWith(fake);
    const { ctx, statuses, logLines } = context();

    await expect(gateway.startAccount!(ctx)).resolves.toBeUndefined();

    const blocked = statuses.find((s) => s.lifecycle === "blocked");
    expect(blocked).toMatchObject({
      accountId: "default",
      running: false,
      connected: false,
      // What stops the gateway auto-restarting a channel that cannot start.
      terminalDisconnect: true,
    });
    expect(blocked?.lastError).toContain("install it");
    expect(logLines.some((l) => l.startsWith("error") && l.includes("install it"))).toBe(true);
    expect(fake.state.starts).toBe(1);
    expect(getRuntime("default")).toBeUndefined();
  });

  it("throws for a failure a retry might cure, so the gateway backs off and retries", async () => {
    const fake = fakeBridge({ startError: new McpError("initialize timed out", "timeout") });
    const gateway = await adapterWith(fake);
    const { ctx } = context();
    await expect(gateway.startAccount!(ctx)).rejects.toThrow("initialize timed out");
  });

  it("refuses clearly when the gateway gave it no channel runtime", async () => {
    const gateway = await adapterWith(fakeBridge());
    const { ctx } = context({ channelRuntime: undefined });
    await expect(gateway.startAccount!(ctx)).rejects.toThrow(/channel runtime/);
  });

  it("replaces a previous run of the same account instead of leaking it", async () => {
    const first = fakeBridge();
    const second = fakeBridge();
    const bridges = [first, second];
    const { loadSdk } = await import("./sdk.js");
    const sdk = await loadSdk();
    const gateway = createGatewayAdapter({
      loadSdk: async () => sdk,
      createBridge: () => bridges.shift()!.bridge,
      lifecycle: { stopGraceMs: 100 },
    });

    const a = context();
    const runningA = gateway.startAccount!(a.ctx);
    await vi.waitFor(() => expect(first.state.running).toBe(true));

    const b = context();
    const runningB = gateway.startAccount!(b.ctx);
    await vi.waitFor(() => expect(second.state.running).toBe(true));

    // The old child was stopped, and A's run has ended.
    expect(first.state.running).toBe(false);
    await runningA;
    expect(getRuntime("default")?.bridge).toBe(second.bridge);

    b.controller.abort();
    await runningB;
  });
});

describe("stopAccount", () => {
  it("tears the account down on its own, and startAccount settles", async () => {
    const fake = fakeBridge();
    const gateway = await adapterWith(fake);
    const { ctx } = context();
    const running = gateway.startAccount!(ctx);
    await vi.waitFor(() => expect(getRuntime("default")).toBeDefined());

    await gateway.stopAccount!(ctx);
    await running;

    expect(fake.state.running).toBe(false);
    expect(getRuntime("default")).toBeUndefined();
  });

  it("is safe to call more than once, and when nothing is running", async () => {
    const fake = fakeBridge();
    const gateway = await adapterWith(fake);
    const { ctx } = context();

    await expect(gateway.stopAccount!(ctx)).resolves.toBeUndefined();

    const running = gateway.startAccount!(ctx);
    await vi.waitFor(() => expect(getRuntime("default")).toBeDefined());
    await gateway.stopAccount!(ctx);
    await gateway.stopAccount!(ctx);
    await running;
    expect(fake.state.stops).toBe(1);
  });

  it("is idempotent with the gateway's own abort", async () => {
    const fake = fakeBridge();
    const gateway = await adapterWith(fake);
    const { ctx, controller } = context();
    const running = gateway.startAccount!(ctx);
    await vi.waitFor(() => expect(getRuntime("default")).toBeDefined());

    // The gateway aborts first, then calls stopAccount.
    controller.abort();
    await gateway.stopAccount!(ctx);
    await running;
    expect(fake.state.stops).toBe(1);
  });
});
