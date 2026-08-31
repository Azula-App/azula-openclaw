import { describe, expect, it, vi } from "vitest";
import type { AzulaEvent } from "./events.js";
import { InboundPump, pumpOnce } from "./pump.js";
import { endTurn, resolveSurface, withTypingIndicator } from "./turn.js";
import { SurfaceTracker } from "./surfaces.js";
import type { InboundItem } from "./inbound.js";

const quietLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const msg = (text: string): AzulaEvent => ({ type: "message", device: "phone", text });

describe("pumpOnce", () => {
  it("commits a translated batch", async () => {
    const committed: InboundItem[][] = [];
    const items = await pumpOnce({
      bridge: { getEvents: async () => [msg("one"), msg("two")] },
      logger: quietLogger,
      commit: async (batch) => void committed.push(batch),
    });
    expect(items).toHaveLength(2);
    expect(committed).toHaveLength(1);
    expect(committed[0]).toHaveLength(2);
  });

  it("does not commit an empty batch", async () => {
    const commit = vi.fn(async () => {});
    await pumpOnce({
      bridge: { getEvents: async () => [] },
      logger: quietLogger,
      commit,
    });
    expect(commit).not.toHaveBeenCalled();
  });

  /**
   * get_events is a destructive drain, so a failure to hand the batch onward
   * must be loud. Swallowing it would lose events that azula has already
   * discarded.
   */
  it("propagates a commit failure rather than losing the batch", async () => {
    await expect(
      pumpOnce({
        bridge: { getEvents: async () => [msg("one")] },
        logger: quietLogger,
        commit: async () => {
          throw new Error("durable append failed");
        },
      }),
    ).rejects.toThrow("durable append failed");
  });
});

describe("InboundPump", () => {
  it("polls repeatedly and stops cleanly", async () => {
    let calls = 0;
    const seen: InboundItem[] = [];
    const pump = new InboundPump({
      bridge: {
        getEvents: async () => {
          calls += 1;
          return calls <= 2 ? [msg(`batch-${calls}`)] : [];
        },
      },
      logger: quietLogger,
      commit: async (items) => void seen.push(...items),
      pollTimeoutSeconds: 0,
      idleYieldMs: 1,
      sleep: async (ms) => {
        await new Promise((r) => setTimeout(r, ms));
      },
    });

    pump.start();
    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(2), {
      timeout: 2000,
    });
    await pump.stop();
    expect(pump.running).toBe(false);
  });

  /** A persistent failure must back off, not spin. */
  it("backs off on error instead of spinning", async () => {
    let polls = 0;
    const sleeps: number[] = [];
    const pump = new InboundPump({
      bridge: {
        getEvents: async () => {
          polls += 1;
          throw new Error("bridge down");
        },
      },
      logger: quietLogger,
      commit: async () => {},
      errorBackoffMs: 5,
      sleep: async (ms) => {
        sleeps.push(ms);
        await new Promise((r) => setTimeout(r, 1));
      },
    });

    pump.start();
    await vi.waitFor(() => expect(sleeps.length).toBeGreaterThanOrEqual(2), {
      timeout: 2000,
    });
    await pump.stop();
    expect(sleeps.every((ms) => ms === 5)).toBe(true);
    expect(polls).toBeGreaterThanOrEqual(2);
  });
});

describe("turn lifecycle", () => {
  const makeDeps = () => {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        bridge: {
          setTyping: async (on: boolean) => void calls.push(`typing:${on}`),
          deleteUi: async (id: string) => void calls.push(`delete:${id}`),
        },
        surfaces: new SurfaceTracker(),
      },
    };
  };

  it("clears the indicator after a successful turn", async () => {
    const { calls, deps } = makeDeps();
    const result = await withTypingIndicator(deps, async () => "done");
    expect(result).toBe("done");
    expect(calls).toEqual(["typing:true", "typing:false"]);
  });

  /** The case that matters: a failed turn is when the agent looks stuck. */
  it("clears the indicator when the turn throws", async () => {
    const { calls, deps } = makeDeps();
    await expect(
      withTypingIndicator(deps, async () => {
        throw new Error("turn blew up");
      }),
    ).rejects.toThrow("turn blew up");
    expect(calls).toEqual(["typing:true", "typing:false"]);
  });

  it("removes every surface the turn opened", async () => {
    const { calls, deps } = makeDeps();
    deps.surfaces.opened("s1");
    deps.surfaces.opened("s2");
    await endTurn(deps);
    expect(calls).toContain("delete:s1");
    expect(calls).toContain("delete:s2");
    expect(deps.surfaces.openSurfaces).toEqual([]);
  });

  it("resolving a surface deletes it exactly once", async () => {
    const { calls, deps } = makeDeps();
    deps.surfaces.opened("s1");
    await resolveSurface(deps, "s1");
    await resolveSurface(deps, "s1");
    expect(calls.filter((c) => c === "delete:s1")).toHaveLength(1);
  });
});
