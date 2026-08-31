/**
 * Turn lifecycle: the thinking indicator, and cleaning up after a turn.
 *
 * The indicator must never be left on. A turn that throws is exactly when the
 * agent looks stuck, so clearing it belongs in a `finally`, not on the happy
 * path.
 */

import type { AzulaBridge } from "./bridge.js";
import { SurfaceTracker } from "./surfaces.js";

export type TurnDeps = {
  bridge: Pick<AzulaBridge, "setTyping" | "deleteUi">;
  surfaces: SurfaceTracker;
};

/**
 * Run a turn with the indicator on, clearing it and any surfaces afterwards.
 *
 * Cleanup runs whether the turn returned or threw. Surfaces are deleted on the
 * way out so stale controls do not accumulate in the conversation — a button
 * from three turns ago is worse than no button, because tapping it does
 * nothing the user can see.
 */
export async function withTypingIndicator<T>(
  deps: TurnDeps,
  run: () => Promise<T>,
): Promise<T> {
  await deps.bridge.setTyping(true);
  try {
    return await run();
  } finally {
    await deps.bridge.setTyping(false);
  }
}

/**
 * Close out a turn: clear the indicator and remove every surface it opened.
 *
 * Separate from {@link withTypingIndicator} because a surface may legitimately
 * outlive the turn that created it — an approval the agent is still waiting on
 * — so surface cleanup is the caller's decision, not automatic.
 */
export async function endTurn(deps: TurnDeps): Promise<void> {
  await deps.bridge.setTyping(false);
  for (const surfaceId of deps.surfaces.drain()) {
    // deleteUi never throws; a surface that cannot be removed is logged and
    // left rather than failing the turn's end.
    await deps.bridge.deleteUi(surfaceId);
  }
}

/** Resolve one surface: remove it and stop tracking it. */
export async function resolveSurface(
  deps: TurnDeps,
  surfaceId: string,
): Promise<void> {
  if (deps.surfaces.closed(surfaceId)) {
    await deps.bridge.deleteUi(surfaceId);
  }
}
