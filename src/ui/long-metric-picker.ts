// src/ui/long-metric-picker.ts
//
// The long-shape drop's metric picker. In shape L the entities are ROWS, so
// their count is unknown until the scan and the metric axis is the only
// choice; this is where the coming allocation (entities x metrics x 8760 x
// 4 B) is priced BEFORE it is attempted. Kind-neutral: it takes a noun and a
// list of strings. Area's own picker groups by area's rules and is separate.

import { HOURS_PER_YEAR } from '../model/calendar';
import { confirmLargeAllocation } from './confirm-allocation';

const BYTES_PER_VALUE = 4; // Float32Array

export interface LongMetricPickerRequest {
  /** Every metric column the batch's headers carry, in union order. */
  union: string[];
  /** The kind's noun, for wording only: "bus", "unit". Never a kind token. */
  noun: string;
  /** Entities the scan pass found -- the axis the cube is about to be sized
   * on. This is why the picker runs AFTER the scan on this path. */
  entityCount: number;
  /** Files in this batch; each gets its own cube of the stated size. */
  fileCount: number;
  /** Ticked on open. Empty on a first drop: at bus width the Enter key would
   * otherwise allocate every metric the file carries. */
  preselected?: readonly string[];
  /** Answered at the Import Dialog: the picker never opens and the whole
   * union is kept, but the price is still confirmed. */
  everything?: boolean;
}

/**
 * The retained metric list, or `null` on cancel (loads nothing). "Keep
 * everything" can be gigabytes, so it states the figure, confirms when large,
 * and is never the default so Enter cannot reach it.
 */
export function showLongMetricPicker(request: LongMetricPickerRequest): Promise<string[] | null> {
  const { union, noun, entityCount, fileCount } = request;
  const keepAllWhat = `all ${union.length} metric${union.length === 1 ? '' : 's'}`;
  const keepAllBytes = (bytesPerMetric: number): number =>
    union.length * bytesPerMetric * fileCount;
  // The same product `createAccumulator` is about to hand to
  // `new Float32Array`, per file, so the number on screen, the number in the
  // confirmation and the number in the refusal cannot disagree.
  const perMetric = entityCount * HOURS_PER_YEAR * BYTES_PER_VALUE;

  // An unpriced multi-GB allocation is what a skipped picker must not become.
  if (request.everything) {
    return confirmLargeAllocation(keepAllBytes(perMetric), keepAllWhat).then((ok) =>
      ok ? [...union] : null,
    );
  }

  return new Promise((resolve) => {
    const inUnion = new Set(union);
    const chosen = new Set((request.preselected ?? []).filter((name) => inUnion.has(name)));

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const modal = document.createElement('div');
    modal.className = 'modal';
    backdrop.appendChild(modal);

    const title = document.createElement('h2');
    title.textContent = `Which ${noun} metrics should be kept?`;
    modal.appendChild(title);

    const subtitle = document.createElement('p');
    subtitle.className = 'modal-subtitle';
    subtitle.textContent =
      `${entityCount.toLocaleString()} ${noun}${entityCount === 1 ? '' : 's'} were read from ` +
      `${fileCount} file${fileCount === 1 ? '' : 's'}. Every metric kept costs one full plane ` +
      `per ${noun}, so the figure below is exactly what loading is about to allocate.`;
    modal.appendChild(subtitle);

    const toolbar = document.createElement('div');
    toolbar.className = 'modal-toolbar';
    const filter = document.createElement('input');
    filter.type = 'search';
    filter.placeholder = 'Filter metrics…';
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
    modal.appendChild(toolbar);

    const list = document.createElement('div');
    list.className = 'modal-list';
    modal.appendChild(list);

    const readout = document.createElement('p');
    readout.className = 'modal-readout';
    modal.appendChild(readout);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = 'Cancel';
    const keepAll = document.createElement('button');
    keepAll.type = 'button';
    keepAll.className = 'btn';
    keepAll.textContent = 'Keep everything';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'btn btn-primary';
    confirm.textContent = 'Load with these';
    actions.append(cancel, keepAll, confirm);
    modal.appendChild(actions);

    function paint(): void {
      const needle = filter.value.trim().toLowerCase();
      list.replaceChildren();
      for (const name of union) {
        if (needle && !name.toLowerCase().includes(needle)) continue;
        const row = document.createElement('label');
        row.className = 'modal-row';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.value = name;
        box.checked = chosen.has(name);
        box.addEventListener('change', () => {
          if (box.checked) chosen.add(name);
          else chosen.delete(name);
          paint();
        });
        row.appendChild(box);
        const text = document.createElement('span');
        text.className = 'modal-row-name';
        text.textContent = name;
        row.appendChild(text);
        list.appendChild(row);
      }
      const bytes = chosen.size * perMetric * fileCount;
      keepAll.title =
        `Load ${keepAllWhat} — ` + `${(keepAllBytes(perMetric) / (1024 * 1024)).toFixed(0)} MB`;
      readout.textContent =
        `${chosen.size} metric${chosen.size === 1 ? '' : 's'} × ` +
        `${entityCount.toLocaleString()} ${noun}${entityCount === 1 ? '' : 's'} × ` +
        `${HOURS_PER_YEAR} h × 4 B ≈ ${(bytes / (1024 * 1024)).toFixed(0)} MB` +
        (fileCount === 1 ? '' : ` across ${fileCount} files`);
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

    function close(result: string[] | null): void {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    // Escape CANCELS here, where area's picker takes what is on screen. The
    // default there is a recommended set; the default here is nothing, so
    // "take what is on screen" would load nothing and say nothing about it.
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') close(null);
    }
    document.addEventListener('keydown', onKey);
    cancel.addEventListener('click', () => close(null));
    keepAll.addEventListener('click', () => {
      // See src/ui/wide-entity-picker.ts for why the picker's own Escape
      // handler comes off while the confirmation is up.
      document.removeEventListener('keydown', onKey);
      void confirmLargeAllocation(keepAllBytes(perMetric), keepAllWhat).then((ok) => {
        if (ok) close([...union]);
        else document.addEventListener('keydown', onKey);
      });
    });
    confirm.addEventListener('click', () => close([...chosen]));

    paint();
    document.body.appendChild(backdrop);
    filter.focus();
  });
}
