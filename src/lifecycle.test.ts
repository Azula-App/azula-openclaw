import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedAzulaAccount } from "./accounts.js";
import { AzulaConfigError, DeviceNotPairedError, type AzulaBridge } from "./bridge.js";
import type { AzulaEvent } from "./events.js";
import { AccountLifecycle, type AccountStatus, type LifecycleOptions } from "./lifecycle.js";
import { McpError } from "./mcp-client.js";
import { clearRuntimes, getRuntime, requireRuntime, registerRuntime } from "./runtime.js";
import { SurfaceTracker } from "./surfaces.js";

const account: ResolvedAzulaAccount = {
  accountId: "default",
  enabled: true,
  device: "phone",
  binary: "azula",
  session: "openclaw",
  label: "OpenClaw",
};

const logs: string[] = [];
const logger = {
  debug: (m: string) => void logs.push(`debug ${m}`),
  info: (m: string) => void logs.push(`info ${m}`),
  warn: (m: string) => void logs.push(`warn ${m}`),
  error: (m: string) => void logs.push(`error ${m}`),
};

/** A claim/commit/release double with the SDK's `{ kind }` result shape. */
function fakeDedupe() {
  const claimed = new Set<string>();
  const committed = new Set<string>();
  return {
    committed,
    claim: async (key: string) => {
      if (committed.has(key) || claimed.has(key)) return { kind: "duplicate" as const };
      claimed.add(key);
      return { kind: "claimed" as const };
    },
    commit: async (key: string) => {
      claimed.delete(key);
      committed.add(key);
      return true;
    },
    release: (key: string) => void claimed.delete(key),
  };
}

/**
 * A bridge that behaves like the real one where it matters to the lifecycle:
 * `getEvents` parks until something is pushed, and stopping or crashing rejects
 * whatever is parked — which is exactly what killing the child does.
 */
function fakeBridge(
  options: {
    /** Errors thrown by successive start() calls; `undefined` means succeed. */
    startErrors?: Array<unknown>;
    deviceErrors?: Array<unknown>;
    /** Hold start() open until released. */
    holdStart?: Promise<void>;
    /** Devices the session already knows when the bridge starts, name → status. */
    devices?: Record<string, string>;
  } = {},
) {
  const state = {
    running: false,
    starts: 0,
    stops: 0,
    polls: 0,
    typing: [] as boolean[],
    sent: [] as string[],
    deleted: [] as string[],
    /** `assertDeviceKnown` calls: a pairing account must make none. */
    assertCalls: 0,
    /** Devices the session knows, name → status, as `list_devices` shows them. */
    devices: new Map<string, string>(),
    /** The device the bridge was retargeted at, once a phone is adopted. */
    device: undefined as string | undefined,
    invites: 0,
  };
  for (const [name, status] of Object.entries(options.devices ?? {})) state.devices.set(name, status);
  const startErrors = [...(options.startErrors ?? [])];
  const deviceErrors = [...(options.deviceErrors ?? [])];
  const parked: Array<{
    resolve: (events: AzulaEvent[]) => void;
    reject: (error: Error) => void;
  }> = [];
  const queued: AzulaEvent[][] = [];
  let onExit: (() => void) | undefined;
  /** Every exit callback ever registered, oldest first. */
  const exitCallbacks: Array<(() => void) | undefined> = [];

  const rejectParked = (error: Error) => {
    for (const p of parked.splice(0)) p.reject(error);
  };

  const bridge = {
    get running() {
      return state.running;
    },
    async start(exit?: () => void) {
      state.starts += 1;
      onExit = exit;
      exitCallbacks.push(exit);
      await options.holdStart;
      if (startErrors.length > 0) {
        const err = startErrors.shift();
        if (err !== undefined) throw err;
      }
      state.running = true;
    },
    async stop() {
      state.stops += 1;
      state.running = false;
      rejectParked(new McpError("azula bridge stopped", "closed"));
    },
    async assertDeviceKnown() {
      state.assertCalls += 1;
      if (deviceErrors.length > 0) {
        const err = deviceErrors.shift();
        if (err !== undefined) throw err;
      }
    },
    async listDevices() {
      if (!state.running) throw new McpError("azula bridge is not running", "closed");
      return [...state.devices].map(([name, status]) => `${name}  [${name.slice(0, 8)}…]  ${status}`);
    },
    setDevice(device: string) {
      state.device = device;
    },
    async pairingInvite() {
      state.invites += 1;
      return "https://azula.app/i/abc\n\n```\n▄▄ qr ▄▄\n```\n\nScan with your phone's camera.";
    },
    getEvents(_timeoutSeconds?: number): Promise<AzulaEvent[]> {
      state.polls += 1;
      if (!state.running) {
        return Promise.reject(new McpError("azula bridge is not running", "closed"));
      }
      const next = queued.shift();
      if (next) return Promise.resolve(next);
      return new Promise((resolve, reject) => parked.push({ resolve, reject }));
    },
    async setTyping(on: boolean) {
      state.typing.push(on);
    },
    async deleteUi(id: string) {
      state.deleted.push(id);
    },
    async sendMessage(text: string) {
      state.sent.push(text);
    },
  };

  return {
    bridge: bridge as unknown as AzulaBridge,
    state,
    /** Deliver a batch to the pump, whether or not it is parked yet. */
    push(...events: AzulaEvent[]) {
      const waiter = parked.shift();
      if (waiter) waiter.resolve(events);
      else queued.push(events);
    },
    /** The child dying on its own. */
    crash() {
      state.running = false;
      rejectParked(new McpError("azula bridge exited (code=1, signal=null)", "closed"));
      onExit?.();
    },
    /** The first child's exit notification, delivered late. */
    staleExit() {
      exitCallbacks[0]?.();
    },
    /** A phone appearing in (or changing status in) the session's device list. */
    pair(name: string, status = "connected") {
      state.devices.set(name, status);
    },
    get parkedPolls() {
      return parked.length;
    },
  };
}

