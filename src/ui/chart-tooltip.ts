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

/** Hover readout. uPlot's own legend is off (the Legend pane slot states the
 * colour mapping once, in full), so the cursor gets a values-only box: the x
 * position and one number per series, in the series' own colours. It pins to a top
 * corner of the plot rather than following the pointer, which keeps it out
 * of the way of the cursor points and off the pane edges. */
export function addTooltip(
  options: uPlot.Options,
  labelX: (value: number) => string,
  colors: string[],
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

        const rows: HTMLElement[] = [];
        for (let i = 1; i < self.series.length; i++) {
          const value = self.data[i][idx];
          if (value == null || !Number.isFinite(value)) continue;
          const row = document.createElement('div');
          row.className = 'chart-tip-row';
          const dot = document.createElement('span');
          dot.className = 'chart-tip-dot';
          // Colours come from the case colours handed in, not series[i].stroke
          // -- uPlot normalises stroke into a function, which stringifies to
          // garbage.
          dot.style.background = colors[i - 1] ?? '#666';
          row.appendChild(dot);
          const name = document.createElement('span');
          name.className = 'chart-tip-name';
          const label = self.series[i].label;
          name.textContent = typeof label === 'string' ? label : '';
          row.appendChild(name);
          const number = document.createElement('b');
          number.textContent = formatNumber(value);
          row.appendChild(number);
          rows.push(row);
        }
        if (rows.length === 0) {
          tip.style.display = 'none';
          return;
        }

        const head = document.createElement('div');
        head.className = 'chart-tip-x';
        head.textContent = labelX(self.data[0][idx] as number);
        tip.replaceChildren(head, ...rows);
        tip.style.display = '';
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
 */
export function addStackedTooltip(
  options: uPlot.Options,
  labelX: (value: number) => string,
  colors: string[],
  rawValues: (Float32Array | null)[],
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
        const rows: HTMLElement[] = [];
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
          const dot = document.createElement('span');
          dot.className = 'chart-tip-dot';
          dot.style.background = colors[i - 1] ?? '#666';
          row.appendChild(dot);
          const name = document.createElement('span');
          name.className = 'chart-tip-name';
          const label = self.series[i].label;
          name.textContent = typeof label === 'string' ? label : '';
          row.appendChild(name);
          const number = document.createElement('b');
          number.textContent = formatNumber(rawVal);
          row.appendChild(number);
          rows.push(row);
        }

        if (rows.length === 0) {
          tip.style.display = 'none';
          return;
        }

        if (validCount > 1) {
          const totalRow = document.createElement('div');
          totalRow.className = 'chart-tip-row';
          totalRow.style.borderTop = '1px solid var(--color-border, #ddd)';
          totalRow.style.marginTop = '4px';
          totalRow.style.paddingTop = '2px';
          const name = document.createElement('span');
          name.className = 'chart-tip-name';
          name.style.fontWeight = '600';
          name.textContent = 'Total';
          totalRow.appendChild(name);
          const number = document.createElement('b');
          number.textContent = formatNumber(total);
          totalRow.appendChild(number);
          rows.push(totalRow);
        }

        const head = document.createElement('div');
        head.className = 'chart-tip-x';
        head.textContent = labelX(hour);
        tip.replaceChildren(head, ...rows);
        tip.style.display = '';

        const right = left < self.over.clientWidth / 2;
        tip.style.left = right ? 'auto' : '6px';
        tip.style.right = right ? '6px' : 'auto';
      },
    ],
  };
}
