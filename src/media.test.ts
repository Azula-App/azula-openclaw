import { describe, expect, it } from "vitest";
import { MAX_FILE_BYTES } from "./bridge.js";
import { isRemoteUrl, linkNote, localPathFor, remoteMediaFetcher, resolveMedia } from "./media.js";

type Any = Record<string, any>;

const logs = () => {
  const lines = { debug: [] as string[], warn: [] as string[] };
  return {
    lines,
    logger: {
      debug: (m: string) => void lines.debug.push(m),
      info: () => {},
      warn: (m: string) => void lines.warn.push(m),
      error: () => {},
    },
  };
};

describe("localPathFor", () => {
  it("passes through plain paths and rejects remote schemes", () => {
    expect(localPathFor("/tmp/a.png")).toBe("/tmp/a.png");
    expect(localPathFor("relative/a.png")).toBe("relative/a.png");
    expect(localPathFor("https://example.com/a.png")).toBeNull();
    expect(localPathFor("data:image/png;base64,AAA")).toBeNull();
    // A Windows drive letter is a path, not a scheme.
    expect(localPathFor("C:\\Users\\sal\\a.png")).toBe("C:\\Users\\sal\\a.png");
  });

  it("reads a file:// URL", () => {
    expect(localPathFor("file:///tmp/a%20b.png")).toBe("/tmp/a b.png");
  });
});

describe("isRemoteUrl", () => {
  it("is true for http and https only", () => {
    expect(isRemoteUrl("https://example.com/a.png")).toBe(true);
    expect(isRemoteUrl("HTTP://example.com/a.png")).toBe(true);
    expect(isRemoteUrl("ftp://example.com/a.png")).toBe(false);
    expect(isRemoteUrl("/tmp/a.png")).toBe(false);
  });
});

describe("resolveMedia", () => {
  it("returns a local path as a file, without touching the network", async () => {
    let fetched = false;
    const result = await resolveMedia("/tmp/a.png", {
      fetchMedia: async () => {
        fetched = true;
        return { path: "/x" };
      },
    });
    expect(result).toEqual({ kind: "file", path: "/tmp/a.png" });
    expect(fetched).toBe(false);
  });

  it("fetches a remote URL and returns the local copy", async () => {
    const result = await resolveMedia("https://example.com/a.png?q=1", {
      fetchMedia: async (url) => ({ path: `/media/${url.length}.png` }),
    });
    expect(result).toEqual({ kind: "file", path: "/media/29.png" });
  });

  it("degrades to the link, and warns, when the fetch fails", async () => {
    const { lines, logger } = logs();
    const result = await resolveMedia("https://example.com/a.png", {
      fetchMedia: async () => {
        throw new Error("payload exceeds maxBytes");
      },
      logger,
    });
    expect(result).toEqual({ kind: "link", url: "https://example.com/a.png" });
    expect(lines.warn[0]).toContain("payload exceeds maxBytes");
    expect(lines.warn[0]).toContain("https://example.com/a.png");
  });

  it("degrades to the link when nothing can fetch", async () => {
    const result = await resolveMedia("https://example.com/a.png", {});
    expect(result).toEqual({ kind: "link", url: "https://example.com/a.png" });
  });

  it("refuses a data URI without echoing it", async () => {
    const huge = `data:image/png;base64,${"A".repeat(5000)}`;
    const result = await resolveMedia(huge, {});
    expect(result.kind).toBe("unsupported");
    if (result.kind === "unsupported") expect(result.reason.length).toBeLessThan(200);
  });
});

describe("linkNote", () => {
  it("labels a picture as an image, judging by the path, not the query string", () => {
    expect(linkNote("https://x.org/a/Rockridge%20Station.png?itok=T-N3IK5w")).toBe(
      "Image: https://x.org/a/Rockridge%20Station.png?itok=T-N3IK5w",
    );
    expect(linkNote("https://x.org/photo.JPEG")).toBe("Image: https://x.org/photo.JPEG");
  });

  it("labels anything else as an attachment", () => {
    expect(linkNote("https://x.org/report.pdf")).toBe("Attachment: https://x.org/report.pdf");
    expect(linkNote("https://x.org/download?file=a.png")).toBe(
      "Attachment: https://x.org/download?file=a.png",
    );
  });
});

describe("remoteMediaFetcher", () => {
  function channel(saved: Any[]) {
    return {
      media: {
        saveRemoteMedia: async (options: Any) => {
          saved.push(options);
          return { id: "1", path: "/media/outbound/x.png", size: 1 };
        },
      },
    } as never;
  }

  it("goes through the gateway's guarded loader, capped at azula's limit", async () => {
    const saved: Any[] = [];
    const fetcher = remoteMediaFetcher(channel(saved));
    const result = await fetcher(
      "https://www.bart.gov/sites/default/files/styles/s/public/2024-08/Rockridge%20Station.png?itok=T-N3IK5w",
    );
    expect(result).toEqual({ path: "/media/outbound/x.png" });
    expect(saved[0]).toMatchObject({
      maxBytes: MAX_FILE_BYTES,
      subdir: "outbound",
      originalFilename: "Rockridge Station.png",
    });
    // Bounded, so a slow host cannot hold the reply's text.
    expect(saved[0].timeoutMs).toBeLessThanOrEqual(30_000);
    // The SSRF policy is left to the loader's default (private addresses refused).
    expect(saved[0].ssrfPolicy).toBeUndefined();
  });

  it("offers no file name when the URL path has none worth keeping", async () => {
    const saved: Any[] = [];
    await remoteMediaFetcher(channel(saved))("https://example.com/image?id=7");
    expect(saved[0]).not.toHaveProperty("originalFilename");
  });
});
