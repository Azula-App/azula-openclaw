/**
 * The bridge is a child process, and the failure modes that matter for a
 * gateway are about that process: not leaving one behind, and not waiting on
 * one that will never answer. These run real children (small `sh` scripts that
 * stand in for a misbehaving `azula`), because a mock cannot leak a process.
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AzulaBridge } from "./bridge.js";
import { AzulaMcpClient, McpError } from "./mcp-client.js";

const quietLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Write an executable script; returns its path and where it records its pid. */
function script(body: string) {
  const dir = mkdtempSync(join(tmpdir(), "azula-proc-test-"));
  dirs.push(dir);
  const pidFile = join(dir, "pid");
  const path = join(dir, "fake-azula.sh");
  writeFileSync(path, `#!/bin/sh\necho $$ > "${pidFile}"\n${body}\n`);
  chmodSync(path, 0o755);
  return { path, pid: () => Number(readFileSync(pidFile, "utf8").trim()) };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Give the OS a moment to reap a killed child before checking it is gone. */
async function gone(pid: number, withinMs = 2_000) {
  const deadline = Date.now() + withinMs;
  while (alive(pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return !alive(pid);
}

const bridgeFor = (binary: string) =>
  new AzulaBridge({
    binary,
    session: "test",
    label: "test",
    device: "phone",
    logger: quietLogger,
  });

describe("a bridge that never finishes starting", () => {
  /**
   * An abort that lands during the handshake must be able to kill the child it
   * is waiting on; otherwise the process outlives the gateway's shutdown.
   */
  it("is killed by stop(), and start() fails instead of hanging", async () => {
    const fake = script("exec sleep 60"); // never answers `initialize`
    const bridge = bridgeFor(fake.path);

    const starting = bridge.start().catch((e) => e);
    await new Promise((r) => setTimeout(r, 200));
    const pid = fake.pid();
    expect(alive(pid)).toBe(true);

    const began = Date.now();
    await bridge.stop();
    const outcome = await starting;

    expect(outcome).toBeInstanceOf(McpError);
    expect(Date.now() - began).toBeLessThan(3_000);
    expect(await gone(pid)).toBe(true);
  }, 20_000);
});

describe("a handshake that fails part-way", () => {
  /**
   * The child answered, wrongly, and is still running. Nothing else holds a
   * reference to it, so start() must reap it before it reports the failure.
   */
  it("does not leave the child running", async () => {
    const fake = script(
      `read line
echo '{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"not a bridge"}}'
exec sleep 60`,
    );
    const bridge = bridgeFor(fake.path);

    const err = await bridge.start().catch((e) => e);

    expect(err).toBeInstanceOf(McpError);
    expect(err.message).toContain("not a bridge");
    expect(await gone(fake.pid())).toBe(true);
  }, 20_000);
});

describe("stopping the client", () => {
  /** A bridge that ignores SIGTERM must not be left behind or hang shutdown. */
  it("escalates to SIGKILL for a child that ignores SIGTERM", async () => {
    const fake = script(
      `trap '' TERM
read line
echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"x","version":"0"}}}'
read line
read line
echo '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"send_message"}]}}'
while :; do sleep 1; done`,
    );
    const client = new AzulaMcpClient({ command: fake.path, args: [], logger: quietLogger });
    await client.start();
    const pid = fake.pid();
    expect(alive(pid)).toBe(true);

    const began = Date.now();
    await client.stop();

    const took = Date.now() - began;
    expect(took).toBeGreaterThanOrEqual(1_500);
    expect(took).toBeLessThan(4_500);
    expect(await gone(pid)).toBe(true);
  }, 20_000);

  it("fails an in-flight call at once instead of waiting it out", async () => {
    const fake = script(
      `read line
echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"x","version":"0"}}}'
read line
read line
echo '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"get_events"}]}}'
exec sleep 60`,
    );
    const client = new AzulaMcpClient({ command: fake.path, args: [], logger: quietLogger });
    await client.start();

    // A long poll: the child never answers it.
    const poll = client.call("get_events", { timeout_s: 25 }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 100));

    const began = Date.now();
    await client.stop();
    const outcome = await poll;

    expect(outcome).toBeInstanceOf(McpError);
    expect(Date.now() - began).toBeLessThan(3_000);
  }, 20_000);

  it("does not wait for a child that has already exited", async () => {
    const fake = script(
      `read line
echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"x","version":"0"}}}'
read line
read line
echo '{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}'
exit 0`,
    );
    let exited = false;
    const client = new AzulaMcpClient({
      command: fake.path,
      args: [],
      logger: quietLogger,
      onExit: () => (exited = true),
    });
    await client.start();
    const pid = fake.pid();
    expect(await gone(pid)).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(exited).toBe(true);

    const began = Date.now();
    await client.stop();
    // Nothing is left to exit, so there is nothing to wait for.
    expect(Date.now() - began).toBeLessThan(500);
  }, 20_000);
});
