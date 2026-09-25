// src/ui/value-checklist.ts
//
// A text column's distinct values as a searchable checklist: the column
// filter dropdown's body and a Slicer, one renderer for both, so a tick means
// the same thing wherever it is made.
//
//   * **A tick is an exact `values` filter; the box only narrows the list.**
//     The caller decides whether the box is also a `contains` filter (the
//     dropdown's, with nothing ticked). A tick is never written into the box:
//     "SAMPLE_HYDRO" as text would also keep "SAMPLE_HYDRO: Pump 1".
//   * **The list is capped and the cap is said.** County and City run to
//     hundreds; a missing item would look absent from the study.
//   * **A tick does not rebuild the list**, which would scroll it back to its
//     top. `setTicked` updates the boxes in place for a write made elsewhere.

import { containsAnyToken, textTokens, type BrowseColumn } from './browse-model';

/** Items listed before the rest are counted instead. */
const LIMIT = 100;

/** A column's distinct non-blank values over `rowCount` rows, in reading order
 * (`Zone 2` before `Zone 10`). */
export function distinctValues(column: BrowseColumn, rowCount: number): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (let row = 0; row < rowCount; row++) {
    const value = column.value(row);
    if (value === null) continue;
    const text = String(value).trim();
    if (text !== '' && !seen.has(text)) {
      seen.add(text);
      values.push(text);
    }
  }
  return values.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export interface ValueChecklistOptions {
  readonly values: readonly string[];
  readonly ticked: readonly string[];
  /** The box's starting text: the dropdown's own `contains` filter, or ''. */
  readonly text: string;
  readonly placeholder: string;
  /** Every tick, Select All and Clear, with the whole ticked set. */
  onTicks(ticked: readonly string[]): void;
}

export interface ValueChecklist {
  readonly input: HTMLInputElement;
  /** What is ticked now. */
  ticked(): readonly string[];
  /** Adopt ticks written elsewhere, in place. */
  setTicked(values: readonly string[]): void;
}

export function mountValueChecklist(
  container: HTMLElement,
  options: ValueChecklistOptions,
): ValueChecklist {
  const { values } = options;
  const ticked = new Set<string>(options.ticked);
  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = options.placeholder;
  input.value = options.text;
  container.appendChild(input);

  const handle: ValueChecklist = {
    input,
    ticked: () => [...ticked],
    setTicked(next) {
      ticked.clear();
      for (const value of next) ticked.add(value);
      for (const box of boxes) box.checked = ticked.has(box.value);
      renderCount();
    },
  };
  const boxes: HTMLInputElement[] = [];
  let renderCount = (): void => {};
  if (values.length === 0) return handle;

  const actionsRow = document.createElement('div');
  actionsRow.className = 'browse-filter-checklist-actions';
  const leftActions = document.createElement('div');
  leftActions.className = 'browse-filter-checklist-buttons';
  const selectAllBtn = document.createElement('button');
  selectAllBtn.type = 'button';
  selectAllBtn.className = 'browse-filter-action-btn';
  selectAllBtn.textContent = 'Select All';
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'browse-filter-action-btn';
  clearBtn.textContent = 'Clear';
  leftActions.append(selectAllBtn, clearBtn);
  const countBadge = document.createElement('span');
  countBadge.className = 'browse-filter-count';
  actionsRow.append(leftActions, countBadge);
  container.appendChild(actionsRow);

  const listEl = document.createElement('div');
  listEl.className = 'browse-filter-checklist';
  container.appendChild(listEl);

  // The narrowed set as last rendered: "Select All" means what is seen.
  let visibleItems: readonly string[] = values;

  renderCount = (): void => {
    let selected = 0;
    for (const value of values) if (ticked.has(value)) selected++;
    countBadge.textContent =
      selected > 0 ? `${selected} of ${values.length} selected` : `${values.length} items`;
  };

  const renderChecklist = (): void => {
    listEl.replaceChildren();
    boxes.length = 0;
    // The same rule the table applies to the box, so the list shows what a
    // box filter keeps.
    const tokens = textTokens(input.value);
    visibleItems = values.filter((value) => containsAnyToken(tokens, value));
    const shown = visibleItems.slice(0, LIMIT);
    for (const value of shown) {
      const item = document.createElement('label');
      item.className = 'browse-filter-item';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = value;
      box.checked = ticked.has(value);
      box.addEventListener('change', () => {
        if (box.checked) ticked.add(value);
        else ticked.delete(value);
        options.onTicks([...ticked]);
        renderCount();
      });
      const text = document.createElement('span');
      text.textContent = value;
      item.append(box, text);
      listEl.appendChild(item);
      boxes.push(box);
    }
    if (visibleItems.length > shown.length) {
      const more = document.createElement('div');
      more.className = 'browse-filter-more';
      more.textContent = `${visibleItems.length - shown.length} more — type to narrow`;
      listEl.appendChild(more);
    }
    renderCount();
  };

  input.addEventListener('input', renderChecklist);

  // Ticks the LISTED items and keeps every tick outside the narrowing.
  selectAllBtn.addEventListener('click', () => {
    for (const value of visibleItems) ticked.add(value);
    options.onTicks([...ticked]);
    renderChecklist();
  });

  clearBtn.addEventListener('click', () => {
    ticked.clear();
    input.value = '';
    options.onTicks([]);
    renderChecklist();
  });

  renderChecklist();
  return handle;
}
