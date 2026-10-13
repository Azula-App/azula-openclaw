/**
 * Getting an outbound attachment onto local disk, where azula can send it.
 *
 * azula's `send_file` reads from the machine running the bridge, so a remote
 * URL (an image the agent found, a chart a tool rendered) cannot be sent as it
 * stands. This module is the one place that decides what to do with one:
 * fetch it through OpenClaw's guarded loader and send the local copy, or, when
 * that is not possible, hand the link back so the caller can send it as a short
 * message of its own. Either way the answer is never "throw and lose the message
 * it came with", and a caller never has to wait on a fetch before sending text.
 */

import { fileURLToPath } from "node:url";
import { MAX_FILE_BYTES } from "./bridge.js";
import type { ChannelRuntime } from "./agent.js";
import type { Logger } from "./mcp-client.js";

/**
 * Fetch a remote URL to a local file. Injected, because the real one is the
 * gateway's (`channel.media.saveRemoteMedia`) and tests have no network.
 */
export type RemoteMediaFetcher = (url: string) => Promise<{ path: string }>;

/**
 * Bounds on a remote fetch, so one slow host cannot hold up the attachments
 * queued behind it (the reply's text never waits on a fetch).
 */
const FETCH_TIMEOUT_MS = 30_000;
const FETCH_HEADER_TIMEOUT_MS = 15_000;
const FETCH_IDLE_TIMEOUT_MS = 15_000;

/**
 * The gateway's remote-media loader, as a {@link RemoteMediaFetcher}.
 *
 * `saveRemoteMedia` is OpenClaw's SSRF-guarded fetch: it refuses private and
 * loopback addresses (including after a redirect), follows a bounded number of
 * redirects, and streams the body into the media store while enforcing a size
 * cap, so an oversized download is cut off rather than buffered. The cap is
 * azula's own 64 MiB, so what it saves is always something `send_file` accepts.
 */
export function remoteMediaFetcher(channel: Pick<ChannelRuntime, "media">): RemoteMediaFetcher {
  return async (url) => {
    const name = fileNameOf(url);
    const saved = await channel.media.saveRemoteMedia({
      url,
      maxBytes: MAX_FILE_BYTES,
      subdir: "outbound",
      timeoutMs: FETCH_TIMEOUT_MS,
      responseHeaderTimeoutMs: FETCH_HEADER_TIMEOUT_MS,
      readIdleTimeoutMs: FETCH_IDLE_TIMEOUT_MS,
      ...(name ? { originalFilename: name } : {}),
    });
    return { path: saved.path };
  };
}

/** A readable file name for a URL, when its path ends in one. */
function fileNameOf(url: string): string | undefined {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (!last) return undefined;
    const name = decodeURIComponent(last);
    return /\.[A-Za-z0-9]{1,8}$/.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a media reference is an http(s) URL. */
export function isRemoteUrl(mediaUrl: string): boolean {
  return /^https?:\/\//i.test(mediaUrl);
}

/**
 * Resolve an outbound media reference to a local path.
 *
 * `null` means "not something `send_file` can read as it stands": any URL
 * scheme other than `file://`. The scheme must be two or more characters so a
 * Windows drive letter (`C:\\...`) is still treated as the local path it is.
 * `data:` has no `//`, so matching on `://` alone would let a data URI through
 * and fail later as a missing file.
 */
export function localPathFor(mediaUrl: string): string | null {
  if (mediaUrl.startsWith("file://")) {
    try {
      return fileURLToPath(mediaUrl);
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]+:/i.test(mediaUrl)) return null;
  return mediaUrl;
}

/** What to do with one attachment. */
export type ResolvedMedia =
  /** A local file to send. */
  | { kind: "file"; path: string }
  /** A remote file that could not be fetched: send this link as a message instead. */
  | { kind: "link"; url: string }
  /** A reference no channel path can carry (a `data:` URI, say). */
  | { kind: "unsupported"; reason: string };

/**
 * Decide how one attachment reaches the phone.
 *
 * Never throws: a remote fetch that fails (blocked address, bad status, over
 * the cap, timeout) degrades to the link, and says why through the logger.
 */
export async function resolveMedia(
  mediaUrl: string,
  options: { fetchMedia?: RemoteMediaFetcher | undefined; logger?: Logger | undefined },
): Promise<ResolvedMedia> {
  const local = localPathFor(mediaUrl);
  if (local !== null) return { kind: "file", path: local };

  if (!isRemoteUrl(mediaUrl)) {
    return {
      kind: "unsupported",
      reason: `azula can only attach local files or http(s) links, not '${describe(mediaUrl)}'`,
    };
  }

  if (!options.fetchMedia) {
    options.logger?.debug(`azula: no media loader available; sending ${mediaUrl} as a link`);
    return { kind: "link", url: mediaUrl };
  }
  try {
    return { kind: "file", path: (await options.fetchMedia(mediaUrl)).path };
  } catch (err) {
    options.logger?.warn(
      `azula: could not fetch ${mediaUrl}; sending it as a link instead: ${(err as Error).message}`,
    );
    return { kind: "link", url: mediaUrl };
  }
}

/**
 * The short message sent in place of an attachment that could not be fetched.
 *
 * Labelled by what the link most likely is, so the phone shows "Image: ..." for
 * a picture rather than a bare URL; the label is a courtesy, the link is the point.
 */
export function linkNote(url: string): string {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Not parseable; judge by the raw string.
  }
  return /\.(?:png|jpe?g|gif|webp|avif|bmp|svg|heic|heif|tiff?)$/i.test(pathname)
    ? `Image: ${url}`
    : `Attachment: ${url}`;
}

/** A reference short enough for a log line (a `data:` URI can be megabytes). */
function describe(mediaUrl: string): string {
  return mediaUrl.length > 80 ? `${mediaUrl.slice(0, 77)}...` : mediaUrl;
}
