// src/ui/wide-entity-picker.ts
//
// The picker every shape-W drop opens to choose entities off its header's
// axis. Kind-neutral: labels, filter matching, folding, row caps, wording and
// the readout arithmetic all arrive on the request; there is no kind argument.
//
//   * `mode: 'keepAll'` (interface): Escape keeps the current selection once
//     something is ticked, so the promise never settles to `null`.
//   * `mode: 'cancelable'` (bus, generator): nothing is ticked by default, so
//     Cancel and Escape resolve `null` rather than loading nothing.
//
// "Keep everything" is on every picker, priced by `keepAllCost`, and past
// `LARGE_ALLOCATION_BYTES` it asks for confirmation.

import { confirmLargeAllocation } from './confirm-allocation';

export interface WideEntityPickerGroup {
  title: string;
  names: string[];
}

export interface WideEntityPickerRequest {
  /** In union order. */
  union: string[];
  /** Entity -> the case names whose header carries it. */
  coverage: Map<string, string[]>;
  caseCount: number;
  /** Ticked on open, filtered down to what `union` actually carries. */
  preselected: readonly string[];

  title: string;
  subtitle: string;
  filterPlaceholder: string;
  selectAllLabel: string;
  selectNoneLabel: string;
  /** "Select none" clears what the filter shows ('visible') or everything
   * ('all', where nothing is on screen by default). */
  selectNoneScope: 'visible' | 'all';

  /** Row display text. Defaults to the value itself. */
  label?: (value: string) => string;
  /** Filter predicate; defaults to a case-insensitive substring of `label`. */
  matches?: (value: string, needle: string) => boolean;
  /** Folds the list into named sections; omit for a flat list. */
  groupBy?: (
    visible: string[],
    coverage: Map<string, string[]>,
    caseCount: number,
  ) => WideEntityPickerGroup[];
  /** Caps a flat list's rendered rows; ignored when `groupBy` is set. */
  maxRows?: number;
  /** Notice shown below a capped, overflowing list. Required with `maxRows`. */
  moreText?: (matchedCount: number, maxRows: number) => string;

  /** The readout line: the real allocation arithmetic, not an estimate. */
  readout: (chosenCount: number, unionCount: number, caseCount: number) => string;

  mode: 'keepAll' | 'cancelable';
  /** Defaults to "Keep everything". */
  keepAllLabel?: string;
  /** The union's cost and its name for "Keeping ..." ("all 5,900 buses").
   * One callback, so the tooltip and the confirmation state one price. */
  keepAllCost?: (unionCount: number) => { bytes: number; what: string };
  /** The Import Dialog already said "Load everything": skip the picker but
   * still state the price through `keepAllCost`. */
  everything?: boolean;
}

/**
 * Resolve to the retained entity list. The mode decides whether `null` is
 * reachable, so it decides the return type. `everything` gives up that
 * guarantee in either mode: the large-allocation confirmation can be
 * declined.
 */
