// src/ui/line-panes.ts
//
// The three uPlot panes: time, duration and stacked. No state of its own:
// every slot-indexed array is owned by `createCharts` and shared by reference
// through `deps`. A uPlot instance is created ONCE per slot and updated with
// `setData()`; signature strings tell a rebuild from a data change.

import uPlot from 'uplot';
import { HOURS_PER_YEAR } from '../model/calendar';
import { checkStackOverlap, stackOrder } from '../series/model';
import { withAlpha } from './palette';
import { hourLabel, timeAxisValues, timeSplits } from './chart-format';
import { addStackedTooltip, addTooltip } from './chart-tooltip';
import { addAxisReadout } from './chart-axis';
import type { CaseSeries, ChartsInput } from './charts';

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

/** What the panes reach back into `createCharts` for, shared BY REFERENCE so
 * a zoom reset and a rebuild see the same instance. */
export interface LinePaneDeps {
  paneBodies: HTMLElement[];
  slotUplotHosts: HTMLElement[];
  slotCanvasHosts: HTMLElement[];
  slotLegendHosts: HTMLElement[];
  slotPlots: (uPlot | null)[];
  slotSignatures: string[];
  slotTimeExtents: ([number, number] | null)[];
  /** The session-wide limits switch, read on every draw. */
  limitsCheck: HTMLInputElement;
  paneSize(body: HTMLElement): { width: number; height: number };
  scaleOf(unit: string): string;
  scalesOf(series: { unit: string }[]): { scale: string; label: string }[];
  banner(body: HTMLElement, kind: 'refusal' | 'note', text: string): void;
}

/** What one rebuild of one slot draws. */
export interface LinePaneContext {
  input: ChartsInput;
  drawable: CaseSeries[];
  zeroText: string | null;
}

export interface LinePanes {
  time(slot: number, ctx: LinePaneContext): void;
  duration(slot: number, ctx: LinePaneContext): void;
  stacked(slot: number, ctx: LinePaneContext): void;
}

