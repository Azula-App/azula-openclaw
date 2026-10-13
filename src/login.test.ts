import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AzulaConfigError, type AzulaBridge, type BridgeOptions } from "./bridge.js";
import type { AccountLifecycle } from "./lifecycle.js";
import { LoginCoordinator, runLogin, type CallGateway } from "./login.js";
import { McpError } from "./mcp-client.js";
import type { Sdk } from "./sdk.js";

const logs: string[] = [];
const logger = {
  debug: (m: string) => void logs.push(`debug ${m}`),
  info: (m: string) => void logs.push(`info ${m}`),
  warn: (m: string) => void logs.push(`warn ${m}`),
  error: (m: string) => void logs.push(`error ${m}`),
};

const INVITE = "https://azula.app/i/abc123\n\n```\n    ▄▄▄ qr ▄▄▄\n    ▀▀▀ qr ▀▀▀\n```\n\nScan with your phone's camera.";
const PHONE = "2a64dea5aa5ae9bf56b44bb15bfa1ea8e98e5b3a9c33c4ab6bc4bbfa7e1c6a8d";

type Cfg = Record<string, any>;

/** The SDK slice the coordinator and persistence use, over an in-memory config. */
function fakeSdk(initial: Cfg, options: { writesAllowed?: boolean } = {}) {
  const state = { config: structuredClone(initial) };
  const sdk = {
    getRuntimeConfig: () => state.config,
    resolveChannelConfigWrites: () => options.writesAllowed ?? true,
    mutateConfigFile: async (params: { mutate: (draft: Cfg) => unknown }) => {
      const draft = structuredClone(state.config);
      const result = params.mutate(draft);
      state.config = draft;
      return { result };
    },
  } as unknown as Sdk;
  return { sdk, state };
}

/** A lifecycle as the coordinator sees one. */
function fakeLifecycle(options: {
  device?: string | undefined;
  phase?: string;
  session?: string;
  invite?: () => Promise<{ invite: string; alreadyPaired: string[] }>;
  adoption?: () => Promise<unknown>;
}) {
  return {
    device: options.device,
    phase: options.phase ?? (options.device === undefined ? "pairing" : "ready"),
    account: { accountId: "default", session: options.session ?? "openclaw" },
    pairingInvite: options.invite ?? (async () => ({ invite: INVITE, alreadyPaired: [] })),
    waitForAdoption: options.adoption ?? (async () => null),
  } as unknown as AccountLifecycle;
}

/** The temporary session's bridge, with a device list the test controls. */
function fakeBridges() {
  const state = {
    built: [] as BridgeOptions[],
    starts: 0,
    stops: 0,
    devices: new Map<string, string>(),
    startError: undefined as Error | undefined,
  };
  const createBridge = (options: BridgeOptions) => {
    state.built.push(options);
    return {
      start: async () => {
        state.starts += 1;
        if (state.startError) throw state.startError;
      },
      stop: async () => void (state.stops += 1),
      listDevices: async () => [...state.devices].map(([n, s]) => `${n}  [${n.slice(0, 8)}…]  ${s}`),
      pairingInvite: async () => INVITE,
    } as unknown as AzulaBridge;
  };
  return { state, createBridge };
}

function coordinator(options: {
  config: Cfg;
  live?: Map<string, AccountLifecycle>;
  writesAllowed?: boolean;
  bridges?: ReturnType<typeof fakeBridges>;
  sessionTtlMs?: number;
}) {
  const sdk = fakeSdk(options.config, { writesAllowed: options.writesAllowed ?? true });
  const bridges = options.bridges ?? fakeBridges();
  const live = options.live ?? new Map();
  const login = new LoginCoordinator({
    live,
    loadSdk: async () => sdk.sdk,
    logger,
    createBridge: bridges.createBridge,
    pollMs: 5,
    ...(options.sessionTtlMs === undefined ? {} : { sessionTtlMs: options.sessionTtlMs }),
  });
  return { login, sdk, bridges, live };
}

