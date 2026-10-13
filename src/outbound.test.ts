import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function fakeRuntime(
  accountId = "default",
  extra: { fetchMedia?: (url: string) => Promise<{ path: string }> } = {},
) {
  const sent: Sent[] = [];
  const bridge = {
    sendMessage: async (text: string) => void sent.push({ kind: "text", text }),
    sendFile: async (path: string, caption?: string) =>
      void sent.push({ kind: "file", path, ...(caption ? { caption } : {}) }),
  };
  registerRuntime(accountId, {
    bridge: bridge as never,
    surfaces: new SurfaceTracker(),
    ...extra,
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
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

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
   * URL is fetched first. With nothing to fetch it, the caption must not be
   * lost with it: the link goes out as text.
   */
  it("sends the caption, then the link as its own message, when there is no way to fetch a remote URL", async () => {
    const sent = fakeRuntime();
    await sendMedia({ mediaUrl: "https://example.com/a.png", text: "look" });
    expect(sent).toEqual([
      { kind: "text", text: "look" },
      { kind: "text", text: "Image: https://example.com/a.png" },
    ]);
  });

  it("sends just the link when a remote URL has no caption and cannot be fetched", async () => {
    const sent = fakeRuntime();
    await sendMedia({ mediaUrl: "https://example.com/report.pdf" });
    expect(sent).toEqual([{ kind: "text", text: "Attachment: https://example.com/report.pdf" }]);
  });

  it("sends the caption before fetching a remote URL, then the local copy", async () => {
    const file = join(dir, "fetched.png");
    writeFileSync(file, "png");
    const asked: string[] = [];
    const seenWhenAsked: number[] = [];
    let sentRef: Sent[] = [];
    sentRef = fakeRuntime("default", {
      fetchMedia: async (url) => {
        asked.push(url);
        // What had already reached the phone when the fetch began.
        seenWhenAsked.push(sentRef.length);
        return { path: file };
      },
    });
    await sendMedia({ mediaUrl: "https://example.com/a.png?x=1", text: "look" });
    expect(asked).toEqual(["https://example.com/a.png?x=1"]);
    expect(seenWhenAsked).toEqual([1]);
    expect(sentRef).toEqual([
      { kind: "text", text: "look" },
      { kind: "file", path: file },
    ]);
  });

  it("falls back to the link, not an error, when the fetch fails", async () => {
    const sent = fakeRuntime("default", {
      fetchMedia: async () => {
        throw new Error("blocked");
      },
    });
    await sendMedia({ mediaUrl: "https://example.com/a.png", text: "look" });
    expect(sent).toEqual([
      { kind: "text", text: "look" },
      { kind: "text", text: "Image: https://example.com/a.png" },
    ]);
  });

  it("says what the caption was, then refuses, for a reference no path can carry", async () => {
    const sent = fakeRuntime();
    await expect(
      sendMedia({ mediaUrl: "data:image/png;base64,AAAA", text: "inline" }),
    ).rejects.toThrow(/only attach local files/);
    expect(sent).toEqual([{ kind: "text", text: "inline" }]);
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