export function createLinePanes(deps: LinePaneDeps): LinePanes {
  const {
    paneBodies,
    slotUplotHosts,
    slotCanvasHosts,
    slotLegendHosts,
    slotPlots,
    slotSignatures,
    slotTimeExtents,
    limitsCheck,
    paneSize,
    scaleOf,
    scalesOf,
    banner,
  } = deps;

  function baseOptions(
    body: HTMLElement,
    xLabel: string,
    units: { scale: string; label: string }[],
    xValues: (self: uPlot, splits: number[]) => string[],
    xSplits?: (self: uPlot, axis: number, min: number, max: number) => number[],
  ): uPlot.Options {
    const { width, height } = paneSize(body);
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

  function time(slot: number, ctx: LinePaneContext): void {
    const { input, drawable, zeroText } = ctx;
    const body = paneBodies[slot];
    const uplotHost = slotUplotHosts[slot];
    const canvasHost = slotCanvasHosts[slot];
    const legendHost = slotLegendHosts[slot];
    canvasHost.style.display = 'none';
    legendHost.style.display = 'none';
    const tooManyUnits = scalesOf(drawable).length > 2;
    if (tooManyUnits || input.refusal) {
      uplotHost.style.display = 'none';
      slotPlots[slot]?.destroy();
      slotPlots[slot] = null;
      slotSignatures[slot] = '';
      const msg =
        input.refusal ??
        `${unitsOf(drawable).length} different units selected: ${unitBreakdown(drawable)}. ` +
          'Two is the most a chart can carry — one axis on each side.';
      banner(body, 'refusal', msg);
      return;
    }

    uplotHost.style.display = '';
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
    slotTimeExtents[slot] = last < first ? null : [first - 0.5, last + 0.5];

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
    let plot = slotPlots[slot];
    if (
      !plot ||
      plot.series.length - 1 !== drawable.length + limits.length ||
      slotSignatures[slot] !== wanted
    ) {
      slotSignatures[slot] = wanted;
      plot?.destroy();
      const options = baseOptions(body, '', scales, timeAxisValues, timeSplits);
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
      plot = new uPlot(options, data, uplotHost);
      slotPlots[slot] = plot;
    } else {
      plot.setData(data);
    }
    if (slotTimeExtents[slot]) {
      plot.setScale('x', { min: slotTimeExtents[slot]![0], max: slotTimeExtents[slot]![1] });
    }
    if (zeroText) banner(body, 'note', zeroText);
  }

  function duration(slot: number, ctx: LinePaneContext): void {
    const { input, drawable, zeroText } = ctx;
    const body = paneBodies[slot];
    const uplotHost = slotUplotHosts[slot];
    const canvasHost = slotCanvasHosts[slot];
    const legendHost = slotLegendHosts[slot];
    canvasHost.style.display = 'none';
    legendHost.style.display = 'none';
    const tooManyUnits = scalesOf(drawable).length > 2;
    if (tooManyUnits || input.refusal) {
      uplotHost.style.display = 'none';
      slotPlots[slot]?.destroy();
      slotPlots[slot] = null;
      slotSignatures[slot] = '';
      const msg =
        input.refusal ??
        `${unitsOf(drawable).length} different units selected (${unitsOf(drawable).join(', ')}). ` +
          'Two is the most a chart can carry — one axis on each side.';
      banner(body, 'refusal', msg);
      return;
    }

    uplotHost.style.display = '';
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
    let plot = slotPlots[slot];
    if (!plot || plot.series.length - 1 !== drawable.length || slotSignatures[slot] !== wanted) {
      slotSignatures[slot] = wanted;
      plot?.destroy();
      const options = baseOptions(body, '% of interval', scalesOf(drawable), (_self, splits) =>
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
      plot = new uPlot(options, data, uplotHost);
      slotPlots[slot] = plot;
    } else {
      plot.setData(data);
    }
    if (zeroText) banner(body, 'note', zeroText);
  }

  function stacked(slot: number, ctx: LinePaneContext): void {
    const { input, drawable, zeroText } = ctx;
    const body = paneBodies[slot];
    const uplotHost = slotUplotHosts[slot];
    const canvasHost = slotCanvasHosts[slot];
    const legendHost = slotLegendHosts[slot];
    canvasHost.style.display = 'none';
    legendHost.style.display = 'none';
    const distinctUnits = unitsOf(drawable);
    if (input.refusal) {
      uplotHost.style.display = 'none';
      slotPlots[slot]?.destroy();
      slotPlots[slot] = null;
      slotSignatures[slot] = '';
      banner(body, 'refusal', input.refusal);
      return;
    }
    if (distinctUnits.length > 1) {
      uplotHost.style.display = 'none';
      slotPlots[slot]?.destroy();
      slotPlots[slot] = null;
      slotSignatures[slot] = '';
      banner(
        body,
        'refusal',
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
      uplotHost.style.display = 'none';
      slotPlots[slot]?.destroy();
      slotPlots[slot] = null;
      slotSignatures[slot] = '';
      banner(
        body,
        'refusal',
        `${signed.name} goes negative, so a stack would not add up: each band is drawn ` +
          `between running totals, and a falling total inverts the band. Plot these as ` +
          `lines instead.`,
      );
      return;
    }

    const overlapRefusal = checkStackOverlap(drawable);
    if (overlapRefusal) {
      uplotHost.style.display = 'none';
      slotPlots[slot]?.destroy();
      slotPlots[slot] = null;
      slotSignatures[slot] = '';
      banner(body, 'refusal', overlapRefusal);
      return;
    }

    uplotHost.style.display = '';

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
    slotTimeExtents[slot] = last < first ? null : [first - 0.5, last + 0.5];

    const unit = stack[0].unit;
    const scales = [{ scale: scaleOf(unit), label: unit }];
    // From the STACK order, so a change in which series is largest rebuilds
    // the plot.
    const wanted = `stacked|${stack.map((s) => `${s.name}|${s.color}|${s.unit}|${s.dashed ? 'd' : ''}`).join(',')}`;
    let plot = slotPlots[slot];
    if (!plot || plot.series.length - 1 !== stack.length || slotSignatures[slot] !== wanted) {
      slotSignatures[slot] = wanted;
      plot?.destroy();
      const options = baseOptions(body, '', scales, timeAxisValues, timeSplits);
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
      plot = new uPlot(options, data, uplotHost);
      slotPlots[slot] = plot;
    } else {
      plot.setData(data);
    }
    if (slotTimeExtents[slot]) {
      plot.setScale('x', { min: slotTimeExtents[slot]![0], max: slotTimeExtents[slot]![1] });
    }
    if (zeroText) banner(body, 'note', zeroText);
  }

  return { time, duration, stacked };
}
