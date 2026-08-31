import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { AzulaBridge, AzulaConfigError, REQUIRED_TOOLS } from "./bridge.js";
import { extractToolNames } from "./mcp-client.js";

const quietLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * The azula binary built from this checkout. Present when azula-cli has been
 * built; the real-bridge tests below skip cleanly when it has not, so this
 * suite still runs on a machine that only has the plugin.
 */
const AZULA_BIN =
  "/Users/sal/Developer/azula/azula-cli/target/debug/azula";
const haveAzula = existsSync(AZULA_BIN);

describe("extractToolNames", () => {
  it("pulls names and tolerates shape drift", () => {
    expect(extractToolNames({ tools: [{ name: "a" }, { name: "b" }] })).toEqual(["a", "b"]);
    expect(extractToolNames({ tools: [{ name: "a" }, {}, 5] })).toEqual(["a"]);
    expect(extractToolNames({})).toEqual([]);
    expect(extractToolNames(null)).toEqual([]);
  });
});

describe("prerequisite failures", () => {
  it("reports a missing binary as a configuration error naming the fix", async () => {
    const bridge = new AzulaBridge({
      binary: "/nonexistent/azula-does-not-exist",
      session: "test",
      label: "test",
      device: "phone",
      logger: quietLogger,
    });

    const err = await bridge.start().catch((e) => e);
    expect(err).toBeInstanceOf(AzulaConfigError);
    expect(err.message).toContain("could not be run");
    expect(err.remedy).toMatch(/install it|full path/);
    // The operator-facing string names both the problem and the remedy.
    expect(err.full).toContain("→");
  });
});

describe.runIf(haveAzula)("against a real azula bridge", () => {
  it("starts, finds every required tool, and stops cleanly", async () => {
    const bridge = new AzulaBridge({
      binary: AZULA_BIN,
      session: "openclaw-test",
      label: "OpenClaw test",
      device: "phone",
      logger: quietLogger,
    });

    await bridge.start();
    expect(bridge.running).toBe(true);
    await bridge.stop();
    expect(bridge.running).toBe(false);
  }, 60_000);

  it("reports an unpaired device as a configuration error", async () => {
    const bridge = new AzulaBridge({
      binary: AZULA_BIN,
      session: "openclaw-test",
      label: "OpenClaw test",
      device: "definitely-not-a-paired-device",
      logger: quietLogger,
    });

    await bridge.start();
    try {
      const err = await bridge.assertDeviceKnown().catch((e) => e);
      expect(err).toBeInstanceOf(AzulaConfigError);
      expect(err.message).toContain("definitely-not-a-paired-device");
      expect(err.remedy).toContain("pair");
    } finally {
      await bridge.stop();
    }
  }, 60_000);

  /**
   * mcp-bridge spec: a waiting drain that finds nothing returns an empty
   * result, not an error — nothing arriving is a normal outcome for a poll.
   */
  it("returns an empty list rather than erroring when a waiting drain times out", async () => {
    const bridge = new AzulaBridge({
      binary: AZULA_BIN,
      session: "openclaw-test",
      label: "OpenClaw test",
      device: "phone",
      logger: quietLogger,
    });

    await bridge.start();
    try {
      // `phone` is paired but not currently connected, so get_events finds no
      // live entry for it and reports an unknown device; with a connected but
      // quiet device the same call returns []. Either way it must return
      // promptly and in a shape the pump can handle.
      const result = await bridge.getEvents(1).catch((e) => e as Error);
      if (result instanceof Error) {
        expect(result.message).toContain("unknown device");
      } else {
        expect(Array.isArray(result)).toBe(true);
      }
    } finally {
      await bridge.stop();
    }
  }, 60_000);

  /**
   * `phone` here is paired but unreachable, which is the interesting case:
   * set_typing establishes liveness by a lazy redial, so the tool itself takes
   * a full dial timeout to fail. The indicator must neither throw nor hold the
   * turn open while that happens.
   */
  it("never throws from setTyping, and gives up quickly on an unreachable device", async () => {
    const bridge = new AzulaBridge({
      binary: AZULA_BIN,
      session: "openclaw-test",
      label: "OpenClaw test",
      device: "phone",
      logger: quietLogger,
    });

    await bridge.start();
    try {
      const started = Date.now();
      await expect(bridge.setTyping(true)).resolves.toBeUndefined();
      await expect(bridge.setTyping(false)).resolves.toBeUndefined();
      const elapsed = Date.now() - started;
      // Two bounded attempts; well under the dial timeout that would otherwise
      // stall the heartbeat.
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      await bridge.stop();
    }
  }, 60_000);
});

describe("constants", () => {
  it("requires exactly the tools the plugin calls unconditionally", () => {
    expect([...REQUIRED_TOOLS]).toEqual(["send_message", "get_events", "set_typing"]);
  });
});
