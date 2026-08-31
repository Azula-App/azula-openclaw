/**
 * A minimal MCP stdio client, scoped to exactly one server: `azula mcp`.
 *
 * This is deliberately not a general MCP client. The plugin talks to one
 * server whose tool surface is specified in azula-docs' `mcp-bridge` spec, so
 * the client only needs `initialize`, `tools/list` and `tools/call` over
 * newline-delimited JSON-RPC on the child's stdin/stdout.
 *
 * stdout is the JSON-RPC channel; the bridge writes all logging and its banner
 * to stderr, which we surface through the logger rather than parsing.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

export type Logger = {
  debug: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export type McpClientOptions = {
  /** Path to the azula binary. */
  command: string;
  /** Arguments after the binary — normally `mcp --session … --name …`. */
  args: string[];
  logger: Logger;
  /** How long a single tool call may take before it is abandoned. */
  requestTimeoutMs?: number;
  /** Called when the child exits for any reason, expected or not. */
  onExit?: (info: { code: number | null; signal: string | null }) => void;
};

export class McpError extends Error {
  constructor(
    message: string,
    readonly kind: "spawn" | "protocol" | "tool" | "timeout" | "closed",
  ) {
    super(message);
    this.name = "McpError";
  }
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

/** The text payload of a `tools/call` result, plus whether it was an error. */
export type ToolResult = { text: string; isError: boolean };

const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;

export class AzulaMcpClient {
  #child: ChildProcessWithoutNullStreams | null = null;
  #rl: Interface | null = null;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #closed = false;
  #tools: string[] = [];

  constructor(private readonly opts: McpClientOptions) {}

  get toolNames(): readonly string[] {
    return this.#tools;
  }

  get running(): boolean {
    return this.#child !== null && !this.#closed;
  }

  /**
   * Spawn the bridge, complete the MCP handshake, and cache its tool list.
   *
   * The tool list is fetched here rather than lazily so a bridge that predates
   * the tools this plugin needs fails once at startup, with a clear message,
   * instead of once per message mid-conversation.
   */
  async start(): Promise<void> {
    if (this.#child) return;
    this.#closed = false;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.opts.command, this.opts.args, {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      throw new McpError(
        `could not run '${this.opts.command}': ${(err as Error).message}`,
        "spawn",
      );
    }
    this.#child = child;

    child.on("error", (err) => {
      // ENOENT lands here rather than throwing from spawn().
      this.#failAll(
        new McpError(
          `could not run '${this.opts.command}': ${err.message}`,
          "spawn",
        ),
      );
    });

    child.on("exit", (code, signal) => {
      this.#closed = true;
      this.#failAll(
        new McpError(
          `azula bridge exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
          "closed",
        ),
      );
      this.opts.onExit?.({ code, signal });
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) this.opts.logger.debug(`azula: ${trimmed}`);
      }
    });

    this.#rl = createInterface({ input: child.stdout });
    this.#rl.on("line", (line) => this.#onLine(line));

    await this.#request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "azula-openclaw", version: "0.0.1" },
    });
    this.#notify("notifications/initialized", {});

    const listed = await this.#request("tools/list", {});
    this.#tools = extractToolNames(listed);
  }

  /** Call a tool, returning its text payload and whether it reported an error. */
  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.running) {
      throw new McpError("azula bridge is not running", "closed");
    }
    const result = (await this.#request("tools/call", {
      name,
      arguments: args,
    })) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    const text = (result?.content ?? [])
      .filter((c) => c?.type === "text" || typeof c?.text === "string")
      .map((c) => c.text ?? "")
      .join("\n");
    return { text, isError: result?.isError === true };
  }

  /** Like {@link call}, but turns a tool-reported error into a thrown one. */
  async callOrThrow(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const { text, isError } = await this.call(name, args);
    if (isError) throw new McpError(text || `${name} failed`, "tool");
    return text;
  }

  /** Terminate the bridge and fail anything still in flight. */
  async stop(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    this.#closed = true;
    this.#rl?.close();
    this.#rl = null;

    const exited = new Promise<void>((resolve) => {
      const done = () => resolve();
      child.once("exit", done);
      // A bridge that ignores SIGTERM should not hang shutdown.
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
        resolve();
      }, 3_000).unref?.();
    });
    child.kill("SIGTERM");
    await exited;

    this.#child = null;
    this.#failAll(new McpError("azula bridge stopped", "closed"));
  }

  #onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(trimmed);
    } catch {
      // Not our protocol; the bridge promises stdout is pure JSON-RPC, so this
      // is worth surfacing rather than swallowing silently.
      this.opts.logger.warn(`azula: unparseable stdout line: ${trimmed.slice(0, 200)}`);
      return;
    }
    if (typeof msg.id !== "number") return; // a notification
    const pending = this.#pending.get(msg.id);
    if (!pending) return;
    this.#pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) {
      pending.reject(
        new McpError(msg.error.message ?? "bridge returned an error", "protocol"),
      );
    } else {
      pending.resolve(msg.result);
    }
  }

  #request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const child = this.#child;
    if (!child || this.#closed) {
      return Promise.reject(new McpError("azula bridge is not running", "closed"));
    }
    const id = this.#nextId++;
    const timeoutMs = this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new McpError(`${method} timed out after ${timeoutMs}ms`, "timeout"));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }

  #notify(method: string, params: Record<string, unknown>): void {
    this.#child?.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
    );
  }

  #failAll(err: Error): void {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.#pending.clear();
  }
}

/** Pull tool names out of a `tools/list` result, tolerating shape drift. */
export function extractToolNames(result: unknown): string[] {
  if (typeof result !== "object" || result === null) return [];
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .map((t) =>
      typeof t === "object" && t !== null
        ? (t as { name?: unknown }).name
        : undefined,
    )
    .filter((n): n is string => typeof n === "string");
}
