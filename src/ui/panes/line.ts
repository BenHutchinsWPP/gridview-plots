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
//
// Time and stacked draw a Case over every year it spans, on one axis per
// frame (`spanAxisOf`), so Cases of different years sit side by side by date.
// Time's "overlay years" instead lays every year of every line over one
// year slot (`yearLinesOf`), each year a shade of its line's colour.

import { scaleOf, scalesOf } from '../../series/scales';
import uPlot from 'uplot';
import { YEAR_SLOT_HOURS, realHours } from '../../model/calendar';
import { NO_YEAR } from '../../app/boxes';
import { checkStackOverlap, stackOrder } from '../../series/model';
import { shade, withAlpha } from '../palette';
import { axisHour, hourLabel, timeAxis } from '../chart-format';
import { addStackedTooltip, addTooltip, type TipName } from '../chart-tooltip';
import { addAxisReadout } from '../chart-axis';
import { wideHeaderLine, wideRow, yearColumnName } from '../hourly-csv';
import { saveBlob } from '../download';
import { createYearOverview } from '../year-overview';
import { yearsLabel } from '../status-sentence';
import type { CaseSeries, ChartsInput, DrawnLimit } from '../charts';
import { rangeHours, rangeOfHours, setLabel, type DateSet } from '../../model/date-range';
import {
  figureShot,
  hasYear,
  pinnedOf,
  yearsShown,
  type FigureShot,
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

const PERCENT_AXIS = Array.from(
  { length: DURATION_POINTS },
  (_, i) => (i / (DURATION_POINTS - 1)) * 100,
);

/**
 * A time or stacked pane's x axis for one frame, in slot positions from
 * `origin` (AGENTS.md, "the time axis is slot positions"): the earliest
 * first year of a drawn line's Case. A line with no year names no origin and
 * sits at x = 0; with none named the axis is the slot's and shows no year.
 */
interface SpanAxis {
  readonly origin: number | undefined;
  /** Whole year slots long, one slot at the least. */
  readonly length: number;
  /** Where values starting in `year` place their first hour. */
  offsetOf(year: number | undefined): number;
  /** The line's own offset, by its Case's span. */
  lineOffset(line: CaseSeries): number;
}

function spanAxisOf(
  input: ChartsInput,
  lines: readonly CaseSeries[],
  limits: readonly DrawnLimit[],
): SpanAxis {
  const yearOf = (line: CaseSeries) => input.spanOf?.(line).firstYear;
  let origin: number | undefined;
  for (const line of lines) {
    const year = yearOf(line);
    if (hasYear(year) && (origin === undefined || year < origin)) origin = year;
  }
  const offsetOf = (year: number | undefined) =>
    origin === undefined || !hasYear(year) ? 0 : (year - origin) * YEAR_SLOT_HOURS;
  const lineOffset = (line: CaseSeries) => offsetOf(yearOf(line));
  let end = YEAR_SLOT_HOURS;
  for (const line of lines) end = Math.max(end, lineOffset(line) + (line.values?.length ?? 0));
  for (const limit of limits) end = Math.max(end, offsetOf(limit.firstYear) + limit.values.length);
  const length = Math.ceil(end / YEAR_SLOT_HOURS) * YEAR_SLOT_HOURS;
  return { origin, length, offsetOf, lineOffset };
}

/** The one year slot an overlay draws on: no origin, so no year prints. */
const OVERLAY_AXIS: SpanAxis = {
  origin: undefined,
  length: YEAR_SLOT_HOURS,
  offsetOf: () => 0,
  lineOffset: () => 0,
};

/**
 * The most lines "overlay years" draws: thirty, three years of each of the
 * ten series the series cap allows, or ten years of three. Past it a
 * series' shades stop reading apart beside the other series'. The refusal
 * names the Years filter because it takes years off every series at once.
 */
const OVERLAY_LINE_CAP = 30;

/** One year of a line laid over the others. */
interface YearLine {
  readonly line: CaseSeries;
  /** Absent for a line with no Case year. */
  readonly year: number | undefined;
  /** The year's slot hours. */
  readonly values: Float32Array;
  /** `shade` of the line's colour, by the year's place among those drawn. */
  readonly color: string;
  /** The plot's name for it: the line's and the year. */
  readonly name: string;
  /** The hover's: the year a tag, which no ellipsis cuts. */
  readonly tip: TipName;
}

/**
 * Each line cut into its year slots, oldest first, for "overlay years". A
 * year holding no value (dropped by the Years filter, or emptied by the
 * dates) is not drawn, and the shades run over the years that are, so a
 * line's kept years span its whole ramp.
 */
function yearLinesOf(input: ChartsInput, lines: readonly CaseSeries[]): YearLine[] {
  return lines.flatMap((line) => {
    const all = line.values;
    if (!all) return [];
    const first = input.spanOf?.(line).firstYear;
    const held: { slot: number; values: Float32Array }[] = [];
    for (let slot = 0; slot * YEAR_SLOT_HOURS < all.length; slot++) {
      const values = all.subarray(slot * YEAR_SLOT_HOURS, (slot + 1) * YEAR_SLOT_HOURS);
      if (values.some((value) => !Number.isNaN(value))) held.push({ slot, values });
    }
    return held.map(({ slot, values }, i) => {
      const year = hasYear(first) ? first + slot : undefined;
      return {
        line,
        year,
        values,
        color: shade(line.color, i, held.length),
        name: year === undefined ? line.name : `${line.name} · ${year}`,
        tip: year === undefined ? { name: line.name } : { name: line.name, tag: `${year}` },
      };
    });
  });
}

/** The overlay's refusal when it draws more lines than the cap. */
function overlayCapMessage(lines: readonly YearLine[]): string | null {
  if (lines.length <= OVERLAY_LINE_CAP) return null;
  const series = new Set(lines.map((entry) => entry.line)).size;
  const years = new Set(lines.map((entry) => entry.year)).size;
  return (
    `Overlaying ${series} series over ${years} years draws ${lines.length} lines; the most a ` +
    `chart can tell apart is ${OVERLAY_LINE_CAP}. Keep fewer years with the Years filter, ` +
    'or fewer series.'
  );
}

/**
 * A limit's years folded onto one slot, for an overlay: a limit repeats its
 * monthly values in every year of its Case, so each slot hour takes the
 * first year that holds it and the limit is drawn once, in its line's
 * colour, rather than once per shade.
 */
function foldedYears(values: Float32Array): Float32Array {
  const out = new Float32Array(YEAR_SLOT_HOURS).fill(NaN);
  for (let x = 0; x < values.length; x++) {
    const hour = x % YEAR_SLOT_HOURS;
    if (Number.isNaN(out[hour])) out[hour] = values[x];
  }
  return out;
}

/** The x values of an axis this long, reused while the length holds. */
let xValues: number[] = [];
function xAxisOf(length: number): number[] {
  if (xValues.length !== length) xValues = Array.from({ length }, (_, i) => i);
  return xValues;
}

/** `values` placed at `offset` on an axis `length` long: null outside them
 * and where a value is NaN. */
function placed(values: Float32Array, offset: number, length: number): (number | null)[] {
  const column: (number | null)[] = new Array(length).fill(null);
  const end = Math.min(length, offset + values.length);
  for (let x = Math.max(0, offset); x < end; x++) {
    const value = values[x - offset];
    if (!Number.isNaN(value)) column[x] = value;
  }
  return column;
}

/** The kept hours' extent over some placed columns, half an hour wide each
 * side, or null when none is kept. */
function extentOf(columns: readonly (number | null)[][]): [number, number] | null {
  let first = Infinity;
  let last = -1;
  for (const column of columns) {
    for (let x = 0; x < column.length; x++) {
      if (column[x] === null) continue;
      if (x < first) first = x;
      if (x > last) last = x;
    }
  }
  return last < 0 ? null : [first - 0.5, last + 0.5];
}

/** The x label and phantom test an axis's hover reads. */
function hoverOf(axis: SpanAxis): {
  label: (x: number) => string;
  phantom: (x: number) => boolean;
} {
  const { origin } = axis;
  return {
    label: (x) => hourLabel(x, origin),
    phantom: (x) => origin !== undefined && axisHour(x, origin).phantom,
  };
}

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
  /** The window a zoom reset returns to: the kept hours' extent, or the
   * shown year's dates. */
  extent: [number, number] | null;
  /** The axis last drawn, for a time or stacked plot. */
  axis: SpanAxis | null;
}

