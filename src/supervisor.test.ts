import { describe, expect, it } from "vitest";
import { BridgeSupervisor } from "./supervisor.js";
import { AzulaConfigError } from "./bridge.js";

const quietLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

describe("BridgeSupervisor", () => {
  it("reports healthy after a successful start", async () => {
    const s = new BridgeSupervisor({
      connect: async () => {},
      disconnect: async () => {},
      logger: quietLogger,
    });
    await s.start();
    expect(s.health).toEqual({ state: "healthy" });
    expect(s.healthy).toBe(true);
  });

  it("recovers with backoff and reports healthy again", async () => {
    let attempts = 0;
    const waits: number[] = [];
    const s = new BridgeSupervisor({
      connect: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("bridge down");
      },
      disconnect: async () => {},
      logger: quietLogger,
      baseBackoffMs: 10,
      sleep: async (ms) => void waits.push(ms),
    });

    expect(await s.reconnect()).toBe(true);
    expect(s.healthy).toBe(true);
    // Exponential, not constant.
    expect(waits).toEqual([10, 20]);
  });

  it("gives up after the cap and reports unhealthy with a reason", async () => {
    const waits: number[] = [];
    const s = new BridgeSupervisor({
      connect: async () => {
        throw new Error("still down");
      },
      disconnect: async () => {},
      logger: quietLogger,
      baseBackoffMs: 1,
      maxAttempts: 4,
      sleep: async (ms) => void waits.push(ms),
    });

    expect(await s.reconnect()).toBe(false);
    expect(s.health.state).toBe("unhealthy");
    expect(s.health).toMatchObject({ reason: expect.stringContaining("4 attempts") });
    // One sleep fewer than attempts: no point waiting after the last failure.
    expect(waits).toHaveLength(3);
  });

  it("caps the backoff rather than growing without bound", async () => {
    const waits: number[] = [];
    const s = new BridgeSupervisor({
      connect: async () => {
        throw new Error("down");
      },
      disconnect: async () => {},
      logger: quietLogger,
      baseBackoffMs: 100,
      maxBackoffMs: 250,
      maxAttempts: 6,
      sleep: async (ms) => void waits.push(ms),
    });
    await s.reconnect();
    expect(waits).toEqual([100, 200, 250, 250, 250]);
  });

  /**
   * No amount of backoff installs a missing binary or pairs a phone. Retrying
   * would bury the one message that tells the operator what to fix.
   */
  it("does not retry a configuration error", async () => {
    let attempts = 0;
    const s = new BridgeSupervisor({
      connect: async () => {
        attempts += 1;
        throw new AzulaConfigError("azula is missing", "install it");
      },
      disconnect: async () => {},
      logger: quietLogger,
      baseBackoffMs: 1,
      maxAttempts: 5,
      sleep: async () => {},
    });

    expect(await s.reconnect()).toBe(false);
    expect(attempts).toBe(1);
    expect(s.health).toMatchObject({
      state: "unhealthy",
      reason: expect.stringContaining("install it"),
    });
  });

  it("start() surfaces a configuration error rather than swallowing it", async () => {
    const s = new BridgeSupervisor({
      connect: async () => {
        throw new AzulaConfigError("no device", "pair the phone");
      },
      disconnect: async () => {},
      logger: quietLogger,
    });
    await expect(s.start()).rejects.toBeInstanceOf(AzulaConfigError);
    expect(s.health).toMatchObject({ state: "unhealthy" });
  });

  /**
   * A child exit and a failed send can both notice the same outage; two
   * reconnect loops racing would double the spawn rate exactly when things
   * are already unwell.
   */
  it("collapses concurrent reconnects into one", async () => {
    let connects = 0;
    const s = new BridgeSupervisor({
      connect: async () => {
        connects += 1;
        await new Promise((r) => setTimeout(r, 20));
      },
      disconnect: async () => {},
      logger: quietLogger,
    });

    const [a, b] = await Promise.all([s.reconnect(), s.reconnect()]);
    expect(a || b).toBe(true);
    expect(connects).toBe(1);
  });
});
