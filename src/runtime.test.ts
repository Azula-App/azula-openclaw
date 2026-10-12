import { beforeEach, describe, expect, it } from "vitest";
import type { AzulaBridge } from "./bridge.js";
import {
  clearRuntimes,
  getRuntime,
  markUnavailable,
  NoRuntimeError,
  registerRuntime,
  requireRuntime,
  unavailableReason,
  unregisterRuntime,
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
