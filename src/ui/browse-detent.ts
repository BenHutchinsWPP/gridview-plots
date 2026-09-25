// src/ui/browse-detent.ts
//
// The browse drawer's three detents and the dragged height between them.
// Height is CSS-only: a data attribute and a custom property, never a tab
// build (`applyHeight` is pinned draw()-free by tests/test_dom_contract.mjs).
//
// OPENING is not a resize: renders are skipped while closed, so leaving
// `closed` calls `onOpen` once to repaint current data. The handle both
// reopens (click) and sizes (drag); the reopen is served on pointerup so a
// click after a drag does not reopen what the drag just sized.

import { nearestDetent, settleHeight, type DrawerHeight } from './drawer-height';

/** Closed, the bottom two slots' worth, or nearly the whole chart area. */
export type Detent = 'closed' | 'half' | 'full';

const DETENTS: readonly Detent[] = ['closed', 'half', 'full'];

export interface BrowseDetentDeps {
  readonly root: HTMLElement;
  readonly handle: HTMLButtonElement;
  readonly resizeStrip: HTMLElement;
  readonly expandButton: HTMLButtonElement;
  readonly collapseButton: HTMLButtonElement;
  readonly closePopover: () => void;
  /** The drawer has just left `closed`: paint what is current. */
  readonly onOpen: () => void;
}

export interface BrowseDetent {
  detent(): Detent;
  setDetent(next: Detent): void;
  /** Forwarded from `BrowseDrawer.heightPx`. */
  heightPx(): number | null;
  /** Forwarded from `BrowseDrawer.restoreHeight`. */
  restoreHeight(px: number): void;
  applyHeight(next: DrawerHeight): void;
}

export function createBrowseDetent(deps: BrowseDetentDeps): BrowseDetent {
  const { handle, root, resizeStrip, expandButton, collapseButton } = deps;

  let detent: Detent = 'closed';
  /** The dragged height, or null on a detent's own share; what a save reads. */
  let draggedHeight: number | null = null;

  const setDetent = (next: Detent): void => {
    deps.closePopover();
    applyDetent(next);
  };

  const applyDetent = (next: Detent): void => {
    const opening = detent === 'closed' && next !== 'closed';
    detent = next;
    root.dataset.detent = next;
    expandButton.disabled = next === 'full';
    collapseButton.disabled = next === 'closed';
    if (opening) deps.onOpen();
  };

  const step = (by: 1 | -1): void => {
    // A detent button snaps to its NAMED height, clearing any dragged one, so
    // it tracks window resizes again.
    writeDraggedHeight(null);
    const at = DETENTS.indexOf(detent);
    setDetent(DETENTS[Math.min(DETENTS.length - 1, Math.max(0, at + by))]);
  };

  expandButton.addEventListener('click', () => step(1));
  collapseButton.addEventListener('click', () => step(-1));
  // Reopen from the handle: to the tab active at close, and to the half
  // detent unless a dragged or restored height stands.
  function openFromHandle(): void {
    if (detent !== 'closed') return;
    deps.closePopover();
    applyDetent(draggedHeight === null ? 'half' : nearestDetent(draggedHeight, cellHeight()));
  }
  // Keyboard only in practice: pointer presses are served on release, and a
  // click after a drag is a no-op (a drag always settles open).
  handle.addEventListener('click', openFromHandle);

  // ---------------------------------------------------------- the drag
  //
  // Two grips: the open drawer's top strip and the closed handle. The pointer
  // is captured on the DRAWER, since starting on the handle opens the drawer
  // and hides the handle.

  const HEIGHT_VAR = '--browse-drawer-height';
  /** Pixels that tell a handle drag from a reopening click. */
  const HANDLE_DRAG_SLOP_PX = 4;

  interface HeightDrag {
    readonly pointerId: number;
    /** The drawer's bottom edge, the height's fixed reference. */
    readonly bottom: number;
    readonly startY: number;
    readonly slop: number;
    /** Begun on the closed handle, where a release without movement is a
     * click (see pointerup). */
    readonly openOnRelease: boolean;
    moved: boolean;
  }
  let heightDrag: HeightDrag | null = null;

  /** The chart cell's height from the grid's resolved row tracks, rather than
   * mirroring the other rows' sizes in code. */
  function cellHeight(): number {
    const grid = root.parentElement;
    if (!grid) return 0;
    const middle = Number.parseFloat(getComputedStyle(grid).gridTemplateRows.split(' ')[1] ?? '');
    return Number.isFinite(middle) ? middle : 0;
  }

  /** The one writer of the dragged height; `null` snaps to the detent. */
  const writeDraggedHeight = (px: number | null): void => {
    draggedHeight = px;
    if (px === null) root.style.removeProperty(HEIGHT_VAR);
    else root.style.setProperty(HEIGHT_VAR, `${px}px`);
  };

  /** Set the height variable and detent, and nothing else: a resize must never
   * rebuild a tab. */
  function applyHeight(next: DrawerHeight): void {
    writeDraggedHeight(next.heightPx);
    applyDetent(next.detent);
  }

  const beginHeightDrag = (e: PointerEvent, slop: number, openOnRelease = false): void => {
    if (e.button !== 0) return;
    // No text selection or focus change: the grip is an edge, not a control.
    e.preventDefault();
    deps.closePopover();
    heightDrag = {
      pointerId: e.pointerId,
      bottom: root.getBoundingClientRect().bottom,
      startY: e.clientY,
      slop,
      openOnRelease,
      moved: false,
    };
    root.setPointerCapture(e.pointerId);
  };

  resizeStrip.addEventListener('pointerdown', (e) => beginHeightDrag(e, 0));
  handle.addEventListener('pointerdown', (e) => {
    if (detent === 'closed') beginHeightDrag(e, HANDLE_DRAG_SLOP_PX, true);
  });

  root.addEventListener('pointermove', (e) => {
    const drag = heightDrag;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (!drag.moved) {
      if (Math.abs(e.clientY - drag.startY) <= drag.slop) return;
      drag.moved = true;
    }
    applyHeight(settleHeight(drag.bottom - e.clientY, cellHeight()));
  });
  const endHeightDrag = (e: PointerEvent): void => {
    const drag = heightDrag;
    if (drag?.pointerId !== e.pointerId) return;
    heightDrag = null;
    // An unmoved press on the handle is a click, served here: preventDefault
    // on pointerdown suppresses the derived `click`. The click listener
    // remains for the keyboard.
    if (drag.openOnRelease && !drag.moved && e.type === 'pointerup') openFromHandle();
  };
  root.addEventListener('pointerup', endHeightDrag);
  root.addEventListener('pointercancel', endHeightDrag);

  // Re-settle a dragged height when the window shrinks, so it never covers
  // the pane headers.
  window.addEventListener('resize', () => {
    if (draggedHeight === null) return;
    const next = settleHeight(draggedHeight, cellHeight());
    // Closed: only the remembered height moves.
    if (detent === 'closed') writeDraggedHeight(next.heightPx);
    else applyHeight(next);
  });

  return {
    detent: () => detent,
    setDetent,
    heightPx: () => draggedHeight,
    restoreHeight(px: number) {
      const next = settleHeight(px, cellHeight());
      // A restore never opens the drawer; closed keeps only the height.
      if (detent === 'closed') writeDraggedHeight(next.heightPx);
      else applyHeight(next);
    },
    applyHeight,
  };
}
