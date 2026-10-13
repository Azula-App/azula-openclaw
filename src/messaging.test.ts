import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AzulaBridge } from "./bridge.js";
import { azulaChannelPlugin } from "./channel.js";
import {
  formatTargetDisplay,
  inferTargetChatType,
  normalizeTarget,
  parseTarget,
  resolveAzulaTarget,
  targetFor,
} from "./messaging.js";
import { clearRuntimes, registerRuntime } from "./runtime.js";
import { SurfaceTracker } from "./surfaces.js";

const cfg = (azula: Record<string, unknown>) => ({ channels: { azula } });

const one = cfg({ device: "phone" });
const two = cfg({ device: "phone", accounts: { work: { device: "work-phone" } } });

beforeEach(() => clearRuntimes());
afterEach(() => clearRuntimes());

describe("naming a device", () => {
  it("accepts the bare name, the channel prefix, and the usual prefixes", () => {
    for (const raw of ["phone", "azula:phone", "AZULA:phone", "user:phone", "azula:user:phone", "@phone", "  azula: phone  "]) {
      expect(parseTarget(raw)).toBe("phone");
    }
  });

  it("finds nothing in an empty target", () => {
    for (const raw of ["", "   ", "azula:", "user:", undefined, null]) expect(parseTarget(raw)).toBeUndefined();
  });

  it("keeps a long endpoint-id name intact", () => {
    const id = "2a64dea5aa5ae9bf56b44bb15bfa1ea8e98e5b3a9c33c4ab6bc4bbfa7e1c6a8d";
    expect(parseTarget(`azula:${id}`)).toBe(id);
    expect(normalizeTarget(id)).toBe(`azula:${id}`);
  });

  it("normalizes to the one canonical form inbound turns record as the route", () => {
    expect(targetFor("phone")).toBe("azula:phone");
    expect(normalizeTarget("phone")).toBe("azula:phone");
    expect(normalizeTarget("azula:phone")).toBe("azula:phone");
    expect(normalizeTarget("")).toBeUndefined();
  });

  it("is always a direct conversation, and shows the bare name", () => {
    expect(inferTargetChatType()).toBe("direct");
    expect(formatTargetDisplay({ target: "azula:phone" })).toBe("phone");
    expect(formatTargetDisplay({ target: "azula:phone", display: "Sal's phone" })).toBe("Sal's phone");
  });
});

describe("resolving a target to the account's phone", () => {
  it("resolves the account's device by name or with the prefix", () => {
    for (const input of ["phone", "azula:phone", "user:phone", "PHONE"]) {
      expect(resolveAzulaTarget(one, undefined, input)).toEqual({
        ok: true,
        accountId: "default",
        device: "phone",
        to: "azula:phone",
      });
    }
  });

  it("uses the phone itself when no destination was named", () => {
    expect(resolveAzulaTarget(one, undefined, undefined)).toMatchObject({ ok: true, to: "azula:phone" });
    expect(resolveAzulaTarget(one, undefined, "")).toMatchObject({ ok: true, to: "azula:phone" });
  });

  describe("unknown targets", () => {
    it("fail by naming the account's device and how to address it", () => {
      const result = resolveAzulaTarget(one, undefined, "somebody");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('Unknown target "somebody" for azula');
      expect(result.error.message).toContain("The paired device is 'phone'");
      expect(result.error.message).toContain("--target phone");
      expect(result.error.message).toContain("--target azula:phone");
    });

    it("list every account's device when there are several", () => {
      const result = resolveAzulaTarget(two, undefined, "somebody");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("'phone' (account 'default')");
      expect(result.error.message).toContain("'work-phone' (account 'work')");
    });
  });

  describe("accounts", () => {
    it("resolves each account's own device", () => {
      expect(resolveAzulaTarget(two, "work", "work-phone")).toMatchObject({
        ok: true,
        accountId: "work",
        device: "work-phone",
        to: "azula:work-phone",
      });
      expect(resolveAzulaTarget(two, "default", "phone")).toMatchObject({ ok: true, accountId: "default" });
    });

    it("refuses a device that belongs to another account, and says which --account to add", () => {
      const result = resolveAzulaTarget(two, undefined, "work-phone");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("belongs to account 'work'");
      expect(result.error.message).toContain("--account work");

      const reverse = resolveAzulaTarget(two, "work", "phone");
      expect(reverse.ok).toBe(false);
      if (reverse.ok) return;
      expect(reverse.error.message).toContain("--account default");
    });

    it("rejects an account that does not exist", () => {
      const result = resolveAzulaTarget(two, "nope", "phone");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toBe("no azula account named 'nope'");
    });

    it("treats a blank account id as the default one", () => {
      expect(resolveAzulaTarget(two, "  ", "phone")).toMatchObject({ ok: true, accountId: "default" });
      expect(resolveAzulaTarget(two, null, "phone")).toMatchObject({ ok: true, accountId: "default" });
    });

    it("falls back to the first listed account when the root is only defaults", () => {
      const named = cfg({ accounts: { work: { device: "work-phone" } } });
      expect(resolveAzulaTarget(named, undefined, "work-phone")).toMatchObject({ ok: true, accountId: "work" });
    });
  });

  describe("an account that has no phone yet", () => {
    it("says to pair one, with the login command for that account", () => {
      const result = resolveAzulaTarget(cfg({ enabled: true }), undefined, "phone");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("no paired phone in the config");
      expect(result.error.message).toContain("openclaw channels login --channel azula");
      // A phone the account serves but never saved is the other way to land here.
      expect(result.error.message).toContain("`openclaw config set` line");

      const named = resolveAzulaTarget(cfg({ accounts: { work: {} } }), "work", "x");
      expect(named.ok).toBe(false);
      if (named.ok) return;
      expect(named.error.message).toContain("openclaw channels login --channel azula --account work");
    });

    it("prefers the running account's phone, which may be one the config does not have yet", () => {
      registerRuntime("default", {
        bridge: { device: "just-adopted" } as unknown as AzulaBridge,
        surfaces: new SurfaceTracker(),
      });
      expect(resolveAzulaTarget(cfg({ enabled: true }), undefined, "just-adopted")).toMatchObject({
        ok: true,
        device: "just-adopted",
        to: "azula:just-adopted",
      });
    });
  });

  /**
   * Heartbeat and cron deliveries reuse the session's last route, which can
   * predate the account's current phone. Nobody typed it, and the account has
   * one phone to deliver to.
   */
  describe("implicit destinations", () => {
    it("deliver to the account's phone even when the recorded route is stale", () => {
      for (const mode of ["implicit", "heartbeat"] as const) {
        expect(resolveAzulaTarget(one, undefined, "azula:an-older-phone", mode)).toMatchObject({
          ok: true,
          to: "azula:phone",
        });
      }
    });

    it("do not extend that leniency to a typed target", () => {
      expect(resolveAzulaTarget(one, undefined, "azula:an-older-phone", "explicit").ok).toBe(false);
      expect(resolveAzulaTarget(one, undefined, "azula:an-older-phone", undefined).ok).toBe(false);
    });

    it("still have nowhere to go if the account has no phone", () => {
      expect(resolveAzulaTarget(cfg({ enabled: true }), undefined, "azula:x", "heartbeat").ok).toBe(false);
    });
  });
});

