// src/ui/drawer-height.ts
//
// The browse drawer's drag-to-resize policy, as DOM-free arithmetic (tested
// in tests/test_browse.mjs). The drawer overlays the charts, so a drag
// changes one height, bounded by what the overlay may cost:
//
//   * FLOOR: the tab bar's height; lower clips the bar being dragged.
//   * CEILING: one pane header of chart stays uncovered.
//   * Near a detent the drag SNAPS, and a snapped height carries no pixels, so
//     the detent's share keeps tracking window resizes.
//
// The two lengths mirrored from styles.css are pinned by
// tests/test_dom_contract.mjs.

/** An open drawer's named heights (closed is only the handle). */
export type OpenDetent = 'half' | 'full';

/** The floor: the tab bar's height (`.browse-bar` in styles.css). */
export const BAR_HEIGHT_PX = 36;

/** The ceiling reserve: one pane header of chart stays visible
 * (`.gv-section .pane-header` in styles.css). */
export const PANE_HEADER_PX = 28;

/** Snap distance to a detent: magnetic, yet at most one snap zone on any cell
 * tall enough to hold a chart. */
export const SNAP_PX = 24;

/** Each open detent's share of the chart cell; the CSS fallbacks carry the
 * same numbers (pinned by tests/test_dom_contract.mjs). */
export const DETENT_SHARE: Readonly<Record<OpenDetent, number>> = {
  half: 0.5,
  full: 0.85,
};

/** A drag's answer: pixels, or `null` when snapped to a detent. */
export interface DrawerHeight {
  readonly detent: OpenDetent;
  readonly heightPx: number | null;
}

/** Clamp to [floor, ceiling]. A cell too short for both takes the floor: a
 * clipped bar is a broken control, a covered header only a covered chart. */
export function clampHeight(px: number, cellHeight: number): number {
  if (!Number.isFinite(px) || !Number.isFinite(cellHeight)) return BAR_HEIGHT_PX;
  const ceiling = Math.max(BAR_HEIGHT_PX, cellHeight - PANE_HEADER_PX);
  return Math.round(Math.min(ceiling, Math.max(BAR_HEIGHT_PX, px)));
}

/** The detent a height belongs to; an exact midpoint rounds up to `full`. */
export function nearestDetent(px: number, cellHeight: number): OpenDetent {
  const halfPx = DETENT_SHARE.half * cellHeight;
  const fullPx = DETENT_SHARE.full * cellHeight;
  return px - halfPx < fullPx - px ? 'half' : 'full';
}

/** Where a height settles: clamped, snapped if a detent is near, else pixels
 * plus the detent it matches. A non-finite input settles on half rather than
 * putting NaN into a CSS length. */
export function settleHeight(px: number, cellHeight: number): DrawerHeight {
  if (!Number.isFinite(px) || !Number.isFinite(cellHeight)) {
    return { detent: 'half', heightPx: null };
  }
  const height = clampHeight(px, cellHeight);
  // Half first, so a very short cell settles on the smaller detent.
  for (const detent of ['half', 'full'] as const) {
    if (Math.abs(height - DETENT_SHARE[detent] * cellHeight) <= SNAP_PX) {
      return { detent, heightPx: null };
    }
  }
  return { detent: nearestDetent(height, cellHeight), heightPx: height };
}
