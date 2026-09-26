// src/ui/year-overview.ts
//
// A time pane's year overview: the whole year's daily values under the chart,
// with each run of the dates as a window to drag. It writes the same `Filters.dates` as
// the rail, so the rail, the pane and the overview show one range.
//
// The lines it draws are resolved with the dates cleared (`main.ts`), since
// the pane's own lines are masked outside them and would leave the year
// empty. It has no y axis: each unit spans the strip on its own, because the
// strip is for finding days, not for reading values.
//
// A drag moves the dates as it goes, like the rail's strip, at most once a
// frame: each change re-renders every pane and the browse drawer.

import { MONTH_LENGTHS, MONTH_NAMES } from '../model/calendar';
import {
  DAYS_PER_YEAR,
  MONTH_STARTS,
  rangeOf,
  replaceRun,
  sameSet,
  type DateRange,
  type DateSet,
} from '../model/date-range';

export interface OverviewLine {
  color: string;
  unit: string;
  /** 8,760 values, NaN where filtered out or missing. */
  values: Float32Array;
}

export interface YearOverview {
  /** `left` and `width` are the chart's plot area in CSS px, so a day sits
   * under its own hours. */
  draw(
    lines: readonly OverviewLine[],
    dates: DateSet | null,
    plot: { left: number; width: number },
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

function svgEl(name: string, attrs: Record<string, string | number>, parent: Element): Element {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  parent.appendChild(node);
  return node;
}

/** Each day's mean, min and max over its kept hours; NaN for a day with
 * none. */
function daily(values: Float32Array): { mean: Float32Array; min: Float32Array; max: Float32Array } {
  const mean = new Float32Array(DAYS_PER_YEAR);
  const min = new Float32Array(DAYS_PER_YEAR);
  const max = new Float32Array(DAYS_PER_YEAR);
  for (let d = 0; d < DAYS_PER_YEAR; d++) {
    let lo = Infinity;
    let hi = -Infinity;
    let sum = 0;
    let n = 0;
    for (let h = d * 24; h < d * 24 + 24; h++) {
      const v = values[h];
      if (Number.isNaN(v)) continue;
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
  for (let d = 0; d < DAYS_PER_YEAR; d++) {
    if (Number.isNaN(ys[d])) {
      pen = false;
      continue;
    }
    path += `${pen ? 'L' : 'M'}${x(d + 0.5).toFixed(1)} ${y(ys[d]).toFixed(1)}`;
    pen = true;
  }
  return path;
}

export function createYearOverview(
  host: HTMLElement,
  onChange: (dates: DateSet) => void,
): YearOverview {
  let lines: readonly OverviewLine[] = [];
  let stats: ReturnType<typeof daily>[] = [];
  let committed: DateSet | null = null;
  let shown: DateSet | null = null;
  let plot = { left: 0, width: 0 };
  /** The run under the pointer at the press, and the set it came from: a
   * drag moves or resizes that run only. A press outside every run starts
   * over with an empty `base`. */
  let drag: {
    mode: 'move' | 'left' | 'right';
    from: number;
    index: number;
    range: DateRange;
    base: DateSet;
  } | null = null;

  const width = (): number => Math.max(1, Math.floor(host.clientWidth));
  const plotWidth = (): number => (plot.width > 0 ? plot.width : width() - plot.left);
  const x = (d: number): number => plot.left + (d / DAYS_PER_YEAR) * plotWidth();
  const dayAt = (px: number): number =>
    Math.max(
      0,
      Math.min(DAYS_PER_YEAR - 1, Math.floor(((px - plot.left) / plotWidth()) * DAYS_PER_YEAR)),
    );

  function paint(): void {
    const w = width();
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(HEIGHT));
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'The whole year, by day, with the dates as a window');
    const bottom = HEIGHT - BOTTOM;

    for (let m = 0; m < 12; m++) {
      svgEl(
        'line',
        { x1: x(MONTH_STARTS[m]), x2: x(MONTH_STARTS[m]), y1: TOP, y2: bottom, stroke: '#f0f0f0' },
        svg,
      );
      const label = svgEl(
        'text',
        {
          x: x(MONTH_STARTS[m] + MONTH_LENGTHS[m] / 2),
          y: HEIGHT - 3,
          'text-anchor': 'middle',
          'font-size': 10,
          fill: '#666666',
        },
        svg,
      );
      label.textContent = MONTH_NAMES[m];
    }

    // One scale per unit, over what that unit's lines draw.
    const band = lines.length === 1;
    const scales = new Map<string, { lo: number; hi: number }>();
    lines.forEach((line, i) => {
      const scale = scales.get(line.unit) ?? { lo: Infinity, hi: -Infinity };
      const [lows, highs] = band ? [stats[i].min, stats[i].max] : [stats[i].mean, stats[i].mean];
      for (let d = 0; d < DAYS_PER_YEAR; d++) {
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
        for (let d = 0; d <= DAYS_PER_YEAR; d++) {
          const kept = d < DAYS_PER_YEAR && !Number.isNaN(stats[i].max[d]);
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
      // Dim every gap outside the runs, then a window per run.
      const right = plot.left + plotWidth();
      const dim = { y: TOP, height: bottom - TOP, fill: '#ffffff', 'fill-opacity': 0.6 };
      let gap = plot.left;
      for (const run of shown) {
        svgEl('rect', { ...dim, x: gap, width: Math.max(0, x(run.start) - gap) }, svg);
        gap = x(run.end + 1);
      }
      svgEl('rect', { ...dim, x: gap, width: Math.max(0, right - gap) }, svg);
      for (const run of shown) drawWindow(svg, run, bottom);
    }
    host.replaceChildren(svg);
  }

  /** One run's outline and its two edge handles. */
  function drawWindow(svg: Element, run: DateRange, bottom: number): void {
    const x0 = x(run.start);
    const x1 = x(run.end + 1);
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

  /** The run a pointer at `px` grabs, and how: an edge, or its middle. */
  function hit(px: number): { index: number; mode: 'move' | 'left' | 'right' } | null {
    if (!committed) return null;
    for (let index = 0; index < committed.length; index++) {
      const run = committed[index];
      const x0 = x(run.start);
      const x1 = x(run.end + 1);
      // A narrow run's edges shrink, so its middle still moves it.
      const edge = Math.min(EDGE, (x1 - x0) / 4);
      if (Math.abs(px - x0) <= edge) return { index, mode: 'left' };
      if (Math.abs(px - x1) <= edge) return { index, mode: 'right' };
    }
    const index = committed.findIndex((run) => px > x(run.start) && px < x(run.end + 1));
    return index < 0 ? null : { index, mode: 'move' };
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
    const day = dayAt(px);
    const grabbed = hit(px);
    // Outside every run: one new run, grown by dragging its right edge.
    drag = grabbed
      ? { ...grabbed, from: day, range: committed![grabbed.index], base: committed! }
      : { mode: 'right', from: day, index: 0, range: rangeOf(day, day), base: [] };
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
    const day = dayAt(localX(event));
    const { mode, from, range, base, index } = drag;
    let next: DateRange;
    if (mode === 'move') {
      const len = range.end - range.start;
      const start = Math.max(0, Math.min(DAYS_PER_YEAR - 1 - len, range.start + day - from));
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
    drag = null;
    cancelAnimationFrame(frame);
    frame = 0;
    if (shown && !sameSet(shown, committed)) onChange(shown);
  };
  host.addEventListener('pointerup', release);
  host.addEventListener('pointercancel', release);

  return {
    draw(nextLines, dates, plotArea) {
      // Recomputed every draw: the values are pool buffers, reused in place.
      lines = nextLines;
      stats = lines.map((line) => daily(line.values));
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