type Dispatched = Parameters<LifecycleOptions["dispatch"]>;

function harness(
  bridgeOptions: Parameters<typeof fakeBridge>[0] = {},
  overrides: Partial<LifecycleOptions> = {},
) {
  const fake = fakeBridge(bridgeOptions);
  const statuses: AccountStatus[] = [];
  const dispatched: Dispatched[0][] = [];
  const scopes: Dispatched[1][] = [];
  const dedupe = fakeDedupe();
  const lifecycle = new AccountLifecycle({
    account,
    logger,
    dedupe,
    dispatch: async (item, scope) => {
      dispatched.push(item);
      scopes.push(scope);
    },
    onStatus: (s) => void statuses.push(s),
    createBridge: () => fake.bridge,
    // Real timing would make these tests slow; nothing here depends on it.
    reconnect: { baseBackoffMs: 1, maxBackoffMs: 2, sleep: async () => {} },
    stopGraceMs: 200,
    pumpErrorBackoffMs: 1,
    ...overrides,
  });
  const controller = new AbortController();
  const running = lifecycle.run(controller.signal);
  // `run` must settle cleanly in every test, so surface a stray rejection.
  running.catch(() => {});
  return { fake, lifecycle, controller, running, statuses, dispatched, scopes, dedupe };
}

const phases = (statuses: AccountStatus[]) =>
  statuses.flatMap((s) => (s.phase ? [s.phase] : []));

const message = (text: string): AzulaEvent => ({ type: "message", device: "phone", text });

beforeEach(() => {
  logs.length = 0;
  clearRuntimes();
});
afterEach(() => {
  clearRuntimes();
});

describe("start", () => {
  it("brings the bridge up, registers the runtime and starts polling", async () => {
    const h = harness();
    await vi.waitFor(() => expect(phases(h.statuses)).toContain("ready"));

    expect(h.fake.state.starts).toBe(1);
    // Outbound sends find this account's bridge through the registry...
    expect(getRuntime("default")?.bridge).toBe(h.fake.bridge);
    // ...and the pump is already long-polling for the phone's messages.
    await vi.waitFor(() => expect(h.fake.parkedPolls).toBe(1));

    h.controller.abort();
    await h.running;
  });

  /**
   * Sends that happen outside a turn (`message send`, cron) reach a bridge only
   * through this registry, so it is also where they find the logger and the
   * remote-media loader.
   */
  it("hands the outbound path its logger and remote-media loader", async () => {
    const fetchMedia = async () => ({ path: "/media/x.png" });
    const h = harness({}, { fetchMedia });
    await vi.waitFor(() => expect(phases(h.statuses)).toContain("ready"));

    expect(getRuntime("default")?.fetchMedia).toBe(fetchMedia);
    expect(getRuntime("default")?.logger).toBe(logger);

    h.controller.abort();
    await h.running;
  });

  it("reports starting before ready", async () => {
    const h = harness();
    await vi.waitFor(() => expect(phases(h.statuses)).toContain("ready"));
    expect(phases(h.statuses).slice(0, 2)).toEqual(["starting", "ready"]);
    h.controller.abort();
    await h.running;
  });

  /**
   * Missing binary, azula too old, phone not paired: nothing a retry cures, and
   * a retry loop would bury the message that says what to do.
   */
  it("reports a configuration error as blocked, without throwing or retrying", async () => {
    const err = new AzulaConfigError("the azula binary could not be run ('azula')", "install it");
    const h = harness({ startErrors: [err] });

    await expect(h.running).resolves.toBeUndefined();

    expect(h.fake.state.starts).toBe(1);
    const blocked = h.statuses.find((s) => s.phase === "blocked");
    expect(blocked?.error).toContain("could not be run");
    expect(blocked?.error).toContain("install it");
    // It tells the operator how to get unstuck, not just what is wrong.
    expect(blocked?.error).toMatch(/restart/);
    expect(logs.some((l) => l.startsWith("error") && l.includes("could not be run"))).toBe(true);
    // Never reported as stopped over the top of the reason.
    expect(phases(h.statuses)).not.toContain("stopped");
    expect(getRuntime("default")).toBeUndefined();
    // A send now says why, instead of a bare "no running bridge".
    expect(() => requireRuntime("default")).toThrow(/could not be run/);
  });

  it("treats an unpaired device as a configuration error and kills the child it started", async () => {
    const err = new AzulaConfigError(
      "no azula device named 'phone' is paired with this machine",
      "pair the phone first",
    );
    const h = harness({ deviceErrors: [err] });

    await expect(h.running).resolves.toBeUndefined();

    expect(h.statuses.find((s) => s.phase === "blocked")?.error).toContain("pair the phone first");
    expect(getRuntime("default")).toBeUndefined();
    // The bridge was up when the pairing check failed; it must not be left running.
    expect(h.fake.state.stops).toBeGreaterThanOrEqual(1);
    expect(h.fake.state.running).toBe(false);
  });

  it("rejects, once, when the bridge fails for a reason a later attempt might cure", async () => {
    const h = harness({ startErrors: [new McpError("initialize timed out", "timeout")] });

    await expect(h.running).rejects.toThrow("initialize timed out");

    // The gateway's own, slower restart policy owns the retry; this layer does not spin.
    expect(h.fake.state.starts).toBe(1);
    expect(getRuntime("default")).toBeUndefined();
    expect(() => requireRuntime("default")).toThrow(/initialize timed out/);
  });

  it("does not run twice", async () => {
    const h = harness();
    await vi.waitFor(() => expect(phases(h.statuses)).toContain("ready"));
    await expect(h.lifecycle.run(new AbortController().signal)).rejects.toThrow(/only be called once/);
    h.controller.abort();
    await h.running;
  });
});

