import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AzulaBridge, BridgeOptions } from "./bridge.js";
import { McpError } from "./mcp-client.js";
import {
  findNewDevice,
  NO_DEVICE_YET,
  PairingSession,
  parseDeviceLines,
  watchForDevice,
} from "./pairing.js";

const logs: string[] = [];
const logger = {
  debug: (m: string) => void logs.push(`debug ${m}`),
  info: (m: string) => void logs.push(`info ${m}`),
  warn: (m: string) => void logs.push(`warn ${m}`),
  error: (m: string) => void logs.push(`error ${m}`),
};

const PHONE = "2a64dea5aa5ae9bf56b44bb15bfa1ea8e98e5b3a9c33c4ab6bc4bbfa7e1c6a8d";

describe("parseDeviceLines", () => {
  /** Real `list_devices` output from azula 0.3.0. */
  it("reads the rows list_devices prints", () => {
    const listing = `Known devices:\n  bridge-12072255  [12072255…]  connected\n  ${PHONE}  [2a64dea5…]  offline`;
    expect([...parseDeviceLines(listing.split("\n"))]).toEqual([
      ["bridge-12072255", "connected"],
      [PHONE, "offline"],
    ]);
  });

  it("reads trimmed lines, as the bridge hands them over", () => {
    expect([...parseDeviceLines(["phone  [abc123…]  disconnected"])]).toEqual([["phone", "disconnected"]]);
  });

  it("finds no devices in the heading or in the empty case", () => {
    expect(parseDeviceLines(["Known devices:"]).size).toBe(0);
    expect(parseDeviceLines(["No devices registered. Use `connect` to add one."]).size).toBe(0);
    expect(parseDeviceLines([]).size).toBe(0);
  });
});

describe("findNewDevice", () => {
  const table = (rows: Record<string, string>) => new Map(Object.entries(rows));

  it("sees a phone that has appeared and is connected to this session", () => {
    expect(findNewDevice(table({}), table({ [PHONE]: "connected" }))).toBe(PHONE);
    expect(findNewDevice(table({ a: "connected" }), table({ a: "connected", b: "connected" }))).toBe("b");
  });

  it("sees a phone that connected and dropped again between two looks", () => {
    expect(findNewDevice(table({}), table({ quick: "disconnected" }))).toBe("quick");
    expect(findNewDevice(table({ quick: "offline" }), table({ quick: "disconnected" }))).toBe("quick");
  });

  it("sees a known phone that has just connected", () => {
    expect(findNewDevice(table({ a: "disconnected" }), table({ a: "connected" }))).toBe("a");
    expect(findNewDevice(table({ a: "offline" }), table({ a: "connected" }))).toBe("a");
  });

  /**
   * azula's registry belongs to the machine: a phone paired with another
   * session (or imported with `azula pair`) appears in this session's list too,
   * but `offline`, because this session has never dialed or accepted it.
   */
  it("ignores a row that appeared without this session ever seeing it, which is another session's phone", () => {
    expect(findNewDevice(table({}), table({ other: "offline" }))).toBeUndefined();
    expect(findNewDevice(table({ a: "connected" }), table({ a: "connected", other: "offline" }))).toBeUndefined();
  });

  it("waits for that row to connect, and then sees it", () => {
    expect(findNewDevice(table({ other: "offline" }), table({ other: "connected" }))).toBe("other");
  });

  it("sees nothing when nothing changed, or a phone merely went away", () => {
    expect(findNewDevice(table({ a: "connected" }), table({ a: "connected" }))).toBeUndefined();
    expect(findNewDevice(table({ a: "connected" }), table({ a: "disconnected" }))).toBeUndefined();
    expect(findNewDevice(table({ a: "disconnected" }), table({ a: "disconnected" }))).toBeUndefined();
    expect(findNewDevice(table({ a: "connected" }), table({}))).toBeUndefined();
  });
});

describe("watchForDevice", () => {
  /** A clock the fake sleep drives, so no test waits in real time. */
  function clock() {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms), elapsed: () => t };
  }

  it("returns the phone as soon as the list shows one", async () => {
    const c = clock();
    let calls = 0;
    const found = await watchForDevice({
      list: async () => (++calls < 3 ? ["No devices registered."] : [`${PHONE}  [2a64dea5…]  connected`]),
      baseline: new Map(),
      ...c,
    });
    expect(found).toBe(PHONE);
    expect(calls).toBe(3);
  });

  it("ignores what the baseline already had", async () => {
    const c = clock();
    const found = await watchForDevice({
      list: async () => ["old  [aaaaaaaa…]  connected"],
      baseline: new Map([["old", "connected"]]),
      timeoutMs: 10_000,
      ...c,
    });
    expect(found).toBeNull();
    expect(c.elapsed()).toBeGreaterThanOrEqual(10_000);
  });

  it("keeps watching through a bridge that is briefly down", async () => {
    const c = clock();
    let calls = 0;
    const found = await watchForDevice({
      list: async () => {
        if (++calls < 3) throw new McpError("azula bridge is not running", "closed");
        return ["p  [pppppppp…]  connected"];
      },
      baseline: new Map(),
      ...c,
    });
    expect(found).toBe("p");
  });

  it("gives up at the deadline", async () => {
    const c = clock();
    const found = await watchForDevice({ list: async () => [], baseline: new Map(), timeoutMs: 5_000, ...c });
    expect(found).toBeNull();
    expect(c.elapsed()).toBe(5_000);
  });

  it("stops when told to, without a phone", async () => {
    const controller = new AbortController();
    const found = watchForDevice({
      list: async () => [],
      baseline: new Map(),
      signal: controller.signal,
      intervalMs: 5,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(found).resolves.toBeNull();
  });

  it("does not poll at all if already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const list = vi.fn(async () => [] as string[]);
    await expect(watchForDevice({ list, baseline: new Map(), signal: controller.signal })).resolves.toBeNull();
    expect(list).not.toHaveBeenCalled();
  });
});

