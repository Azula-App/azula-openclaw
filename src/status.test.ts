import { describe, expect, it } from "vitest";
import type { ResolvedAzulaAccount } from "./accounts.js";
import { azulaStatus } from "./status.js";

const account: ResolvedAzulaAccount = {
  accountId: "default",
  enabled: true,
  device: "phone",
  binary: "/opt/azula",
  session: "openclaw",
  label: "OpenClaw",
};

const build = (runtime?: Record<string, unknown>) =>
  azulaStatus.buildAccountSnapshot!({
    account,
    cfg: {} as never,
    ...(runtime ? { runtime: runtime as never } : {}),
  }) as Record<string, unknown>;

describe("the account snapshot", () => {
  /** The whole reason this exists: the gateway drops `lastError` unless asked. */
  it("carries the reason an account is blocked through to status", () => {
    const snapshot = build({
      lifecycle: "blocked",
      terminalDisconnect: true,
      lastError: "no azula device named 'phone' is paired\n  → pair the phone first",
      running: false,
    });
    expect(snapshot["lastError"]).toContain("pair the phone first");
    expect(snapshot["lifecycle"]).toBe("blocked");
    expect(snapshot["terminalDisconnect"]).toBe(true);
  });

  it("shows which device and binary the account runs", () => {
    expect(build()).toMatchObject({
      accountId: "default",
      name: "phone",
      enabled: true,
      configured: true,
      cliPath: "/opt/azula",
    });
  });

  it("reports an account that has not started as not running, with no error", () => {
    expect(build()).toMatchObject({ running: false, connected: false, lastError: null });
  });

  it("passes the activity timestamps through", () => {
    expect(
      build({ running: true, connected: true, lifecycle: "ready", lastInboundAt: 5, lastEventAt: 6 }),
    ).toMatchObject({ running: true, connected: true, lifecycle: "ready", lastInboundAt: 5, lastEventAt: 6 });
  });

  it("does not leak anything the lifecycle did not publish", () => {
    const snapshot = build({ running: true, somethingElse: "x", token: "secret" });
    expect(snapshot).not.toHaveProperty("somethingElse");
    expect(snapshot).not.toHaveProperty("token");
  });
});

describe("an account waiting for a phone", () => {
  const unpaired: ResolvedAzulaAccount = { ...account, device: undefined };
  const buildFor = (acct: ResolvedAzulaAccount, runtime?: Record<string, unknown>) =>
    azulaStatus.buildAccountSnapshot!({
      account: acct,
      cfg: {} as never,
      ...(runtime ? { runtime: runtime as never } : {}),
    }) as Record<string, unknown>;

  it("has no device name to show yet, and says it is waiting", () => {
    const snapshot = buildFor(unpaired, { running: true, connected: true, lifecycle: "ready", azulaPairing: true });
    expect(snapshot).not.toHaveProperty("name");
    expect(snapshot).toMatchObject({ running: true, connected: true, azulaPairing: true, configured: true });
  });

  it("shows the phone the account adopted, which the config may not have yet", () => {
    expect(buildFor(unpaired, { running: true, azulaDevice: "2a64dea5" })).toMatchObject({ name: "2a64dea5" });
    // The running account's phone wins over a stale resolved one.
    expect(buildFor(account, { running: true, azulaDevice: "newer" })).toMatchObject({ name: "newer" });
  });

  it("passes the unsaved-device hint through", () => {
    const snapshot = buildFor(unpaired, { azulaConfigHint: "openclaw config set channels.azula.device x" });
    expect(snapshot["azulaConfigHint"]).toBe("openclaw config set channels.azula.device x");
  });

  describe("what `channels status` warns about", () => {
    const issues = (accounts: Array<Record<string, unknown>>) =>
      azulaStatus.collectStatusIssues!(accounts as never);

    it("names the command that gets the invite", () => {
      expect(issues([{ accountId: "default", azulaPairing: true }])).toEqual([
        {
          channel: "azula",
          accountId: "default",
          kind: "config",
          message: "waiting for a phone to pair (no device configured)",
          fix: "run `openclaw channels login --channel azula`, then scan the invite with the azula app",
        },
      ]);
    });

    it("names the account for a named one", () => {
      const [issue] = issues([{ accountId: "work", azulaPairing: true }]);
      expect(issue?.fix).toContain("openclaw channels login --channel azula --account work");
    });

    it("warns, with the exact set line, about a phone that nothing has saved", () => {
      expect(
        issues([{ accountId: "default", azulaConfigHint: "openclaw config set channels.azula.device 2a64dea5" }]),
      ).toEqual([
        {
          channel: "azula",
          accountId: "default",
          kind: "config",
          message: "serving a paired phone that is not saved in the config; a restart would forget it",
          fix: "openclaw config set channels.azula.device 2a64dea5",
        },
      ]);
    });

    it("says nothing about a healthy or merely stopped account", () => {
      expect(issues([{ accountId: "default", running: true, connected: true }, { accountId: "work", running: false }])).toEqual([]);
      expect(issues([{ accountId: "default", azulaPairing: undefined, azulaConfigHint: "" }])).toEqual([]);
    });
  });
});
