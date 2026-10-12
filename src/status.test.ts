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
