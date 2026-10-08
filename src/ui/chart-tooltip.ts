// src/ui/chart-tooltip.ts
//
// The two hover readouts a line pane can carry: the plain one, and the
// stacked one that also totals the hovered hour.
//
// Split from `charts.ts` because they are DOM construction wearing a uPlot
// hook -- every line of both builds elements and sets styles, and the only
// uPlot in them is `setCursor` and the cursor's index. Keeping them beside
// the pane wiring made the wiring read as though hover were part of it.
//
// They stay TWO functions rather than one with a flag. The stacked one reads
// its numbers from `rawValues` and not from `self.data`, because a stacked
// series' plotted value is the running total and the reading the analyst
// wants is the series' own; folding that into a parameter of the plain one
// would hide exactly the difference that matters.

import type uPlot from 'uplot';
import { formatNumber } from './chart-format';

/** A hover row's name split in two: `name`, which an ellipsis may cut, and
 * `tag` after it, which it never does. An overlay's year is a tag, so a long
 * name cannot hide which year a row is. */
export interface TipName {
  readonly name: string;
  readonly tag?: string;
}

/** A built hover row, with where its value sits on the plot. */
interface TipRow {
  readonly el: HTMLElement;
  readonly series: number;
  /** The value as plotted (a stacked series' running total). */
  readonly plotted: number;
}

/** A row's height and one column's width, in CSS pixels, where the page has
 * no layout to measure: 11px text at line-height 1.5, and a row whose name
 * fills its 140px. */
const ROW_PX = 17;
const COLUMN_PX = 240;
/** What of the plot area a tip's rows cannot use: its 6px inset from the
 * top and the same below, its padding and its border. */
const TIP_CHROME_PX = 24;
const TIP_INSET_PX = 6;

/** A row's dot and name cells, the name split per `TipName`. */
function nameCells(row: HTMLElement, color: string, label: TipName): void {
  const dot = document.createElement('span');
  dot.className = 'chart-tip-dot';
  dot.style.background = color;
  row.appendChild(dot);
  const name = document.createElement('span');
  name.className = 'chart-tip-name';
  name.textContent = label.name;
  row.appendChild(name);
  if (label.tag === undefined) return;
  const tag = document.createElement('span');
  tag.className = 'chart-tip-tag';
  tag.textContent = label.tag;
  row.appendChild(tag);
}

/** Series `i`'s hover name: `names`' when handed, else its uPlot label. */
function nameOf(self: uPlot, i: number, names: readonly TipName[] | undefined): TipName {
  const given = names?.[i - 1];
  if (given) return given;
  const label = self.series[i].label;
  return { name: typeof label === 'string' ? label : '' };
}

/**
 * Show `head`, `rows` and `after` in `tip`, every row inside the plot area.
 * Rows that outgrow its height flow into columns (CSS multi-column on the
 * tip, so the DOM is the same either way and a tip that fits looks as it
 * always did). Rows that outgrow the columns its width holds too keep those
 * nearest the cursor, in their own order, and a last line counts the rest:
 * the tip says what it left out rather than running off the pane.
 */
function showRows(
  self: uPlot,
  tip: HTMLElement,
  head: HTMLElement,
  rows: readonly TipRow[],
  after: readonly HTMLElement[] = [],
): void {
  tip.style.columnCount = '';
  tip.replaceChildren(head, ...rows.map((row) => row.el), ...after);
  tip.style.display = '';
  const height = self.over.clientHeight;
  // No layout (a detached or hidden plot): nothing to fit to.
  if (!height || rows.length === 0) return;
  const rowPx = rows[0].el.offsetHeight || ROW_PX;
  const headPx = head.offsetHeight || ROW_PX;
  const afterPx = after.reduce((sum, el) => sum + (el.offsetHeight || ROW_PX), 0);
  const perColumn = Math.max(1, Math.floor((height - TIP_CHROME_PX - headPx - afterPx) / rowPx));
  if (rows.length <= perColumn) return;
  const columnPx = tip.offsetWidth || COLUMN_PX;
  const fits = Math.max(1, Math.floor((self.over.clientWidth - 2 * TIP_INSET_PX) / columnPx));
  const columns = Math.ceil(rows.length / perColumn);
  if (columns <= fits) {
    tip.style.columnCount = String(columns);
    return;
  }
  // One place goes to the line counting what is left out.
  const room = perColumn * fits - 1;
  const top = self.cursor.top ?? 0;
  const nearest = new Set(
    rows
      .map((row) => ({
        row,
        off: Math.abs(self.valToPos(row.plotted, self.series[row.series].scale ?? 'y') - top),
      }))
      .sort((a, b) => a.off - b.off)
      .slice(0, room)
      .map(({ row }) => row),
  );
  const more = document.createElement('div');
  more.className = 'chart-tip-more';
  more.textContent = `+${rows.length - nearest.size} more, farther from the cursor`;
  tip.style.columnCount = fits > 1 ? String(fits) : '';
  tip.replaceChildren(
    head,
    ...rows.filter((row) => nearest.has(row)).map((row) => row.el),
    more,
    ...after,
  );
}

