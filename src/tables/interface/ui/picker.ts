// src/tables/interface/ui/picker.ts
//
// The interface picker, shown on the first drop and skippable.
//
// Two things make this more than a checkbox list:
//
//   * It opens over the UNION of every dropped file's header. Runs
//     monitor different sets of paths, and a column that is offered by one
//     file has to be offered for all of them or it can never be selected at
//     all -- so the list says which files carry a path, and a case that does
//     not carries it as absent rather than as zero.
//   * Selection narrows the cube's interface axis itself, not just the parse,
//     and the readout below is the real allocation arithmetic rather than an
//     estimate. At this shape memory is not the binding constraint it was for
//     the area exports -- a full 167-interface year is ~6 MB -- so the default
//     is everything and the picker's real job is keeping 167 paths out of the
//     browse drawer when you care about four of them.
//
// This is `showWideEntityPicker` (`src/ui/wide-entity-picker.ts`) in its
// `keepAll` shape: folded into named groups by `interfaceGroups`, and
// resolving `union` unchanged rather than `null` when the user skips.

import { cubeBytesFor } from '../pool';
import { interfaceGroups } from '../rules';
import { showWideEntityPicker } from '../../../ui/wide-entity-picker';

/**
 * Resolve to the retained interface list, or to `union` unchanged if the user
 * skips. `coverage` maps interface -> the case names whose header carries it.
 */
export function showPicker(
  union: string[],
  coverage: Map<string, string[]>,
  caseCount: number,
  preselected: readonly string[] = union,
  everything: boolean,
): Promise<string[] | null> {
  // Everything, on a first drop. On a WIDENING drop the caller narrows this
  // to what is already retained plus the paths nobody has been offered, so
  // reopening the picker does not silently re-tick a path the user removed.
  return showWideEntityPicker({
    union,
    coverage,
    caseCount,
    preselected,
    title: 'Which interfaces should be kept?',
    subtitle:
      caseCount > 1
        ? `Every path monitored by any of these ${caseCount} files is listed. Keep the lot, or ` +
          'narrow it now — what you keep here is what the browse drawer offers later.'
        : 'Every path this export monitors is listed. Keep the lot, or narrow it now — what ' +
          'you keep here is what the browse drawer offers later.',
    filterPlaceholder: 'Filter interfaces…',
    selectAllLabel: 'Select all',
    selectNoneLabel: 'Select none',
    selectNoneScope: 'visible',
    groupBy: interfaceGroups,
    mode: 'keepAll',
    everything,
    keepAllLabel: 'Keep everything',
    keepAllCost: (unionCount) => ({
      bytes: cubeBytesFor(unionCount) * caseCount,
      what: `all ${unionCount} interfaces`,
    }),
    readout: (chosenCount, unionCount, cases) => {
      const bytes = cubeBytesFor(chosenCount) * cases;
      return (
        `${chosenCount} of ${unionCount} interface${unionCount === 1 ? '' : 's'} × ` +
        `${cases} case${cases === 1 ? '' : 's'} ≈ ${(bytes / (1024 * 1024)).toFixed(1)} MB`
      );
    },
  });
}
