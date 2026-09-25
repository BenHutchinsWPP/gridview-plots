// src/tables/generator/ui/picker.ts
//
// The generator picker, shown on the first generator drop and again on any
// later drop carrying a unit nobody has been offered yet
// (`SectionState.covers`).
//
// Like src/tables/bus/ui/picker.ts, it is the Interface picker with ONE rule
// inverted: **nothing is selected by default**.
//
// A full-width generator case is a ~170 MB contiguous `Float32Array` (4,900
// units x 8,760 h x 4 B). Interface's "keep everything, the picker's job is
// keeping 167 paths out of the drawer" reasoning does not survive an axis
// twenty times wider, so the Enter key must not be able to produce that
// allocation. The "Keep everything" button can, which is why it names the
// whole cost on hover rather than offering itself as the ordinary path: the
// readout states the real arithmetic (`cubeBytesFor`, not an estimate) for
// both the ticked set and the union, and the confirm stays disabled until at
// least one generator is chosen.
//
// The axis is the NAME, which this kind may key on where Bus may not: a
// generator name is unique, and a duplicate in a wide header is refused at
// ingest.
//
// Same `showWideEntityPicker` `cancelable` shape as the Bus picker: flat (no
// `groupBy`) and capped at `MAX_ROWS`.

import { cubeBytesFor } from '../wide';
import { showWideEntityPicker } from '../../../ui/wide-entity-picker';

/** How many rows the list renders at once. The filter box is how a selection
 * is built past this; rendering 4,900 checkbox rows costs seconds and helps
 * nobody, since the chart draws at most ten lines. */
const MAX_ROWS = 200;

/**
 * Resolve to the retained generator names, or to `null` if the user cancels.
 *
 * `preselected` is what a WIDENING drop starts ticked with: the units already
 * loaded, so the user is deciding about the new ones rather than rebuilding
 * their whole selection. Empty on a first drop, which is the header's rule.
 */
export function showGeneratorPicker(
  union: string[],
  coverage: Map<string, string[]>,
  caseCount: number,
  preselected: readonly string[] = [],
  everything: boolean,
): Promise<string[] | null> {
  return showWideEntityPicker({
    union,
    coverage,
    caseCount,
    // EMPTY on a first drop, deliberately. See the header.
    preselected,
    title: 'Which generators should be kept?',
    subtitle:
      'Nothing is selected: a full-width generator export is well over a hundred megabytes per ' +
      'case, so this one is opt-in. Filter, tick what you need, and the readout below states ' +
      'exactly what will be allocated. What you keep here is what the browse drawer offers later.',
    filterPlaceholder: 'Filter generators…',
    selectAllLabel: 'Select all shown',
    selectNoneLabel: 'Select none',
    selectNoneScope: 'all',
    // Both act on WHAT THE FILTER SHOWS, as Interface's do -- and "Select
    // all" with an empty filter box is how a user asks for the whole axis,
    // which is allowed but never the default.
    maxRows: MAX_ROWS,
    moreText: (matchedCount, maxRows) =>
      `${matchedCount.toLocaleString()} generators match — the first ${maxRows} are ` +
      `listed. Narrow the filter to reach the rest.`,
    mode: 'cancelable',
    everything,
    keepAllCost: (unionCount) => ({
      bytes: cubeBytesFor(unionCount) * caseCount,
      what: `all ${unionCount.toLocaleString()} generators`,
    }),
    readout: (chosenCount, unionCount, cases) => {
      const bytes = cubeBytesFor(chosenCount) * cases;
      const allBytes = cubeBytesFor(unionCount) * cases;
      return (
        `${chosenCount.toLocaleString()} of ${unionCount.toLocaleString()} generator` +
        `${unionCount === 1 ? '' : 's'} × ${cases} case${cases === 1 ? '' : 's'} = ` +
        `${(bytes / (1024 * 1024)).toFixed(1)} MB` +
        ` (all of them would be ${(allBytes / (1024 * 1024)).toFixed(0)} MB)`
      );
    },
  });
}
