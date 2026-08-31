/**
 * The one leg the main e2e cannot drive on its own: a file sent FROM the
 * phone, arriving as an inbound `file` event with its media facts intact.
 *
 * Usage: node scripts/e2e-inbound-file.mjs
 * Prints its pairing invite, waits for a phone, then waits for a file.
 */

import { AzulaBridge } from "../dist/src/bridge.js";
import { translateBatch } from "../dist/src/inbound.js";

const logger = {
  debug: () => {},
  info: (m) => console.log(`  info: ${m}`),
  warn: (m) => console.log(`  warn: ${m}`),
  error: (m) => console.error(`  error: ${m}`),
};

const runId = process.env.E2E_RUN_ID ?? String(process.pid);
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const bridge = new AzulaBridge({
  binary: "/Users/sal/Developer/azula/azula-cli/target/debug/azula",
  session: `openclaw-file-${runId}`,
  label: `OpenClaw File ${runId}`,
  device: "pending",
  logger,
});

try {
  await bridge.start();
  check("bridge starts", true);

  const invite = await bridge.pairingInvite();
  console.log(`\n>>> INVITE ${invite.match(/https:\/\/azula\.app\/i\/\S+/)?.[0]}\n`);

  const connectDeadline = Date.now() + 120_000;
  let device = null;
  let early = [];
  while (Date.now() < connectDeadline && !device) {
    const events = await bridge.getEvents(5, { allDevices: true });
    // Any event names a live device, not just `connected` — and a drain that
    // discarded the others would lose the very file this checks for, since
    // get_events is destructive.
    device = events[0]?.device ?? null;
    early = events;
  }
  if (!device) throw new Error("no device connected within 120s");
  bridge.setDevice(device);
  check("phone connected", true, device);

  await bridge.sendMessage("Send me a file from the phone (paperclip → Downloads).");
  console.log("\n>>> WAITING for an inbound file (120s)...\n");

  const fileDeadline = Date.now() + 120_000;
  let fileEvent = early.find((e) => e.type === "file") ?? null;
  let items = fileEvent ? translateBatch(early) : [];
  while (Date.now() < fileDeadline && !fileEvent) {
    const events = await bridge.getEvents(5);
    if (events.length) {
      items = translateBatch(events);
      fileEvent = events.find((e) => e.type === "file") ?? null;
    }
  }

  if (!fileEvent) {
    check("inbound file received", false, "none within 120s");
  } else {
    check(
      "inbound file arrives as a structured `file` event",
      true,
      JSON.stringify(fileEvent).slice(0, 200),
    );
    check(
      "media facts are present and complete",
      Boolean(fileEvent.name && fileEvent.mime && fileEvent.size > 0 && fileEvent.path),
      `${fileEvent.name} (${fileEvent.mime}, ${fileEvent.size}B)`,
    );
    const msg = items.find((i) => i.kind === "message" && i.media.length > 0);
    check(
      "translates into a message carrying ordered media facts",
      Boolean(msg),
      msg && msg.kind === "message" ? msg.media.map((m) => m.filename).join(",") : "",
    );
  }
} catch (err) {
  check("run completed without an unexpected error", false, String(err?.message ?? err));
} finally {
  await bridge.stop();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
