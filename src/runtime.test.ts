import { beforeEach, describe, expect, it } from "vitest";
import type { AzulaBridge } from "./bridge.js";
import {
  canForwardToGateway,
  clearRuntimes,
  getRuntime,
  isGatewayProcess,
  markGatewayProcess,
  markUnavailable,
  NoRuntimeError,
  registerRuntime,
  requireRuntime,
  unavailableReason,
  unregisterRuntime,
  whileForwarding,
  type AccountRuntime,
} from "./runtime.js";
import { SurfaceTracker } from "./surfaces.js";

const runtime = (): AccountRuntime => ({
  bridge: {} as unknown as AzulaBridge,
  surfaces: new SurfaceTracker(),
});

beforeEach(() => clearRuntimes());

describe("the runtime registry", () => {
  it("finds an account's runtime, treating no id as the default account", () => {
    const rt = runtime();
    registerRuntime("default", rt);
    expect(getRuntime("default")).toBe(rt);
    expect(getRuntime(undefined)).toBe(rt);
    expect(getRuntime(null)).toBe(rt);
    expect(getRuntime("work")).toBeUndefined();
  });

  it("removes a runtime", () => {
    registerRuntime("default", runtime());
    unregisterRuntime("default");
    expect(getRuntime("default")).toBeUndefined();
  });

  /** The gateway can start a successor before a slow stop has finished. */
  it("removes only the registration it is asked to, when it is asked", () => {
    const old = runtime();
    const successor = runtime();
    registerRuntime("default", old);
    registerRuntime("default", successor);

    unregisterRuntime("default", old);
    expect(getRuntime("default")).toBe(successor);

    unregisterRuntime("default", successor);
    expect(getRuntime("default")).toBeUndefined();
  });
});

describe("a send with nothing to send through", () => {
  it("says why, when the lifecycle knows", () => {
    markUnavailable("default", "no azula device named 'phone' is paired with this machine");
    expect(unavailableReason("default")).toContain("paired");
    const err = (() => {
      try {
        requireRuntime("default");
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(NoRuntimeError);
    expect(err?.message).toContain("account 'default'");
    expect(err?.message).toContain("is paired with this machine");
  });

  it("still names the account when it does not", () => {
    expect(() => requireRuntime("work")).toThrow("account 'work'");
  });

  it("forgets the reason once the account is back", () => {
    markUnavailable("default", "the bridge exited");
    registerRuntime("default", runtime());
    expect(unavailableReason("default")).toBeUndefined();
    expect(requireRuntime("default")).toBeDefined();
  });
});

describe("telling a CLI from the gateway", () => {
  it("lets a process with no runtime and no sign of being the gateway forward a send", () => {
    expect(isGatewayProcess()).toBe(false);
    expect(canForwardToGateway("default")).toBe(true);
    expect(canForwardToGateway(undefined)).toBe(true);
  });

  it("never lets the gateway forward, once anything has said it is the gateway", () => {
    markGatewayProcess();
    expect(canForwardToGateway("default")).toBe(false);
  });

  it("takes a registered runtime as proof, and an account marked unavailable too", () => {
    registerRuntime("a", { bridge: {} as never, surfaces: new SurfaceTracker() });
    expect(isGatewayProcess()).toBe(true);
    clearRuntimes();
    expect(isGatewayProcess()).toBe(false);
    markUnavailable("b", "stopped");
    expect(isGatewayProcess()).toBe(true);
  });

  it("does not forward for an account that has a runtime", () => {
    registerRuntime("work", { bridge: {} as never, surfaces: new SurfaceTracker() });
    expect(canForwardToGateway("work")).toBe(false);
  });

  it("refuses a second forward for an account while one is in flight, and counts nested ones", async () => {
    let inner: boolean | undefined;
    let innerOther: boolean | undefined;
    await whileForwarding("default", async () => {
      inner = canForwardToGateway("default");
      innerOther = canForwardToGateway("work");
      await whileForwarding("default", async () => undefined);
      // The inner one finishing must not clear the outer one's mark.
      expect(canForwardToGateway("default")).toBe(false);
    });
    expect(inner).toBe(false);
    expect(innerOther).toBe(true);
    expect(canForwardToGateway("default")).toBe(true);
  });

  it("clears the mark when the forward throws", async () => {
    await whileForwarding("default", async () => {
      throw new Error("x");
    }).catch(() => {});
    expect(canForwardToGateway("default")).toBe(true);
  });
});
