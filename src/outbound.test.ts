import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { localPathFor, sendMedia, sendText } from "./outbound.js";
import {
  assertSendableSize,
  clearRuntimes,
  NoRuntimeError,
  registerRuntime,
} from "./runtime.js";
import { MAX_FILE_BYTES } from "./bridge.js";
import { SurfaceTracker } from "./surfaces.js";

type Sent = { kind: "text"; text: string } | { kind: "file"; path: string; caption?: string };

function fakeRuntime(accountId = "default") {
  const sent: Sent[] = [];
  const bridge = {
    sendMessage: async (text: string) => void sent.push({ kind: "text", text }),
    sendFile: async (path: string, caption?: string) =>
      void sent.push({ kind: "file", path, ...(caption ? { caption } : {}) }),
  };
  registerRuntime(accountId, {
    bridge: bridge as never,
    surfaces: new SurfaceTracker(),
  });
  return sent;
}

afterEach(() => clearRuntimes());

describe("sendText", () => {
  it("delivers the text and returns a correlatable id", async () => {
    const sent = fakeRuntime();
    const result = await sendText({ text: "hello" });
    expect(sent).toEqual([{ kind: "text", text: "hello" }]);
    expect(result.messageId).toMatch(/^azula-/);
  });

  it("mints a distinct id per send", async () => {
    fakeRuntime();
    const a = await sendText({ text: "one" });
    const b = await sendText({ text: "two" });
    expect(a.messageId).not.toBe(b.messageId);
  });

  it("routes to the account's own bridge", async () => {
    const home = fakeRuntime("default");
    const work = fakeRuntime("work");
    await sendText({ text: "for work", accountId: "work" });
    expect(work).toHaveLength(1);
    expect(home).toHaveLength(0);
  });

  it("fails clearly when no bridge is running for the account", async () => {
    await expect(sendText({ text: "hi" })).rejects.toBeInstanceOf(NoRuntimeError);
  });
});

describe("sendMedia", () => {
  const dir = mkdtempSync(join(tmpdir(), "azula-openclaw-"));

  it("attaches a local file, using the text as its caption", async () => {
    const sent = fakeRuntime();
    const file = join(dir, "note.txt");
    writeFileSync(file, "hello");

    await sendMedia({ mediaUrl: file, text: "look at this" });
    expect(sent).toEqual([{ kind: "file", path: file, caption: "look at this" }]);
  });

  it("accepts a file:// URL", async () => {
    const sent = fakeRuntime();
    const file = join(dir, "via-url.txt");
    writeFileSync(file, "hi");

    await sendMedia({ mediaUrl: pathToFileURL(file).href });
    expect(sent[0]).toMatchObject({ kind: "file", path: file });
  });

  /**
   * azula's send_file reads from the machine running the bridge, so a remote
   * URL cannot be attached — and A2UI deliberately will not fetch one either.
   */
  it("refuses a remote URL rather than pretending to fetch it", async () => {
    fakeRuntime();
    await expect(
      sendMedia({ mediaUrl: "https://example.com/a.png" }),
    ).rejects.toThrow(/only attach local files/);
  });

  it("falls back to text when the payload has no media", async () => {
    const sent = fakeRuntime();
    await sendMedia({ text: "no media here" });
    expect(sent).toEqual([{ kind: "text", text: "no media here" }]);
  });

  it("reports an unreadable file by path", async () => {
    fakeRuntime();
    await expect(
      sendMedia({ mediaUrl: join(dir, "does-not-exist.bin") }),
    ).rejects.toThrow(/could not read/);
  });
});

describe("size cap", () => {
  it("names the limit and refuses before any transfer", () => {
    expect(() => assertSendableSize(MAX_FILE_BYTES + 1, "huge.bin")).toThrow(
      /64 MiB/,
    );
    expect(() => assertSendableSize(MAX_FILE_BYTES + 1, "huge.bin")).toThrow(
      /huge\.bin/,
    );
  });

  it("allows a file exactly at the limit", () => {
    expect(() => assertSendableSize(MAX_FILE_BYTES, "exact.bin")).not.toThrow();
  });
});

describe("localPathFor", () => {
  it("passes through plain paths and rejects remote schemes", () => {
    expect(localPathFor("/tmp/a.png")).toBe("/tmp/a.png");
    expect(localPathFor("relative/a.png")).toBe("relative/a.png");
    expect(localPathFor("https://example.com/a.png")).toBeNull();
    expect(localPathFor("data:image/png;base64,AAA")).toBeNull();
    // A Windows drive letter is a path, not a scheme.
    expect(localPathFor("C:\\Users\\sal\\a.png")).toBe("C:\\Users\\sal\\a.png");
  });
});
