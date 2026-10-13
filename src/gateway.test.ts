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
  const state = {
    running: false,
    starts: 0,
    stops: 0,
    sent: [] as string[],
    typing: [] as boolean[],
    devices: new Map<string, string>(),
    device: undefined as string | undefined,
  };
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
    async listDevices() {
      return [...state.devices].map(([n, st]) => `${n}  [${n.slice(0, 8)}…]  ${st}`);
    },
    setDevice(device: string) {
      state.device = device;
    },
    async pairingInvite() {
      return "https://azula.app/i/live\n\n```\n▄▄ qr ▄▄\n```\n\nScan.";
    },
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

/**
 * An account with no `device` waits for a phone, and `openclaw channels login`
 * reaches it through the gateway's `web.login.*` hooks. The SDK values that talk
 * to the real config file are replaced by an in-memory config; the status
 * patches are the SDK's own.
 */
describe("pairing through the gateway adapter", () => {
  const unpaired: ResolvedAzulaAccount = { ...account, device: undefined };

  async function pairingAdapter(
    fake: ReturnType<typeof fakeBridge>,
    options: { writesAllowed?: boolean; loginBridge?: () => AzulaBridge } = {},
  ) {
    const { loadSdk } = await import("./sdk.js");
    const real = await loadSdk();
    const config: Any = { channels: { azula: { enabled: true } } };
    const sdk = {
      ...real,
      getRuntimeConfig: () => config,
      resolveChannelConfigWrites: () => options.writesAllowed ?? true,
      mutateConfigFile: async (params: { mutate: (draft: Any) => unknown }) => ({ result: params.mutate(config) }),
      resolveChannelInboundRouteEnvelope: ((params: Any) => ({
        route: { agentId: "main", sessionKey: `agent:main:azula:${params.peer.id}` },
        buildEnvelope: (input: Any) => input.body,
      })) as unknown as typeof real.resolveChannelInboundRouteEnvelope,
    } as typeof real;
    const adapter = createGatewayAdapter({
      loadSdk: async () => sdk,
      createBridge: () => fake.bridge,
      lifecycle: {
        pairingPollMs: 5,
        stopGraceMs: 100,
        pumpErrorBackoffMs: 1,
        reconnect: { baseBackoffMs: 1, maxBackoffMs: 1, sleep: async () => {} },
      },
      login: {
        pollMs: 5,
        ...(options.loginBridge ? { createBridge: options.loginBridge } : {}),
      },
    });
    return { adapter, config };
  }

  const pairingContext = (overrides: Partial<Ctx> = {}) =>
    context({ account: unpaired, cfg: { channels: { azula: { enabled: true } } } as never, ...overrides });

  it("publishes a waiting account as running and connected, never as unlinked", async () => {
    const fake = fakeBridge();
    const { adapter } = await pairingAdapter(fake);
    const { ctx, controller, statuses } = pairingContext();
    const running = adapter.startAccount!(ctx);

    await vi.waitFor(() => expect(statuses.some((s) => s.azulaPairing === true)).toBe(true));
    const waiting = statuses.find((s) => s.azulaPairing === true)!;
    expect(waiting).toMatchObject({ accountId: "default", running: true, connected: true, lifecycle: "ready", lastError: null });
    // `linked: false` would make the gateway refuse to ever start the account again.
    for (const status of statuses) expect(status).not.toHaveProperty("linked");
    expect(getRuntime("default")).toBeUndefined();

    controller.abort();
    await running;
    expect(statuses.at(-1)).toMatchObject({ lifecycle: "stopped", running: false, azulaPairing: undefined });
  });

  it("goes ready on the phone that pairs, saving it, and clears the waiting fact", async () => {
    const fake = fakeBridge();
    const { adapter, config } = await pairingAdapter(fake);
    const { ctx, controller, statuses } = pairingContext();
    const running = adapter.startAccount!(ctx);
    await vi.waitFor(() => expect(statuses.some((s) => s.azulaPairing === true)).toBe(true));

    fake.state.devices.set("2a64dea5aaaa", "connected");
    await vi.waitFor(() => expect(statuses.some((s) => s.azulaDevice === "2a64dea5aaaa")).toBe(true));

    expect(statuses.at(-1)).toMatchObject({
      running: true,
      connected: true,
      lifecycle: "ready",
      azulaPairing: undefined,
      azulaDevice: "2a64dea5aaaa",
      azulaConfigHint: undefined,
    });
    expect(config.channels.azula.device).toBe("2a64dea5aaaa");
    expect(fake.state.device).toBe("2a64dea5aaaa");
    expect(getRuntime("default")?.bridge).toBe(fake.bridge);

    controller.abort();
    await running;
  });

  it("publishes how to save the phone when config writes are off", async () => {
    const fake = fakeBridge();
    const { adapter, config } = await pairingAdapter(fake, { writesAllowed: false });
    const { ctx, controller, statuses } = pairingContext();
    const running = adapter.startAccount!(ctx);
    await vi.waitFor(() => expect(statuses.some((s) => s.azulaPairing === true)).toBe(true));

    fake.state.devices.set("phone-x", "connected");
    await vi.waitFor(() => expect(statuses.some((s) => s.azulaDevice === "phone-x")).toBe(true));

    expect(statuses.at(-1)).toMatchObject({
      lifecycle: "ready",
      azulaDevice: "phone-x",
      azulaConfigHint: "openclaw config set channels.azula.device phone-x",
    });
    expect(config.channels.azula.device).toBeUndefined();

    controller.abort();
    await running;
  });

  it("answers the gateway's login request from the running account, and then the wait", async () => {
    const fake = fakeBridge();
    const { adapter } = await pairingAdapter(fake);
    const { ctx, controller, statuses } = pairingContext();
    const running = adapter.startAccount!(ctx);
    await vi.waitFor(() => expect(statuses.some((s) => s.azulaPairing === true)).toBe(true));

    const started = await adapter.loginWithQrStart!({ accountId: "default" });
    expect(started.connected).toBe(false);
    expect(started.message).toContain("https://azula.app/i/live");
    expect(started.message).toContain("▄▄ qr ▄▄");
    // No `qrDataUrl`: the gateway stops a channel that answers with a QR image.
    expect(started).not.toHaveProperty("qrDataUrl");

    const waiting = adapter.loginWithQrWait!({ accountId: "default", timeoutMs: 5_000 });
    fake.state.devices.set("phone-1", "connected");
    await expect(waiting).resolves.toMatchObject({ connected: true });

    // The account the phone paired with is the account that was running; no restart.
    expect(fake.state.starts).toBe(1);

    controller.abort();
    await running;
  });

  it("tells a login for a running account with a phone that it has one", async () => {
    const fake = fakeBridge();
    const { adapter } = await pairingAdapter(fake);
    const { ctx, controller } = context();
    const running = adapter.startAccount!(ctx);
    await vi.waitFor(() => expect(getRuntime("default")).toBeDefined());

    const started = await adapter.loginWithQrStart!({ accountId: "default" });
    expect(started).toMatchObject({ connected: true });
    expect(started.message).toContain("already serves device 'phone'");

    controller.abort();
    await running;
  });

  it("opens the session itself when the account is not running, and the account takes it over afterwards", async () => {
    const live = fakeBridge();
    const temp = fakeBridge();
    const { adapter, config } = await pairingAdapter(live, { loginBridge: () => temp.bridge });

    // Nothing is running: the login holds the azula session on its own.
    const started = await adapter.loginWithQrStart!({ accountId: "default" });
    expect(started.message).toContain("https://azula.app/i/live");
    expect(temp.state.running).toBe(true);

    const waiting = adapter.loginWithQrWait!({ accountId: "default", timeoutMs: 5_000 });
    temp.state.devices.set("fresh-phone", "connected");
    await expect(waiting).resolves.toMatchObject({ connected: true });
    expect(config.channels.azula.device).toBe("fresh-phone");
    // Handed back before the gateway starts the account.
    expect(temp.state.running).toBe(false);
  });

  it("closes a lingering login session before it starts the account, which needs the same azula session", async () => {
    const live = fakeBridge();
    const temp = fakeBridge();
    const { adapter } = await pairingAdapter(live, { loginBridge: () => temp.bridge });
    await adapter.loginWithQrStart!({ accountId: "default" });
    expect(temp.state.running).toBe(true);

    const { ctx, controller, statuses } = pairingContext();
    const running = adapter.startAccount!(ctx);
    await vi.waitFor(() => expect(statuses.some((s) => s.azulaPairing === true)).toBe(true));

    expect(temp.state.running).toBe(false);
    expect(live.state.running).toBe(true);

    controller.abort();
    await running;
  });

  it("clears the plugin's own facts when the account is blocked", async () => {
    const fake = fakeBridge({
      startError: new AzulaConfigError("the azula binary could not be run ('azula')", "install it"),
    });
    const { adapter } = await pairingAdapter(fake);
    const { ctx, statuses } = pairingContext();
    await adapter.startAccount!(ctx);
    expect(statuses.find((s) => s.lifecycle === "blocked")).toMatchObject({
      azulaPairing: undefined,
      azulaDevice: undefined,
      azulaConfigHint: undefined,
    });
  });
});
