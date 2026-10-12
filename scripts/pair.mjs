#!/usr/bin/env node
/**
 * Pair a phone with the azula session an account of this channel will use.
 *
 * The phone has to pair with *that* session — the persistent identity the
 * channel's `azula mcp --session <name>` runs as — so this starts exactly the
 * process the channel would, asks it for its invite, and waits for a phone to
 * redeem it. It then prints the name to put in `channels.azula.device`.
 *
 * Run it on the gateway machine, as the user the gateway runs as, BEFORE the
 * channel is enabled (or with it stopped): one session cannot be held by two
 * processes at once.
 *
 *   node pair.mjs [--binary azula] [--session openclaw] [--label OpenClaw] [--wait 900]
 *
 * It never drains the session's inbox, so it does not swallow anything the
 * phone sends; a message sent before the channel is running is simply not
 * delivered to the agent.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

const { values: opts } = parseArgs({
  options: {
    binary: { type: "string", default: "azula" },
    session: { type: "string", default: "openclaw" },
    label: { type: "string", default: "OpenClaw" },
    wait: { type: "string", default: "900" },
  },
});

const child = spawn(opts.binary, ["mcp", "--session", opts.session, "--name", opts.label], {
  // azula logs to stderr; keep it out of the way unless something goes wrong.
  stdio: ["pipe", "pipe", "pipe"],
});
let stderrTail = "";
child.stderr.on("data", (chunk) => {
  stderrTail = (stderrTail + chunk).slice(-4000);
});
child.on("error", (err) => fail(`could not run '${opts.binary}': ${err.message}`));
child.on("exit", (code) => fail(`azula exited (code ${code})\n${stderrTail}`));

const pending = new Map();
let nextId = 1;
createInterface({ input: child.stdout }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const waiter = pending.get(msg.id);
  if (!waiter) return;
  pending.delete(msg.id);
  if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
  else waiter.resolve(msg.result);
});

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

async function call(name, args = {}) {
  const result = await rpc("tools/call", { name, arguments: args });
  const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
  if (result.isError) throw new Error(`${name}: ${text}`);
  return text;
}

function fail(message) {
  console.error(`pair: ${message}`);
  process.exit(1);
}

/** `list_devices` lines → name → status ("connected" | "disconnected" | "offline"). */
function devices(listing) {
  const out = new Map();
  for (const line of listing.split("\n")) {
    const m = line.match(/^\s+(\S+)\s+\[[^\]]*\]\s+(\w+)\s*$/);
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "azula-openclaw-pair", version: "1" },
});
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const tools = (await rpc("tools/list", {})).tools.map((t) => t.name);
for (const needed of ["start_pairing", "list_devices", "get_events", "set_typing"]) {
  if (!tools.includes(needed)) {
    fail(`this azula has no '${needed}' tool; the channel needs azula 0.3.0 or newer`);
  }
}

const before = devices(await call("list_devices"));
console.log(await call("start_pairing"));
console.log(
  `\nWaiting up to ${opts.wait}s for a phone to pair with session '${opts.session}'` +
    ` (in the azula app: + connect a peer, then scan or paste)…`,
);

const deadline = Date.now() + Number(opts.wait) * 1000;
let paired = null;
while (!paired && Date.now() < deadline) {
  await sleep(2000);
  for (const [name, status] of devices(await call("list_devices"))) {
    // A new row is a first-time pairing; a known device turning `connected`
    // is a phone that was already paired dialling this session.
    if (!before.has(name) || (status === "connected" && before.get(name) !== "connected")) {
      paired = name;
      break;
    }
  }
}

child.removeAllListeners("exit");
child.kill("SIGTERM");

if (!paired) fail(`no phone paired within ${opts.wait}s`);
console.log(`\nPaired: ${paired}\n\nPoint the channel at it:\n`);
console.log(`  openclaw config set channels.azula.device ${paired}`);
process.exit(0);
