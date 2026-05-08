/**
 * Module-level "is the user dragging a panel handle right now?" signal.
 *
 * Heavy animated surfaces (BrainLiquid in particular) read `isResizing()`
 * inside their per-frame `requestAnimationFrame` step and skip the
 * paint while a drag is in flight. The PanelGroup's `onLayout` fires
 * every layout change during drag, so we just call `pulseResize()`
 * from there and clear the flag ~120 ms after the last fire.
 *
 * Why a module-level flag and not React state / Context: state updates
 * would re-render the very components we're trying to keep cheap, and
 * Context would propagate through React's reconciler — slower than a
 * direct global read. The brain's animation loop reads this flag
 * dozens of times per second; cheap polling is the right shape.
 */

let resizing = false;
let timer: ReturnType<typeof setTimeout> | null = null;

/** How long after the last `pulseResize` call we consider drag done. */
const COOLDOWN_MS = 120;

/**
 * Mark the UI as actively resizing. Idempotent; each call resets the
 * cooldown so a continuous drag stream keeps the flag true throughout.
 */
export function pulseResize(): void {
  resizing = true;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    resizing = false;
    timer = null;
  }, COOLDOWN_MS);
}

/** Cheap O(1) read; safe to call dozens of times per frame. */
export function isResizing(): boolean {
  return resizing;
}
