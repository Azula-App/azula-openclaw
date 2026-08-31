/**
 * The azula side of the channel: one long-lived `azula mcp` session per
 * account, and typed operations over its tool surface.
 *
 * Design D1/D2 (azula-docs, openclaw-channel-plugin): one process serves both
 * directions. azula binds a per-process session identity, so a second process
 * would be a second endpoint id and therefore a second conversation on the
 * phone — which is why inbound comes through `get_events` on this same session
 * rather than from a sibling `azula watch`.
 */

import { AzulaMcpClient, McpError, type Logger } from "./mcp-client.js";
import { parseAzulaEvents, type AzulaEvent } from "./events.js";

/** Tools this plugin cannot work without (design D7). */
export const REQUIRED_TOOLS = [
  "send_message",
  "get_events",
  "set_typing",
] as const;

/**
 * How long to wait on a typing indicator before giving up on it.
 *
 * Short on purpose: a paired-but-unreachable device costs a full dial timeout
 * inside the tool, and an indicator is worth less than a responsive turn.
 */
const TYPING_TIMEOUT_MS = 2_000;

/** azula's inline transfer cap — 64 MiB, mirrored from the mcp-bridge spec. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

export class AzulaConfigError extends Error {
  constructor(
    message: string,
    readonly remedy: string,
  ) {
    super(message);
    this.name = "AzulaConfigError";
  }

  /** The message an operator should see: what is wrong, then what to do. */
  get full(): string {
    return `${this.message}\n  → ${this.remedy}`;
  }
}

export type BridgeOptions = {
  /** Path to the azula binary; `azula` if it is on PATH. */
  binary: string;
  /** Persistent session name — keeps one conversation across restarts. */
  session: string;
  /** Conversation title shown on the phone. */
  label: string;
  /** The azula device this account talks to. */
  device: string;
  logger: Logger;
};

export class AzulaBridge {
  #client: AzulaMcpClient | null = null;

  constructor(private readonly opts: BridgeOptions) {}

  get device(): string {
    return this.opts.device;
  }

  get running(): boolean {
    return this.#client?.running ?? false;
  }

  /**
   * Start the bridge and verify it can actually serve this plugin.
   *
   * Two distinct failures are separated deliberately, because they have
   * different fixes: the binary being absent, and the binary being too old to
   * have the tools this plugin calls. Both are configuration errors raised
   * once at startup, not per-message failures.
   */
  async start(onExit?: () => void): Promise<void> {
    const client = new AzulaMcpClient({
      command: this.opts.binary,
      args: [
        "mcp",
        "--session",
        this.opts.session,
        "--name",
        this.opts.label,
      ],
      logger: this.opts.logger,
      ...(onExit ? { onExit } : {}),
    });

    try {
      await client.start();
    } catch (err) {
      if (err instanceof McpError && err.kind === "spawn") {
        throw new AzulaConfigError(
          `the azula binary could not be run ('${this.opts.binary}')`,
          "install it (https://azula.app) or set the channel's `binary` to its full path",
        );
      }
      throw err;
    }

    const missing = REQUIRED_TOOLS.filter(
      (t) => !client.toolNames.includes(t),
    );
    if (missing.length > 0) {
      await client.stop();
      throw new AzulaConfigError(
        `this azula build does not provide ${missing.join(", ")}`,
        "upgrade azula: `get_events` and `set_typing` were added for this plugin, and a build without them cannot carry inbound events or typing",
      );
    }

    this.#client = client;
  }

  async stop(): Promise<void> {
    await this.#client?.stop();
    this.#client = null;
  }

