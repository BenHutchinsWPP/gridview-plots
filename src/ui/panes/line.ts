// src/ui/panes/line.ts
//
// The three uPlot chart types: time, duration and stacked, one adapter each.
// Each adapter creates its uPlot instance ONCE and updates it with
// `setData()`; a signature string tells a rebuild from a data change.
// Recreating the plot per change or resize gives up the performance uPlot was
// chosen for. Leaving the type destroys it, since the three share the pane's
// uPlot surface.
//
// The time type also holds its pane's year overview and "follow dates": both
// are drawn from, and die with, the time plot.

import { scaleOf, scalesOf } from '../../series/scales';
import uPlot from 'uplot';
import { HOURS_PER_YEAR } from '../../model/calendar';
import { checkStackOverlap, stackOrder } from '../../series/model';
import { withAlpha } from '../palette';
import { hourLabel, timeAxisValues, timeSplits } from '../chart-format';
import { addStackedTooltip, addTooltip } from '../chart-tooltip';
import { addAxisReadout } from '../chart-axis';
import { HOUR_COLUMNS, csvField, formatCell, hourFields } from '../hourly-csv';
import { saveBlob } from '../download';
import { createYearOverview } from '../year-overview';
import type { CaseSeries, ChartsInput, DrawnLimit } from '../charts';
import { rangeHours, rangeOfHours, setLabel, type DateSet } from '../../model/date-range';
import {
  figureShot,
  pinnedOf,
  type PaneAdapter,
  type PaneControl,
  type PaneFrame,
  type PaneHost,
} from './adapter';

/** Points on the duration curve's x axis (% of interval, so cases with
 * different kept-hour counts overlay); >2 per pixel at any pane width. */
const DURATION_POINTS = 1000;

/** The preview's dash: deliberate at pane width, short enough to show shape. */
const PREVIEW_DASH = [5, 4];

/** An interface limit's dash. MUST stay visibly different from
 * `PREVIEW_DASH`: dashed means "only hovering", and a limit is drawn in its
 * line's own colour, so a shared pattern would read as a preview. */
const LIMIT_DASH = [2, 3];

/** Stacked band fill opacity: gridlines show through, thin bands still read
 * as bands. */
const STACK_FILL_ALPHA = 0.3;

const HOUR_AXIS = Array.from({ length: HOURS_PER_YEAR }, (_, i) => i);
const PERCENT_AXIS = Array.from(
  { length: DURATION_POINTS },
  (_, i) => (i / (DURATION_POINTS - 1)) * 100,
);

/**
 * Whether to draw point markers. A filter keeping one hour a day leaves every
 * value isolated between nulls, with nothing to stroke, so the pane would
 * render empty. That depends on the gaps, not the point count.
 */
function showPoints(self: uPlot, seriesIndex: number, from: number, to: number): boolean {
  const values = self.data[seriesIndex];
  let kept = 0;
  let segments = 0;
  for (let i = from; i <= to; i++) {
    if (values[i] == null) continue;
    kept++;
    if (i < to && values[i + 1] != null) segments++;
  }
  if (kept === 0) return false;
  // Nothing would be stroked: markers are all that can show.
  if (segments === 0) return true;
  // Otherwise only when legible, about one per 4 px.
  return kept <= self.bbox.width / (devicePixelRatio || 1) / 4;
}

/**
 * A dot on each series' highest and lowest point in the VISIBLE window,
 * recomputed on every draw so a zoom re-marks what is on screen. A NULL in
 * `colors` means no markers (limit lines: their extremes are not readings).
 */
