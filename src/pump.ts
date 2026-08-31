/**
 * The inbound pump: long-poll the bridge, translate, dispatch.
 *
 * Ordering and at-most-once delivery are the two properties that matter here.
 * `get_events` is a *destructive* drain, so a crash between draining and
 * dispatching loses events unless the batch is handed over durably first —
 * hence {@link PumpDeps.commit}, which the caller backs with OpenClaw's
 * durable ingress.
 */

import type { AzulaBridge } from "./bridge.js";
import type { Logger } from "./mcp-client.js";
import { translateBatch, type InboundItem } from "./inbound.js";

export type PumpDeps = {
  bridge: Pick<AzulaBridge, "getEvents">;
  logger: Logger;
  /**
   * Hand a translated batch onward. Must not resolve until the batch is
   * durably recorded — everything after this point may be replayed, and
   * anything before it may be lost.
   */
  commit: (items: InboundItem[]) => Promise<void>;
  /** Seconds to wait per poll. */
  pollTimeoutSeconds?: number;
  /** Backoff after an error, so a persistent failure cannot spin. */
  errorBackoffMs?: number;
  /**
   * How long to pause after an empty poll when {@link pollTimeoutSeconds} is
   * zero, so a non-blocking drain cannot become a hot loop.
   */
  idleYieldMs?: number;
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_POLL_SECONDS = 25;
const DEFAULT_ERROR_BACKOFF_MS = 2_000;
const DEFAULT_IDLE_YIELD_MS = 50;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

export class InboundPump {
  #running = false;
  #stopped: Promise<void> | null = null;

  constructor(private readonly deps: PumpDeps) {}

  get running(): boolean {
    return this.#running;
  }

  /** Begin polling. Returns once the loop has started, not when it ends. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#stopped = this.#loop();
  }

  /** Stop polling and wait for the in-flight iteration to finish. */
  async stop(): Promise<void> {
    this.#running = false;
    await this.#stopped;
    this.#stopped = null;
  }

  async #loop(): Promise<void> {
    const sleep = this.deps.sleep ?? defaultSleep;
    const pollSeconds = this.deps.pollTimeoutSeconds ?? DEFAULT_POLL_SECONDS;
    const backoff = this.deps.errorBackoffMs ?? DEFAULT_ERROR_BACKOFF_MS;
    const idleMs = this.deps.idleYieldMs ?? DEFAULT_IDLE_YIELD_MS;

    while (this.#running) {
      try {
        const events = await this.deps.bridge.getEvents(pollSeconds);
        if (!this.#running) break;
        if (events.length === 0) {
          // With a non-zero poll timeout the bridge itself does the waiting.
          // With a zero one it returns instantly, and re-polling immediately
          // would be a hot loop that starves timers on this thread — so yield
          // before going round again.
          if (pollSeconds === 0) await sleep(idleMs);
          continue;
        }

        const items = translateBatch(events);
        if (items.length === 0) continue;

        // Commit before anything else can observe the batch. A failure here
        // is loud: the events are already drained from azula, so swallowing
        // it would lose them silently.
        await this.deps.commit(items);
      } catch (err) {
        if (!this.#running) break;
        this.deps.logger.warn(
          `azula: inbound poll failed: ${(err as Error).message}`,
        );
        await sleep(backoff);
      }
    }
  }
}

/**
 * Run the pump once over a single batch — the unit the durable-ingress wiring
 * and the tests both drive.
 */
export async function pumpOnce(deps: PumpDeps): Promise<InboundItem[]> {
  const events = await deps.bridge.getEvents(deps.pollTimeoutSeconds ?? 0);
  const items = translateBatch(events);
  if (items.length > 0) await deps.commit(items);
  return items;
}
