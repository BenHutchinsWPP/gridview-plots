// src/ui/pane-focus.ts
//
// Focus mode (one pane fills the chart area, back with Esc) and the
// section's keyboard shortcuts: `1`–`4` focus a pane, `Esc` returns to the
// grid, `r` clears the filters. The keys live with focus mode because the
// shell dispatches to ONE handler per section (`registerKeys`); a second
// registration for the same root would be a second owner of its keystrokes.
//
// Focus is layout only: it is not in the query, and charts.ts's
// ResizeObserver re-fits the panes.

import type { PaneView } from '../model/types';
import { within } from './dom';
import { registerKeys } from './shell';

/** The four pane hooks, spelled out (see src/ui/charts.ts). */
const PANE_HOOKS = ['[data-pane="1"]', '[data-pane="2"]', '[data-pane="3"]', '[data-pane="4"]'];

/** Wire the pane icons, header double-clicks and the section's keys inside
 * `root`. `onReset` is what `r` does. Called once per section. */
export function mountPaneFocus(root: HTMLElement, onReset: () => void): void {
  const chartArea = within(root, '[data-el="chart-area"]');
  let view: PaneView = 'grid';

  function setView(next: PaneView): void {
    view = next;
    chartArea.classList.toggle('focus-mode', next !== 'grid');
    for (let pane = 1; pane <= 4; pane++) {
      const focused = next === pane;
      const element = within(root, PANE_HOOKS[pane - 1]);
      element.classList.toggle('focused', focused);
      const icon = element.querySelector('.pane-icon');
      if (icon) {
        icon.textContent = focused ? '⤡' : '⤢';
        icon.setAttribute(
          'title',
          focused ? 'Back to the grid (or press Esc)' : `Expand this pane (or press ${pane})`,
        );
      }
    }
  }

  for (let pane = 1; pane <= 4; pane++) {
    const header = within(root, PANE_HOOKS[pane - 1]).querySelector('.pane-header');
    const toggle = () => setView(view === pane ? 'grid' : (pane as PaneView));
    // The ⤢ acts on one click; double-clicking the header also works.
    header?.querySelector('.pane-icon')?.addEventListener('click', (event) => {
      event.stopPropagation();
      toggle();
    });
    header?.addEventListener('dblclick', toggle);
  }

  registerKeys({
    root,
    handle(event) {
      if (event.key >= '1' && event.key <= '4') {
        const pane = Number(event.key) as PaneView;
        setView(view === pane ? 'grid' : pane);
      } else if (event.key === 'Escape') {
        setView('grid');
      } else if (event.key === 'r') {
        onReset();
      }
    },
  });
}
