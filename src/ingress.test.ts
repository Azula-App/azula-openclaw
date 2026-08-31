import { describe, expect, it } from "vitest";
import { dispatchOnce, ingressKey, isDuplicate } from "./ingress.js";
import type { InboundItem } from "./inbound.js";

const quietLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const message = (text: string): InboundItem => ({
  kind: "message", device: "phone", text, media: [],
});

/** An in-memory stand-in with the claim/commit/release contract. */
function fakeDedupe() {
  const claimed = new Set<string>();
  const committed = new Set<string>();
  return {
    claimed,
    committed,
    claim: async (key: string) => {
      if (claimed.has(key) || committed.has(key)) return { duplicate: true };
      claimed.add(key);
      return { duplicate: false };
    },
    commit: async (key: string) => {
      claimed.delete(key);
      committed.add(key);
      return true;
    },
    release: (key: string) => void claimed.delete(key),
  };
}

describe("ingressKey", () => {
  it("distinguishes position, so identical repeated messages both deliver", () => {
    const a = ingressKey("default", "b1", 0, message("hi"));
    const b = ingressKey("default", "b1", 1, message("hi"));
    expect(a).not.toBe(b);
  });

  it("distinguishes accounts and batches", () => {
    expect(ingressKey("a", "b1", 0, message("x")))
      .not.toBe(ingressKey("b", "b1", 0, message("x")));
    expect(ingressKey("a", "b1", 0, message("x")))
      .not.toBe(ingressKey("a", "b2", 0, message("x")));
  });

  it("is stable for the same item", () => {
    expect(ingressKey("a", "b1", 0, message("x")))
      .toBe(ingressKey("a", "b1", 0, message("x")));
  });
});

describe("isDuplicate", () => {
  it("recognises the shapes it knows", () => {
    expect(isDuplicate({ duplicate: true })).toBe(true);
    expect(isDuplicate({ claimed: false })).toBe(true);
    expect(isDuplicate({ status: "duplicate" })).toBe(true);
  });

  /**
   * Delivering twice is visible and recoverable; dropping silently is not. An
   * unrecognised shape must therefore fall on the deliver side.
   */
  it("treats an unrecognised shape as not-a-duplicate", () => {
    expect(isDuplicate({ something: "else" })).toBe(false);
    expect(isDuplicate(null)).toBe(false);
    expect(isDuplicate(undefined)).toBe(false);
  });
});

describe("dispatchOnce", () => {
  it("dispatches each item once, in order", async () => {
    const seen: string[] = [];
    const result = await dispatchOnce(
      {
        dedupe: fakeDedupe(),
        logger: quietLogger,
        account: "default",
        dispatch: async (item) => {
          if (item.kind === "message") seen.push(item.text);
        },
      },
      "batch-1",
      [message("one"), message("two"), message("three")],
    );

    expect(seen).toEqual(["one", "two", "three"]);
    expect(result).toMatchObject({ dispatched: 3, skipped: 0, failed: 0 });
  });

  /** The replay case: the same batch arriving again after a crash. */
  it("skips items already committed", async () => {
    const dedupe = fakeDedupe();
    const seen: string[] = [];
    const deps = {
      dedupe,
      logger: quietLogger,
      account: "default",
      dispatch: async (item: InboundItem) => {
        if (item.kind === "message") seen.push(item.text);
      },
    };

    await dispatchOnce(deps, "batch-1", [message("one"), message("two")]);
    const second = await dispatchOnce(deps, "batch-1", [message("one"), message("two")]);

    expect(seen).toEqual(["one", "two"]);
    expect(second).toMatchObject({ dispatched: 0, skipped: 2 });
  });

  /**
   * An item that failed to reach the agent has not been delivered. Committing
   * it anyway would lose it for good.
   */
  it("releases a failed claim so the item can be retried", async () => {
    const dedupe = fakeDedupe();
    let attempts = 0;
    const deps = {
      dedupe,
      logger: quietLogger,
      account: "default",
      dispatch: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("agent unavailable");
      },
    };

    const first = await dispatchOnce(deps, "batch-1", [message("one")]);
    expect(first).toMatchObject({ dispatched: 0, failed: 1 });
    expect(dedupe.committed.size).toBe(0);

    const retry = await dispatchOnce(deps, "batch-1", [message("one")]);
    expect(retry).toMatchObject({ dispatched: 1 });
  });

  it("does not claim presence events", async () => {
    const dedupe = fakeDedupe();
    const woken: InboundItem[] = [];
    const result = await dispatchOnce(
      {
        dedupe,
        logger: quietLogger,
        account: "default",
        dispatch: async (item) => void woken.push(item),
      },
      "batch-1",
      [
        { kind: "presence", device: "phone", connected: true },
        message("hi"),
        { kind: "presence", device: "phone", connected: false },
      ],
    );

    expect(woken).toHaveLength(1);
    expect(result.dispatched).toBe(1);
    // Only the message consumed a dedupe key.
    expect(dedupe.committed.size).toBe(1);
  });

  it("keeps going after one item fails", async () => {
    const seen: string[] = [];
    const result = await dispatchOnce(
      {
        dedupe: fakeDedupe(),
        logger: quietLogger,
        account: "default",
        dispatch: async (item) => {
          if (item.kind === "message") {
            if (item.text === "bad") throw new Error("nope");
            seen.push(item.text);
          }
        },
      },
      "batch-1",
      [message("good"), message("bad"), message("also good")],
    );

    expect(seen).toEqual(["good", "also good"]);
    expect(result).toMatchObject({ dispatched: 2, failed: 1 });
  });
});