describe("PairingSession", () => {
  beforeEach(() => {
    logs.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function fakeBridge(options: { startError?: Error; devices?: Record<string, string> } = {}) {
    const state = {
      starts: 0,
      stops: 0,
      invites: 0,
      devices: new Map(Object.entries(options.devices ?? {})),
      built: undefined as BridgeOptions | undefined,
    };
    const bridge = {
      start: async () => {
        state.starts += 1;
        if (options.startError) throw options.startError;
      },
      stop: async () => void (state.stops += 1),
      listDevices: async () => [...state.devices].map(([n, s]) => `${n}  [${n.slice(0, 8)}…]  ${s}`),
      pairingInvite: async () => {
        state.invites += 1;
        return "https://azula.app/i/x";
      },
    };
    const create = (o: BridgeOptions) => {
      state.built = o;
      return bridge as unknown as AzulaBridge;
    };
    return { state, create };
  }

  const bridgeOptions: BridgeOptions = {
    binary: "azula",
    session: "openclaw",
    label: "OpenClaw",
    device: NO_DEVICE_YET,
    logger,
  };

  it("opens the account's own session, notes what it already knew, and returns azula's invite", async () => {
    const f = fakeBridge({ devices: { known: "connected", "another-sessions-phone": "offline" } });
    const session = new PairingSession({ bridge: bridgeOptions, createBridge: f.create, logger });

    await expect(session.open()).resolves.toBe("https://azula.app/i/x");

    expect(f.state.built).toMatchObject({ session: "openclaw", label: "OpenClaw", device: "" });
    // Only a phone connected to this session is known to belong to it; the rest of
    // azula's (machine-wide) list could be paired with anything.
    expect(session.alreadyPaired).toEqual(["known"]);
    await session.close();
  });

  it("waits for the phone and reports it", async () => {
    const f = fakeBridge();
    const session = new PairingSession({ bridge: bridgeOptions, createBridge: f.create, logger, intervalMs: 5 });
    await session.open();

    const waiting = session.waitForDevice(5_000);
    f.state.devices.set(PHONE, "connected");

    await expect(waiting).resolves.toBe(PHONE);
    await session.close();
  });

  it("reports no phone when the wait runs out, and stays open for another try", async () => {
    const f = fakeBridge();
    const session = new PairingSession({ bridge: bridgeOptions, createBridge: f.create, logger, intervalMs: 5 });
    await session.open();

    await expect(session.waitForDevice(30)).resolves.toBeNull();
    expect(session.closed).toBe(false);
    f.state.devices.set(PHONE, "connected");
    await expect(session.waitForDevice(1_000)).resolves.toBe(PHONE);
    await session.close();
  });

  it("releases the azula session on close, once", async () => {
    const f = fakeBridge();
    const session = new PairingSession({ bridge: bridgeOptions, createBridge: f.create, logger });
    await session.open();
    await session.close();
    await session.close();
    expect(f.state.stops).toBe(1);
    expect(session.closed).toBe(true);
    await expect(session.waitForDevice(10)).resolves.toBeNull();
  });

  it("does not leave a session held when opening fails", async () => {
    const f = fakeBridge({ startError: new McpError("could not run 'azula'", "spawn") });
    const session = new PairingSession({ bridge: bridgeOptions, createBridge: f.create, logger });
    await expect(session.open()).rejects.toThrow(/could not run/);
    expect(f.state.stops).toBe(1);
    expect(session.closed).toBe(true);
  });

  /** An abandoned `channels login` must not hold the account's session for good. */
  it("closes itself after a stretch of silence", async () => {
    vi.useFakeTimers();
    const f = fakeBridge();
    const expired = vi.fn();
    const session = new PairingSession({
      bridge: bridgeOptions,
      createBridge: f.create,
      logger,
      ttlMs: 60_000,
      onExpire: expired,
    });
    await session.open();

    await vi.advanceTimersByTimeAsync(59_000);
    expect(session.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(session.closed).toBe(true);
    expect(f.state.stops).toBe(1);
    expect(expired).toHaveBeenCalledOnce();
  });

  it("counts a wait as activity, so a patient operator is not cut off", async () => {
    vi.useFakeTimers();
    const f = fakeBridge();
    const session = new PairingSession({
      bridge: bridgeOptions,
      createBridge: f.create,
      logger,
      ttlMs: 60_000,
      intervalMs: 1_000,
    });
    await session.open();

    await vi.advanceTimersByTimeAsync(50_000);
    const waiting = session.waitForDevice(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await waiting;
    // 80s since open, but only 0s since the last wait began + 30s of it: still alive.
    expect(session.closed).toBe(false);
    await session.close();
  });
});