export function showWideEntityPicker(
  request: WideEntityPickerRequest & { everything: boolean },
): Promise<string[] | null>;
export function showWideEntityPicker(
  request: WideEntityPickerRequest & { mode: 'keepAll' },
): Promise<string[]>;
export function showWideEntityPicker(
  request: WideEntityPickerRequest & { mode: 'cancelable' },
): Promise<string[] | null>;
export function showWideEntityPicker(request: WideEntityPickerRequest): Promise<string[] | null> {
  const { union, coverage, caseCount } = request;
  const label = (value: string): string => (request.label ? request.label(value) : value);
  const matchOne = (value: string, needle: string): boolean =>
    request.matches ? request.matches(value, needle) : label(value).toLowerCase().includes(needle);

  const keepAllCost = request.keepAllCost ? request.keepAllCost(union.length) : null;

  // Skip the dialog, keep the confirmation; a declined `null` loads nothing
  // rather than an unpriced huge allocation.
  if (request.everything) {
    return keepAllCost === null
      ? Promise.resolve(union)
      : confirmLargeAllocation(keepAllCost.bytes, keepAllCost.what).then((ok) =>
          ok ? union : null,
        );
  }

  return new Promise((resolve) => {
    const inUnion = new Set(union);
    const chosen = new Set(request.preselected.filter((value) => inUnion.has(value)));

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';

    const modal = document.createElement('div');
    modal.className = 'modal';
    backdrop.appendChild(modal);

    const title = document.createElement('h2');
    title.textContent = request.title;
    modal.appendChild(title);

    const subtitle = document.createElement('p');
    subtitle.className = 'modal-subtitle';
    subtitle.textContent = request.subtitle;
    modal.appendChild(subtitle);

    const toolbar = document.createElement('div');
    toolbar.className = 'modal-toolbar';
    const filter = document.createElement('input');
    filter.type = 'search';
    filter.placeholder = request.filterPlaceholder;
    filter.className = 'modal-filter';
    toolbar.appendChild(filter);

    // Both act on WHAT THE FILTER SHOWS, so a selection can be built filter by
    // filter.
    const selectAll = document.createElement('button');
    selectAll.type = 'button';
    selectAll.className = 'btn';
    selectAll.textContent = request.selectAllLabel;
    toolbar.appendChild(selectAll);

    const selectNone = document.createElement('button');
    selectNone.type = 'button';
    selectNone.className = 'btn';
    selectNone.textContent = request.selectNoneLabel;
    toolbar.appendChild(selectNone);
    modal.appendChild(toolbar);

    const list = document.createElement('div');
    list.className = 'modal-list';
    modal.appendChild(list);

    const readout = document.createElement('p');
    readout.className = 'modal-readout';
    modal.appendChild(readout);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const keepAllBtn = document.createElement('button');
    keepAllBtn.type = 'button';
    keepAllBtn.className = 'btn';
    keepAllBtn.textContent = request.keepAllLabel ?? 'Keep everything';
    actions.appendChild(keepAllBtn);
    const cancelBtn = request.mode === 'cancelable' ? document.createElement('button') : null;
    if (cancelBtn) {
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn';
      cancelBtn.textContent = 'Cancel';
      actions.appendChild(cancelBtn);
    }
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'btn btn-primary';
    confirm.textContent = 'Load with these';
    actions.appendChild(confirm);
    modal.appendChild(actions);

    /** Folders the user has opened or closed, by title -- `groupBy` only. */
    const openState = new Map<string, boolean>();

    function matching(): string[] {
      const needle = filter.value.trim().toLowerCase();
      return needle ? union.filter((value) => matchOne(value, needle)) : union;
    }

    function buildRow(value: string): HTMLElement {
      const row = document.createElement('label');
      row.className = 'modal-row';

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = value;
      box.checked = chosen.has(value);
      row.appendChild(box);

      const text = document.createElement('span');
      text.className = 'modal-row-name';
      text.textContent = label(value);
      row.appendChild(text);

      const carriers = coverage.get(value) ?? [];
      if (caseCount > 1 && carriers.length < caseCount) {
        row.title = `Only in ${carriers.join(', ')}. The other file(s) load it as no-data.`;
        const flag = document.createElement('span');
        flag.className = 'picker-count';
        flag.textContent = `${carriers.length}/${caseCount}`;
        row.appendChild(flag);
      }

      box.addEventListener('change', () => {
        if (box.checked) chosen.add(value);
        else chosen.delete(value);
        paint();
      });
      return row;
    }

    function paint(): void {
      const needle = filter.value.trim().toLowerCase();
      const matched = matching();
      list.replaceChildren();

      if (request.groupBy) {
        for (const { title: groupTitle, names } of request.groupBy(matched, coverage, caseCount)) {
          const folder = document.createElement('details');
          folder.dataset.group = groupTitle;
          // A filter opens every folder (a hidden hit is useless); otherwise a
          // folder remembers what the user last did to it.
          folder.open = needle ? true : (openState.get(groupTitle) ?? true);

          const summary = document.createElement('summary');
          summary.className = 'picker-folder';
          // On click, not toggle: painting sets `open` and fires toggle too.
          summary.addEventListener('click', () => openState.set(groupTitle, !folder.open));
          const groupLabel = document.createElement('span');
          groupLabel.textContent = groupTitle;
          summary.appendChild(groupLabel);
          const count = document.createElement('span');
          count.className = 'picker-count';
          count.textContent = `${names.filter((n) => chosen.has(n)).length}/${names.length}`;
          summary.appendChild(count);
          folder.appendChild(summary);

          for (const name of names) folder.appendChild(buildRow(name));
          list.appendChild(folder);
        }
      } else {
        const maxRows = request.maxRows;
        const head = maxRows ? matched.slice(0, maxRows) : matched;
        // Selected entities are always listed: an unseen selection cannot be
        // undone.
        const shown = maxRows
          ? [...head, ...[...chosen].filter((value) => !head.includes(value))]
          : head;
        for (const value of shown) list.appendChild(buildRow(value));

        if (maxRows && matched.length > maxRows) {
          const more = document.createElement('p');
          more.className = 'modal-readout';
          more.textContent = request.moreText ? request.moreText(matched.length, maxRows) : '';
          list.appendChild(more);
        }
      }

      readout.textContent = request.readout(chosen.size, union.length, caseCount);
      keepAllBtn.title = keepAllCost
        ? `Load ${keepAllCost.what} — ${(keepAllCost.bytes / (1024 * 1024)).toFixed(0)} MB`
        : '';
      confirm.disabled = chosen.size === 0;
    }

    filter.addEventListener('input', paint);
    selectAll.addEventListener('click', () => {
      for (const value of matching()) chosen.add(value);
      paint();
    });
    selectNone.addEventListener('click', () => {
      if (request.selectNoneScope === 'all') chosen.clear();
      else for (const value of matching()) chosen.delete(value);
      paint();
    });

    function close(result: string[] | null): void {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      // 'keepAll': the default is everything, so Escape keeps what is ticked
      // (unless nothing is). 'cancelable': Escape cancels, since taking what is
      // on screen would load nothing.
      if (request.mode === 'keepAll') {
        if (chosen.size > 0) close([...chosen]);
      } else {
        close(null);
      }
    }
    document.addEventListener('keydown', onKey);
    keepAllBtn.addEventListener('click', () => {
      if (!keepAllCost) {
        close(union);
        return;
      }
      // Detach this Escape handler while the confirmation is up, or one
      // Escape would close both dialogs.
      document.removeEventListener('keydown', onKey);
      void confirmLargeAllocation(keepAllCost.bytes, keepAllCost.what).then((ok) => {
        if (ok) close(union);
        else document.addEventListener('keydown', onKey);
      });
    });
    if (cancelBtn) cancelBtn.addEventListener('click', () => close(null));
    confirm.addEventListener('click', () => close([...chosen]));

    paint();
    document.body.appendChild(backdrop);
    filter.focus();
  });
}
