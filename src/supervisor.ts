/**
 * Keeping the bridge alive.
 *
 * The bridge is a child process; it can exit for reasons that have nothing to
 * do with the gateway. Re-establishing it must not spin, must not lose the
 * distinction between "temporarily down" and "misconfigured", and must not
 * silently retry forever while the channel reports itself healthy.
 */

import { AzulaConfigError } from "./bridge.js";
import type { Logger } from "./mcp-client.js";

export type SupervisorDeps = {
  /** Establish a working bridge, or throw. */
  connect: () => Promise<void>;
  /** Tear down whatever is there, before reconnecting. */
  disconnect: () => Promise<void>;
  logger: Logger;
  /** First backoff step; doubles up to {@link maxBackoffMs}. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Give up (and report unhealthy) after this many consecutive failures. */
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
};

export type Health =
  | { state: "starting" }
  | { state: "healthy" }
  | { state: "reconnecting"; attempts: number; lastError: string }
  | { state: "unhealthy"; reason: string };

const DEFAULT_BASE_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 8;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

export class BridgeSupervisor {
  #health: Health = { state: "starting" };
  #reconnecting = false;

  constructor(private readonly deps: SupervisorDeps) {}

  get health(): Health {
    return this.#health;
  }

  get healthy(): boolean {
    return this.#health.state === "healthy";
  }

  /**
   * Bring the bridge up for the first time.
   *
   * A configuration error is *not* retried: no amount of backoff installs a
   * missing binary or pairs a phone, and retrying would bury the one message
   * that tells the operator what to fix.
   */
  async start(): Promise<void> {
    try {
      await this.deps.connect();
      this.#health = { state: "healthy" };
    } catch (err) {
      if (err instanceof AzulaConfigError) {
        this.#health = { state: "unhealthy", reason: err.full };
      } else {
        this.#health = { state: "unhealthy", reason: (err as Error).message };
      }
      throw err;
    }
  }

  /**
   * Re-establish the bridge after it dropped, with exponential backoff.
   *
   * Concurrent calls collapse into one: a child exit and a failed send can
   * both notice the outage, and two reconnect loops racing would double the
   * spawn rate exactly when things are already unwell.
   */
  async reconnect(): Promise<boolean> {
    if (this.#reconnecting) return this.healthy;
    this.#reconnecting = true;

    const sleep = this.deps.sleep ?? defaultSleep;
    const base = this.deps.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    const max = this.deps.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    const maxAttempts = this.deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          await this.deps.disconnect();
        } catch {
          // Already gone, which is the normal case here.
        }

        try {
          await this.deps.connect();
          this.#health = { state: "healthy" };
          this.deps.logger.info(
            `azula: bridge re-established after ${attempt} attempt(s)`,
          );
          return true;
        } catch (err) {
          const message = (err as Error).message;
          this.#health = { state: "reconnecting", attempts: attempt, lastError: message };

          if (err instanceof AzulaConfigError) {
            // Same reasoning as start(): this will not fix itself.
            this.#health = { state: "unhealthy", reason: err.full };
            this.deps.logger.error(`azula: ${err.full}`);
            return false;
          }

          if (attempt === maxAttempts) {
            const reason = `bridge could not be re-established after ${maxAttempts} attempts: ${message}`;
            this.#health = { state: "unhealthy", reason };
            this.deps.logger.error(`azula: ${reason}`);
            return false;
          }

          const wait = Math.min(base * 2 ** (attempt - 1), max);
          this.deps.logger.warn(
            `azula: bridge down (${message}); retrying in ${wait}ms`,
          );
          await sleep(wait);
        }
      }
      return false;
    } finally {
      this.#reconnecting = false;
    }
  }
}