function markExtremes(options: uPlot.Options, colors: (string | null)[]): void {
  options.hooks = {
    ...options.hooks,
    draw: [
      (self) => {
        const { min, max } = self.scales.x;
        if (min == null || max == null) return;
        // The x values are hour indices, so the visible range needs no search.
        const lo = Math.max(0, Math.ceil(min));
        const hi = Math.min(self.data[0].length - 1, Math.floor(max));
        if (hi < lo) return;

        const ratio = devicePixelRatio || 1;
        const ctx = self.ctx;
        ctx.save();
        ctx.beginPath();
        ctx.rect(self.bbox.left, self.bbox.top, self.bbox.width, self.bbox.height);
        ctx.clip();

        for (let s = 1; s < self.series.length; s++) {
          if (self.series[s].show === false) continue;
          if (colors[s - 1] === null) continue;
          const values = self.data[s];
          let lowest = -1;
          let highest = -1;
          for (let i = lo; i <= hi; i++) {
            const value = values[i];
            if (value == null) continue;
            if (lowest < 0 || value < (values[lowest] as number)) lowest = i;
            if (highest < 0 || value > (values[highest] as number)) highest = i;
          }
          if (lowest < 0) continue;

          const scale = self.series[s].scale ?? 'y';
          ctx.fillStyle = colors[s - 1] ?? '#666';
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5 * ratio;
          for (const index of lowest === highest ? [lowest] : [lowest, highest]) {
            const x = self.valToPos(self.data[0][index] as number, 'x', true);
            const y = self.valToPos(values[index] as number, scale, true);
            ctx.beginPath();
            ctx.arc(x, y, 3.5 * ratio, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
        }
        ctx.restore();
      },
    ],
  };
}

/** One uPlot type's hold on the pane's uPlot surface. */
interface Held {
  plot: uPlot | null;
  signature: string;
  /** The kept hours' extent, which a zoom reset returns to. */
  extent: [number, number] | null;
}

function held(): Held {
  return { plot: null, signature: '', extent: null };
}

function release(state: Held): void {
  state.plot?.destroy();
  state.plot = null;
  state.signature = '';
}

/** A refusal in place of the chart. */
function refuse(host: PaneHost, state: Held, text: string): void {
  host.uplotHost.style.display = 'none';
  release(state);
  host.banner('refusal', text);
}

function baseOptions(
  host: PaneHost,
  xLabel: string,
  units: { scale: string; label: string }[],
  xValues: (self: uPlot, splits: number[]) => string[],
  xSplits?: (self: uPlot, axis: number, min: number, max: number) => number[],
): uPlot.Options {
  const { width, height } = host.size();
  return {
    width,
    height,
    padding: [8, 12, 0, 0],
    legend: { show: false }, // the Legend PANE carries the colour mapping
    cursor: { drag: { x: true, y: false } },
    scales: { x: { time: false } },
    axes: [
      { label: xLabel, values: xValues, splits: xSplits, grid: { stroke: '#e8e8e8' }, size: 34 },
      ...units.map(({ scale, label }, index) => ({
        scale,
        label,
        side: (index === 0 ? 3 : 1) as 1 | 3,
        grid: { stroke: index === 0 ? '#e8e8e8' : 'transparent' },
        labelSize: 18,
        size: 58,
      })),
    ],
    series: [{}],
  };
}

function unitsOf(series: CaseSeries[]): string[] {
  return Array.from(new Set(series.map((s) => s.unit)));
}

/** The drawn set, series by series with units, so a mixed-unit refusal says
 * WHICH series brought the second unit. */
function unitBreakdown(series: CaseSeries[]): string {
  return series.map((entry) => `${entry.name} (${entry.unit})`).join(', ');
}

function resetZoom(plot: uPlot | null, extent: [number, number] | null): void {
  if (!plot) return;
  const x = plot.data[0];
  if (x.length === 0) return;
  const [min, max] = extent ?? [x[0], x[x.length - 1]];
  plot.setScale('x', { min, max });
}

function xWindow(plot: uPlot | null): [number, number] | null {
  const scale = plot?.scales.x;
  return scale?.min != null && scale.max != null ? [scale.min, scale.max] : null;
}

/** The hours a time or stacked pane shows, as CSV. */
function downloadHours(plot: uPlot | null, series: readonly CaseSeries[]): void {
  if (!plot) return;
  const drawn = series.filter((s) => s.values !== null);
  const { min, max } = plot.scales.x;
  if (min == null || max == null || drawn.length === 0) return;

  const rows = [[...HOUR_COLUMNS, ...drawn.map((s) => csvField(s.name))].join(',')];
  for (let hour = Math.max(0, Math.ceil(min)); hour <= Math.min(HOURS_PER_YEAR - 1, max); hour++) {
    const values = drawn.map((s) => (s.values as Float32Array)[hour]);
    if (values.every((value) => Number.isNaN(value))) continue;
    rows.push(`${hourFields(hour)},${values.map(formatCell).join(',')}`);
  }

  saveBlob(new Blob([rows.join('\n') + '\n'], { type: 'text/csv' }), 'time-series.csv');
}

export function createTimeAdapter(host: PaneHost): PaneAdapter {
  const state = held();
  const { limits: limitsCheck, follow, overview: overviewCheck, overviewHost } = host.controls;
  let frame: PaneFrame | null = null;
  /** The dates shaded over the whole year when the zoom does not follow
   * them; read on every draw. */
  let bands: DateSet | null = null;
  /** The lines and limits drawn when they are not the frame's: the Figure
   * and Download take what the pane shows. */
  let drawnLines: CaseSeries[] | null = null;
  let drawnLimits: DrawnLimit[] | null = null;
  /** The overview's lines, as last drawn, for the resize path. */
  let overviewLines: readonly CaseSeries[] | null = null;
  const overview = createYearOverview(overviewHost, host.datesChange);

  // A full re-render: limit lines are uPlot series, so hiding them rebuilds
  // the plot.
  for (const check of [limitsCheck, follow, overviewCheck]) {
    check.addEventListener('change', () => host.rerender());
  }

  function onZoom(min: number, max: number): void {
    if (!follow.checked) return;
    // After uPlot applies its own zoom, so the render that follows sets the
    // pane to whole days last.
    // The days the zoom touched, as one run in place of the whole set.
    queueMicrotask(() => host.datesChange([rangeOfHours(min, max)]));
  }

  function paint(input: ChartsInput, drawable: CaseSeries[], zeroText: string | null): void {
    const tooManyUnits = scalesOf(drawable).length > 2;
    if (tooManyUnits || input.refusal) {
      refuse(
        host,
        state,
        input.refusal ??
          `${unitsOf(drawable).length} different units selected: ${unitBreakdown(drawable)}. ` +
            'Two is the most a chart can carry — one axis on each side.',
      );
      return;
    }

    host.uplotHost.style.display = '';
    let first = HOURS_PER_YEAR;
    let last = -1;
    const data: uPlot.AlignedData = [
      HOUR_AXIS,
      ...drawable.map((s) => {
        const column: (number | null)[] = new Array(HOURS_PER_YEAR);
        const values = s.values as Float32Array;
        for (let hour = 0; hour < HOURS_PER_YEAR; hour++) {
          const value = values[hour];
          if (Number.isNaN(value)) {
            column[hour] = null;
            continue;
          }
          column[hour] = value;
          if (hour < first) first = hour;
          if (hour > last) last = hour;
        }
        return column;
      }),
    ];
    state.extent = last < first ? null : [first - 0.5, last + 0.5];

    // Limits for what is drawn, gated on the checkbox. Appended AFTER the
    // series so `colors[i - 1]` still lines up with `drawable`.
    const limits = limitsCheck.checked ? (input.limits ?? []) : [];
    for (const limit of limits) {
      const column: (number | null)[] = new Array(HOURS_PER_YEAR);
      for (let hour = 0; hour < HOURS_PER_YEAR; hour++) {
        const value = limit.values[hour];
        column[hour] = Number.isNaN(value) ? null : value;
      }
      data.push(column);
    }

    const scales = scalesOf([...drawable, ...limits]);
    // Limits are IN the signature, so flipping the checkbox or the pins
    // rebuilds the plot.
    const wanted =
      `time|${drawable.map((s) => `${s.name}|${s.color}|${s.unit}|${s.dashed ? 'd' : ''}`).join(',')}` +
      `|limits:${limits.map((l) => `${l.name}|${l.color}|${l.unit}`).join(',')}`;
    let plot = state.plot;
    if (
      !plot ||
      plot.series.length - 1 !== drawable.length + limits.length ||
      state.signature !== wanted
    ) {
      state.signature = wanted;
      plot?.destroy();
      const options = baseOptions(host, '', scales, timeAxisValues, timeSplits);
      options.series = [
        { label: 'hour' },
        ...drawable.map((s) => ({
          label: s.name,
          stroke: s.color,
          scale: scaleOf(s.unit),
          width: 1,
          dash: s.dashed ? PREVIEW_DASH : undefined,
          points: { show: showPoints, size: 3 },
        })),
        ...limits.map((limit) => ({
          label: limit.name,
          // Exactly the interface's colour, so its owner is obvious.
          stroke: limit.color,
          scale: scaleOf(limit.unit),
          width: 1,
          dash: LIMIT_DASH,
          // Never points: a marker per hour would outweigh the measurement.
          points: { show: false },
        })),
      ];
      addTooltip(
        options,
        hourLabel,
        [...drawable, ...limits].map((s) => s.color),
      );
      addAxisReadout(
        options,
        scales.map((s) => s.scale),
      );
      markExtremes(options, [...drawable.map((s) => s.color), ...limits.map(() => null)]);
      options.hooks = {
        ...options.hooks,
        // Under the lines, so the band tints the chart and hides nothing.
        drawAxes: [
          ...(options.hooks?.drawAxes ?? []),
          (self) => {
            if (!bands) return;
            const { top, height } = self.bbox;
            const ctx = self.ctx;
            ctx.save();
            ctx.fillStyle = 'rgba(0, 102, 204, 0.08)';
            ctx.strokeStyle = 'rgba(0, 102, 204, 0.45)';
            ctx.lineWidth = devicePixelRatio || 1;
            // One band per run of the dates.
            for (const band of bands) {
              const [from, to] = rangeHours(band);
              const x0 = self.valToPos(from - 0.5, 'x', true);
              const x1 = self.valToPos(to - 0.5, 'x', true);
              ctx.fillRect(x0, top, Math.max(1, x1 - x0), height);
              ctx.strokeRect(x0, top, Math.max(1, x1 - x0), height);
            }
            ctx.restore();
          },
        ],
        setSelect: [
          ...(options.hooks?.setSelect ?? []),
          (self) => {
            const { left, width } = self.select;
            if (width < 1) return;
            onZoom(self.posToVal(left, 'x'), self.posToVal(left + width, 'x'));
          },
        ],
      };
      plot = new uPlot(options, data, host.uplotHost);
      state.plot = plot;
    } else {
      plot.setData(data);
    }
    if (state.extent) {
      plot.setScale('x', { min: state.extent[0], max: state.extent[1] });
    }
    if (zeroText) host.banner('note', zeroText);
  }

  /** The year overview, shown when ticked on a drawn chart. */
  function showOverview(shownFrame: PaneFrame): void {
    const shown = overviewCheck.checked && state.plot !== null && !!shownFrame.input.overview;
    overviewHost.hidden = !shown;
    overviewLines = shown
      ? shownFrame.wholeYear().filter((s) => s.values !== null && !s.dashed)
      : null;
    drawOverview();
  }

  function drawOverview(): void {
    const plot = state.plot;
    if (!plot || !overviewLines || !frame) return;
    const ratio = devicePixelRatio || 1;
    overview.draw(
      overviewLines.map((s) => ({
        color: s.color,
        unit: s.unit,
        values: s.values as Float32Array,
      })),
      frame.input.dates,
      { left: plot.bbox.left / ratio, width: plot.bbox.width / ratio },
    );
  }

  return {
    surface: 'uplot',
    controls(shownFrame) {
      // Limits stay hidden until a limits file is loaded.
      const shown: PaneControl[] = ['zoom', 'download', 'dates'];
      return (shownFrame.input.limits?.length ?? 0) > 0 ? [...shown, 'limits'] : shown;
    },
    draw(next) {
      frame = next;
      bands = null;
      drawnLines = null;
      drawnLimits = null;
      const { input } = next;
      // Unfollowed, the pane draws the whole year and the dates as a band,
      // from the lines resolved with the dates cleared: the drawn set is
      // masked outside the dates and would leave the year empty.
      if (!follow.checked && input.dates && input.overview && !input.refusal) {
        bands = input.dates;
        drawnLines = [...next.wholeYear()];
        drawnLimits = input.overviewLimits?.() ?? [];
        paint(
          { ...input, limits: drawnLimits },
          next.wholeYear().filter((s) => s.values !== null),
          next.zeroText,
        );
        host.note(`whole year · dates ${setLabel(input.dates, 3)}`);
      } else {
        paint(input, next.drawable, next.zeroText);
      }
      showOverview(next);
    },
    leave() {
      release(state);
      frame = null;
      bands = null;
      drawnLines = null;
      drawnLimits = null;
      overviewLines = null;
      overviewHost.hidden = true;
    },
    resize() {
      if (!state.plot) return;
      state.plot.setSize(host.size());
      drawOverview();
    },
    resetZoom() {
      resetZoom(state.plot, state.extent);
    },
    download() {
      if (frame) downloadHours(state.plot, drawnLines ?? frame.input.series);
    },
    timeWindow() {
      return xWindow(state.plot);
    },
    figure: {
      offered: () => true,
      capture() {
        const window = xWindow(state.plot);
        if (!frame || !window) return null;
        return figureShot(host, frame.input, {
          pane: 'time',
          ordered: pinnedOf(drawnLines ?? frame.input.series),
          xWindow: window,
          limits: drawnLimits,
          wholeYear: drawnLines !== null,
        });
      },
    },
  };
}

export function createDurationAdapter(host: PaneHost): PaneAdapter {
  const state = held();
  let frame: PaneFrame | null = null;

  function paint({ input, drawable, zeroText }: PaneFrame): void {
    const tooManyUnits = scalesOf(drawable).length > 2;
    if (tooManyUnits || input.refusal) {
      refuse(
        host,
        state,
        input.refusal ??
          `${unitsOf(drawable).length} different units selected (${unitsOf(drawable).join(', ')}). ` +
            'Two is the most a chart can carry — one axis on each side.',
      );
      return;
    }

    host.uplotHost.style.display = '';
    const data: uPlot.AlignedData = [
      PERCENT_AXIS,
      ...drawable.map((s) => {
        const column: (number | null)[] = new Array(DURATION_POINTS);
        for (let idx = 0; idx < DURATION_POINTS; idx++) {
          if (s.n === 0) {
            column[idx] = null;
            continue;
          }
          const at = Math.round((idx / (DURATION_POINTS - 1)) * (s.n - 1));
          column[idx] = s.sorted[at];
        }
        return column;
      }),
    ];

    const wanted = `duration|${drawable.map((s) => `${s.name}|${s.color}|${s.unit}|${s.dashed ? 'd' : ''}`).join(',')}`;
    let plot = state.plot;
    if (!plot || plot.series.length - 1 !== drawable.length || state.signature !== wanted) {
      state.signature = wanted;
      plot?.destroy();
      const options = baseOptions(host, '% of interval', scalesOf(drawable), (_self, splits) =>
        splits.map((value) => `${Math.round(value)}%`),
      );
      options.series = [
        { label: '%' },
        ...drawable.map((s) => ({
          label: s.name,
          stroke: s.color,
          scale: scaleOf(s.unit),
          width: 1.5,
          dash: s.dashed ? PREVIEW_DASH : undefined,
          points: { show: false },
        })),
      ];
      addTooltip(
        options,
        (value) => `${value.toFixed(1)}% of interval`,
        drawable.map((s) => s.color),
      );
      addAxisReadout(
        options,
        scalesOf(drawable).map((s) => s.scale),
      );
      plot = new uPlot(options, data, host.uplotHost);
      state.plot = plot;
    } else {
      plot.setData(data);
    }
    if (zeroText) host.banner('note', zeroText);
  }

  return {
    surface: 'uplot',
    controls: () => ['zoom'],
    draw(next) {
      frame = next;
      paint(next);
    },
    leave() {
      release(state);
      frame = null;
    },
    resize() {
      state.plot?.setSize(host.size());
    },
    resetZoom() {
      resetZoom(state.plot, null);
    },
    figure: {
      offered: () => true,
      capture() {
        const window = xWindow(state.plot);
        if (!frame || !window) return null;
        return figureShot(host, frame.input, {
          pane: 'duration',
          ordered: pinnedOf(frame.input.series),
          xWindow: window,
        });
      },
    },
  };
}

export function createStackedAdapter(host: PaneHost): PaneAdapter {
  const state = held();
  let frame: PaneFrame | null = null;

  function paint({ input, drawable, zeroText }: PaneFrame): void {
    const distinctUnits = unitsOf(drawable);
    if (input.refusal) {
      refuse(host, state, input.refusal);
      return;
    }
    if (distinctUnits.length > 1) {
      refuse(
        host,
        state,
        `Cannot stack series with different units (${distinctUnits.join(', ')}): ` +
          `${unitBreakdown(drawable)}. A stacked chart requires all series to share the ` +
          `same unit.`,
      );
      return;
    }

    // A stack needs every series to ADD. A signed series (a flow reversing)
    // makes the running sum fall, and the filled band would state something
    // false about the area. Refused by name, like the unit and double-count
    // refusals.
    const signed = drawable.find((entry) => (entry.values as Float32Array).some((v) => v < 0));
    if (signed) {
      refuse(
        host,
        state,
        `${signed.name} goes negative, so a stack would not add up: each band is drawn ` +
          `between running totals, and a falling total inverts the band. Plot these as ` +
          `lines instead.`,
      );
      return;
    }

    const overlapRefusal = checkStackOverlap(drawable);
    if (overlapRefusal) {
      refuse(host, state, overlapRefusal);
      return;
    }

    host.uplotHost.style.display = '';

    // BOTTOM-UP BY TOTAL (`stackOrder`): from here `stack` is the order. The
    // refusals above run on the SELECTION, where the reader ticked the series.
    const stack = stackOrder(drawable);
    let first = HOURS_PER_YEAR;
    let last = -1;
    const data: uPlot.AlignedData = [
      HOUR_AXIS,
      ...stack.map((_s, seriesIdx) => {
        const column: (number | null)[] = new Array(HOURS_PER_YEAR);
        for (let hour = 0; hour < HOURS_PER_YEAR; hour++) {
          const allFiltered = stack.every((entry) =>
            Number.isNaN((entry.values as Float32Array)[hour]),
          );
          if (allFiltered) {
            column[hour] = null;
            continue;
          }
          let sum = 0;
          for (let j = 0; j <= seriesIdx; j++) {
            const v = (stack[j].values as Float32Array)[hour];
            if (!Number.isNaN(v)) sum += v;
          }
          column[hour] = sum;
          if (hour < first) first = hour;
          if (hour > last) last = hour;
        }
        return column;
      }),
    ];
    state.extent = last < first ? null : [first - 0.5, last + 0.5];

    const unit = stack[0].unit;
    const scales = [{ scale: scaleOf(unit), label: unit }];
    // From the STACK order, so a change in which series is largest rebuilds
    // the plot.
    const wanted = `stacked|${stack.map((s) => `${s.name}|${s.color}|${s.unit}|${s.dashed ? 'd' : ''}`).join(',')}`;
    let plot = state.plot;
    if (!plot || plot.series.length - 1 !== stack.length || state.signature !== wanted) {
      state.signature = wanted;
      plot?.destroy();
      const options = baseOptions(host, '', scales, timeAxisValues, timeSplits);
      options.series = [
        { label: 'hour' },
        ...stack.map((s) => ({
          label: s.name,
          stroke: s.color,
          fill: withAlpha(s.color, STACK_FILL_ALPHA),
          scale: scaleOf(s.unit),
          width: 1.5,
          dash: s.dashed ? PREVIEW_DASH : undefined,
          points: { show: showPoints, size: 3 },
        })),
      ];
      // Each column is a running sum, so without bands every fill would reach
      // the axis and the largest would bury the rest. A band clips each fill
      // to the gap below its curve; the stroke stays full strength.
      options.bands = stack
        .slice(1)
        .map((_s, idx) => ({ series: [idx + 2, idx + 1] as [number, number] }));
      addStackedTooltip(
        options,
        hourLabel,
        stack.map((s) => s.color),
        stack.map((s) => s.values),
      );
      addAxisReadout(options, [scaleOf(unit)]);
      markExtremes(
        options,
        stack.map((s) => s.color),
      );
      plot = new uPlot(options, data, host.uplotHost);
      state.plot = plot;
    } else {
      plot.setData(data);
    }
    if (state.extent) {
      plot.setScale('x', { min: state.extent[0], max: state.extent[1] });
    }
    if (zeroText) host.banner('note', zeroText);
  }

  return {
    surface: 'uplot',
    controls: () => ['zoom', 'download'],
    draw(next) {
      frame = next;
      paint(next);
    },
    leave() {
      release(state);
      frame = null;
    },
    resize() {
      state.plot?.setSize(host.size());
    },
    resetZoom() {
      resetZoom(state.plot, state.extent);
    },
    download() {
      if (frame) downloadHours(state.plot, frame.input.series);
    },
    timeWindow() {
      return xWindow(state.plot);
    },
    figure: {
      offered: () => true,
      capture() {
        const window = xWindow(state.plot);
        if (!frame || !window) return null;
        // Bottom band first, in the order the pane stacked them.
        const pinned = pinnedOf(frame.input.series);
        return figureShot(host, frame.input, {
          pane: 'stacked',
          ordered: [
            ...stackOrder(pinned.filter((s) => s.values !== null)),
            ...pinned.filter((s) => s.values === null),
          ],
          xWindow: window,
        });
      },
    },
  };
}
