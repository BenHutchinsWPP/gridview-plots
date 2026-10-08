// src/ui/year-overview.ts
//
// A time pane's year overview: daily values over every year slot the pane's
// axis spans, under the chart, with each run of the dates as a window to drag.
// It writes the same `Filters.dates` as the rail, so the rail, the pane and
// the overview show one range. The dates are slot days that apply in every
// year, so each run is drawn in every slot and a drag in any slot moves them
// all; a drag stops at its slot's ends rather than carry a run into the next
// year, which would be a different set of slot days.
//
// The pane hands it its axis and each line's offset on it, so a day sits
// under its own hours without the strip working out a Case's years again.
//
// The lines it draws are resolved with the dates cleared (`main.ts`), since
// the pane's own lines are masked outside them and would leave the year
// empty. It has no y axis: each unit spans the strip on its own, because the
// strip is for finding days, not for reading values.
//
// A drag moves the dates as it goes, like the rail's strip, at most once a
// frame: each change re-renders every pane and the browse drawer. A click on
// a run that moves nothing picks its year instead: the pane shows one year's
// days at a time, and the click names which.

import {
  MONTH_NAMES,
  SLOT_MONTH_LENGTHS,
  SLOT_MONTH_STARTS,
  YEAR_SLOT_DAYS,
} from '../model/calendar';
import { axisHour } from './chart-format';
import { rangeOf, replaceRun, sameSet, type DateRange, type DateSet } from '../model/date-range';

export interface OverviewLine {
  color: string;
  unit: string;
  /** From axis hour `offset` on, NaN where filtered out or missing. */
  values: Float32Array;
  offset: number;
}

/** The pane's time axis: the year at x = 0 (none when no drawn line has
 * one) and its length in hours, whole year slots. */
export interface OverviewAxis {
  readonly origin: number | undefined;
  readonly length: number;
}

export interface YearOverview {
  /** `left` and `width` are the chart's plot area in CSS px, so a day sits
   * under its own hours. */
  draw(
    lines: readonly OverviewLine[],
    dates: DateSet | null,
    plot: { left: number; width: number },
    axis: OverviewAxis,
  ): void;
  /** Repaint at the host's current width. */
  redraw(): void;
}

const NS = 'http://www.w3.org/2000/svg';
const HEIGHT = 56;
const TOP = 4;
const BOTTOM = 14;
/** A pointer this close to a window edge, in px, drags the edge. */
const EDGE = 6;
/** The px a month or year label needs before the strip thins them, over
 * more than one year: one year always labels its twelve months. */
const MONTH_ROOM = 28;
const YEAR_ROOM = 36;
/** Past this many year slots the strip marks years, not months, as the time
 * axis ticks do (`timeTicks`). */
const MONTHS_UP_TO = 2;

function svgEl(name: string, attrs: Record<string, string | number>, parent: Element): Element {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  parent.appendChild(node);
  return node;
}

/** Each axis day's mean, min and max over its kept hours; NaN for a day with
 * none, and for a phantom Feb 29 whatever its values say. */
function daily(
  line: OverviewLine,
  days: number,
  phantom: (day: number) => boolean,
): { mean: Float32Array; min: Float32Array; max: Float32Array } {
  const mean = new Float32Array(days);
  const min = new Float32Array(days);
  const max = new Float32Array(days);
  const { values, offset } = line;
  for (let d = 0; d < days; d++) {
    let lo = Infinity;
    let hi = -Infinity;
    let sum = 0;
    let n = 0;
    const none = phantom(d);
    for (let h = d * 24; !none && h < d * 24 + 24; h++) {
      const v = values[h - offset];
      if (v === undefined || Number.isNaN(v)) continue;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
      sum += v;
      n++;
    }
    mean[d] = n === 0 ? NaN : sum / n;
    min[d] = n === 0 ? NaN : lo;
    max[d] = n === 0 ? NaN : hi;
  }
  return { mean, min, max };
}

/** A path through `ys` by day, broken at every NaN. */
function trace(ys: Float32Array, x: (d: number) => number, y: (v: number) => number): string {
  let path = '';
  let pen = false;
  for (let d = 0; d < ys.length; d++) {
    if (Number.isNaN(ys[d])) {
      pen = false;
      continue;
    }
    path += `${pen ? 'L' : 'M'}${x(d + 0.5).toFixed(1)} ${y(ys[d]).toFixed(1)}`;
    pen = true;
  }
  return path;
}