function held(): Held {
  return { plot: null, signature: '', extent: null, axis: null };
}

function release(state: Held): void {
  state.plot?.destroy();
  state.plot = null;
  state.signature = '';
  state.axis = null;
}

/** An axis of more than one year slot. */
function spansYears(state: Held): boolean {
  return (state.axis?.length ?? YEAR_SLOT_HOURS) > YEAR_SLOT_HOURS;
}

/** Which years an unfollowed pane draws: the overview honours the Years
 * filter, so the note names it rather than claim every year. */
function yearsNote(years: ReadonlySet<number> | null | undefined, spans: boolean): string {
  if (years) return `years ${yearsLabel(years)}`;
  return spans ? 'every year' : 'whole year';
}

/** The days of `dates` in year slot `slot`, first run to last, as an x
 * window: whole hours, half an hour wide each side, as `extentOf`. */
function slotWindow(dates: DateSet, slot: number): [number, number] {
  const offset = slot * YEAR_SLOT_HOURS;
  const from = Math.min(...dates.map((run) => rangeHours(run)[0]));
  const to = Math.max(...dates.map((run) => rangeHours(run)[1]));
  return [offset + from - 0.5, offset + to - 0.5];
}

/** Whether any column holds a value on the days of `dates` in `slot`. */
function slotHasData(columns: readonly (number | null)[][], dates: DateSet, slot: number): boolean {
  const offset = slot * YEAR_SLOT_HOURS;
  return dates.some((run) => {
    const [from, to] = rangeHours(run);
    return columns.some((column) => {
      for (let x = offset + from; x < offset + to && x < column.length; x++) {
        if (column[x] !== null) return true;
      }
      return false;
    });
  });
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
  reset?: () => void,
): uPlot.Options {
  const { width, height } = host.size();
  // uPlot's double-click widens x to the whole data; a pane's extent can be
  // narrower (one year of a followed date filter), so it lands where the
  // reset button does.
  const dblclick: uPlot.Cursor.MouseListenerFactory = (_self, targ, handler) => (e) => {
    if (e.button !== 0 || e.target !== targ) return null;
    handler(e);
    reset?.();
    return null;
  };
  return {
    width,
    height,
    padding: [8, 12, 0, 0],
    legend: { show: false }, // the Legend PANE carries the colour mapping
    cursor: { drag: { x: true, y: false }, bind: { dblclick } },
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

/**
 * The hours a time or stacked pane shows, as CSV, in the drawer's wide
 * layout: rows are the slot hours the window covers, from its first date on,
 * and each line is a column per year the window touches, blank outside the
 * window. A window across New Year writes December's rows, then January's,
 * since a slot hour is a date in every year. Columns
 * name their year only when the window touches more than one, as the
 * drawer's do; an hour every column leaves blank is not written.
 */
function downloadHours(state: Held, series: readonly CaseSeries[]): void {
  const { axis } = state;
  const drawn = series.filter((s) => s.values !== null);
  const window = shownHours(state);
  if (!axis || !window || drawn.length === 0) return;
  const [lo, hi] = window;

  const firstSlot = Math.floor(lo / YEAR_SLOT_HOURS);
  const slots = Array.from(
    { length: Math.floor(hi / YEAR_SLOT_HOURS) - firstSlot + 1 },
    (_, i) => firstSlot + i,
  );
  const yearName = (slot: number) =>
    slots.length === 1
      ? ''
      : axis.origin === undefined
        ? `year ${slot + 1}`
        : `${axis.origin + slot}`;
  const names: string[] = [];
  const columns: Float32Array[] = [];
  for (const line of drawn) {
    const values = line.values as Float32Array;
    const offset = axis.lineOffset(line);
    for (const slot of slots) {
      const start = slot * YEAR_SLOT_HOURS;
      const column = new Float32Array(YEAR_SLOT_HOURS).fill(NaN);
      for (let x = Math.max(lo, start); x <= Math.min(hi, start + YEAR_SLOT_HOURS - 1); x++) {
        const value = values[x - offset];
        if (value !== undefined) column[x - start] = value;
      }
      names.push(yearColumnName(line.name, yearName(slot)));
      columns.push(column);
    }
  }
  saveHours(names, columns, lo % YEAR_SLOT_HOURS);
}

/** The axis hours a uPlot pane's x window covers, first and last, or null
 * when it covers none. */
function shownHours(state: Held): [number, number] | null {
  const { plot, axis } = state;
  const min = plot?.scales.x.min;
  const max = plot?.scales.x.max;
  if (!axis || min == null || max == null) return null;
  const lo = Math.max(0, Math.ceil(min));
  const hi = Math.min(axis.length - 1, Math.floor(max));
  return hi < lo ? null : [lo, hi];
}

/**
 * An overlay's hours as CSV, in the same wide layout: the slot hours the
 * window covers, a column per line and year it draws, each named by its
 * year, since the overlay always holds more than one.
 */
function downloadOverlay(state: Held, lines: readonly YearLine[]): void {
  const window = shownHours(state);
  if (!window || lines.length === 0) return;
  const [lo, hi] = window;
  const columns = lines.map(({ values }) => {
    const column = new Float32Array(YEAR_SLOT_HOURS).fill(NaN);
    column.set(values.subarray(lo, hi + 1), lo);
    return column;
  });
  saveHours(
    lines.map(({ line, year }) => yearColumnName(line.name, year === undefined ? '' : `${year}`)),
    columns,
  );
}

/** Slot-hour columns written as the drawer's wide file, from slot hour
 * `first` round to the one before it; an hour every column leaves blank is
 * not written. */
function saveHours(names: readonly string[], columns: readonly Float32Array[], first = 0): void {
  const ratio = columns.map(() => false);
  const rows = [wideHeaderLine(names)];
  for (let k = 0; k < YEAR_SLOT_HOURS; k++) {
    const hour = (first + k) % YEAR_SLOT_HOURS;
    if (columns.every((column) => Number.isNaN(column[hour]))) continue;
    rows.push(wideRow(columns, ratio, hour));
  }
  saveBlob(new Blob([rows.join('\n') + '\n'], { type: 'text/csv' }), 'time-series.csv');
}

export function createTimeAdapter(host: PaneHost): PaneAdapter {
  const state = held();
  const {
    limits: limitsCheck,
    follow,
    overview: overviewCheck,
    overviewHost,
    overlayYears,
  } = host.controls;
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
  /** A zoom across year slots that cleared the dates: the render that
   * clearing causes keeps it instead of returning to the whole extent. */
  let keptWindow: [number, number] | null = null;
  /** The year slot a followed date filter is shown in, on the origin it was
   * picked on. The dates apply in every year, so the pane shows one year's
   * days, not a sliver of each across the whole span; a zoom or a click on a
   * run in the overview picks the year. */
  let shownSlot: { slot: number; origin: number | undefined } | null = null;
  /** The columns last placed and their kept hours' extent, which the shown
   * year is checked against and clipped to. */
  let drawnColumns: (number | null)[][] = [];
  let drawnExtent: [number, number] | null = null;
  /** The year lines last drawn when "overlay years" is on, else null. */
  let overlaid: YearLine[] | null = null;
  const overview = createYearOverview(overviewHost, host.datesChange, pick);

  // A full re-render: limit lines are uPlot series, so hiding them rebuilds
  // the plot.
  for (const check of [limitsCheck, follow, overviewCheck, overlayYears]) {
    check.addEventListener('change', () => host.rerender());
  }

  function onZoom(min: number, max: number): void {
    if (!follow.checked) return;
    // After uPlot applies its own zoom, so the render that follows sets the
    // pane to whole days last.
    // The days the zoom touched, as one run in place of the whole set. The
    // dates apply in every year, so a window across year slots has no one
    // run to name, and takes every date.
    const slot = Math.floor(Math.max(0, Math.ceil(min)) / YEAR_SLOT_HOURS);
    if (Math.floor(Math.floor(max) / YEAR_SLOT_HOURS) !== slot) {
      if (frame?.input.dates) keptWindow = [min, max];
      queueMicrotask(() => host.datesChange(null));
      return;
    }
    shownSlot = { slot, origin: state.axis?.origin };
    const offset = slot * YEAR_SLOT_HOURS;
    queueMicrotask(() => host.datesChange([rangeOfHours(min - offset, max - offset)]));
  }

  /**
   * The year a followed date filter shows on a multi-year axis, and its
   * window: the picked slot while it holds data on the dates, else the first
   * that does. Null when no year does, or there is one year to show.
   */
  function datesView(dates: DateSet): { slot: number; window: [number, number] } | null {
    const { axis } = state;
    const extent = drawnExtent;
    if (!axis || !extent || !spansYears(state)) return null;
    const slots = axis.length / YEAR_SLOT_HOURS;
    const holds = (slot: number) => slot < slots && slotHasData(drawnColumns, dates, slot);
    let slot = shownSlot && holds(shownSlot.slot) ? shownSlot.slot : -1;
    for (let s = 0; slot < 0 && s < slots; s++) if (holds(s)) slot = s;
    if (slot < 0) return null;
    const [from, to] = slotWindow(dates, slot);
    return { slot, window: [Math.max(from, extent[0]), Math.min(to, extent[1])] };
  }

  /** The header note over a followed date filter shown in one year. */
  function datesNote(input: ChartsInput, dates: DateSet, slot: number): void {
    const { axis } = state;
    if (!axis) return;
    const yearOf = (s: number) => (hasYear(axis.origin) ? axis.origin + s : undefined);
    const slots = axis.length / YEAR_SLOT_HOURS;
    let kept = 0;
    let held = 0;
    for (let s = 0; s < slots; s++) {
      const year = yearOf(s);
      if (year !== undefined && input.years && !input.years.has(year)) continue;
      kept++;
      if (slotHasData(drawnColumns, dates, s)) held++;
    }
    const year = yearOf(slot);
    host.note(
      `Showing ${year ?? `year ${slot + 1}`}. The dates apply in every year: ` +
        `${held} of ${kept} years in the statistics.`,
    );
  }

  /** The overview's click on a run in year slot `slot`: that year's days,
   * the dates untouched. */
  function pick(slot: number): void {
    const dates = frame?.input.dates;
    if (!follow.checked || !dates || !state.plot) return;
    shownSlot = { slot, origin: state.axis?.origin };
    const view = datesView(dates);
    if (!view || !frame) return;
    state.extent = view.window;
    state.plot.setScale('x', { min: view.window[0], max: view.window[1] });
    datesNote(frame.input, dates, view.slot);
  }

  /** The frame's lines cut into years, when "overlay years" is ticked and
   * the axis holds more than one year (a box ticked earlier stays ticked
   * while the control is hidden); else null. */
  function overlayOf(input: ChartsInput, lines: readonly CaseSeries[]): YearLine[] | null {
    if (!overlayYears.checked) return null;
    if (spanAxisOf(input, lines, []).length <= YEAR_SLOT_HOURS) return null;
    return yearLinesOf(input, lines);
  }

  function paint(input: ChartsInput, drawable: CaseSeries[], zeroText: string | null): void {
    overlaid = null;
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

    const overlay = overlayOf(input, drawable);
    const capped = overlay && overlayCapMessage(overlay);
    if (capped) {
      refuse(host, state, capped);
      return;
    }
    overlaid = overlay;

    host.uplotHost.style.display = '';
    // Limits for what is drawn, gated on the checkbox. Appended AFTER the
    // series so `colors[i - 1]` still lines up with the traces.
    const limits = limitsCheck.checked ? (input.limits ?? []) : [];
    const axis = overlay ? OVERLAY_AXIS : spanAxisOf(input, drawable, limits);
    state.axis = axis;
    // What uPlot draws a line for: each line, or each year of each line.
    const traces = overlay
      ? overlay.map((entry) => ({
          name: entry.name,
          color: entry.color,
          unit: entry.line.unit,
          dashed: entry.line.dashed,
          column: placed(entry.values, 0, axis.length),
        }))
      : drawable.map((s) => ({
          name: s.name,
          color: s.color,
          unit: s.unit,
          dashed: s.dashed,
          column: placed(s.values as Float32Array, axis.lineOffset(s), axis.length),
        }));
    const columns = traces.map((trace) => trace.column);
    drawnColumns = columns;
    drawnExtent = extentOf(columns);
    state.extent = drawnExtent;
    if (shownSlot && shownSlot.origin !== axis.origin) shownSlot = null;
    const followed = follow.checked && input.dates ? input.dates : null;
    const view = followed && datesView(followed);
    if (view) state.extent = view.window;
    const data: uPlot.AlignedData = [
      xAxisOf(axis.length),
      ...columns,
      ...limits.map((limit) =>
        overlay
          ? placed(foldedYears(limit.values), 0, axis.length)
          : placed(limit.values, axis.offsetOf(limit.firstYear), axis.length),
      ),
    ];

    const scales = scalesOf([...drawable, ...limits]);
    // Limits are IN the signature, so flipping the checkbox or the pins
    // rebuilds the plot.
    // The origin too: the axis labels are built for it.
    const wanted =
      `time|${traces.map((s) => `${s.name}|${s.color}|${s.unit}|${s.dashed ? 'd' : ''}`).join(',')}` +
      `|limits:${limits.map((l) => `${l.name}|${l.color}|${l.unit}`).join(',')}` +
      `|from:${axis.origin ?? ''}|${overlay ? 'overlay' : 'span'}`;
    let plot = state.plot;
    if (
      !plot ||
      plot.series.length - 1 !== traces.length + limits.length ||
      state.signature !== wanted
    ) {
      state.signature = wanted;
      plot?.destroy();
      const ticks = timeAxis(axis.origin);
      const options = baseOptions(host, '', scales, ticks.values, ticks.splits, () =>
        resetZoom(state.plot, state.extent),
      );
      options.series = [
        { label: 'hour' },
        ...traces.map((s) => ({
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
      const hover = hoverOf(axis);
      addTooltip(
        options,
        hover.label,
        [...traces, ...limits].map((s) => s.color),
        hover.phantom,
        overlay
          ? [...overlay.map((entry) => entry.tip), ...limits.map((l) => ({ name: l.name }))]
          : undefined,
      );
      addAxisReadout(
        options,
        scales.map((s) => s.scale),
      );
      markExtremes(options, [...traces.map((s) => s.color), ...limits.map(() => null)]);
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
            // One band per run of the dates, in every year slot.
            for (let slot = 0; slot < self.data[0].length; slot += YEAR_SLOT_HOURS) {
              for (const band of bands) {
                const [from, to] = rangeHours(band);
                const x0 = self.valToPos(slot + from - 0.5, 'x', true);
                const x1 = self.valToPos(slot + to - 0.5, 'x', true);
                ctx.fillRect(x0, top, Math.max(1, x1 - x0), height);
                ctx.strokeRect(x0, top, Math.max(1, x1 - x0), height);
              }
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
    const window = keptWindow ?? state.extent;
    keptWindow = null;
    if (window) plot.setScale('x', { min: window[0], max: window[1] });
    if (followed && view) datesNote(input, followed, view.slot);
    if (zeroText) host.banner('note', zeroText);
  }

  /** The year overview, shown when ticked on a drawn chart, over the axis
   * the chart draws. */
  function showOverview(shownFrame: PaneFrame): void {
    const shown = overviewCheck.checked && state.plot !== null && !!shownFrame.input.overview;
    overviewHost.hidden = !shown;
    overviewLines = shown
      ? shownFrame.wholeYear().filter((s) => s.values !== null && !s.dashed)
      : null;
    drawOverview();
  }

  function drawOverview(): void {
    const { plot, axis } = state;
    if (!plot || !axis || !overviewLines || !frame) return;
    const ratio = devicePixelRatio || 1;
    // An overlay's strip is its one year slot, each year in its shade: the
    // dates are slot days, so a day still sits under its own hours.
    const stripLines = overlaid
      ? yearLinesOf(frame.input, overviewLines).map((entry) => ({
          color: entry.color,
          unit: entry.line.unit,
          values: entry.values,
          offset: 0,
        }))
      : overviewLines.map((s) => ({
          color: s.color,
          unit: s.unit,
          values: s.values as Float32Array,
          offset: axis.lineOffset(s),
        }));
    overview.draw(
      stripLines,
      frame.input.dates,
      { left: plot.bbox.left / ratio, width: plot.bbox.width / ratio },
      axis,
    );
  }

  /**
   * The Figure of an overlay: the pane's one year slot, a line per series
   * and year in the shade the pane drew it, each naming its series' colour
   * for the key's ramp, and the limits folded as drawn. The hours footnote
   * counts out of the real hours of the years drawn.
   */
  function overlayShot(
    input: ChartsInput,
    years: readonly YearLine[],
    window: [number, number],
  ): FigureShot {
    const ordered = pinnedOf(drawnLines ?? input.series);
    const shot = figureShot(host, input, {
      pane: 'time',
      ordered,
      xWindow: window,
      limits: (drawnLimits ?? input.limits ?? []).map((limit) => ({
        ...limit,
        values: foldedYears(limit.values),
      })),
      wholeYear: drawnLines !== null,
      axis: OVERLAY_AXIS,
    });
    const lines = shot.capture.lines.flatMap((entry, series) => {
      const own = years.filter((year) => year.line === ordered[series]);
      if (entry.values === null || own.length === 0) return [entry];
      return own.map(({ year, values, color }) => ({
        ...entry,
        facets: year === undefined ? entry.facets : yearsShown(entry.facets, [year, year]),
        color,
        values: values.slice(),
        overlay: { series, year, base: entry.color },
      }));
    });
    const drawnYears = new Set(
      lines.flatMap((entry) => (entry.overlay ? [entry.overlay.year ?? NO_YEAR] : [])),
    );
    let hours = 0;
    for (const year of drawnYears) hours += realHours(year, 1);
    return {
      capture: { ...shot.capture, lines, realHours: hours },
      shown: { ...shot.shown, yearsOverlaid: true },
    };
  }

  return {
    surface: 'uplot',
    controls(shownFrame) {
      // Limits stay hidden until a limits file is loaded, and "overlay
      // years" until the axis holds a second year to lay over the first.
      const shown: PaneControl[] = ['zoom', 'download', 'dates'];
      if ((shownFrame.input.limits?.length ?? 0) > 0) shown.push('limits');
      if (spanAxisOf(shownFrame.input, shownFrame.drawable, []).length > YEAR_SLOT_HOURS) {
        shown.push('overlay');
      }
      return shown;
    },
    draw(next) {
      frame = next;
      bands = null;
      drawnLines = null;
      drawnLimits = null;
      const { input } = next;
      if (!input.dates) shownSlot = null;
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
        host.note(
          `${yearsNote(input.years, spansYears(state) || overlaid !== null)} · ` +
            `dates ${setLabel(input.dates, 3)}`,
        );
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
      keptWindow = null;
      shownSlot = null;
      drawnColumns = [];
      drawnExtent = null;
      overlaid = null;
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
      if (overlaid) downloadOverlay(state, overlaid);
      else if (frame) downloadHours(state, drawnLines ?? frame.input.series);
    },
    timeWindow() {
      return xWindow(state.plot);
    },
    figure: {
      offered: () => true,
      capture() {
        const window = xWindow(state.plot);
        if (!frame || !window) return null;
        if (overlaid) return overlayShot(frame.input, overlaid, window);
        return figureShot(host, frame.input, {
          pane: 'time',
          ordered: pinnedOf(drawnLines ?? frame.input.series),
          xWindow: window,
          limits: drawnLimits,
          wholeYear: drawnLines !== null,
          axis: state.axis,
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
  /** Each band's own values on the axis, refilled in place on every paint:
   * the hover holds this array from the plot's build. */
  const raw: (number | null)[][] = [];

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
    const axis = spanAxisOf(input, stack, []);
    state.axis = axis;
    raw.splice(
      0,
      raw.length,
      ...stack.map((s) => placed(s.values as Float32Array, axis.lineOffset(s), axis.length)),
    );
    const sums = raw.map((_column, seriesIdx) => {
      const column: (number | null)[] = new Array(axis.length);
      for (let x = 0; x < axis.length; x++) {
        if (raw.every((entry) => entry[x] === null)) {
          column[x] = null;
          continue;
        }
        let sum = 0;
        for (let j = 0; j <= seriesIdx; j++) sum += raw[j][x] ?? 0;
        column[x] = sum;
      }
      return column;
    });
    state.extent = extentOf(sums);
    const data: uPlot.AlignedData = [xAxisOf(axis.length), ...sums];

    const unit = stack[0].unit;
    const scales = [{ scale: scaleOf(unit), label: unit }];
    // From the STACK order, so a change in which series is largest rebuilds
    // the plot.
    const wanted =
      `stacked|${stack.map((s) => `${s.name}|${s.color}|${s.unit}|${s.dashed ? 'd' : ''}`).join(',')}` +
      `|from:${axis.origin ?? ''}`;
    let plot = state.plot;
    if (!plot || plot.series.length - 1 !== stack.length || state.signature !== wanted) {
      state.signature = wanted;
      plot?.destroy();
      const ticks = timeAxis(axis.origin);
      const options = baseOptions(host, '', scales, ticks.values, ticks.splits, () =>
        resetZoom(state.plot, state.extent),
      );
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
      const hover = hoverOf(axis);
      addStackedTooltip(
        options,
        hover.label,
        stack.map((s) => s.color),
        raw,
        hover.phantom,
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
      if (frame) downloadHours(state, frame.input.series);
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
          axis: state.axis,
        });
      },
    },
  };
}
