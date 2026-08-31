/**
 * Turning an agent's structured choice into an A2UI surface, and back.
 *
 * This is what azula offers that a text messenger cannot: an approval or a
 * selection arrives as real controls on the phone. Design D4 — every surface
 * ships with a text fallback in the same turn, because the text is what the
 * conversation reads like in history after the surface is deleted, what a
 * relay-replayed snapshot degrades to, and what the user sees if the surface
 * cannot be shown at all.
 */

/** One option the agent is offering. */
export type Choice = {
  /** Stable value reported back when picked. */
  id: string;
  /** What the button says. */
  label: string;
};

export type ChoicePrompt = {
  /** The question itself, also used as the text fallback's first line. */
  text: string;
  choices: Choice[];
};

/**
 * Derive a surface id from the message that asked.
 *
 * Deriving rather than allocating means an inbound tap maps back to its
 * question without a side table that could drift from the conversation — and
 * a re-render after a restart lands on the same surface rather than a second
 * one.
 */
export function surfaceIdFor(messageId: string): string {
  const safe = messageId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 48);
  return `openclaw-${safe}`;
}

/** The message id a surface id came from, or null if it isn't one of ours. */
export function messageIdFromSurface(surfaceId: string): string | null {
  return surfaceId.startsWith("openclaw-")
    ? surfaceId.slice("openclaw-".length)
    : null;
}

/**
 * Build the A2UI component tree for a choice prompt.
 *
 * `render_ui` validates that `components` is an array with exactly one
 * `"id":"root"` entry, so the root wraps the question and the buttons.
 */
export function buildChoiceComponents(prompt: ChoicePrompt): unknown[] {
  return [
    {
      id: "root",
      component: "Column",
      properties: {
        children: [
          { id: "question", component: "Text", properties: { text: prompt.text } },
          ...prompt.choices.map((choice, index) => ({
            id: `choice-${index}`,
            component: "Button",
            properties: {
              label: choice.label,
              // The action name carries the choice id, so a tap identifies
              // itself without the plugin holding per-surface state.
              action: { name: "choose", value: choice.id },
            },
          })),
        ],
      },
    },
  ];
}

/**
 * The text sent alongside the surface.
 *
 * Deliberately readable on its own: someone scrolling back after the surface
 * is gone should still see what was asked and what the options were.
 */
export function choiceFallbackText(prompt: ChoicePrompt): string {
  const lines = [prompt.text];
  prompt.choices.forEach((choice, index) => {
    lines.push(`${index + 1}. ${choice.label}`);
  });
  return lines.join("\n");
}

/**
 * Pull the chosen id out of an A2UI tap payload.
 *
 * Tolerant about where the value sits: A2UI event payloads vary by component,
 * and guessing wrong should mean "no choice recognised" rather than a crash.
 */
export function choiceFromEvent(event: unknown): string | null {
  if (typeof event !== "object" || event === null) return null;
  const raw = event as Record<string, unknown>;

  const direct = raw["value"];
  if (typeof direct === "string" && direct.length > 0) return direct;

  const context = raw["context"];
  if (typeof context === "object" && context !== null) {
    const value = (context as Record<string, unknown>)["value"];
    if (typeof value === "string" && value.length > 0) return value;
  }

  const action = raw["action"];
  if (typeof action === "object" && action !== null) {
    const value = (action as Record<string, unknown>)["value"];
    if (typeof value === "string" && value.length > 0) return value;
  }

  return null;
}

/** The surface a tap came from, when the payload names one. */
export function surfaceFromEvent(event: unknown): string | null {
  if (typeof event !== "object" || event === null) return null;
  const id = (event as Record<string, unknown>)["surfaceId"];
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Tracks which surfaces are live so none outlives its turn.
 *
 * Deliberately not persisted: `update_ui`'s offline path only works while the
 * same session still holds a surface's full state, so after a restart the
 * right move is to re-render rather than patch — and a tracker that survived
 * the restart would tempt exactly the wrong thing.
 */
export class SurfaceTracker {
  #open = new Set<string>();

  opened(surfaceId: string): void {
    this.#open.add(surfaceId);
  }

  get openSurfaces(): string[] {
    return [...this.#open];
  }

  has(surfaceId: string): boolean {
    return this.#open.has(surfaceId);
  }

  /** Forget one surface, reporting whether it was actually open. */
  closed(surfaceId: string): boolean {
    return this.#open.delete(surfaceId);
  }

  /** Forget everything, returning what was open so it can be deleted. */
  drain(): string[] {
    const all = [...this.#open];
    this.#open.clear();
    return all;
  }
}
