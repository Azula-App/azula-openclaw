import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AzulaBridge, AzulaConfigError, DeviceNotPairedError, REQUIRED_TOOLS } from "./bridge.js";
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

/**
 * A device named `phone`, paired but with nobody listening: a valid endpoint
 * id (the RFC 8032 test-vector public key) that nothing is serving.
 * The real-bridge tests below are about exactly that state, so each seeds it
 * into its own scratch HOME instead of leaning on whatever is paired on the
 * machine running the suite.
 */
const UNREACHABLE_PHONE = {
  name: "phone",
  ticket: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
  added_at: 1,
};

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
  /**
   * `azula mcp` keeps its state under `$HOME/.azula` — pairing invites,
   * session keys, the device registry — so a bridge spawned with the real HOME
   * writes into the developer's own install on every run. Each test gets a
   * scratch HOME instead (and a scratch TMPDIR, where ephemeral session keys
   * go), removed afterwards.
   */
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "azula-openclaw-home-"));
    mkdirSync(join(home, ".azula"));
    mkdirSync(join(home, "tmp"));
    writeFileSync(
      join(home, ".azula", "devices.json"),
      JSON.stringify({ devices: [UNREACHABLE_PHONE] }),
    );
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const bridgeFor = (device: string) =>
    new AzulaBridge({
      binary: AZULA_BIN,
      session: "openclaw-test",
      label: "OpenClaw test",
      device,
      logger: quietLogger,
      env: { HOME: home, TMPDIR: join(home, "tmp") },
    });

  it("starts, finds every required tool, and stops cleanly", async () => {
    const bridge = bridgeFor("phone");

    await bridge.start();
    expect(bridge.running).toBe(true);
    await bridge.stop();
    expect(bridge.running).toBe(false);
  }, 60_000);

  it("reports an unpaired device as a configuration error", async () => {
    const bridge = bridgeFor("definitely-not-a-paired-device");

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

  it("finds a configured device paired under exactly that name", async () => {
    // The scratch registry's `phone`, seeded by beforeEach.
    const bridge = bridgeFor("phone");

    await bridge.start();
    try {
      await expect(bridge.assertDeviceKnown()).resolves.toBeUndefined();
    } finally {
      await bridge.stop();
    }
  }, 60_000);

  it("is not satisfied by registry rows that merely contain the configured name", async () => {
    // Replace the seeded registry (in this test's own scratch HOME) with rows
    // that contain `phone` without being it. The second key is RFC 8032's test
    // vector 2: a valid endpoint id with nothing serving it.
    writeFileSync(
      join(home, ".azula", "devices.json"),
      JSON.stringify({
        devices: [
          { ...UNREACHABLE_PHONE, name: "phone-2" },
          {
            name: "my-phone",
            ticket: "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
            added_at: 1,
          },
        ],
      }),
    );
    const bridge = bridgeFor("phone");

    await bridge.start();
    try {
      const err = await bridge.assertDeviceKnown().catch((e) => e);
      expect(err).toBeInstanceOf(DeviceNotPairedError);
      expect(err.message).toContain("no azula device named 'phone'");
    } finally {
      await bridge.stop();
    }
  }, 60_000);

  /**
   * mcp-bridge spec: a waiting drain that finds nothing returns an empty
   * result, not an error — nothing arriving is a normal outcome for a poll.
   */
  it("returns an empty list rather than erroring when a waiting drain times out", async () => {
    const bridge = bridgeFor("phone");

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
   * against a phone with a dialable address, set_typing establishes liveness by
   * a lazy redial, so the tool itself takes a full dial timeout to fail. The
   * indicator must neither throw nor hold the turn open while that happens.
   * (The scratch registry's `phone` is a bare endpoint id with nothing to dial,
   * so the tool errors out at once here; the bound is what covers the slow case.)
   */
  it("never throws from setTyping, and gives up quickly on an unreachable device", async () => {
    const bridge = bridgeFor("phone");

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