/** Hover readout. uPlot's own legend is off (the Legend pane slot states the
 * colour mapping once, in full), so the cursor gets a values-only box: the x
 * position and one number per series, in the series' own colours. It pins to a top
 * corner of the plot rather than following the pointer, which keeps it out
 * of the way of the cursor points and off the pane edges. An x that
 * `blank` names (a phantom hour) shows its label with no values. */
export function addTooltip(
  options: uPlot.Options,
  labelX: (value: number) => string,
  colors: string[],
  blank?: (value: number) => boolean,
  names?: readonly TipName[],
): void {
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.style.display = 'none';

  options.hooks = {
    ...options.hooks,
    setCursor: [
      (self) => {
        if (tip.parentElement !== self.over) self.over.appendChild(tip);
        const idx = self.cursor.idx;
        const left = self.cursor.left ?? -1;
        if (idx == null || left < 0) {
          tip.style.display = 'none';
          return;
        }

        const rows: TipRow[] = [];
        for (let i = 1; i < self.series.length; i++) {
          const value = self.data[i][idx];
          if (value == null || !Number.isFinite(value)) continue;
          const row = document.createElement('div');
          row.className = 'chart-tip-row';
          // Colours come from the case colours handed in, not series[i].stroke
          // -- uPlot normalises stroke into a function, which stringifies to
          // garbage.
          nameCells(row, colors[i - 1] ?? '#666', nameOf(self, i, names));
          const number = document.createElement('b');
          number.textContent = formatNumber(value);
          row.appendChild(number);
          rows.push({ el: row, series: i, plotted: value });
        }
        const x = self.data[0][idx] as number;
        if (rows.length === 0 && !blank?.(x)) {
          tip.style.display = 'none';
          return;
        }

        const head = document.createElement('div');
        head.className = 'chart-tip-x';
        head.textContent = labelX(x);
        showRows(self, tip, head, rows);
        // Sit on the side the cursor is not on, so the box never covers the
        // points it is describing.
        const right = left < self.over.clientWidth / 2;
        tip.style.left = right ? 'auto' : '6px';
        tip.style.right = right ? '6px' : 'auto';
      },
    ],
  };
}

/**
 * Hover readout for stacked line charts. Shows the individual series value
 * at the hovered hour, along with the cumulative total when multiple series are present.
 * `rawValues` are indexed by x; `blank` is as `addTooltip`'s.
 */
export function addStackedTooltip(
  options: uPlot.Options,
  labelX: (value: number) => string,
  colors: string[],
  rawValues: readonly (ArrayLike<number | null> | null)[],
  blank?: (value: number) => boolean,
): void {
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.style.display = 'none';

  options.hooks = {
    ...options.hooks,
    setCursor: [
      (self) => {
        if (tip.parentElement !== self.over) self.over.appendChild(tip);
        const idx = self.cursor.idx;
        const left = self.cursor.left ?? -1;
        if (idx == null || left < 0) {
          tip.style.display = 'none';
          return;
        }

        const hour = self.data[0][idx] as number;
        const rows: TipRow[] = [];
        let total = 0;
        let validCount = 0;

        for (let i = 1; i < self.series.length; i++) {
          const rawSeries = rawValues[i - 1];
          const rawVal = rawSeries ? rawSeries[hour] : null;
          if (rawVal == null || !Number.isFinite(rawVal)) continue;

          validCount++;
          total += rawVal;

          const row = document.createElement('div');
          row.className = 'chart-tip-row';
          nameCells(row, colors[i - 1] ?? '#666', nameOf(self, i, undefined));
          const number = document.createElement('b');
          number.textContent = formatNumber(rawVal);
          row.appendChild(number);
          rows.push({ el: row, series: i, plotted: self.data[i][idx] ?? rawVal });
        }

        if (rows.length === 0 && !blank?.(hour)) {
          tip.style.display = 'none';
          return;
        }

        const after: HTMLElement[] = [];
        if (validCount > 1) {
          const totalRow = document.createElement('div');
          totalRow.className = 'chart-tip-row';
          totalRow.style.borderTop = '1px solid var(--color-border, #ddd)';
          totalRow.style.marginTop = '4px';
          totalRow.style.paddingTop = '2px';
          totalRow.style.columnSpan = 'all';
          const name = document.createElement('span');
          name.className = 'chart-tip-name';
          name.style.fontWeight = '600';
          name.textContent = 'Total';
          totalRow.appendChild(name);
          const number = document.createElement('b');
          number.textContent = formatNumber(total);
          totalRow.appendChild(number);
          after.push(totalRow);
        }

        const head = document.createElement('div');
        head.className = 'chart-tip-x';
        head.textContent = labelX(hour);
        showRows(self, tip, head, rows, after);

        const right = left < self.over.clientWidth / 2;
        tip.style.left = right ? 'auto' : '6px';
        tip.style.right = right ? '6px' : 'auto';
      },
    ],
  };
}