  #need(): AzulaMcpClient {
    if (!this.#client?.running) {
      throw new McpError("azula bridge is not running", "closed");
    }
    return this.#client;
  }

  /**
   * Confirm the configured device is actually paired with this machine.
   *
   * Separated from {@link start} because it is a different operator problem
   * with a different fix, and because a device can be forgotten later without
   * the bridge itself becoming invalid.
   */
  async assertDeviceKnown(): Promise<void> {
    const listed = await this.#need().callOrThrow("list_devices", {});
    if (!listed.includes(this.opts.device)) {
      throw new AzulaConfigError(
        `no azula device named '${this.opts.device}' is paired with this machine`,
        "pair the phone first (`azula pair`, or the invite from `start_pairing`), then set the channel's `device` to its name",
      );
    }
  }

  /** Send chat text. azula's queued delivery counts as sent, not failed. */
  async sendMessage(text: string): Promise<void> {
    await this.#need().callOrThrow("send_message", {
      device: this.opts.device,
      text,
    });
  }

  /** Send a local file as an inline attachment. */
  async sendFile(path: string, caption?: string): Promise<void> {
    await this.#need().callOrThrow("send_file", {
      device: this.opts.device,
      path,
      ...(caption ? { caption } : {}),
    });
  }

  /**
   * Show or clear the thinking indicator.
   *
   * Never throws, and never blocks the turn for long.
   *
   * `set_typing` is live-only, but "live" is established by a lazy redial —
   * the same reachability check `send_file` uses — so a device that is paired
   * but currently unreachable costs a full dial timeout before it fails. That
   * is fine for a file transfer the caller is waiting on, and wrong for an
   * indicator whose entire purpose is to be timely: the heartbeat would stall
   * exactly when the agent is trying to look responsive.
   *
   * So this is bounded independently of the tool's own timeout. Losing the
   * indicator is the correct trade against delaying the turn.
   */
  async setTyping(on: boolean): Promise<void> {
    const bounded = new Promise<"timeout">((resolve) => {
      const t = setTimeout(() => resolve("timeout"), TYPING_TIMEOUT_MS);
      t.unref?.();
    });
    try {
      const outcome = await Promise.race([
        this.#need()
          .callOrThrow("set_typing", { device: this.opts.device, on })
          .then(() => "sent" as const),
        bounded,
      ]);
      if (outcome === "timeout") {
        this.opts.logger.debug(
          `azula: typing indicator ${on ? "on" : "off"} gave up after ${TYPING_TIMEOUT_MS}ms`,
        );
      }
    } catch (err) {
      this.opts.logger.debug(
        `azula: typing indicator ${on ? "on" : "off"} failed: ${(err as Error).message}`,
      );
    }
  }

  /** Create or replace an A2UI surface. */
  async renderUi(
    surfaceId: string,
    components: unknown[],
    dataModel?: unknown,
  ): Promise<void> {
    await this.#need().callOrThrow("render_ui", {
      device: this.opts.device,
      surface_id: surfaceId,
      components,
      ...(dataModel === undefined ? {} : { data_model: dataModel }),
    });
  }

  /** Remove a surface. Never throws — a stale surface is not worth a failed turn. */
  async deleteUi(surfaceId: string): Promise<void> {
    try {
      await this.#need().callOrThrow("delete_ui", {
        device: this.opts.device,
        surface_id: surfaceId,
      });
    } catch (err) {
      this.opts.logger.debug(
        `azula: delete_ui ${surfaceId} failed: ${(err as Error).message}`,
      );
    }
  }

  /** Set the conversation's sub-line. */
  async setDescription(description: string): Promise<void> {
    await this.#need().callOrThrow("set_name", {
      device: this.opts.device,
      description,
    });
  }

  /** The machine's pairing invite, for the channel's pairing affordance. */
  async pairingInvite(): Promise<string> {
    return this.#need().callOrThrow("start_pairing", {});
  }

  /**
   * Drain inbound events, optionally waiting up to `timeoutSeconds` first.
   *
   * A tool-reported error is raised; a malformed individual event is skipped
   * and counted, so one bad payload cannot stall the pump.
   */
  async getEvents(timeoutSeconds?: number): Promise<AzulaEvent[]> {
    const body = await this.#need().callOrThrow("get_events", {
      device: this.opts.device,
      ...(timeoutSeconds === undefined ? {} : { timeout_s: timeoutSeconds }),
    });
    const { events, skipped } = parseAzulaEvents(body);
    if (skipped > 0) {
      this.opts.logger.warn(
        `azula: skipped ${skipped} unrecognised inbound event(s)`,
      );
    }
    return events;
  }
}
