// src/tables/bus/ui/picker.ts
//
// The bus picker. Unlike Interface's, **nothing is selected by default**: a
// full-width bus case is hundreds of MB per metric, so Enter must not be able
// to produce that allocation. "Keep everything" states the exact cost
// (`cubeBytesFor`) on hover instead.
//
// The value is the id as a string (what `bus/wide.ts` rewrites the header
// to), shown as `name (id)`, and the filter matches the id too, because two
// buses may share a name.

import { cubeBytesFor } from '../wide';
import { busLabel } from '../rules';
import { showWideEntityPicker } from '../../../ui/wide-entity-picker';

/** How many rows the list renders at once. The filter box is how a selection
 * is built past this; rendering 30,000 checkbox rows costs seconds and helps
 * nobody, since the chart draws at most ten lines. */
const MAX_ROWS = 200;

/**
 * The retained bus ids (as strings), or `null` on cancel. `labels` is display
 * only. `preselected` is the already-loaded set on a WIDENING drop, so the
 * user decides about the new buses only; empty on a first drop.
 */
export function showBusPicker(
  union: string[],
  labels: Map<string, string>,
  coverage: Map<string, string[]>,
  caseCount: number,
  preselected: readonly string[] = [],
  everything: boolean,
): Promise<string[] | null> {
  const label = (id: string): string => busLabel(labels.get(id) ?? '', Number(id));

  return showWideEntityPicker({
    union,
    coverage,
    caseCount,
    // EMPTY on a first drop, deliberately. See the header.
    preselected,
    title: 'Which buses should be kept?',
    subtitle:
      `Nothing is selected: a full-width bus export is hundreds of megabytes per case, so this ` +
      `one is opt-in. Filter, tick what you need, and the readout below states exactly what will ` +
      `be allocated. What you keep here is what the browse drawer offers later.`,
    filterPlaceholder: 'Filter by bus name or number…',
    selectAllLabel: 'Select all shown',
    selectNoneLabel: 'Select none',
    selectNoneScope: 'all',
    label,
    // Both act on WHAT THE FILTER SHOWS, as Interface's do -- and "Select
    // all" with an empty filter box is how a user asks for the whole 207 MB
    // axis, which is allowed but never the default.
    matches: (id, needle) => id.includes(needle) || label(id).toLowerCase().includes(needle),
    maxRows: MAX_ROWS,
    moreText: (matchedCount, maxRows) =>
      `${matchedCount.toLocaleString()} buses match — the first ${maxRows} are listed. ` +
      `Narrow the filter to reach the rest.`,
    mode: 'cancelable',
    everything,
    keepAllCost: (unionCount) => ({
      bytes: cubeBytesFor(unionCount) * caseCount,
      what: `all ${unionCount.toLocaleString()} buses`,
    }),
    readout: (chosenCount, unionCount, cases) => {
      const bytes = cubeBytesFor(chosenCount) * cases;
      const allBytes = cubeBytesFor(unionCount) * cases;
      return (
        `${chosenCount.toLocaleString()} of ${unionCount.toLocaleString()} bus` +
        `${unionCount === 1 ? '' : 'es'} × ${cases} case${cases === 1 ? '' : 's'} = ` +
        `${(bytes / (1024 * 1024)).toFixed(1)} MB` +
        ` (all of them would be ${(allBytes / (1024 * 1024)).toFixed(0)} MB)`
      );
    },
  });
}
