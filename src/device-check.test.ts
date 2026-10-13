import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AzulaBridge, DeviceNotPairedError } from "./bridge.js";
import { parseDeviceLines } from "./device-list.js";

/**
 * "Is the configured device paired?" against a stand-in `azula mcp` whose
 * `list_devices` answer the test chooses. Nothing here touches a real azula or
 * its `~/.azula`: the stand-in is a script written to a scratch directory, and it
 * reads the listing it should return from the environment the bridge hands it.
 */
const FAKE_AZULA = `#!${process.execPath}
const { createInterface } = require("node:readline");
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
const tools = ["send_message", "get_events", "set_typing", "list_devices"];
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return reply(msg.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } });
  if (msg.method === "tools/list") return reply(msg.id, { tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })) });
  if (msg.method === "tools/call") return reply(msg.id, { content: [{ type: "text", text: process.env.FAKE_LISTING ?? "" }], isError: false });
});
`;

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };

let dir: string;
let binary: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "azula-openclaw-fake-"));
  binary = join(dir, "azula");
  writeFileSync(binary, FAKE_AZULA);
  chmodSync(binary, 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** What azula 0.3.0 prints, with `rows` as `[name, status]`. */
const listing = (...rows: Array<[string, string]>) =>
  rows.length === 0
    ? "No devices registered. Use `connect` to add one."
    : ["Known devices:", ...rows.map(([name, status]) => `  ${name}  [${name.slice(0, 8)}…]  ${status}`)].join("\n");

async function check(device: string, shown: string) {
  const bridge = new AzulaBridge({
    binary,
    session: "openclaw-test",
    label: "OpenClaw test",
    device,
    logger: quietLogger,
    env: { FAKE_LISTING: shown },
  });
  await bridge.start();
  try {
    return await bridge.assertDeviceKnown().then(
      () => "known" as const,
      (err: unknown) => err,
    );
  } finally {
    await bridge.stop();
  }
}

describe("assertDeviceKnown", () => {
  it("passes for a row named exactly the configured device", async () => {
    expect(await check("phone", listing(["phone", "connected"]))).toBe("known");
    expect(await check("phone", listing(["tablet", "offline"], ["phone", "offline"]))).toBe("known");
  });

  it("passes for a phone registered under its full endpoint id", async () => {
    const id = "2a64dea5aa5ae9bf56b44bb15bfa1ea8e98e5b3a9c33c4ab6bc4bbfa7e1c6a8d";
    expect(await check(id, listing([id, "connected"]))).toBe("known");
  });

  it("passes for a name with a space in it", async () => {
    expect(await check("my phone", listing(["my phone", "offline"]))).toBe("known");
  });

  /**
   * The substring test this replaces let `phone` be satisfied by any row that
   * merely contained it, so a typo'd or stale `device` started instead of
   * blocking, and then sent to a name azula did not have.
   */
  it("is not satisfied by a row that only contains the name", async () => {
    for (const row of ["phone-2", "my-phone", "phones", "xphonex"]) {
      const result = await check("phone", listing([row, "connected"]));
      expect(result, row).toBeInstanceOf(DeviceNotPairedError);
      expect((result as DeviceNotPairedError).message).toContain("no azula device named 'phone'");
    }
  });

  it("is not satisfied by the words of the listing itself", async () => {
    // "devices" is in the heading; "connected" is a status; the fingerprint is in brackets.
    expect(await check("devices", listing(["phone", "connected"]))).toBeInstanceOf(DeviceNotPairedError);
    expect(await check("connected", listing(["phone", "connected"]))).toBeInstanceOf(DeviceNotPairedError);
    expect(await check("phone…", listing(["phone", "connected"]))).toBeInstanceOf(DeviceNotPairedError);
  });

  it("is not satisfied by an empty registry", async () => {
    expect(await check("phone", listing())).toBeInstanceOf(DeviceNotPairedError);
  });

  it("is not satisfied by a name that differs only in case", async () => {
    expect(await check("Phone", listing(["phone", "connected"]))).toBeInstanceOf(DeviceNotPairedError);
  });
});

describe("the list_devices parser the check shares with pairing", () => {
  it("reads a name that contains spaces", () => {
    expect([...parseDeviceLines(["my phone  [abc12345…]  offline"])]).toEqual([["my phone", "offline"]]);
  });

  it("still reads the plain rows, and nothing else", () => {
    expect([...parseDeviceLines(["Known devices:", "  phone  [abc12345…]  connected"])]).toEqual([
      ["phone", "connected"],
    ]);
  });
});
