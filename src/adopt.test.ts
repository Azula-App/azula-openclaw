import { describe, expect, it } from "vitest";
import { persistDevice, type PersistSdk } from "./adopt.js";

type Cfg = Record<string, any>;

/**
 * The slice of the SDK's config API the channel uses, over an in-memory
 * config: `mutateConfigFile` hands `mutate` a draft and returns its result, as
 * the real one does.
 */
function fakeSdk(initial: Cfg, options: { writesAllowed?: boolean; failWith?: Error } = {}) {
  const state = {
    config: structuredClone(initial),
    writes: [] as Array<{ afterWrite: unknown }>,
    asked: [] as Array<{ channelId?: string | null; accountId?: string | null }>,
  };
  const sdk: PersistSdk = {
    getRuntimeConfig: () => state.config as never,
    resolveChannelConfigWrites: ((p: { channelId?: string | null; accountId?: string | null }) => {
      state.asked.push(p);
      return options.writesAllowed ?? true;
    }) as never,
    mutateConfigFile: (async (params: { afterWrite?: unknown; mutate: (draft: Cfg) => unknown }) => {
      if (options.failWith) throw options.failWith;
      state.writes.push({ afterWrite: params.afterWrite });
      const draft = structuredClone(state.config);
      const result = params.mutate(draft);
      state.config = draft;
      return { result };
    }) as never,
  };
  return { sdk, state };
}

const logs: string[] = [];
const logger = {
  debug: (m: string) => void logs.push(`debug ${m}`),
  info: (m: string) => void logs.push(`info ${m}`),
  warn: (m: string) => void logs.push(`warn ${m}`),
  error: (m: string) => void logs.push(`error ${m}`),
};

describe("persistDevice", () => {
  it("writes the device into the root account's config", async () => {
    const f = fakeSdk({ channels: { azula: { enabled: true } } });

    const outcome = await persistDevice({ sdk: f.sdk, accountId: "default", device: "2a64dea5", logger });

    expect(outcome).toEqual({ persisted: true });
    expect(f.state.config.channels.azula).toEqual({ enabled: true, device: "2a64dea5" });
  });

  it("writes a named account's device into its own entry, not the root's", async () => {
    const f = fakeSdk({
      channels: { azula: { device: "phone", accounts: { work: { enabled: true } } } },
    });

    await persistDevice({ sdk: f.sdk, accountId: "work", device: "w-phone", logger });

    expect(f.state.config.channels.azula.device).toBe("phone");
    expect(f.state.config.channels.azula.accounts.work).toEqual({ enabled: true, device: "w-phone" });
  });

  it("creates the account's section when there is none to write into", async () => {
    const f = fakeSdk({});
    await persistDevice({ sdk: f.sdk, accountId: "work", device: "w", logger });
    expect(f.state.config.channels.azula.accounts.work.device).toBe("w");
  });

  /**
   * `none` would leave the gateway's runtime config without the device, and an
   * account restarted from that view would start unpaired and wait for a phone
   * that is already paired.
   */
  it("lets the gateway's reload planner apply the write, so its own config view stays current", async () => {
    const f = fakeSdk({ channels: { azula: {} } });
    await persistDevice({ sdk: f.sdk, accountId: "default", device: "d", logger });
    expect(f.state.writes).toHaveLength(1);
    expect(f.state.writes[0]?.afterWrite).toEqual({ mode: "auto" });
  });

  it("asks the operator's switch for channel-initiated writes, for this account", async () => {
    const f = fakeSdk({ channels: { azula: {} } });
    await persistDevice({ sdk: f.sdk, accountId: "work", device: "d", logger });
    expect(f.state.asked).toMatchObject([{ channelId: "azula", accountId: "work" }]);
  });

  it("does not write when config writes are switched off, and hands back the set line", async () => {
    const f = fakeSdk({ channels: { azula: {} } }, { writesAllowed: false });

    const outcome = await persistDevice({ sdk: f.sdk, accountId: "default", device: "2a64dea5", logger });

    expect(outcome).toEqual({
      persisted: false,
      configHint: "openclaw config set channels.azula.device 2a64dea5",
    });
    expect(f.state.writes).toHaveLength(0);
    expect(f.state.config.channels.azula.device).toBeUndefined();
  });

  it("gives the named-account set line when it cannot write for one", async () => {
    const f = fakeSdk({ channels: { azula: { accounts: { work: {} } } } }, { writesAllowed: false });
    const outcome = await persistDevice({ sdk: f.sdk, accountId: "work", device: "w", logger });
    expect(outcome.configHint).toBe("openclaw config set channels.azula.accounts.work.device w");
  });

  it("falls back to the set line when the write itself fails", async () => {
    const f = fakeSdk({ channels: { azula: {} } }, { failWith: new Error("config is read-only") });

    const outcome = await persistDevice({ sdk: f.sdk, accountId: "default", device: "d", logger });

    expect(outcome).toEqual({ persisted: false, configHint: "openclaw config set channels.azula.device d" });
    expect(logs.some((l) => l.startsWith("warn") && l.includes("config is read-only"))).toBe(true);
  });

  /** A device the operator named is theirs; adoption must not overwrite it. */
  it("leaves a device that was configured in the meantime alone", async () => {
    const f = fakeSdk({ channels: { azula: { device: "chosen-by-operator" } } });

    const outcome = await persistDevice({ sdk: f.sdk, accountId: "default", device: "other", logger });

    expect(outcome.persisted).toBe(false);
    expect(f.state.config.channels.azula.device).toBe("chosen-by-operator");
  });

  it("replaces a configured device when asked to, as re-pairing an unpaired one does", async () => {
    const f = fakeSdk({ channels: { azula: { device: "typo-phone" } } });

    const outcome = await persistDevice({
      sdk: f.sdk,
      accountId: "default",
      device: "the-real-one",
      logger,
      replace: true,
    });

    expect(outcome).toEqual({ persisted: true });
    expect(f.state.config.channels.azula.device).toBe("the-real-one");
  });

  it("quotes a device name the shell would split", async () => {
    const f = fakeSdk({ channels: { azula: {} } }, { writesAllowed: false });
    const outcome = await persistDevice({ sdk: f.sdk, accountId: "default", device: "my phone", logger });
    expect(outcome.configHint).toBe("openclaw config set channels.azula.device 'my phone'");
  });
});
