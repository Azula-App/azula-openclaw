import { describe, expect, it } from "vitest";
import { azulaChannelPlugin, CHANNEL_ID } from "./channel.js";

/** What the channel registers for the gateway to build its behaviour from. */
describe("the registered channel", () => {
  it("is the azula channel, direct conversations only", () => {
    expect(azulaChannelPlugin.id).toBe(CHANNEL_ID);
    expect(azulaChannelPlugin.capabilities.chatTypes).toEqual(["direct"]);
  });

  /**
   * Pairing saves `device` into config and the gateway answers by reloading the
   * channel; scoped to the account that changed, a named account's new phone
   * does not bounce its siblings.
   */
  it("restarts only the changed named account when its config changes", () => {
    expect(azulaChannelPlugin.reload).toEqual({
      configPrefixes: ["channels.azula"],
      accountScopedRestart: true,
    });
  });

  it("offers pairing through the login command and the gateway's login hooks", () => {
    expect(typeof azulaChannelPlugin.auth?.login).toBe("function");
    expect(typeof azulaChannelPlugin.gateway?.loginWithQrStart).toBe("function");
    expect(typeof azulaChannelPlugin.gateway?.loginWithQrWait).toBe("function");
  });

  it("describes its status issues, so a waiting account is explained", () => {
    expect(typeof azulaChannelPlugin.status?.collectStatusIssues).toBe("function");
  });

  it("resolves an account with no device rather than failing, so it can start and pair", () => {
    const cfg = { channels: { azula: { enabled: true } } } as never;
    expect(azulaChannelPlugin.config.listAccountIds(cfg)).toEqual(["default"]);
    expect(azulaChannelPlugin.config.resolveAccount(cfg, "default")).toMatchObject({
      accountId: "default",
      device: undefined,
    });
    expect(azulaChannelPlugin.config.inspectAccount?.(cfg, "default")).toEqual({
      enabled: true,
      configured: true,
      label: "OpenClaw",
    });
  });
});
