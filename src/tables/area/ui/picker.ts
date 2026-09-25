// src/tables/area/ui/picker.ts
//
// The Area column picker, shown on the first drop and skippable.
//
//   * Every column is an independent choice. A weighted-mean column kept
//     without its weight is allowed: its multi-area series falls back to a
//     plain mean WITH a warning (a single-area series needs no weight). The
//     picker shows the dependency rather than taking the checkbox away.
//   * Selection narrows the cube's metric axis itself, so the live readout is
//     the real allocation, not an estimate.

import { HOURS_PER_YEAR } from '../../../model/calendar';
import { confirmLargeAllocation } from '../../../ui/confirm-allocation';
import {
  CALCULATED_GROUP,
  defaultSelection,
  isDegenerate,
  metricGroups,
  requiredInputs,
  ruleFor,
} from '../rules';

const BYTES_PER_VALUE = 4; // Float32Array

/** Resolve to the retained columns, `union` unchanged on skip, or `null` when
 * a keep-everything drop declines the confirmation. */
export function showPicker(
  union: string[],
  caseCount: number,
  entityCount: number,
  preselected: readonly string[] | undefined,
  everything: boolean,
): Promise<string[] | null> {
  // Skip the dialog, keep the confirmation; declining loads nothing.
  if (everything) {
    const perMetric = caseCount * HOURS_PER_YEAR * entityCount * BYTES_PER_VALUE;
    return confirmLargeAllocation(union.length * perMetric, `all ${union.length} columns`).then(
      (ok) => (ok ? union : null),
    );
  }

  return new Promise((resolve) => {
    // `defaultSelection` first; on a WIDENING drop, what is retained plus
    // never-offered metrics, so a removed column is not re-ticked.
    const chosen = new Set(
      preselected === undefined
        ? defaultSelection(union)
        : preselected.filter((name) => union.includes(name)),
    );

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';

    const modal = document.createElement('div');
    modal.className = 'modal';
    backdrop.appendChild(modal);

    const title = document.createElement('h2');
    title.textContent = 'Which metrics should be kept?';
    modal.appendChild(title);

    const subtitle = document.createElement('p');
    subtitle.className = 'modal-subtitle';
    subtitle.textContent =
      'A recommended set is ticked — load it as-is, adjust it, or keep everything. ' +
      'Memory is exactly linear in what you keep, which is how case count stops being ' +
      'the binding constraint.';
    modal.appendChild(subtitle);

    const toolbar = document.createElement('div');
    toolbar.className = 'modal-toolbar';
    const filter = document.createElement('input');
    filter.type = 'search';
    filter.placeholder = 'Filter columns…';
    filter.className = 'modal-filter';
    toolbar.appendChild(filter);

    const selectAll = document.createElement('button');
    selectAll.type = 'button';
    selectAll.className = 'btn';
    selectAll.textContent = 'Select all';
    toolbar.appendChild(selectAll);

    const selectNone = document.createElement('button');
    selectNone.type = 'button';
    selectNone.className = 'btn';
    selectNone.textContent = 'Select none';
    toolbar.appendChild(selectNone);

    // The way back to the defaults after "Select none".
    const selectDefault = document.createElement('button');
    selectDefault.type = 'button';
    selectDefault.className = 'btn';
    selectDefault.textContent = 'Recommended';
    toolbar.appendChild(selectDefault);
    modal.appendChild(toolbar);

    const list = document.createElement('div');
    list.className = 'modal-list';
    modal.appendChild(list);

    const readout = document.createElement('p');
    readout.className = 'modal-readout';
    modal.appendChild(readout);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'btn';
    skip.textContent = 'Keep everything';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'btn btn-primary';
    confirm.textContent = 'Load with these';
    actions.append(skip, confirm);
    modal.appendChild(actions);

    /** What "Keep everything" would allocate, as `paint` last computed it. */
    let skipBytes = 0;

    /** Columns the selection depends on (weights, calculated operands) and
     * their dependents: shown, not enforced. */
    function lockedInputs(): Map<string, { weight: string[]; operand: string[] }> {
      const locked = new Map<string, { weight: string[]; operand: string[] }>();
      const at = (input: string) => {
        const seen = locked.get(input) ?? { weight: [], operand: [] };
        locked.set(input, seen);
        return seen;
      };
      for (const name of chosen) {
        const rule = ruleFor(name);
        if (!rule) continue;
        for (const weight of [rule.weight, rule.fallbackWeight]) {
          if (weight) at(weight).weight.push(name);
        }
        if (rule.derived) {
          at(rule.derived.minuend).operand.push(name);
          at(rule.derived.subtrahend).operand.push(name);
        }
      }
      return locked;
    }

    /** Folders the user has opened or closed, by title. */
    const openState = new Map<string, boolean>();

    /** Folders open by default: the ones an analyst opens anyway. */
    const OPEN_BY_DEFAULT = new Set(['Load', 'Generation', 'Prices', CALCULATED_GROUP]);

    function grouped(needle: string): { title: string; names: string[] }[] {
      return metricGroups(union.filter((name) => !needle || name.toLowerCase().includes(needle)));
    }

    function paint(): void {
      const locked = lockedInputs();
      const needle = filter.value.trim().toLowerCase();
      list.replaceChildren();

      for (const { title, names } of grouped(needle)) {
        const folder = document.createElement('details');
        folder.dataset.group = title;
        // Calculated columns are marked, not passed off as export data.
        const calculated = title === CALCULATED_GROUP;
        if (calculated) folder.className = 'picker-calculated';
        // A filter opens every folder; otherwise a folder remembers the user.
        folder.open = needle ? true : (openState.get(title) ?? OPEN_BY_DEFAULT.has(title));

        const summary = document.createElement('summary');
        summary.className = 'picker-folder';
        // On click, not toggle (see src/ui/wide-entity-picker.ts).
        summary.addEventListener('click', () => openState.set(title, !folder.open));
        const label = document.createElement('span');
        label.textContent = calculated ? `${title} — computed at load, not in the export` : title;
        summary.appendChild(label);
        const count = document.createElement('span');
        count.className = 'picker-count';
        count.textContent = `${names.filter((n) => chosen.has(n)).length}/${names.length}`;
        summary.appendChild(count);
        folder.appendChild(summary);

        for (const name of names) {
          const row = document.createElement('label');
          row.className = 'modal-row';

          const box = document.createElement('input');
          box.type = 'checkbox';
          box.value = name;
          box.checked = chosen.has(name);
          row.appendChild(box);

          const text = document.createElement('span');
          text.className = 'modal-row-name';
          text.textContent = name;
          row.appendChild(text);

          const dependents = locked.get(name);
          const rule = ruleFor(name);
          if (rule?.derived) {
            const symbol = rule.derived.op === 'div' ? '\u00f7' : '\u2212';
            row.title =
              `Calculated at load: ${rule.derived.minuend} ${symbol} ${rule.derived.subtrahend}. ` +
              'Keep both of those or this cannot be built.';
          } else if (dependents && dependents.operand.length > 0) {
            row.title =
              `${dependents.operand.join(', ')} is calculated from this. Without it, that ` +
              'column cannot be built at all.';
          } else if (dependents && dependents.weight.length > 0) {
            row.title =
              `${dependents.weight.join(', ')} uses this as a weight. Without it, those ` +
              'columns can only be plotted for a single area.';
          } else if (isDegenerate(name)) {
            row.title =
              'Identically zero in every hour of the reference export. Valid data, but a constant.';
          }

          box.addEventListener('change', () => {
            if (box.checked) chosen.add(name);
            else chosen.delete(name);
            paint();
          });
          folder.appendChild(row);
        }
        list.appendChild(folder);
      }

      const missing = requiredInputs([...chosen]).filter((weight) => !chosen.has(weight));
      // Exactly what ingest allocates: retained x cases x hours x areas x 4.
      const perMetric = caseCount * HOURS_PER_YEAR * entityCount * BYTES_PER_VALUE;
      const bytes = chosen.size * perMetric;
      // What "keep everything" costs, stated; past `LARGE_ALLOCATION_BYTES` it
      // also needs confirmation.
      skipBytes = union.length * perMetric;
      skip.title = `All ${union.length} columns ≈ ${(skipBytes / (1024 * 1024)).toFixed(0)} MB`;
      readout.textContent =
        `${chosen.size} metric${chosen.size === 1 ? '' : 's'} × ${caseCount} case` +
        `${caseCount === 1 ? '' : 's'} ≈ ${(bytes / (1024 * 1024)).toFixed(0)} MB` +
        (missing.length > 0
          ? ` · without ${missing.join(', ')}, the columns weighted by ${
              missing.length === 1 ? 'it' : 'them'
            } plot for one area only`
          : '');
      confirm.disabled = chosen.size === 0;
    }

    filter.addEventListener('input', paint);
    selectAll.addEventListener('click', () => {
      for (const name of union) chosen.add(name);
      paint();
    });
    selectNone.addEventListener('click', () => {
      chosen.clear();
      paint();
    });
    selectDefault.addEventListener('click', () => {
      chosen.clear();
      for (const name of defaultSelection(union)) chosen.add(name);
      paint();
    });

    function close(result: string[]): void {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    // Escape takes what is on screen (the recommended set until changed), not
    // "keep everything": dismissing a dialog should not be its most expensive
    // choice.
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape' && chosen.size > 0) close([...chosen]);
    }
    document.addEventListener('keydown', onKey);
    skip.addEventListener('click', () => {
      // Suspend this Escape handler during the confirmation.
      document.removeEventListener('keydown', onKey);
      void confirmLargeAllocation(skipBytes, `all ${union.length} columns`).then((ok) => {
        if (ok) close(union);
        else document.addEventListener('keydown', onKey);
      });
    });
    // Exactly the ticked columns: re-adding weights would make the MB readout
    // wrong and silence ingest's "not retained" warning.
    confirm.addEventListener('click', () => close([...chosen]));

    paint();
    document.body.appendChild(backdrop);
    filter.focus();
  });
}
