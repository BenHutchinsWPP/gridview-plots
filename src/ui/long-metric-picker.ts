// src/ui/long-metric-picker.ts
//
// The long-shape drop's metric picker. In shape L the entities are ROWS, so
// their count is unknown until the scan and the metric axis is the only
// choice; this is where the coming allocation (metrics x entities x years x
// 8784 x 4 B) is priced BEFORE it is attempted. Kind-neutral: it takes a noun and a
// list of strings. Area's own picker groups by area's rules and is separate.

import { cubeCost, type CubeCost } from '../ingest';
import { confirmLargeAllocation } from './confirm-allocation';

export interface LongMetricPickerRequest {
  /** Every metric column the batch's headers carry, in union order. */
  union: string[];
  /** The kind's noun, singular and plural, for wording only. Never a kind
   * token. */
  noun: { readonly one: string; readonly many: string };
  /** Entities the scan pass found -- the axis the cube is about to be sized
   * on. This is why the picker runs AFTER the scan on this path. */
  entityCount: number;
  /** Files in this batch; each gets its own cube of the stated size. */
  fileCount: number;
  /** The years the scan found, summed over the batch's files: each file's
   * cube holds one 8,784-hour slot per year of its span. */
  yearCount: number;
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
  const { union, noun, entityCount, fileCount, yearCount } = request;
  // The same product `createAccumulator` is about to hand to
  // `new Float32Array`, worded by the same `cubeCost` as its allocation
  // refusal, so the number on screen, the number in the confirmation and the
  // number in the refusal cannot disagree.
  const costOf = (metricCount: number): CubeCost =>
    cubeCost(
      [
        { count: metricCount, one: 'metric', many: 'metrics' },
        { count: entityCount, one: noun.one, many: noun.many },
      ],
      yearCount,
    );
  const keepAll = {
    what: `all ${union.length} metric${union.length === 1 ? '' : 's'}`,
    cost: costOf(union.length),
    lever: 'fewer metrics',
  };

  // An unpriced multi-GB allocation is what a skipped picker must not become.
  if (request.everything) {
    return confirmLargeAllocation(keepAll).then((ok) => (ok ? [...union] : null));
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
    title.textContent = `Which ${noun.one} metrics should be kept?`;
    modal.appendChild(title);

    const subtitle = document.createElement('p');
    subtitle.className = 'modal-subtitle';
    subtitle.textContent =
      `${entityCount.toLocaleString()} ${entityCount === 1 ? noun.one : noun.many} were read from ` +
      `${fileCount} file${fileCount === 1 ? '' : 's'}. Every metric kept costs one full plane ` +
      `per ${noun.one} per year, so the figure below is exactly what loading is about to allocate.`;
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
    const keepAllButton = document.createElement('button');
    keepAllButton.type = 'button';
    keepAllButton.className = 'btn';
    keepAllButton.textContent = 'Keep everything';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'btn btn-primary';
    confirm.textContent = 'Load with these';
    actions.append(cancel, keepAllButton, confirm);
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
      keepAllButton.title = `Load ${keepAll.what}: ${keepAll.cost.arithmetic}`;
      readout.textContent =
        costOf(chosen.size).arithmetic + (fileCount === 1 ? '' : ` across ${fileCount} files`);
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
    keepAllButton.addEventListener('click', () => {
      // See src/ui/wide-entity-picker.ts for why the picker's own Escape
      // handler comes off while the confirmation is up.
      document.removeEventListener('keydown', onKey);
      void confirmLargeAllocation(keepAll).then((ok) => {
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