describe("stop", () => {
  /**
   * The gateway gives a stopping account a few seconds. The pump is parked in a
   * 25-second long-poll; killing the child is what releases it.
   */
  it("is prompt even while a long poll is in flight", async () => {
    const h = harness();
    await vi.waitFor(() => expect(h.fake.parkedPolls).toBe(1));

    const started = Date.now();
    h.controller.abort();
    await h.running;

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(h.fake.state.running).toBe(false);
    expect(getRuntime("default")).toBeUndefined();
    expect(phases(h.statuses).at(-1)).toBe("stopped");
  });

  it("is idempotent, and joins a stop already in progress", async () => {
    const h = harness();
    await vi.waitFor(() => expect(phases(h.statuses)).toContain("ready"));

    const first = h.lifecycle.stop();
    const second = h.lifecycle.stop();
    expect(second).toBe(first);
    await first;
    await h.lifecycle.stop();
    await h.running;

    expect(h.fake.state.stops).toBe(1);
    expect(phases(h.statuses).filter((p) => p === "stopped")).toHaveLength(1);
  });

  it("stops when told to directly, not only by abort", async () => {
    const h = harness();
    await vi.waitFor(() => expect(phases(h.statuses)).toContain("ready"));
    await h.lifecycle.stop();
    await expect(h.running).resolves.toBeUndefined();
    expect(getRuntime("default")).toBeUndefined();
  });

  it("does not start at all if already aborted", async () => {
    const fake = fakeBridge();
    const lifecycle = new AccountLifecycle({
      account,
      logger,
      dedupe: fakeDedupe(),
      dispatch: async () => {},
      createBridge: () => fake.bridge,
    });
    const controller = new AbortController();
    controller.abort();
    await lifecycle.run(controller.signal);
    expect(fake.state.starts).toBe(0);
  });

  it("kills a child that is still starting when the abort lands", async () => {
    let release!: () => void;
    const holdStart = new Promise<void>((resolve) => (release = resolve));
    const h = harness({ holdStart });
    await vi.waitFor(() => expect(h.fake.state.starts).toBe(1));

    h.controller.abort();
    release();
    await expect(h.running).resolves.toBeUndefined();

    expect(h.fake.state.stops).toBeGreaterThanOrEqual(1);
    expect(h.fake.state.running).toBe(false);
    expect(getRuntime("default")).toBeUndefined();
  });

  /**
   * The gateway can start the successor before a slow stop finishes. A late
   * stop must not tear down the registration that replaced its own.
   */
  it("leaves a successor's registration alone", async () => {
    const h = harness();
    await vi.waitFor(() => expect(phases(h.statuses)).toContain("ready"));

    const successor = { bridge: fakeBridge().bridge, surfaces: new SurfaceTracker() };
    registerRuntime("default", successor);
    h.controller.abort();
    await h.running;

    expect(getRuntime("default")).toBe(successor);
  });

  it("aborts an in-flight agent turn rather than waiting for it", async () => {
    let seenSignal: AbortSignal | undefined;
    const h = harness(
      {},
      {
        dispatch: (_item, scope) => {
          seenSignal = scope.signal;
          // A turn that only ends when it is told to.
          return new Promise<void>((_resolve, reject) =>
            scope.signal.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            }),
          );
        },
      },
    );
    await vi.waitFor(() => expect(h.fake.parkedPolls).toBe(1));
    h.fake.push(message("long task"));
    await vi.waitFor(() => expect(seenSignal).toBeDefined());

    const started = Date.now();
    h.controller.abort();
    await h.running;

    expect(seenSignal?.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("does not wait forever on a dispatch that ignores the abort", async () => {
    let entered = false;
    const h = harness(
      {},
      {
        dispatch: () => {
          entered = true;
          return new Promise<void>(() => {});
        },
        stopGraceMs: 50,
      },
    );
    await vi.waitFor(() => expect(h.fake.parkedPolls).toBe(1));
    h.fake.push(message("stuck"));
    await vi.waitFor(() => expect(entered).toBe(true));

    const started = Date.now();
    h.controller.abort();
    await h.running;

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(getRuntime("default")).toBeUndefined();
  });
});

describe("inbound", () => {
  it("dispatches a message to the agent exactly once", async () => {
    const h = harness();
    await vi.waitFor(() => expect(h.fake.parkedPolls).toBe(1));

    h.fake.push(message("hello agent"));
    await vi.waitFor(() => expect(h.dispatched).toHaveLength(1));

    expect(h.dispatched[0]).toMatchObject({ kind: "message", device: "phone", text: "hello agent" });
    expect(h.scopes[0]?.bridge).toBe(h.fake.bridge);
    // Claimed and committed: a replay of the same batch would be skipped.
    expect(h.dedupe.committed.size).toBe(1);

    // And the pump keeps going afterwards.
    h.fake.push(message("second"));
    await vi.waitFor(() => expect(h.dispatched).toHaveLength(2));
    expect(h.dispatched.map((i) => (i.kind === "message" ? i.text : ""))).toEqual([
      "hello agent",
      "second",
    ]);

    h.controller.abort();
    await h.running;
  });

  it("preserves order within a batch", async () => {
    const h = harness();
    await vi.waitFor(() => expect(h.fake.parkedPolls).toBe(1));
    h.fake.push(message("one"), message("two"), message("three"));
    await vi.waitFor(() => expect(h.dispatched).toHaveLength(3));
    expect(h.dispatched.map((i) => (i.kind === "message" ? i.text : ""))).toEqual([
      "one",
      "two",
      "three",
    ]);
    h.controller.abort();
    await h.running;
  });

  it("does not hand a presence change to the agent, but does record it", async () => {
    const h = harness();
    await vi.waitFor(() => expect(h.fake.parkedPolls).toBe(1));

    h.fake.push({ type: "disconnected", device: "phone" });
    await vi.waitFor(() => expect(h.statuses.some((s) => s.lastEventAt !== undefined)).toBe(true));
    h.fake.push({ type: "connected", device: "phone" });
    await vi.waitFor(() => expect(logs.filter((l) => l.includes("connected")).length).toBe(2));

    expect(h.dispatched).toHaveLength(0);
    expect(logs).toContain("info azula: device 'phone' disconnected");
    expect(logs).toContain("info azula: device 'phone' connected");
    // Not an inbound message, so not counted as one.
    expect(h.statuses.some((s) => s.lastInboundAt !== undefined)).toBe(false);

    h.controller.abort();
    await h.running;
  });

  it("delivers a tap as a choice and resolves its surface", async () => {
    const h = harness();
    await vi.waitFor(() => expect(h.fake.parkedPolls).toBe(1));
    getRuntime("default")?.surfaces.opened("openclaw-azula-1");

    h.fake.push({
      type: "ui_event",
      device: "phone",
      event: {
        action: {
          name: "choose",
          surfaceId: "openclaw-azula-1",
          context: { choice: "approve" },
        },
      },
    });
    await vi.waitFor(() => expect(h.dispatched).toHaveLength(1));

    expect(h.dispatched[0]).toMatchObject({ kind: "choice", value: "approve" });
    expect(h.fake.state.deleted).toEqual(["openclaw-azula-1"]);

    h.controller.abort();
    await h.running;
  });

  it("clears stale controls when the user types instead of tapping", async () => {
    const h = harness();
    await vi.waitFor(() => expect(h.fake.parkedPolls).toBe(1));
    getRuntime("default")?.surfaces.opened("openclaw-azula-old");

    h.fake.push(message("never mind, do it differently"));
    await vi.waitFor(() => expect(h.dispatched).toHaveLength(1));

    expect(h.fake.state.deleted).toEqual(["openclaw-azula-old"]);
    h.controller.abort();
    await h.running;
  });

  it("ignores an item from a device the account does not serve", async () => {
    const h = harness();
    await vi.waitFor(() => expect(h.fake.parkedPolls).toBe(1));

    h.fake.push({ type: "message", device: "someone-else", text: "let me in" }, message("mine"));
    await vi.waitFor(() => expect(h.dispatched).toHaveLength(1));

    expect(h.dispatched[0]).toMatchObject({ text: "mine" });
    expect(logs.some((l) => l.includes("other than 'phone'"))).toBe(true);
    h.controller.abort();
    await h.running;
  });

  it("releases the claim, tells the phone, and carries on when dispatch fails", async () => {
    let calls = 0;
    const h = harness(
      {},
      {
        dispatch: async (item) => {
          calls += 1;
          if (calls === 1) throw new Error("agent exploded");
          void item;
        },
      },
    );
    await vi.waitFor(() => expect(h.fake.parkedPolls).toBe(1));

    h.fake.push(message("will fail"));
    await vi.waitFor(() => expect(h.fake.state.sent).toHaveLength(1));
    expect(h.fake.state.sent[0]).toContain("agent exploded");
    // Not recorded as delivered: it never reached the agent.
    expect(h.dedupe.committed.size).toBe(0);

    // The account is still serving.
    h.fake.push(message("will work"));
    await vi.waitFor(() => expect(calls).toBe(2));
    expect(h.dedupe.committed.size).toBe(1);

    h.controller.abort();
    await h.running;
  });

  /**
   * At-most-once: a dispatch that failed part-way may already have run the
   * agent, so the lifecycle must not re-run it on its own.
   */
  it("does not retry a failed dispatch by itself", async () => {
    let calls = 0;
    const h = harness(
      {},
      {
        dispatch: async () => {
          calls += 1;
          throw new Error("no");
        },
      },
    );
    await vi.waitFor(() => expect(h.fake.parkedPolls).toBe(1));
    h.fake.push(message("once"));
    await vi.waitFor(() => expect(h.fake.state.sent).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(1);
    h.controller.abort();
    await h.running;
  });

  it("reports inbound activity", async () => {
    const h = harness();
    await vi.waitFor(() => expect(h.fake.parkedPolls).toBe(1));
    h.fake.push(message("hi"));
    await vi.waitFor(() => expect(h.statuses.some((s) => s.lastInboundAt !== undefined)).toBe(true));
    h.controller.abort();
    await h.running;
  });
});

describe("recovery", () => {
  it("reconnects when the bridge exits, and resumes inbound", async () => {
    const h = harness();
    await vi.waitFor(() => expect(h.fake.parkedPolls).toBe(1));

    h.fake.crash();
    await vi.waitFor(() => expect(h.fake.state.starts).toBe(2));
    await vi.waitFor(() => expect(phases(h.statuses).filter((p) => p === "ready")).toHaveLength(2));

    expect(phases(h.statuses)).toContain("recovering");
    // Same registration throughout: a send during the outage fails loudly
    // (the bridge is not running) rather than vanishing.
    expect(getRuntime("default")?.bridge).toBe(h.fake.bridge);

    await vi.waitFor(() => expect(h.fake.parkedPolls).toBe(1));
    h.fake.push(message("back again"));
    await vi.waitFor(() => expect(h.dispatched).toHaveLength(1));

    h.controller.abort();
    await h.running;
  });

  it("parks the pump during an outage instead of failing a poll every few seconds", async () => {
    let releaseReconnect!: () => void;
    const reconnectHeld = new Promise<void>((resolve) => (releaseReconnect = resolve));
    const h = harness({ holdStart: undefined }, { pumpErrorBackoffMs: 1 });
    await vi.waitFor(() => expect(h.fake.parkedPolls).toBe(1));

    // Make the next start() block so the outage lasts while we measure.
    const original = h.fake.bridge.start.bind(h.fake.bridge);
    h.fake.bridge.start = async (exit?: () => void) => {
      await reconnectHeld;
      return original(exit);
    };

    h.fake.crash();
    await vi.waitFor(() => expect(phases(h.statuses)).toContain("recovering"));
    const before = h.fake.state.polls;
    await new Promise((r) => setTimeout(r, 100));
    // With a 1ms error back-off an ungated pump would have polled dozens of times.
    expect(h.fake.state.polls - before).toBeLessThanOrEqual(1);

    releaseReconnect();
    await vi.waitFor(() => expect(phases(h.statuses).filter((p) => p === "ready")).toHaveLength(2));
    h.controller.abort();
    await h.running;
  });

  it("forgets surfaces when the session they lived in dies", async () => {
    const h = harness();
    await vi.waitFor(() => expect(h.fake.parkedPolls).toBe(1));
    getRuntime("default")?.surfaces.opened("openclaw-azula-1");
    h.fake.crash();
    await vi.waitFor(() => expect(phases(h.statuses)).toContain("recovering"));
    expect(getRuntime("default")?.surfaces.openSurfaces).toEqual([]);
    h.controller.abort();
    await h.running;
  });

  it("hands the failure to the gateway when recovery keeps failing", async () => {
    const boom = new McpError("spawn storm", "protocol");
    const h = harness(
      { startErrors: [undefined, boom, boom] },
      { reconnect: { baseBackoffMs: 1, maxBackoffMs: 1, maxAttempts: 2, sleep: async () => {} } },
    );
    await vi.waitFor(() => expect(h.fake.parkedPolls).toBe(1));

    h.fake.crash();
    await expect(h.running).rejects.toThrow(/could not be re-established after 2 attempts/);

    // Bounded: two reconnect attempts, not an endless loop.
    expect(h.fake.state.starts).toBe(3);
    expect(getRuntime("default")).toBeUndefined();
    expect(h.statuses.find((s) => s.error?.includes("re-established"))?.phase).toBe("recovering");
  });

  it("blocks, rather than throwing, when the cause turns out to be configuration", async () => {
    const unpaired = new AzulaConfigError("no azula device named 'phone' is paired", "pair it");
    const h = harness({ deviceErrors: [undefined, unpaired] });
    await vi.waitFor(() => expect(h.fake.parkedPolls).toBe(1));

    h.fake.crash();
    await expect(h.running).resolves.toBeUndefined();

    expect(h.statuses.find((s) => s.phase === "blocked")?.error).toContain("pair it");
    expect(getRuntime("default")).toBeUndefined();
    // One reconnect attempt, and no more: it will not fix itself.
    expect(h.fake.state.starts).toBe(2);
  });

  it("ignores the exit of a bridge it is itself replacing", async () => {
    const h = harness();
    await vi.waitFor(() => expect(h.fake.parkedPolls).toBe(1));
    h.fake.crash();
    await vi.waitFor(() => expect(phases(h.statuses).filter((p) => p === "ready")).toHaveLength(2));
    // A late exit notification from the first (stale) child must not start a
    // second recovery on top of the healthy one.
    const starts = h.fake.state.starts;
    h.fake.staleExit();
    await new Promise((r) => setTimeout(r, 30));
    expect(h.fake.state.starts).toBe(starts);
    expect(phases(h.statuses).filter((p) => p === "recovering")).toHaveLength(1);
    h.controller.abort();
    await h.running;
  });
});

/** An account with no `device`: it pairs instead of failing. */
describe("pairing", () => {
  const unpaired: ResolvedAzulaAccount = { ...account, device: undefined };

  /** A pairing harness, with a fast poll and a recorded `adoptDevice`. */
  function pairingHarness(
    bridgeOptions: Parameters<typeof fakeBridge>[0] = {},
    overrides: Partial<LifecycleOptions> = {},
  ) {
    const adopted: string[] = [];
    const created: Array<Parameters<NonNullable<LifecycleOptions["createBridge"]>>[0]> = [];
    const fake = fakeBridge(bridgeOptions);
    const h = harness(bridgeOptions, {
      account: unpaired,
      pairingPollMs: 5,
      adoptDevice: async (device) => {
        adopted.push(device);
        return { persisted: true };
      },
      createBridge: (options) => {
        created.push(options);
        return fake.bridge;
      },
      ...overrides,
    });
    // `harness` built its own fake; the one wired in through `createBridge` is
    // the one the lifecycle drives, so hand back that one.
    return { ...h, fake, adopted, created };
  }

  it("starts without a device and waits for a phone instead of failing", async () => {
    const h = pairingHarness();
    await vi.waitFor(() => expect(phases(h.statuses)).toContain("pairing"));

    expect(phases(h.statuses)).toEqual(["starting", "pairing"]);
    expect(h.lifecycle.phase).toBe("pairing");
    expect(h.lifecycle.device).toBeUndefined();
    // The bridge is up and holds the session, with no device to address yet.
    expect(h.fake.state.running).toBe(true);
    expect(h.created[0]?.device).toBe("");
    // There is no device to be "known", so the unpaired-device check is skipped.
    expect(h.fake.state.assertCalls).toBe(0);
    expect(logs.some((l) => l.startsWith("info") && l.includes("waiting for a phone to pair"))).toBe(true);
    expect(logs.some((l) => l.includes("openclaw channels login --channel azula"))).toBe(true);

    h.controller.abort();
    await h.running;
  });

  it("sends no agent traffic while it waits, and says why a send fails", async () => {
    const h = pairingHarness();
    await vi.waitFor(() => expect(phases(h.statuses)).toContain("pairing"));
    await new Promise((r) => setTimeout(r, 30));

    // Not registered, so nothing can reach a bridge with no device to address...
    expect(getRuntime("default")).toBeUndefined();
    expect(() => requireRuntime("default")).toThrow(/waiting for a phone to pair/);
    expect(() => requireRuntime("default")).toThrow(/openclaw channels login --channel azula/);
    // ...and no inbound pump is draining a device that does not exist.
    expect(h.fake.state.polls).toBe(0);

    h.controller.abort();
    await h.running;
  });

  it("names the account in the login command it points a named account at", async () => {
    const h = pairingHarness({}, { account: { ...unpaired, accountId: "work" } });
    await vi.waitFor(() => expect(phases(h.statuses)).toContain("pairing"));
    expect(logs.some((l) => l.includes("openclaw channels login --channel azula --account work"))).toBe(true);
    h.controller.abort();
    await h.running;
  });

  describe("adopting a phone", () => {
    it("adopts the device that appears in the session's device list", async () => {
      const h = pairingHarness();
      await vi.waitFor(() => expect(phases(h.statuses)).toContain("pairing"));

      h.fake.pair("2a64dea5aaaa");
      await vi.waitFor(() => expect(phases(h.statuses)).toContain("ready"));

      expect(h.adopted).toEqual(["2a64dea5aaaa"]);
      // The bridge is retargeted, so every later send addresses the phone.
      expect(h.fake.state.device).toBe("2a64dea5aaaa");
      expect(h.lifecycle.device).toBe("2a64dea5aaaa");
      expect(h.statuses.find((s) => s.phase === "ready")).toMatchObject({
        phase: "ready",
        device: "2a64dea5aaaa",
        configHint: null,
      });
      // Now an ordinary ready account: reachable for sends, and polling for the phone.
      expect(getRuntime("default")?.bridge).toBe(h.fake.bridge);
      await vi.waitFor(() => expect(h.fake.parkedPolls).toBe(1));
      // Pairing did not need a restart: one child the whole time.
      expect(h.fake.state.starts).toBe(1);
      expect(logs.some((l) => l.includes("paired with device '2a64dea5aaaa'"))).toBe(true);

      h.controller.abort();
      await h.running;
    });

    it("delivers the adopted phone's messages to the agent, scoped to that device", async () => {
      const h = pairingHarness();
      await vi.waitFor(() => expect(phases(h.statuses)).toContain("pairing"));
      h.fake.pair("2a64dea5aaaa");
      await vi.waitFor(() => expect(h.fake.parkedPolls).toBe(1));

      h.fake.push({ type: "message", device: "2a64dea5aaaa", text: "hello" });
      await vi.waitFor(() => expect(h.dispatched).toHaveLength(1));

      expect(h.dispatched[0]).toMatchObject({ kind: "message", text: "hello", device: "2a64dea5aaaa" });
      // The agent is told the device through the scope: the resolved account
      // is only the config as it was at start, and has none.
      expect(h.scopes[0]?.device).toBe("2a64dea5aaaa");

      h.controller.abort();
      await h.running;
    });

    it("ignores a phone the session already knew when pairing began", async () => {
      const h = pairingHarness({ devices: { "already-here": "connected", "someone-elses": "offline" } });
      await vi.waitFor(() => expect(phases(h.statuses)).toContain("pairing"));
      await new Promise((r) => setTimeout(r, 40));

      expect(h.adopted).toEqual([]);
      expect(phases(h.statuses)).not.toContain("ready");
      // It is offered to the operator instead of being adopted silently.
      expect(
        logs.some((l) => l.includes("already-here is already connected to session") && l.includes("openclaw config set channels.azula.device already-here")),
      ).toBe(true);
      expect((await h.lifecycle.pairingInvite()).alreadyPaired).toEqual(["already-here"]);

      h.fake.pair("brand-new");
      await vi.waitFor(() => expect(h.adopted).toEqual(["brand-new"]));

      h.controller.abort();
      await h.running;
    });

    /**
     * azula's device registry is the machine's: a phone that paired with another
     * session (a second account, or `azula pair`) is listed here too, but never
     * connected to this session.
     */
    it("does not adopt a phone that is only listed, because it paired with another session", async () => {
      const h = pairingHarness();
      await vi.waitFor(() => expect(phases(h.statuses)).toContain("pairing"));

      h.fake.pair("another-accounts-phone", "offline");
      await new Promise((r) => setTimeout(r, 40));
      expect(h.adopted).toEqual([]);
      expect(phases(h.statuses)).not.toContain("ready");

      // The phone that really paired with this session is connected to it.
      h.fake.pair("my-phone", "connected");
      await vi.waitFor(() => expect(h.adopted).toEqual(["my-phone"]));

      h.controller.abort();
      await h.running;
    });

    it("adopts a known phone that was offline and has now connected", async () => {
      const h = pairingHarness({ devices: { "old-phone": "disconnected" } });
      await vi.waitFor(() => expect(phases(h.statuses)).toContain("pairing"));

      h.fake.pair("old-phone", "connected");
      await vi.waitFor(() => expect(h.adopted).toEqual(["old-phone"]));

      h.controller.abort();
      await h.running;
    });

    it("takes only one phone: a second pairing is left alone", async () => {
      const h = pairingHarness();
      await vi.waitFor(() => expect(phases(h.statuses)).toContain("pairing"));
      h.fake.pair("first");
      await vi.waitFor(() => expect(phases(h.statuses)).toContain("ready"));

      h.fake.pair("second");
      await new Promise((r) => setTimeout(r, 40));

      expect(h.adopted).toEqual(["first"]);
      expect(h.lifecycle.device).toBe("first");
      expect(h.fake.state.device).toBe("first");

      h.controller.abort();
      await h.running;
    });

    it("keeps what the session knew across a reconnect, so a phone paired during the outage still counts", async () => {
      const h = pairingHarness();
      await vi.waitFor(() => expect(phases(h.statuses)).toContain("pairing"));

      h.fake.crash();
      h.fake.pair("paired-during-outage");
      await vi.waitFor(() => expect(h.adopted).toEqual(["paired-during-outage"]));

      h.controller.abort();
      await h.running;
    });

    it("goes back to waiting, not to ready, after the bridge is re-established", async () => {
      const h = pairingHarness();
      await vi.waitFor(() => expect(phases(h.statuses)).toContain("pairing"));

      h.fake.crash();
      await vi.waitFor(() => expect(phases(h.statuses)).toEqual(["starting", "pairing", "recovering", "pairing"]));
      // Recovered without a device: it must still check nothing it cannot.
      expect(h.fake.state.assertCalls).toBe(0);
      expect(phases(h.statuses)).not.toContain("ready");

      h.controller.abort();
      await h.running;
    });
  });

  describe("remembering the phone", () => {
    it("asks for it to be saved, and publishes no hint when it was", async () => {
      const h = pairingHarness();
      await vi.waitFor(() => expect(phases(h.statuses)).toContain("pairing"));
      h.fake.pair("phone-1");
      await vi.waitFor(() => expect(phases(h.statuses)).toContain("ready"));

      expect(h.adopted).toEqual(["phone-1"]);
      expect(h.statuses.find((s) => s.phase === "ready")?.configHint).toBeNull();
      expect(logs.some((l) => l.includes("saved device 'phone-1'"))).toBe(true);

      h.controller.abort();
      await h.running;
    });

    it("serves the phone anyway, and says how to save it, when it could not be saved", async () => {
      const h = pairingHarness(
        {},
        { adoptDevice: async () => ({ persisted: false, configHint: "openclaw config set channels.azula.device phone-1" }) },
      );
      await vi.waitFor(() => expect(phases(h.statuses)).toContain("pairing"));
      h.fake.pair("phone-1");
      await vi.waitFor(() => expect(phases(h.statuses)).toContain("ready"));

      expect(h.statuses.find((s) => s.phase === "ready")).toMatchObject({
        device: "phone-1",
        configHint: "openclaw config set channels.azula.device phone-1",
      });
      expect(getRuntime("default")).toBeDefined();
      expect(
        logs.some((l) => l.startsWith("warn") && l.includes("not saved in the config") && l.includes("openclaw config set channels.azula.device phone-1")),
      ).toBe(true);

      h.controller.abort();
      await h.running;
    });

    it("falls back to the exact set line when saving throws, and still goes ready", async () => {
      const h = pairingHarness(
        {},
        {
          account: { ...unpaired, accountId: "work" },
          adoptDevice: async () => {
            throw new Error("config is locked");
          },
        },
      );
      await vi.waitFor(() => expect(phases(h.statuses)).toContain("pairing"));
      h.fake.pair("phone-w");
      await vi.waitFor(() => expect(phases(h.statuses)).toContain("ready"));

      expect(h.statuses.find((s) => s.phase === "ready")?.configHint).toBe(
        "openclaw config set channels.azula.accounts.work.device phone-w",
      );
      expect(logs.some((l) => l.includes("config is locked"))).toBe(true);

      h.controller.abort();
      await h.running;
    });

    it("with no way to save at all, shows the set line rather than pretending", async () => {
      const h = pairingHarness({}, { adoptDevice: undefined as never });
      await vi.waitFor(() => expect(phases(h.statuses)).toContain("pairing"));
      h.fake.pair("phone-1");
      await vi.waitFor(() => expect(phases(h.statuses)).toContain("ready"));
      expect(h.statuses.find((s) => s.phase === "ready")?.configHint).toBe(
        "openclaw config set channels.azula.device phone-1",
      );
      h.controller.abort();
      await h.running;
    });

    it("keeps publishing the hint when the account recovers, until the device is saved", async () => {
      const h = pairingHarness({}, { adoptDevice: async () => ({ persisted: false, configHint: "SAVE-ME" }) });
      await vi.waitFor(() => expect(phases(h.statuses)).toContain("pairing"));
      h.fake.pair("phone-1");
      await vi.waitFor(() => expect(phases(h.statuses)).toContain("ready"));

      h.fake.crash();
      await vi.waitFor(() => expect(phases(h.statuses).filter((p) => p === "ready")).toHaveLength(2));
      expect(h.statuses.filter((s) => s.phase === "ready").map((s) => s.configHint)).toEqual(["SAVE-ME", "SAVE-ME"]);
      // A device that is adopted is checked on reconnect like any configured one.
      expect(h.fake.state.assertCalls).toBe(1);

      h.controller.abort();
      await h.running;
    });
  });

  describe("the invite", () => {
    it("mints azula's own invite from the account's bridge while it waits", async () => {
      const h = pairingHarness();
      await vi.waitFor(() => expect(phases(h.statuses)).toContain("pairing"));

      const { invite, alreadyPaired } = await h.lifecycle.pairingInvite();

      expect(invite).toContain("https://azula.app/i/abc");
      expect(alreadyPaired).toEqual([]);
      expect(h.fake.state.invites).toBe(1);

      h.controller.abort();
      await h.running;
    });

    it("refuses once the account has a phone, naming it", async () => {
      const h = pairingHarness();
      await vi.waitFor(() => expect(phases(h.statuses)).toContain("pairing"));
      h.fake.pair("phone-1");
      await vi.waitFor(() => expect(phases(h.statuses)).toContain("ready"));

      await expect(h.lifecycle.pairingInvite()).rejects.toThrow(/already serves device 'phone-1'/);
      expect(h.fake.state.invites).toBe(0);

      h.controller.abort();
      await h.running;
    });

    it("lets a caller wait for the adoption, and hands them the outcome", async () => {
      const h = pairingHarness();
      await vi.waitFor(() => expect(phases(h.statuses)).toContain("pairing"));

      const waiting = h.lifecycle.waitForAdoption(5_000);
      h.fake.pair("phone-1");

      await expect(waiting).resolves.toEqual({ device: "phone-1", persisted: true });
      // Later callers get the same answer rather than waiting forever.
      await expect(h.lifecycle.waitForAdoption(5_000)).resolves.toMatchObject({ device: "phone-1" });

      h.controller.abort();
      await h.running;
    });

    it("gives up waiting when no phone pairs in time", async () => {
      const h = pairingHarness();
      await vi.waitFor(() => expect(phases(h.statuses)).toContain("pairing"));
      await expect(h.lifecycle.waitForAdoption(20)).resolves.toBeNull();
      h.controller.abort();
      await h.running;
    });

    it("releases a waiter when the account stops, rather than leaving it hanging", async () => {
      const h = pairingHarness();
      await vi.waitFor(() => expect(phases(h.statuses)).toContain("pairing"));
      const waiting = h.lifecycle.waitForAdoption(60_000);
      h.controller.abort();
      await h.running;
      await expect(waiting).resolves.toBeNull();
    });
  });

  it("stops promptly while waiting, and leaves no bridge behind", async () => {
    const h = pairingHarness();
    await vi.waitFor(() => expect(phases(h.statuses)).toContain("pairing"));

    const started = Date.now();
    h.controller.abort();
    await h.running;

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(h.fake.state.running).toBe(false);
    expect(phases(h.statuses).at(-1)).toBe("stopped");
    expect(getRuntime("default")).toBeUndefined();
  });

  it("does not adopt a phone that appears after the account has stopped", async () => {
    const h = pairingHarness();
    await vi.waitFor(() => expect(phases(h.statuses)).toContain("pairing"));
    h.controller.abort();
    await h.running;
    h.fake.pair("too-late");
    await new Promise((r) => setTimeout(r, 30));
    expect(h.adopted).toEqual([]);
  });
});

/**
 * A configured `device` the session is not paired with is still terminal, but
 * its fix is now the channel's own login rather than a hand-edit.
 */
describe("a configured device that is not paired", () => {
  it("blocks with a fix that points at the login command, and does not ask for a restart", async () => {
    const h = harness({ deviceErrors: [new DeviceNotPairedError("phone")] });
    await expect(h.running).resolves.toBeUndefined();

    const blocked = h.statuses.find((s) => s.phase === "blocked");
    expect(blocked?.error).toContain("no azula device named 'phone' is paired");
    expect(blocked?.error).toContain("`openclaw channels login --channel azula`");
    expect(blocked?.error).toContain("`channels.azula.device`");
    // Login restarts the account itself; asking for a restart as well would contradict it.
    expect(blocked?.error).toContain("starts by itself");
    expect(blocked?.error).not.toMatch(/then restart/);
    expect(getRuntime("default")).toBeUndefined();
    expect(h.fake.state.running).toBe(false);
  });

  it("names the account for a named one", async () => {
    const h = harness(
      { deviceErrors: [new DeviceNotPairedError("work-phone")] },
      { account: { ...account, accountId: "work", device: "work-phone" } },
    );
    await expect(h.running).resolves.toBeUndefined();
    const error = h.statuses.find((s) => s.phase === "blocked")?.error;
    expect(error).toContain("openclaw channels login --channel azula --account work");
    expect(error).toContain("channels.azula.accounts.work.device");
  });

  it("keeps the old advice for every other configuration problem", async () => {
    const h = harness({ startErrors: [new AzulaConfigError("the azula binary could not be run", "install it")] });
    await expect(h.running).resolves.toBeUndefined();
    expect(h.statuses.find((s) => s.phase === "blocked")?.error).toMatch(/then restart the azula channel/);
  });
});
