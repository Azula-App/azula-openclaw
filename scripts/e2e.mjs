/**
 * End-to-end check against a real phone, driven through the plugin's own
 * bridge client — so this exercises the shipped code path, not a stand-in.
 *
 * Usage: node scripts/e2e.mjs <device-name>
 *
 * Not part of `npm test`: it needs a connected device and drives real UI.
 */

import { AzulaBridge } from "../dist/src/bridge.js";
import {
  buildChoiceComponents,
  choiceFallbackText,
  surfaceIdFor,
} from "../dist/src/surfaces.js";
import { translateBatch } from "../dist/src/inbound.js";

// The device connects to THIS session, so its name is discovered at runtime
// rather than passed in: an azula session has its own identity, and a device
// paired to a different session is not reachable from this one.
let device = process.argv[2] ?? "pending";

const logger = {
  debug: () => {},
  info: (m) => console.log(`  info: ${m}`),
  warn: (m) => console.log(`  warn: ${m}`),
  error: (m) => console.error(`  error: ${m}`),
};

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const bridge = new AzulaBridge({
  binary: "/Users/sal/Developer/azula/azula-cli/target/debug/azula",
  session: "openclaw-e2e-run",
  label: "OpenClaw E2E",
  device,
  logger,
});

try {
  await bridge.start();
  check("bridge starts and has every required tool", true);

  // Print this session's invite so the harness can deep-link it, then wait
  // for the phone to dial in.
  const invite = await bridge.pairingInvite();
  const url = invite.match(/https:\/\/azula\.app\/i\/\S+/)?.[0];
  console.log(`\n>>> INVITE ${url}\n`);

  // A phone dialling in emits a `connected` event naming itself — which is
  // exactly what get_events carries, so wait on that rather than scraping
  // list_devices' human-readable table.
  const connectDeadline = Date.now() + 120_000;
  let connected = null;
  while (Date.now() < connectDeadline && !connected) {
    const events = await bridge.getEvents(5, { allDevices: true });
    connected = events.find((e) => e.type === "connected")?.device ?? null;
    if (!connected) {
      const listed = await bridge.listDevices();
      const line = listed.find((l) => /\bconnected\b/.test(l) && !/disconnected/.test(l));
      connected = line ? line.split(/\s+/)[0] : null;
    }
  }
  if (!connected) throw new Error("no device connected to this session within 120s");
  device = connected;
  bridge.setDevice(device);
  console.log(`>>> CONNECTED ${device}`);
  check("phone connects to this session", true, device);

  // --- typing indicator -------------------------------------------------
  const t0 = Date.now();
  await bridge.setTyping(true);
  await bridge.setTyping(false);
  check(
    "typing indicator round-trips promptly",
    Date.now() - t0 < 10_000,
    `${Date.now() - t0}ms`,
  );

  // --- outbound text ----------------------------------------------------
  await bridge.sendMessage("Hello from OpenClaw, over azula.");
  check("outbound text sent", true);

  // --- interactive surface ---------------------------------------------
  const messageId = "e2e-approval";
  const surfaceId = surfaceIdFor(messageId);
  const prompt = {
    text: "Deploy to production?",
    choices: [
      { id: "approve", label: "Approve" },
      { id: "reject", label: "Reject" },
    ],
  };
  await bridge.sendMessage(choiceFallbackText(prompt));
  await bridge.renderUi(surfaceId, buildChoiceComponents(prompt));
  check("A2UI surface rendered with its text fallback", true, surfaceId);

  // Drain anything queued before the tap, so the tap is unambiguous.
  await bridge.getEvents();

  console.log("\n>>> WAITING for a tap on the surface (60s)...");
  const deadline = Date.now() + 60_000;
  let tap = null;
  let raw = [];
  while (Date.now() < deadline && !tap) {
    const events = await bridge.getEvents(5);
    raw.push(...events);
    const items = translateBatch(events);
    tap = items.find((i) => i.kind === "choice") ?? null;
  }

  if (tap) {
    check(
      "tap arrives as a structured ui_event, not a rendered line",
      raw.some((e) => e.type === "ui_event"),
      JSON.stringify(raw.find((e) => e.type === "ui_event")?.event ?? {}).slice(0, 160),
    );
    check(
      "tap correlates back to the asking message",
      tap.replyToMessageId === messageId,
      `replyToMessageId=${tap.replyToMessageId}`,
    );
    check("tap carries the chosen value", Boolean(tap.value), `value=${tap.value}`);
  } else {
    check("tap received", false, "no ui_event within 60s");
  }

  await bridge.deleteUi(surfaceId);
  check("surface removed after resolution", true);
} catch (err) {
  check("run completed without an unexpected error", false, String(err?.message ?? err));
} finally {
  await bridge.stop();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
