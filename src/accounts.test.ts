import { describe, expect, it } from "vitest";
import {
  AzulaAccountError,
  DEFAULT_ACCOUNT_ID,
  listAccountIds,
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

  it("requires a device and says what to do about it", () => {
    expect(() => resolveAccount({})).toThrow(AzulaAccountError);
    expect(() => resolveAccount({})).toThrow(/device/);
    expect(() => resolveAccount(undefined)).toThrow(/not configured/);
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

  it("reports an account that cannot resolve at all", () => {
    const { accounts, errors } = resolveAllAccounts({
      accounts: { orphan: {} },
    });
    expect(accounts).toHaveLength(0);
    expect(errors.map((e) => e.accountId).sort()).toEqual(["default", "orphan"]);
  });
});
