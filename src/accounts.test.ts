import { describe, expect, it } from "vitest";
import {
  AzulaAccountError,
  azulaSection,
  configSetCommand,
  DEFAULT_ACCOUNT_ID,
  deviceConfigPath,
  listAccountIds,
  loginCommand,
  resolveAccount,
  resolveAllAccounts,
} from "./accounts.js";

describe("resolveAccount", () => {
  it("applies defaults around a bare device", () => {
    const a = resolveAccount({ device: "phone" });
    expect(a).toEqual({
      accountId: DEFAULT_ACCOUNT_ID,
      enabled: true,
      device: "phone",
      binary: "azula",
      session: "openclaw",
      label: "OpenClaw",
    });
  });

  /**
   * No device is the pairing state, not a configuration error: the account
   * starts, waits for a phone, and adopts it.
   */
  it("resolves an account with no device, which then starts in its pairing state", () => {
    expect(resolveAccount({})).toEqual({
      accountId: DEFAULT_ACCOUNT_ID,
      enabled: true,
      device: undefined,
      binary: "azula",
      session: "openclaw",
      label: "OpenClaw",
    });
    expect(resolveAccount({ enabled: true }).device).toBeUndefined();
    expect(resolveAccount({ device: "   " }).device).toBeUndefined();
  });

  it("still rejects a channel that is not configured at all, and says how to pair", () => {
    expect(() => resolveAccount(undefined)).toThrow(AzulaAccountError);
    expect(() => resolveAccount(undefined)).toThrow(/not configured/);
    expect(() => resolveAccount(undefined)).toThrow(/channels login/);
  });

  it("inherits unset fields from the root", () => {
    const cfg = {
      device: "phone",
      binary: "/opt/azula",
      label: "Bot",
      accounts: { work: { device: "work-phone" } },
    };
    const work = resolveAccount(cfg, "work");
    expect(work.device).toBe("work-phone");
    expect(work.binary).toBe("/opt/azula");
    expect(work.label).toBe("Bot");
  });

  /**
   * Two accounts sharing one persistent session would bind the same azula
   * session key. azula gives each process its own identity precisely so they
   * cannot collide, so inheritance must not undo that.
   */
  it("gives a sub-account its own session rather than inheriting the root's", () => {
    const cfg = { device: "phone", accounts: { work: { device: "work-phone" } } };
    expect(resolveAccount(cfg).session).toBe("openclaw");
    expect(resolveAccount(cfg, "work").session).toBe("openclaw-work");
  });

  it("lets a sub-account name its session explicitly", () => {
    const cfg = {
      device: "phone",
      accounts: { work: { device: "w", session: "custom" } },
    };
    expect(resolveAccount(cfg, "work").session).toBe("custom");
  });

  it("respects an explicit root session name for derived ids too", () => {
    const cfg = { device: "p", session: "bot", accounts: { work: { device: "w" } } };
    expect(resolveAccount(cfg, "work").session).toBe("bot-work");
  });

  it("rejects an unknown account id", () => {
    expect(() => resolveAccount({ device: "p" }, "nope")).toThrow(/no azula account/);
  });

  it("treats blank strings as unset", () => {
    const a = resolveAccount({ device: "phone", label: "   " });
    expect(a.label).toBe("OpenClaw");
  });

  it("honours enabled=false, and inherits it", () => {
    expect(resolveAccount({ device: "p", enabled: false }).enabled).toBe(false);
    const cfg = { device: "p", enabled: false, accounts: { w: { device: "w" } } };
    expect(resolveAccount(cfg, "w").enabled).toBe(false);
    const override = {
      device: "p",
      enabled: false,
      accounts: { w: { device: "w", enabled: true } },
    };
    expect(resolveAccount(override, "w").enabled).toBe(true);
  });
});

describe("listAccountIds", () => {
  it("lists the root first, then sub-accounts", () => {
    expect(listAccountIds({ device: "p", accounts: { b: {}, a: {} } })).toEqual([
      "default",
      "b",
      "a",
    ]);
    expect(listAccountIds(undefined)).toEqual([]);
  });

  /** An empty `channels.azula` is how a single-account operator asks for a phone to be paired. */
  it("lists the root of a device-less single-account channel, so it can pair", () => {
    expect(listAccountIds({})).toEqual(["default"]);
    expect(listAccountIds({ enabled: true })).toEqual(["default"]);
  });

  /**
   * With named accounts, a device-less root is only their shared defaults.
   * Starting it would open a second, unwanted pairing session.
   */
  it("does not start a device-less root that only carries defaults for named accounts", () => {
    expect(listAccountIds({ binary: "/opt/azula", accounts: { work: { device: "w" } } })).toEqual([
      "work",
    ]);
  });
});

describe("resolveAllAccounts", () => {
  it("resolves two accounts to two distinct devices", () => {
    const { accounts, errors } = resolveAllAccounts({
      device: "home-phone",
      accounts: { work: { device: "work-phone" } },
    });
    expect(errors).toEqual([]);
    expect(accounts.map((a) => a.device)).toEqual(["home-phone", "work-phone"]);
    // Distinct sessions, so the two conversations cannot collide.
    expect(new Set(accounts.map((a) => a.session)).size).toBe(2);
  });

  it("keeps good accounts when one is misconfigured", () => {
    const { accounts, errors } = resolveAllAccounts({
      device: "home-phone",
      accounts: { broken: { device: "  " } },
    });
    // `broken` inherits the root device rather than failing, which is the
    // documented inheritance rule; a truly broken account is one with no
    // device anywhere.
    expect(accounts).toHaveLength(2);
    expect(errors).toEqual([]);
  });

  /** An account with no device is an account waiting for a phone, not a broken one. */
  it("resolves an account with no device anywhere, to be paired", () => {
    const { accounts, errors } = resolveAllAccounts({
      accounts: { orphan: {} },
    });
    expect(errors).toEqual([]);
    expect(accounts.map((a) => [a.accountId, a.device])).toEqual([["orphan", undefined]]);
  });

  it("resolves nothing when the channel is not configured", () => {
    expect(resolveAllAccounts(undefined)).toEqual({ accounts: [], errors: [] });
  });
});

describe("the commands an operator is pointed at", () => {
  it("names the login command, with --account only for a named account", () => {
    expect(loginCommand("default")).toBe("openclaw channels login --channel azula");
    expect(loginCommand("work")).toBe("openclaw channels login --channel azula --account work");
  });

  it("names the config path and the exact set command, quoting what needs it", () => {
    expect(deviceConfigPath("default")).toBe("channels.azula.device");
    expect(deviceConfigPath("work")).toBe("channels.azula.accounts.work.device");
    expect(configSetCommand("default", "2a64dea5")).toBe(
      "openclaw config set channels.azula.device 2a64dea5",
    );
    expect(configSetCommand("work", "my phone")).toBe(
      "openclaw config set channels.azula.accounts.work.device 'my phone'",
    );
  });
});

describe("azulaSection", () => {
  it("reads channels.azula without assuming the shape", () => {
    expect(azulaSection({ channels: { azula: { device: "p" } } })).toEqual({ device: "p" });
    expect(azulaSection({ channels: { azula: "nope" } })).toBeUndefined();
    expect(azulaSection({})).toBeUndefined();
    expect(azulaSection(undefined)).toBeUndefined();
  });
});