/** The adapters the gateway actually calls, as the channel registers them. */
describe("the channel's registered adapters", () => {
  const messaging = azulaChannelPlugin.messaging!;
  const resolver = messaging.targetResolver!;

  it("declares the channel prefix and a direct-only conversation kind", () => {
    expect(messaging.targetPrefixes).toEqual(["azula"]);
    expect(messaging.inferTargetChatType?.({ to: "azula:phone" })).toBe("direct");
    expect(messaging.normalizeTarget?.("phone")).toBe("azula:phone");
  });

  it("never claims a target 'looks like an id', which would skip checking it against the account", () => {
    expect(resolver.looksLikeId?.("azula:phone", "azula:phone")).toBe(false);
    expect(resolver.looksLikeId?.("phone", "azula:phone")).toBe(false);
  });

  it("resolves a typed target to the account's direct conversation", async () => {
    await expect(
      resolver.resolveTarget!({ cfg: one as never, accountId: undefined, input: "phone", normalized: "azula:phone" }),
    ).resolves.toEqual({ to: "azula:phone", kind: "user", display: "phone", source: "normalized" });
  });

  it("resolves for the account that was named", async () => {
    await expect(
      resolver.resolveTarget!({ cfg: two as never, accountId: "work", input: "azula:work-phone", normalized: "azula:work-phone" }),
    ).resolves.toMatchObject({ to: "azula:work-phone", display: "work-phone" });
  });

  it("turns an unknown target away with the message that names the device", async () => {
    await expect(
      resolver.resolveTarget!({ cfg: one as never, accountId: undefined, input: "nope", normalized: "azula:nope" }),
    ).rejects.toThrow(/Unknown target "nope" for azula\. The paired device is 'phone'/);
  });

  describe("the last check before delivery", () => {
    const resolveTarget = azulaChannelPlugin.outbound!.resolveTarget!;

    it("accepts the account's phone and canonicalizes it", () => {
      expect(resolveTarget({ cfg: one as never, to: "phone", accountId: undefined, mode: "explicit" })).toEqual({
        ok: true,
        to: "azula:phone",
      });
    });

    it("refuses a target that is not the account's phone, rather than delivering it to the wrong one", () => {
      const result = resolveTarget({ cfg: two as never, to: "azula:work-phone", accountId: "default", mode: "explicit" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("--account work");
    });

    it("lets cron and heartbeat through to the phone the account has now", () => {
      expect(resolveTarget({ cfg: one as never, to: "azula:old", accountId: undefined, mode: "heartbeat" })).toEqual({
        ok: true,
        to: "azula:phone",
      });
    });

    it("fails with the pairing hint when there is no phone", () => {
      const result = resolveTarget({ cfg: cfg({ enabled: true }) as never, to: "azula:x", accountId: undefined, mode: "explicit" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toMatch(/channels login/);
    });
  });

  it("makes the phone the default destination, so cron and heartbeat need no target", () => {
    const resolveDefaultTo = azulaChannelPlugin.config.resolveDefaultTo!;
    expect(resolveDefaultTo({ cfg: one as never, accountId: undefined })).toBe("azula:phone");
    expect(resolveDefaultTo({ cfg: two as never, accountId: "work" })).toBe("azula:work-phone");
    expect(resolveDefaultTo({ cfg: cfg({ enabled: true }) as never, accountId: undefined })).toBeUndefined();
  });

  /**
   * The bridge is a child of the gateway process. `direct` would make
   * `openclaw message send` try to deliver from the CLI process, where there is
   * no bridge.
   */
  it("hands CLI sends to the gateway, where the azula session lives", () => {
    expect(azulaChannelPlugin.outbound?.deliveryMode).toBe("gateway");
  });

  it("offers the login command as its pairing affordance", () => {
    expect(typeof azulaChannelPlugin.auth?.login).toBe("function");
  });
});