/** One copy of a run of the dates: run `index` of the set, in year slot
 * `slot`. */
interface Copy {
  readonly index: number;
  readonly slot: number;
  readonly run: DateRange;
}

export function createYearOverview(
  host: HTMLElement,
  onChange: (dates: DateSet) => void,
  onPick: (slot: number) => void,
): YearOverview {
  let lines: readonly OverviewLine[] = [];
  let stats: ReturnType<typeof daily>[] = [];
  let committed: DateSet | null = null;
  let shown: DateSet | null = null;
  let plot = { left: 0, width: 0 };
  let axis: OverviewAxis = { origin: undefined, length: YEAR_SLOT_DAYS * 24 };
  /** The run under the pointer at the press, the slot it was grabbed in,
   * and the set it came from: a drag moves or resizes that run only, in slot
   * days. A press outside every run starts over with an empty `base`. */
  let drag: {
    mode: 'move' | 'left' | 'right';
    from: number;
    index: number;
    slot: number;
    range: DateRange;
    base: DateSet;
    grabbed: boolean;
  } | null = null;

  const days = (): number => axis.length / 24;
  const slots = (): number => Math.max(1, Math.round(days() / YEAR_SLOT_DAYS));
  const width = (): number => Math.max(1, Math.floor(host.clientWidth));
  const plotWidth = (): number => (plot.width > 0 ? plot.width : width() - plot.left);
  /** The px of axis day `d`. */
  const x = (d: number): number => plot.left + (d / days()) * plotWidth();
  /** The axis day under `px`, kept on the strip. */
  const dayAt = (px: number): number =>
    Math.max(0, Math.min(days() - 1, Math.floor(((px - plot.left) / plotWidth()) * days())));
  /** The slot day of year slot `slot` under `px`, kept inside that slot. */
  const slotDayAt = (px: number, slot: number): number =>
    Math.max(
      0,
      Math.min(
        YEAR_SLOT_DAYS - 1,
        Math.floor(((px - plot.left) / plotWidth()) * days()) - slot * YEAR_SLOT_DAYS,
      ),
    );
  const phantom = (d: number): boolean =>
    axis.origin !== undefined && axisHour(d * 24, axis.origin).phantom;

  /** Every run of `set` in every year slot, in axis order. */
  function copies(set: DateSet): Copy[] {
    const all: Copy[] = [];
    for (let slot = 0; slot < slots(); slot++) {
      set.forEach((run, index) => all.push({ index, slot, run }));
    }
    return all;
  }
  const startOf = (copy: Copy): number => copy.slot * YEAR_SLOT_DAYS + copy.run.start;
  const endOf = (copy: Copy): number => copy.slot * YEAR_SLOT_DAYS + copy.run.end + 1;

  /** Month lines and labels for one or two year slots, year lines and labels
   * past that, thinned to fit; one year keeps its twelve months as they are. */
  function paintCalendar(svg: Element, bottom: number): void {
    const count = slots();
    const label = (at: number, text: string): void => {
      const node = svgEl(
        'text',
        { x: x(at), y: HEIGHT - 3, 'text-anchor': 'middle', 'font-size': 10, fill: '#666666' },
        svg,
      );
      node.textContent = text;
    };
    const rule = (at: number, stroke: string): void => {
      svgEl('line', { x1: x(at), x2: x(at), y1: TOP, y2: bottom, stroke }, svg);
    };
    const yearName = (slot: number): string =>
      axis.origin === undefined ? `year ${slot + 1}` : String(axis.origin + slot);

    if (count <= MONTHS_UP_TO) {
      const monthPx = plotWidth() / (count * 12);
      const step = count === 1 ? 1 : ([1, 2, 3, 6].find((n) => n * monthPx >= MONTH_ROOM) ?? 12);
      for (let slot = 0; slot < count; slot++) {
        const first = slot * YEAR_SLOT_DAYS;
        for (let m = 0; m < 12; m++) {
          rule(first + SLOT_MONTH_STARTS[m], '#f0f0f0');
          if (m % step !== 0) continue;
          // Jan names its year once the strip holds more than one.
          const text = count > 1 && m === 0 ? yearName(slot) : MONTH_NAMES[m];
          label(first + SLOT_MONTH_STARTS[m] + SLOT_MONTH_LENGTHS[m] / 2, text);
        }
      }
    } else {
      const step = Math.max(1, Math.ceil(YEAR_ROOM / (plotWidth() / count)));
      for (let slot = 0; slot < count; slot += step) {
        label(slot * YEAR_SLOT_DAYS + YEAR_SLOT_DAYS / 2, yearName(slot));
      }
    }
    // Over the month lines, so a year reads as a year.
    for (let slot = 1; slot < count; slot++) rule(slot * YEAR_SLOT_DAYS, '#bbbbbb');
  }

  function paint(): void {
    const w = width();
    const total = days();
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(HEIGHT));
    svg.setAttribute('role', 'img');
    svg.setAttribute(
      'aria-label',
      slots() === 1
        ? 'The whole year, by day, with the dates as a window'
        : 'Every year drawn, by day, with the dates as a window in each year',
    );
    const bottom = HEIGHT - BOTTOM;

    paintCalendar(svg, bottom);

    // One scale per unit, over what that unit's lines draw.
    const band = lines.length === 1;
    const scales = new Map<string, { lo: number; hi: number }>();
    lines.forEach((line, i) => {
      const scale = scales.get(line.unit) ?? { lo: Infinity, hi: -Infinity };
      const [lows, highs] = band ? [stats[i].min, stats[i].max] : [stats[i].mean, stats[i].mean];
      for (let d = 0; d < total; d++) {
        if (!Number.isNaN(lows[d])) scale.lo = Math.min(scale.lo, lows[d]);
        if (!Number.isNaN(highs[d])) scale.hi = Math.max(scale.hi, highs[d]);
      }
      scales.set(line.unit, scale);
    });
    lines.forEach((line, i) => {
      const { lo, hi } = scales.get(line.unit)!;
      if (!Number.isFinite(lo)) return;
      // A flat line runs through the middle, not along the bottom edge.
      const y = (v: number): number =>
        hi === lo ? (TOP + bottom) / 2 : TOP + (1 - (v - lo) / (hi - lo)) * (bottom - TOP);
      if (band) {
        // Each run of kept days as its own closed band.
        const runs: string[] = [];
        let start = -1;
        for (let d = 0; d <= total; d++) {
          const kept = d < total && !Number.isNaN(stats[i].max[d]);
          if (kept && start < 0) start = d;
          if (!kept && start >= 0) {
            let path = '';
            for (let k = start; k < d; k++) {
              path += `${k === start ? 'M' : 'L'}${x(k + 0.5).toFixed(1)} ${y(stats[i].max[k]).toFixed(1)}`;
            }
            for (let k = d - 1; k >= start; k--) {
              path += `L${x(k + 0.5).toFixed(1)} ${y(stats[i].min[k]).toFixed(1)}`;
            }
            runs.push(path + 'Z');
            start = -1;
          }
        }
        svgEl('path', { d: runs.join(''), fill: line.color, 'fill-opacity': 0.22 }, svg);
      }
      svgEl(
        'path',
        { d: trace(stats[i].mean, x, y), fill: 'none', stroke: line.color, 'stroke-width': 1 },
        svg,
      );
    });

    if (shown) {
      // Dim every gap outside the runs, then a window per run, in every
      // year slot.
      const right = plot.left + plotWidth();
      const dim = { y: TOP, height: bottom - TOP, fill: '#ffffff', 'fill-opacity': 0.6 };
      const all = copies(shown);
      let gap = plot.left;
      for (const copy of all) {
        svgEl('rect', { ...dim, x: gap, width: Math.max(0, x(startOf(copy)) - gap) }, svg);
        gap = x(endOf(copy));
      }
      svgEl('rect', { ...dim, x: gap, width: Math.max(0, right - gap) }, svg);
      for (const copy of all) drawWindow(svg, copy, bottom);
    }
    host.replaceChildren(svg);
  }

  /** One run's outline and its two edge handles. */
  function drawWindow(svg: Element, copy: Copy, bottom: number): void {
    const x0 = x(startOf(copy));
    const x1 = x(endOf(copy));
    svgEl(
      'rect',
      {
        x: x0,
        y: TOP,
        width: Math.max(2, x1 - x0),
        height: bottom - TOP,
        fill: 'none',
        stroke: '#0066cc',
        'stroke-width': 1.5,
        rx: 2,
      },
      svg,
    );
    for (const edge of [x0, x1]) {
      svgEl(
        'rect',
        {
          x: edge - 2.5,
          y: TOP + (bottom - TOP) / 2 - 8,
          width: 5,
          height: 16,
          rx: 1.5,
          fill: '#0066cc',
        },
        svg,
      );
    }
  }

  /** The run a pointer at `px` grabs, in which slot, and how: an edge, or
   * its middle. */
  function hit(
    px: number,
  ): { index: number; slot: number; mode: 'move' | 'left' | 'right' } | null {
    if (!committed) return null;
    const all = copies(committed);
    for (const copy of all) {
      const x0 = x(startOf(copy));
      const x1 = x(endOf(copy));
      // A narrow run's edges shrink, so its middle still moves it.
      const edge = Math.min(EDGE, (x1 - x0) / 4);
      if (Math.abs(px - x0) <= edge) return { index: copy.index, slot: copy.slot, mode: 'left' };
      if (Math.abs(px - x1) <= edge) return { index: copy.index, slot: copy.slot, mode: 'right' };
    }
    const inside = all.find((copy) => px > x(startOf(copy)) && px < x(endOf(copy)));
    return inside ? { index: inside.index, slot: inside.slot, mode: 'move' } : null;
  }

  let frame = 0;
  /** Send the dragged set on the next frame, dropping any in between. */
  function live(): void {
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      if (drag && shown && !sameSet(shown, committed)) onChange(shown);
    });
  }

  function localX(event: PointerEvent): number {
    return event.clientX - host.getBoundingClientRect().left;
  }

  host.addEventListener('pointerdown', (event) => {
    const px = localX(event);
    const grabbed = hit(px);
    const slot = grabbed?.slot ?? Math.floor(dayAt(px) / YEAR_SLOT_DAYS);
    const day = slotDayAt(px, slot);
    // Outside every run: one new run, grown by dragging its right edge.
    drag = grabbed
      ? {
          ...grabbed,
          from: day,
          range: committed![grabbed.index],
          base: committed!,
          grabbed: true,
        }
      : {
          mode: 'right',
          from: day,
          index: 0,
          slot,
          range: rangeOf(day, day),
          base: [],
          grabbed: false,
        };
    shown = grabbed ? committed : [drag.range];
    host.setPointerCapture(event.pointerId);
    event.preventDefault();
    paint();
    live();
  });
  host.addEventListener('pointermove', (event) => {
    if (!drag) {
      const grabbed = hit(localX(event));
      host.style.cursor = !grabbed ? '' : grabbed.mode === 'move' ? 'grab' : 'ew-resize';
      return;
    }
    const { mode, from, range, base, index, slot } = drag;
    const day = slotDayAt(localX(event), slot);
    let next: DateRange;
    if (mode === 'move') {
      const len = range.end - range.start;
      const start = Math.max(0, Math.min(YEAR_SLOT_DAYS - 1 - len, range.start + day - from));
      next = { start, end: start + len };
    } else if (mode === 'left') {
      next = rangeOf(Math.min(day, range.end), range.end);
    } else {
      next = rangeOf(range.start, Math.max(day, range.start));
    }
    // Always from the set at the press, so a run dragged across another
    // merges with it only where it ends up.
    const set = base.length === 0 ? [next] : (replaceRun(base, index, next) ?? [next]);
    if (!sameSet(set, shown)) {
      shown = set;
      paint();
      live();
    }
  });
  const release = (): void => {
    if (!drag) return;
    const { grabbed, slot } = drag;
    drag = null;
    cancelAnimationFrame(frame);
    frame = 0;
    if (shown && !sameSet(shown, committed)) onChange(shown);
    else if (grabbed) onPick(slot);
  };
  host.addEventListener('pointerup', release);
  host.addEventListener('pointercancel', release);

  return {
    draw(nextLines, dates, plotArea, nextAxis) {
      axis = nextAxis;
      // Recomputed every draw: the values are pool buffers, reused in place.
      lines = nextLines;
      stats = lines.map((line) => daily(line, days(), phantom));
      committed = dates;
      if (!drag) shown = dates;
      plot = plotArea;
      paint();
    },
    redraw() {
      if (host.hidden) return;
      paint();
    },
  };
}