beforeEach(() => {
  logs.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("asking the gateway for the invite", () => {
  describe("while the account is running and waiting for a phone", () => {
    it("answers with azula's own invite, from the account's own session", async () => {
      const live = new Map([["default", fakeLifecycle({ device: undefined })]]);
      const { login, bridges } = coordinator({ config: { channels: { azula: {} } }, live });

      const result = await login.start({ accountId: undefined });

      expect(result.connected).toBe(false);
      expect(result.sessionKey).toBe("default");
      // The URL and the QR, with the markdown fence and azula's own footer dropped.
      expect(result.message).toContain("Pair a phone with azula (account 'default', session 'openclaw').");
      expect(result.message).toContain("https://azula.app/i/abc123");
      expect(result.message).toContain("▄▄▄ qr ▄▄▄\n    ▀▀▀ qr ▀▀▀");
      expect(result.message).not.toContain("```");
      expect(result.message).toContain('tap "+ connect a peer"');
      // The running account answered; nothing else opened the session.
      expect(bridges.state.starts).toBe(0);
    });

    it("tells the operator about phones this session already has", async () => {
      const live = new Map([
        ["default", fakeLifecycle({ device: undefined, invite: async () => ({ invite: INVITE, alreadyPaired: ["old-phone"] }) })],
      ]);
      const { login } = coordinator({ config: { channels: { azula: {} } }, live });

      const { message } = await login.start({ accountId: "default" });

      expect(message).toContain("A phone is already connected to this session: old-phone.");
      expect(message).toContain("openclaw config set channels.azula.device old-phone");
    });

    it("reports a failure to mint the invite as an error that names the account", async () => {
      const live = new Map([
        ["default", fakeLifecycle({ device: undefined, invite: async () => { throw new McpError("start_pairing failed", "tool"); } })],
      ]);
      const { login } = coordinator({ config: { channels: { azula: {} } }, live });
      await expect(login.start({ accountId: "default" })).rejects.toThrow(
        /could not mint azula's invite for account 'default': start_pairing failed/,
      );
    });
  });

  /**
   * The gateway's `force` stops the channel first and starts it again after the
   * login unless the login returned a QR image. azula has none to return, so a
   * forced login must not open a session the restart would immediately close.
   */
  describe("with force", () => {
    it("answers without opening a session, so the channel the gateway restarts is left alone", async () => {
      const { login, bridges } = coordinator({ config: { channels: { azula: { enabled: true } } } });

      const result = await login.start({ accountId: "default", force: true });

      expect(result.connected).toBe(true);
      expect(result.message).toContain("`force` does not re-pair");
      expect(result.message).toContain("openclaw config unset channels.azula.device");
      expect(result.message).toContain("openclaw channels login --channel azula");
      expect(bridges.state.starts).toBe(0);
    });

    it("names a named account's own path", async () => {
      const { login } = coordinator({ config: {} });
      const result = await login.start({ accountId: "work", force: true });
      expect(result.message).toContain("openclaw config unset channels.azula.accounts.work.device");
    });
  });

  describe("when the account already has a phone", () => {
    it("does not mint a second invite, and says how to replace the phone", async () => {
      const live = new Map([["work", fakeLifecycle({ device: "work-phone" })]]);
      const { login } = coordinator({ config: { channels: { azula: { accounts: { work: { device: "work-phone" } } } } }, live });

      const result = await login.start({ accountId: "work" });

      expect(result.connected).toBe(true);
      expect(result.message).toContain("already serves device 'work-phone'");
      expect(result.message).toContain("openclaw config unset channels.azula.accounts.work.device");
      expect(result.message).toContain("openclaw channels login --channel azula --account work");
    });
  });

  describe("when the account is not running", () => {
    const configured = { channels: { azula: { enabled: true, binary: "/opt/azula", label: "Bot" } } };

    it("opens the account's session just for the pairing, as the account would", async () => {
      const { login, bridges } = coordinator({ config: configured });

      const result = await login.start({ accountId: undefined });

      expect(bridges.state.built[0]).toMatchObject({ binary: "/opt/azula", session: "openclaw", label: "Bot", device: "" });
      expect(bridges.state.starts).toBe(1);
      expect(result.connected).toBe(false);
      expect(result.message).toContain("https://azula.app/i/abc123");
    });

    it("uses a named account's own session", async () => {
      const cfg = { channels: { azula: { accounts: { work: { enabled: true } } } } };
      const { login, bridges } = coordinator({ config: cfg });
      await login.start({ accountId: "work" });
      expect(bridges.state.built[0]).toMatchObject({ session: "openclaw-work" });
    });

    it("says what will be replaced when the account names a device that is not paired", async () => {
      const cfg = { channels: { azula: { device: "typo-phone" } } };
      const { login } = coordinator({ config: cfg });
      const { message } = await login.start({ accountId: "default" });
      expect(message).toContain("will replace the configured device 'typo-phone'");
    });

    it("replaces an earlier pairing session instead of holding two", async () => {
      const { login, bridges } = coordinator({ config: configured });
      await login.start({ accountId: "default" });
      await login.start({ accountId: "default" });
      expect(bridges.state.starts).toBe(2);
      expect(bridges.state.stops).toBe(1);
    });

    it("refuses an account that is not configured at all, and says how to start", async () => {
      const { login } = coordinator({ config: {} });
      await expect(login.start({ accountId: "default" })).rejects.toThrow(/openclaw config set channels.azula.enabled true/);
    });

    it("refuses a disabled account", async () => {
      const { login, bridges } = coordinator({ config: { channels: { azula: { enabled: false } } } });
      await expect(login.start({ accountId: "default" })).rejects.toThrow(/is disabled/);
      expect(bridges.state.starts).toBe(0);
    });

    it("refuses an account that does not exist", async () => {
      const { login } = coordinator({ config: configured });
      await expect(login.start({ accountId: "nope" })).rejects.toThrow(/no azula account named 'nope'/);
    });

    it("reports a missing or too-old azula with its fix, and holds nothing", async () => {
      const bridges = fakeBridges();
      bridges.state.startError = new AzulaConfigError("the azula binary could not be run ('azula')", "install it");
      const { login } = coordinator({ config: configured, bridges });

      await expect(login.start({ accountId: "default" })).rejects.toThrow(/could not be run[\s\S]*install it/);
      expect(bridges.state.stops).toBe(1);
    });
  });
});

describe("waiting for the phone", () => {
  describe("on a running account", () => {
    it("reports the phone it adopted", async () => {
      const live = new Map([
        ["default", fakeLifecycle({ device: undefined, adoption: async () => ({ device: PHONE, persisted: true }) })],
      ]);
      const { login } = coordinator({ config: {}, live });

      const result = await login.wait({ accountId: undefined, timeoutMs: 1_000 });

      expect(result.connected).toBe(true);
      expect(result.message).toBe(`Paired with device '${PHONE}'.`);
    });

    it("says how to save the phone when it could not be saved", async () => {
      const live = new Map([
        [
          "default",
          fakeLifecycle({
            device: undefined,
            adoption: async () => ({ device: "p", persisted: false, configHint: "openclaw config set channels.azula.device p" }),
          }),
        ],
      ]);
      const { login } = coordinator({ config: {}, live });
      const result = await login.wait({ accountId: "default", timeoutMs: 1_000 });
      expect(result.connected).toBe(true);
      expect(result.message).toContain("will be forgotten on restart; run: openclaw config set channels.azula.device p");
    });

    it("keeps waiting when no phone has paired yet", async () => {
      const live = new Map([["default", fakeLifecycle({ device: undefined })]]);
      const { login } = coordinator({ config: {}, live });
      const result = await login.wait({ accountId: "default", timeoutMs: 10 });
      expect(result).toEqual({ connected: false, message: "Still waiting for a phone to pair with account 'default'." });
    });

    /**
     * Saving the phone makes the gateway reload the channel, which stops this
     * account; the wait can be released by that stop rather than by the adoption.
     */
    it("counts a stop that follows an adoption as the pairing working", async () => {
      // The phone is adopted while the wait is parked, and the stop releases it.
      const lifecycle = fakeLifecycle({
        device: undefined,
        phase: "pairing",
        adoption: async () => {
          Object.assign(lifecycle, { device: "phone-1", phase: "stopped" });
          return null;
        },
      });
      const { login } = coordinator({ config: {}, live: new Map([["default", lifecycle]]) });

      await expect(login.wait({ accountId: "default", timeoutMs: 10 })).resolves.toEqual({
        connected: true,
        message: "Paired with device 'phone-1'. Account 'default' is restarting with it.",
      });
    });

    it("gives up, as an error, when the account stopped under the wait", async () => {
      const lifecycle = fakeLifecycle({
        device: undefined,
        phase: "pairing",
        adoption: async () => {
          Object.assign(lifecycle, { phase: "stopped" });
          return null;
        },
      });
      const { login } = coordinator({ config: {}, live: new Map([["default", lifecycle]]) });
      await expect(login.wait({ accountId: "default", timeoutMs: 10 })).rejects.toThrow(/stopped before a phone paired/);
    });

    /** A lifecycle on its way out of the gateway's table holds no session; a login must not use it. */
    it("does not treat an account that has already stopped as running", async () => {
      const live = new Map([["default", fakeLifecycle({ device: undefined, phase: "stopped" })]]);
      const { login, bridges } = coordinator({ config: { channels: { azula: { enabled: true } } }, live });

      const started = await login.start({ accountId: "default" });

      // It opened the session itself instead of asking a lifecycle that cannot answer.
      expect(bridges.state.starts).toBe(1);
      expect(started.message).toContain("https://azula.app/i/abc123");
      await expect(login.wait({ accountId: "default", timeoutMs: 5 })).resolves.toMatchObject({ connected: false });
    });

    it("answers at once for an account that has a phone", async () => {
      const live = new Map([["default", fakeLifecycle({ device: "phone" })]]);
      const { login } = coordinator({ config: {}, live });
      await expect(login.wait({ accountId: "default" })).resolves.toMatchObject({ connected: true });
    });
  });

  describe("on a temporary pairing session", () => {
    const configured = { channels: { azula: { enabled: true, device: "typo-phone" } } };

    it("saves the phone as the account's device, hands the session back, and says the account is starting", async () => {
      const { login, bridges, sdk } = coordinator({ config: configured });
      await login.start({ accountId: "default" });

      const waiting = login.wait({ accountId: "default", timeoutMs: 5_000 });
      bridges.state.devices.set(PHONE, "connected");
      const result = await waiting;

      expect(result.connected).toBe(true);
      expect(result.message).toContain(`Paired with device '${PHONE}' and saved it as channels.azula.device. Starting account 'default'.`);
      // The unpaired device it replaced is gone.
      expect(sdk.state.config.channels.azula.device).toBe(PHONE);
      // The azula session is released before the account is started on top of it.
      expect(bridges.state.stops).toBe(1);
    });

    it("saves into a named account's own entry", async () => {
      const cfg = { channels: { azula: { device: "phone", accounts: { work: { enabled: true } } } } };
      const { login, bridges, sdk } = coordinator({ config: cfg });
      await login.start({ accountId: "work" });
      const waiting = login.wait({ accountId: "work", timeoutMs: 5_000 });
      bridges.state.devices.set("w-phone", "connected");
      await waiting;
      expect(sdk.state.config.channels.azula.device).toBe("phone");
      expect(sdk.state.config.channels.azula.accounts.work.device).toBe("w-phone");
    });

    it("keeps waiting, with the session open, until the phone pairs", async () => {
      const { login, bridges } = coordinator({ config: configured });
      await login.start({ accountId: "default" });

      await expect(login.wait({ accountId: "default", timeoutMs: 20 })).resolves.toMatchObject({ connected: false });
      expect(bridges.state.stops).toBe(0);

      const waiting = login.wait({ accountId: "default", timeoutMs: 5_000 });
      bridges.state.devices.set(PHONE, "connected");
      await expect(waiting).resolves.toMatchObject({ connected: true });
    });

    it("fails, with the set line, when the paired phone cannot be saved", async () => {
      const { login, bridges, sdk } = coordinator({ config: configured, writesAllowed: false });
      await login.start({ accountId: "default" });
      const waiting = login.wait({ accountId: "default", timeoutMs: 5_000 });
      bridges.state.devices.set("p", "connected");

      await expect(waiting).rejects.toThrow(
        /paired with device 'p', but it could not be saved to the config\. Run: openclaw config set channels\.azula\.device p/,
      );
      expect(sdk.state.config.channels.azula.device).toBe("typo-phone");
      expect(bridges.state.stops).toBe(1);
    });

    it("fails when nothing is in progress", async () => {
      const { login } = coordinator({ config: configured });
      await expect(login.wait({ accountId: "default", timeoutMs: 10 })).rejects.toThrow(
        /no pairing is in progress for azula account 'default'; run openclaw channels login --channel azula again/,
      );
    });

    it("fails once the session has timed out", async () => {
      vi.useFakeTimers();
      const { login } = coordinator({ config: configured, sessionTtlMs: 1_000 });
      await login.start({ accountId: "default" });
      await vi.advanceTimersByTimeAsync(1_500);
      await expect(login.wait({ accountId: "default", timeoutMs: 10 })).rejects.toThrow(/no pairing is in progress/);
    });

    it("lets go of the session when the account is about to start", async () => {
      const { login, bridges } = coordinator({ config: configured });
      await login.start({ accountId: "default" });
      await login.release("default");
      expect(bridges.state.stops).toBe(1);
      await login.release("default");
      expect(bridges.state.stops).toBe(1);
    });

    it("lets go of every session at shutdown", async () => {
      const cfg = { channels: { azula: { device: "phone", accounts: { work: { enabled: true } } } } };
      const { login, bridges } = coordinator({ config: cfg });
      await login.start({ accountId: "default" });
      await login.start({ accountId: "work" });
      await login.releaseAll();
      expect(bridges.state.stops).toBe(2);
    });
  });
});

describe("`openclaw channels login`", () => {
  const READY = { channelAccounts: { azula: [{ accountId: "default", running: true, lifecycle: "ready", name: "x" }] } };
  const NOT_READY = { channelAccounts: { azula: [{ accountId: "default", running: false, lifecycle: "starting" }] } };
  const NOW = (clock: { t: number }) => () => clock.t;

  /**
   * A scripted gateway: requests to each method are answered from that
   * method's list, in order, and the last answer repeats.
   */
  function gateway(script: Record<string, Array<Record<string, unknown> | Error>>) {
    const calls: Array<{ method: string; params: Record<string, unknown>; timeoutMs: number }> = [];
    const seen: Record<string, number> = {};
    const call: CallGateway = async (method, params, timeoutMs) => {
      calls.push({ method, params, timeoutMs });
      const answers = script[method] ?? [{}];
      const index = Math.min(seen[method] ?? 0, answers.length - 1);
      seen[method] = (seen[method] ?? 0) + 1;
      const answer = answers[index];
      if (answer instanceof Error) throw answer;
      return answer ?? {};
    };
    return { call, calls, methods: () => calls.map((c) => c.method) };
  }
  const output = () => {
    const lines: string[] = [];
    return { lines, runtime: { log: (m: string) => void lines.push(m) } };
  };
  /** A clock the fake sleep advances, so nothing waits in real time. */
  const clock = () => {
    const c = { t: 0 };
    return { now: NOW(c), sleep: async (ms: number) => void (c.t += ms), c };
  };

  it("prints the invite, waits, and reports the phone", async () => {
    const g = gateway({
      "web.login.start": [{ connected: false, sessionKey: "default", message: "INVITE TEXT" }],
      "web.login.wait": [{ connected: false, message: "Still waiting" }, { connected: true, message: "Paired with device 'x'." }],
      "channels.status": [READY],
    });
    const o = output();

    await runLogin({ accountId: undefined, runtime: o.runtime }, { call: g.call, ...clock() });

    expect(g.methods()).toEqual(["web.login.start", "web.login.wait", "web.login.wait", "channels.status"]);
    expect(g.calls[0]?.params).toEqual({ channel: "azula", accountId: "default", timeoutMs: 60_000 });
    expect(g.calls[1]?.params).toMatchObject({ channel: "azula", accountId: "default", sessionKey: "default" });
    expect(o.lines[0]).toBe("INVITE TEXT");
    expect(o.lines).toContain("\nPaired with device 'x'.");
    expect(o.lines.join("\n")).toContain("Waiting for the phone");
    // It ends by saying the account is really serving the phone.
    expect(o.lines.at(-1)).toBe("Account 'default' is ready for device 'x'.");
  });

  it("asks about the account that was named", async () => {
    const g = gateway({ "web.login.start": [{ connected: true, message: "already" }] });
    await runLogin({ accountId: "work", runtime: output().runtime }, { call: g.call, ...clock() });
    expect(g.calls[0]?.params).toMatchObject({ channel: "azula", accountId: "work" });
  });

  it("does not wait when the account already has a phone", async () => {
    const g = gateway({ "web.login.start": [{ connected: true, message: "already serves device 'phone'" }] });
    const o = output();
    await runLogin({ accountId: "default", runtime: o.runtime }, { call: g.call, ...clock() });
    expect(g.methods()).toEqual(["web.login.start"]);
    expect(o.lines).toEqual(["already serves device 'phone'"]);
  });

  describe("after the phone has paired", () => {
    const paired = {
      "web.login.start": [{ connected: false, sessionKey: "default", message: "INVITE" }],
      "web.login.wait": [{ connected: true, message: "Paired with device 'x'." }],
    };

    /**
     * Saving the phone makes the gateway reload the channel and restart the
     * account. The command must not hand OpenClaw's own follow-up a channel
     * in the middle of that.
     */
    it("lets the gateway's reload finish before it looks, and before it returns", async () => {
      const g = gateway({ ...paired, "channels.status": [READY] });
      const k = clock();
      const before = k.c.t;
      await runLogin({ accountId: "default", runtime: output().runtime }, { call: g.call, ...k });
      expect(k.c.t - before).toBeGreaterThanOrEqual(1_500);
    });

    it("keeps looking until the account is up, through a gateway that is busy reloading", async () => {
      const g = gateway({
        ...paired,
        "channels.status": [new Error("Channel plugins are reloading"), NOT_READY, NOT_READY, READY],
      });
      const o = output();
      await runLogin({ accountId: "default", runtime: o.runtime }, { call: g.call, ...clock() });
      expect(g.methods().filter((m) => m === "channels.status")).toHaveLength(4);
      expect(o.lines.at(-1)).toBe("Account 'default' is ready for device 'x'.");
    });

    it("does not call a still-waiting account ready", async () => {
      const waiting = { channelAccounts: { azula: [{ accountId: "default", running: true, lifecycle: "ready", azulaPairing: true }] } };
      const g = gateway({ ...paired, "channels.status": [waiting, READY] });
      const o = output();
      await runLogin({ accountId: "default", runtime: o.runtime }, { call: g.call, ...clock() });
      expect(g.methods().filter((m) => m === "channels.status")).toHaveLength(2);
    });

    it("looks at the account that was paired, not another", async () => {
      const other = { channelAccounts: { azula: [{ accountId: "default", running: true, lifecycle: "ready", name: "other" }] } };
      const mine = { channelAccounts: { azula: [{ accountId: "work", running: true, lifecycle: "ready", name: "w" }] } };
      const g = gateway({ ...paired, "channels.status": [other, mine] });
      const o = output();
      await runLogin({ accountId: "work", runtime: o.runtime }, { call: g.call, ...clock() });
      expect(o.lines.at(-1)).toBe("Account 'work' is ready for device 'w'.");
    });

    it("gives up quietly if the gateway never settles, since the pairing itself worked", async () => {
      const g = gateway({ ...paired, "channels.status": [NOT_READY] });
      const o = output();
      const k = clock();
      await runLogin({ accountId: "default", runtime: o.runtime }, { call: g.call, ...k });
      expect(o.lines.at(-1)).toBe("\nPaired with device 'x'.");
      // Bounded, not an endless loop.
      expect(k.c.t).toBeLessThan(30_000);
    });
  });

  it("leaves the wait to the gateway's own timeout, and stops after the total wait", async () => {
    const g = gateway({
      "web.login.start": [{ connected: false, sessionKey: "default", message: "INVITE" }],
      "web.login.wait": [{ connected: false, message: "Still waiting" }],
    });
    const o = output();
    const k = clock();
    const call: CallGateway = async (m, p, timeout) => {
      if (m === "web.login.wait") k.c.t += 30_000;
      return g.call(m, p, timeout);
    };

    await runLogin(
      { accountId: "default", runtime: o.runtime },
      { call, now: k.now, sleep: k.sleep, totalWaitMs: 90_000, waitSliceMs: 30_000 },
    );

    const waits = g.calls.filter((c) => c.method === "web.login.wait");
    expect(waits).toHaveLength(3);
    expect(waits[0]?.params["timeoutMs"]).toBe(30_000);
    // The request is allowed longer than the wait it carries.
    expect(waits[0]?.timeoutMs).toBeGreaterThan(30_000);
    expect(o.lines.at(-1)).toContain("No phone paired yet");
    expect(o.lines.at(-1)).toContain("openclaw channels login --channel azula");
  });

  it("lets a gateway error through, for the CLI to print", async () => {
    const g = gateway({ "web.login.start": [new Error("azula account 'default' is disabled")] });
    await expect(runLogin({ accountId: "default", runtime: output().runtime }, { call: g.call, ...clock() })).rejects.toThrow(
      /is disabled/,
    );
  });

  it("surfaces an error raised while waiting", async () => {
    const g = gateway({
      "web.login.start": [{ connected: false, sessionKey: "default", message: "INVITE" }],
      "web.login.wait": [new Error("paired with device 'p', but it could not be saved")],
    });
    await expect(runLogin({ accountId: "default", runtime: output().runtime }, { call: g.call, ...clock() })).rejects.toThrow(
      /could not be saved/,
    );
  });
});
