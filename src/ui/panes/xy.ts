// src/ui/panes/xy.ts
//
// The X-Y scatter chart type. uPlot panes assume an ascending x of
// hour-of-year, which a scatter's x (one series' values) is not; drawing it
// directly is simpler than bending uPlot and its helpers around it. It draws
// exactly two series or refuses: plotting the first two of five would
// misstate what was compared. A third series is drawn only as the points'
// colour, picked in "colour on", and the other two are the pair. `fitLine`
// is exported for its own test and the print figure, since the arithmetic is
// the half that can be silently wrong.
//
// Cases of several years pair by position: the kth year each side keeps
// under the Years filter against the other's kth, hour by hour within the
// slot, so 2034 can be read against 2035. Rejected: pairing only the years
// both sides share, which would leave two Cases of different years nothing
// to compare. Different counts of kept years have no pairing and refuse.
// A colour series pairs the same way, its kth year against X's kth.

import { YEAR_SLOT_HOURS, realHours } from '../../model/calendar';
import { NO_YEAR } from '../../app/boxes';
import { scalesOf } from '../../series/scales';
import type { CaseSeries, ChartsInput } from '../charts';
import { clip, formatNumber, hourLabel } from '../chart-format';
import {
  NO_COLOUR,
  XY_COLOUR_BY,
  XY_SERIES_PREFIX,
  calendarIndex,
  calendarKey,
  signedColor,
  type XyColourBy,
} from './xy-colour';
import {
  figureShot,
  hasYear,
  pinnedOf,
  type PaneAdapter,
  type PaneFrame,
  type PaneHost,
} from './adapter';

/** One plotted pair, with its canvas position for hover hit-testing. */
interface XyPoint {
  x: number;
  y: number;
  /** The hour within the year slot. */
  hour: number;
  /** Which kept year of each side the pair is from, from 0. */
  k: number;
  /** The colour's category index or series value; NaN for none. */
  v: number;
  color: string;
  px: number;
  py: number;
}

/** What the points are coloured on, as this render resolved it. */
interface Colouring {
  by: Exclude<XyColourBy, 'none'> | 'series';
  /** The colour series, for `by` = series. */
  series: CaseSeries | null;
}

/** The plot rectangle plus the two series' names and colours, for hovers. */
interface XyGeometry {
  marginLeft: number;
  marginTop: number;
  plotWidth: number;
  plotHeight: number;
  x: { name: string; color: string };
  y: { name: string; color: string };
  colouring: Colouring | null;
  /** A series colour's extremes over the plotted points. */
  low: number;
  high: number;
  /** Each side's year by kept position `k`; undefined for a line with no
   * Case year. */
  xYears: (number | undefined)[];
  yYears: (number | undefined)[];
}

/** One year slot a side keeps under the Years filter. */
interface KeptSlot {
  slot: number;
  year: number | undefined;
}

/** The year slots of `series` the Years filter keeps, in order. A line with
 * no Case year keeps every slot it holds. */
function keptSlots(series: CaseSeries, input: ChartsInput): KeptSlot[] {
  const slots = Math.max(1, Math.ceil((series.values?.length ?? 0) / YEAR_SLOT_HOURS));
  const first = input.spanOf?.(series).firstYear;
  const kept: KeptSlot[] = [];
  for (let slot = 0; slot < slots; slot++) {
    const year = hasYear(first) ? first + slot : undefined;
    if (year !== undefined && input.years && !input.years.has(year)) continue;
    kept.push({ slot, year });
  }
  return kept;
}

/** The kept slots' years, leaving out a slot with none. */
function datedYears(kept: readonly KeptSlot[]): number[] {
  return kept.flatMap((k) => (k.year === undefined ? [] : [k.year]));
}

/** Years as a reader writes them: runs as `2034–2036`, the rest listed. */
export function yearsText(years: readonly number[]): string {
  const runs: string[] = [];
  for (let i = 0; i < years.length;) {
    let j = i;
    while (j + 1 < years.length && years[j + 1] === years[j] + 1) j++;
    runs.push(j > i ? `${years[i]}–${years[j]}` : String(years[i]));
    i = j + 1;
  }
  if (runs.length <= 1) return runs[0] ?? '';
  return `${runs.slice(0, -1).join(', ')} and ${runs[runs.length - 1]}`;
}

/** Each side's kept slots, or why the two cannot be paired. */
type Pairing = { ok: true; x: KeptSlot[]; y: KeptSlot[] } | { ok: false; reason: string };

function pairingOf(
  xs: CaseSeries,
  ys: CaseSeries,
  input: ChartsInput,
  colour: CaseSeries | null = null,
): Pairing {
  const x = keptSlots(xs, input);
  const y = keptSlots(ys, input);
  const side = (series: CaseSeries, kept: KeptSlot[]): string => {
    if (kept.length === 0) return `${series.name} keeps no year`;
    const years = datedYears(kept);
    if (years.length < kept.length) {
      return `${series.name} holds ${kept.length === 1 ? 'one undated year' : `${kept.length} undated years`}`;
    }
    const whole = Math.max(1, Math.ceil((series.values?.length ?? 0) / YEAR_SLOT_HOURS));
    return `${series.name} ${kept.length < whole ? 'keeps' : 'spans'} ${yearsText(years)}`;
  };
  if (x.length === y.length) {
    const c = colour ? keptSlots(colour, input) : null;
    if (!c || c.length === x.length) return { ok: true, x, y };
    return {
      ok: false,
      reason:
        `${side(colour!, c)} and ${side(xs, x)}, so it cannot colour the pairs hour by hour. ` +
        'Filter Years to the years all three should pair on.',
    };
  }
  return {
    ok: false,
    reason:
      `${side(xs, x)} and ${side(ys, y)}, so there is no hour-by-hour pairing. ` +
      'Filter Years to the years both should pair on.',
  };
}

/** The pane's hover head: the slot date, with the year when both sides of
 * the pair name the same one, and both years, X first, when they differ. */
export function pairHourLabel(
  hour: number,
  xYear: number | undefined,
  yYear: number | undefined,
): string {
  if (xYear === undefined || yYear === undefined) return hourLabel(hour);
  if (xYear === yYear) return hourLabel(hour, xYear);
  return `${hourLabel(hour)} · ${xYear} against ${yYear}`;
}

/** Point alpha: a year of pairs overplots, and alpha shows density. */
const POINT_ALPHA = 0.4;
const POINT_SIZE = 2.5;
/** Hover snap radius, so the pointer need not land on a 2.5px square. */
const HOVER_RADIUS_PX = 12;
const AXIS_LABEL = 16;
const TICKS = 4;
/** The band above the plot for the fit caption, added only while the fit is
 * on: text over a scatter hides its densest region. */
const FIT_CAPTION_BAND = 16;
/** The band above the plot for the colour key, added only while colouring. */
const KEY_BAND = 16;
const TOP_PAD = 10;
const SWATCH = 8;
const RAMP_PX = 60;

/** A least-squares fit, or the reason there is none. */
export type XyFit =
  | { ok: true; slope: number; intercept: number; r2: number; n: number }
  | { ok: false; reason: string };

/**
 * Ordinary least squares of y on x, plus R². Deliberately asymmetric: swapping
 * the axes gives a DIFFERENT line, as it should.
 *
 * Refuses with fewer than two pairs, or zero variance in x (a vertical line;
 * common here, e.g. a unit at its cap all year). When y is flat, R² is 1 only
 * if the residuals are 0 too; otherwise 0.
 */
export function fitLine(points: readonly { x: number; y: number }[]): XyFit {
  const n = points.length;
  if (n < 2) return { ok: false, reason: 'two points are needed for a fit' };
  let sumX = 0;
  let sumY = 0;
  for (const point of points) {
    sumX += point.x;
    sumY += point.y;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  // Centred sums: the raw Σxy / Σx² form subtracts large near-equal numbers
  // and loses most digits at these magnitudes.
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const point of points) {
    const dx = point.x - meanX;
    const dy = point.y - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0) return { ok: false, reason: 'every kept hour has the same X value' };
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  const ssResidual = syy - slope * sxy;
  const r2 =
    syy === 0 ? (ssResidual === 0 ? 1 : 0) : Math.max(0, Math.min(1, 1 - ssResidual / syy));
  return { ok: true, slope, intercept, r2, n };
}

/** A fit coefficient as text: 4 significant figures, exponential when fixed
 * notation would be all zeroes or too long. Not `formatNumber`, which would
 * render a slope of 0.00042 as 0. */
export function fitNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const size = Math.abs(value);
  if (size !== 0 && (size < 1e-3 || size >= 1e6)) return value.toExponential(2);
  // Number() drops toPrecision's padding zeroes: 12.00 reads as 12.
  return String(Number(value.toPrecision(4)));
}

/** The equation in the axes' own terms, and R². */
export function fitCaption(fit: XyFit): string {
  if (!fit.ok) return `No fit — ${fit.reason}.`;
  // ASCII minus, matching `fitNumber`'s, so the equation uses one sign.
  const sign = fit.intercept < 0 ? '-' : '+';
  return (
    `y = ${fitNumber(fit.slope)}·x ${sign} ${fitNumber(Math.abs(fit.intercept))}` +
    `   R² = ${fit.r2.toFixed(4)}`
  );
}

/** Both sides' kept years in pairing order, or none when a side has no
 * Case year to name. */
function pairYears(pairing: Extract<Pairing, { ok: true }>): {
  years?: { x: number[]; y: number[] };
} {
  const x = datedYears(pairing.x);
  const y = datedYears(pairing.y);
  return x.length === pairing.x.length && y.length === pairing.y.length ? { years: { x, y } } : {};
}

/** `values`' kept slots, end to end. */
function keptValues(values: ArrayLike<number>, kept: readonly KeptSlot[]): Float32Array {
  const out = new Float32Array(kept.length * YEAR_SLOT_HOURS).fill(NaN);
  kept.forEach(({ slot }, k) => {
    const from = slot * YEAR_SLOT_HOURS;
    const to = Math.min(values.length, from + YEAR_SLOT_HOURS);
    for (let h = from; h < to; h++) out[k * YEAR_SLOT_HOURS + h - from] = values[h];
  });
  return out;
}

/** A line's full label: what the pane keys the user's choices by, never
 * `name`, which is relative to the other drawn lines and moves with them. */
const labelOf = (series: CaseSeries): string => series.detail ?? series.name;
/** What the X ⇄ Y choice is kept by: the browse row when the line has one,
 * since a "% of range" label moves with the hour filter. */
const swapKeyOf = (series: CaseSeries): string => series.rowId ?? labelOf(series);
/** A colour series' key: its browse row, which no filter changes (a "% of
 * range" label names its divisors and moves with the hours shown), else its
 * full label. */
const colourKeyOf = (series: CaseSeries): string =>
  XY_SERIES_PREFIX + (series.rowId ?? labelOf(series));

/** The drawn lines as X, Y and colour, or why they cannot be. */
type Layout =
  | { ok: true; pair: [CaseSeries, CaseSeries]; colouring: Colouring | null }
  | { ok: false; reason: string };

/** The key a pane draws above its plot, and a figure under its caption. */
export type XyKey =
  | {
      kind: 'swatches';
      title: string;
      /** What the caption says the points are coloured by. */
      by?: string;
      items: { color: string; label: string }[];
    }
  | {
      kind: 'signed';
      title: string;
      low: number;
      high: number;
      /** The series' unit, written after a value the key or hover names. */
      unit?: string;
      /** No plotted point has a value: there is no ramp to show. */
      empty?: boolean;
    };

/** A signed key's ramp runs through 0, so its black end is always shown:
 * a series that never goes negative reads from black at 0 to red. */
export function rampEnds(key: { low: number; high: number }): [number, number] {
  return [Math.min(key.low, 0), Math.max(key.high, 0)];
}

const CALENDAR_TITLE: Record<Exclude<XyColourBy, 'none'>, string> = {
  season: 'Season',
  month: 'Month',
  hourOfDay: 'Hour ending',
};
const CALENDAR_BY: Record<Exclude<XyColourBy, 'none'>, string> = {
  season: 'season',
  month: 'month',
  hourOfDay: 'hour of day',
};

/** A value followed by its unit, when it has one. */
const withUnit = (value: string, unit: string | undefined): string =>
  unit ? `${value} ${unit}` : value;

/** The points with no colour value, as the pane's key and the Figure's say it. */
export const missingColourText = (count: number): string =>
  `${count.toLocaleString('en-US')} h with no colour value`;

export function createXyAdapter(host: PaneHost): PaneAdapter {
  const { body, canvas, tip } = host;
  const { xySwap, xyFit, xyColour } = host.controls;
  let frame: PaneFrame | null = null;
  let geometry: XyGeometry | null = null;
  let hits: XyPoint[] = [];
  /** The pair as drawn, X first, for the resize path and the Figure. */
  let pair: [CaseSeries, CaseSeries] | null = null;
  let colouring: Colouring | null = null;
  /** The series this pane last put on X, by its browse row else its FULL
   * label, or null for selection order. A key, not an index, so a changed
   * selection cannot reassign the user's choice. Kept across types. */
  let xKey: string | null = null;

  /** The user's "colour on", kept on the select so a bundle can save and
   * restore it before a draw has offered a series choice. A series no longer
   * drawn is kept, and taken up again when it is. */
  const wanted = (): string => xyColour.dataset.want ?? 'none';

  // Redraw this pane only; the fit changes nothing else.
  xyFit.addEventListener('change', () => {
    if (pair) draw(pair[0], pair[1], xyFit.checked);
  });
  xySwap.addEventListener('click', () => {
    if (!frame || !pair) return;
    xKey = swapKeyOf(pair[1]);
    host.rerender();
  });
  // A series choice moves which lines are the pair: every pane's controls
  // and Figure buttons follow, so the whole render runs again.
  xyColour.addEventListener('change', () => {
    xyColour.dataset.want = xyColour.value;
    host.rerender();
  });

  /** The ordered pair to draw. A stored X no longer selected falls back to
   * selection order. */
  function xyPair(drawable: CaseSeries[]): [CaseSeries, CaseSeries] {
    const stored = xKey;
    const x = stored == null ? -1 : drawable.findIndex((s) => swapKeyOf(s) === stored);
    const xAxis = x >= 0 ? x : 0;
    return [drawable[xAxis], drawable[1 - xAxis]];
  }

  /** "Colour on" lists the drawn series only when there are three: with two,
   * each is already an axis. */
  function offerSeries(drawable: readonly CaseSeries[]): void {
    for (const option of Array.from(xyColour.children)) {
      if ((option as HTMLElement).dataset.series !== undefined) option.remove();
    }
    if (drawable.length === 3) {
      for (const series of drawable) {
        const option = document.createElement('option');
        option.value = colourKeyOf(series);
        option.textContent = series.name;
        option.dataset.series = '';
        xyColour.appendChild(option);
      }
    }
  }

  function layoutOf(drawable: CaseSeries[]): Layout {
    const want = wanted();
    if (drawable.length === 3) {
      const at = want.startsWith(XY_SERIES_PREFIX)
        ? drawable.findIndex((s) => colourKeyOf(s) === want)
        : -1;
      if (at < 0) {
        return {
          ok: false,
          reason:
            'Three series are drawn. Pick one in "colour on" to colour the points by, ' +
            'and the other two go on X and Y.',
        };
      }
      return {
        ok: true,
        pair: xyPair(drawable.filter((_, i) => i !== at)),
        colouring: { by: 'series', series: drawable[at] },
      };
    }
    if (drawable.length === 2) {
      const by = XY_COLOUR_BY.includes(want as XyColourBy) ? (want as XyColourBy) : 'none';
      return {
        ok: true,
        pair: xyPair(drawable),
        colouring: by === 'none' ? null : { by, series: null },
      };
    }
    return {
      ok: false,
      reason:
        'Select exactly two series to plot one against the other, or three to colour ' +
        `the points by one — ${drawable.length === 1 ? '1 is' : `${drawable.length} are`} drawn.`,
    };
  }

  /** One axis's label from THAT series' scale rules: the axes are different
   * quantities, and a shared read would borrow the other axis's numbers. */
  function axisLabel(series: CaseSeries): string {
    return scalesOf([series])[0]?.label ?? series.unit;
  }

  /** The key for what was drawn: categories, or a series' signed ramp. */
  function keyOf(drawn: XyGeometry): XyKey | null {
    const c = drawn.colouring;
    if (!c) return null;
    if (c.by === 'series') {
      return {
        kind: 'signed',
        title: c.series!.name,
        low: drawn.low,
        high: drawn.high,
        unit: c.series!.unit,
        ...(Number.isFinite(drawn.low) ? {} : { empty: true }),
      };
    }
    return {
      kind: 'swatches',
      title: CALENDAR_TITLE[c.by],
      by: CALENDAR_BY[c.by],
      items: calendarKey(c.by),
    };
  }

  /** The point's colour label for the hover. */
  function colourText(drawn: XyGeometry, point: XyPoint): string {
    const c = drawn.colouring!;
    if (!Number.isFinite(point.v)) {
      return 'no value';
    }
    return c.by === 'series'
      ? withUnit(formatNumber(point.v), c.series!.unit)
      : calendarKey(c.by)[point.v].label;
  }

  function clear(): void {
    geometry = null;
    hits = [];
    tip.style.display = 'none';
    canvas.style.display = 'none';
  }

  function hover(px: number, py: number): void {
    if (!geometry) return;
    let best = -1;
    let bestDistance = Infinity;
    hits.forEach((point, index) => {
      const distance = (point.px - px) ** 2 + (point.py - py) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    if (best < 0 || bestDistance > HOVER_RADIUS_PX * HOVER_RADIUS_PX) {
      tip.style.display = 'none';
      return;
    }

    const point = hits[best];
    const head = document.createElement('div');
    head.className = 'chart-tip-x';
    head.textContent = pairHourLabel(
      point.hour,
      geometry.xYears[point.k],
      geometry.yYears[point.k],
    );

    const row = (color: string, label: string, value: string): HTMLElement => {
      const element = document.createElement('div');
      element.className = 'chart-tip-row';
      const dot = document.createElement('span');
      dot.className = 'chart-tip-dot';
      dot.style.background = color;
      element.appendChild(dot);
      const name = document.createElement('span');
      name.className = 'chart-tip-name';
      name.textContent = label;
      element.appendChild(name);
      const number = document.createElement('b');
      number.textContent = value;
      element.appendChild(number);
      return element;
    };
    const rows = [
      row(geometry.x.color, geometry.x.name, formatNumber(point.x)),
      row(geometry.y.color, geometry.y.name, formatNumber(point.y)),
    ];
    const key = keyOf(geometry);
    if (key) rows.push(row(point.color, key.title, colourText(geometry, point)));

    tip.replaceChildren(head, ...rows);
    tip.style.display = '';
    const right = px < body.clientWidth / 2;
    tip.style.left = right ? 'auto' : '6px';
    tip.style.right = right ? '6px' : 'auto';
  }

  /** The key in its band above the plot: every category as a swatch when
   * they fit the width, else a strip naming its first and last; a series
   * as its ramp from its low to its high. Points with no colour are counted
   * after it. */
  function drawKey(
    context: CanvasRenderingContext2D,
    key: XyKey,
    missing: number,
    left: number,
    width: number,
    baseline: number,
  ): void {
    context.textAlign = 'left';
    context.fillStyle = '#444';
    const title = `${clip(context, key.title, width / 3)}:`;
    // Swatches at the points' alpha, so a key colour looks as its points do:
    // opaque, the grey of "no colour" would read as a series' 0 does.
    context.fillText(title, left, baseline);
    const swatch = (color: string, at: number, top: number, w: number, h: number): void => {
      context.globalAlpha = POINT_ALPHA;
      context.fillStyle = color;
      context.fillRect(at, top, w, h);
      context.globalAlpha = 1;
    };
    let x = left + context.measureText(title).width + 6;
    const swatchTop = baseline - SWATCH + 1;
    const label = (text: string): void => {
      context.fillStyle = '#444';
      context.fillText(text, x, baseline);
      x += context.measureText(text).width + 4;
    };
    if (key.kind === 'signed' && key.empty) {
      label('no values');
    } else if (key.kind === 'signed') {
      const [from, to] = rampEnds(key);
      label(formatNumber(from));
      for (let step = 0; step < 30; step++) {
        const value = from + ((to - from) * (step + 0.5)) / 30;
        const color = signedColor(value, key.low, key.high);
        swatch(color, x + (step * RAMP_PX) / 30, swatchTop, RAMP_PX / 30 + 0.25, SWATCH);
      }
      x += RAMP_PX + 4;
      label(withUnit(formatNumber(to), key.unit));
    } else {
      const widths = key.items.map(
        (item) => SWATCH + 3 + context.measureText(item.label).width + 8,
      );
      if (widths.reduce((sum, w) => sum + w, 0) <= left + width - x) {
        key.items.forEach((item, i) => {
          swatch(item.color, x, swatchTop, SWATCH, SWATCH);
          context.fillStyle = '#444';
          context.fillText(item.label, x + SWATCH + 3, baseline);
          x += widths[i];
        });
      } else {
        label(key.items[0].label);
        const cell = Math.max(2, Math.min(SWATCH, RAMP_PX / key.items.length));
        key.items.forEach((item, i) => {
          swatch(item.color, x + i * cell, swatchTop, cell, SWATCH);
        });
        x += cell * key.items.length + 4;
        label(key.items[key.items.length - 1].label);
      }
    }
    if (missing > 0) {
      x += 4;
      swatch(NO_COLOUR, x, swatchTop, SWATCH, SWATCH);
      x += SWATCH + 3;
      context.fillStyle = '#444';
      context.fillText(clip(context, missingColourText(missing), left + width - x), x, baseline);
    }
  }

  function draw(xs: CaseSeries, ys: CaseSeries, fit = false): void {
    if (!frame) return;
    const pairing = pairingOf(xs, ys, frame.input, colouring?.series ?? null);
    if (!pairing.ok) return;
    body.querySelectorAll('.pane-banner').forEach((node) => node.remove());
    const { width, height } = host.size();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.style.display = '';

    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const xv = xs.values;
    const yv = ys.values;
    const cv = colouring?.series?.values ?? null;
    const cSlots = colouring?.series ? keptSlots(colouring.series, frame.input) : [];
    const points: XyPoint[] = [];
    let xLow = Infinity;
    let xHigh = -Infinity;
    let yLow = Infinity;
    let yHigh = -Infinity;
    let cLow = Infinity;
    let cHigh = -Infinity;
    if (xv && yv) {
      pairing.x.forEach((xSlot, k) => {
        const xFrom = xSlot.slot * YEAR_SLOT_HOURS;
        const yFrom = pairing.y[k].slot * YEAR_SLOT_HOURS;
        const cFrom = (cSlots[k]?.slot ?? 0) * YEAR_SLOT_HOURS;
        const hours = Math.min(YEAR_SLOT_HOURS, xv.length - xFrom, yv.length - yFrom);
        for (let hour = 0; hour < hours; hour++) {
          const x = xv[xFrom + hour];
          const y = yv[yFrom + hour];
          // A pair needs both sides; NaN on either leaves no point.
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          xLow = Math.min(xLow, x);
          xHigh = Math.max(xHigh, x);
          yLow = Math.min(yLow, y);
          yHigh = Math.max(yHigh, y);
          let v = NaN;
          if (cv) {
            v = cFrom + hour < cv.length ? cv[cFrom + hour] : NaN;
            if (Number.isFinite(v)) {
              cLow = Math.min(cLow, v);
              cHigh = Math.max(cHigh, v);
            } else v = NaN;
          } else if (colouring && colouring.by !== 'series') {
            v = calendarIndex(colouring.by, hour);
          }
          points.push({ x, y, hour, k, v, color: '#333', px: 0, py: 0 });
        }
      });
    }
    if (points.length === 0) {
      geometry = null;
      hits = [];
      canvas.style.display = 'none';
      host.banner(
        'refusal',
        'No kept hour has a value in both series, so there is no point to plot. ' +
          'The filters may not overlap.',
      );
      return;
    }
    if (xLow === xHigh) {
      xLow -= 1;
      xHigh += 1;
    }
    if (yLow === yHigh) {
      yLow -= 1;
      yHigh += 1;
    }
    let missing = 0;
    if (colouring) {
      const key = colouring.by === 'series' ? null : calendarKey(colouring.by);
      for (const point of points) {
        if (!Number.isFinite(point.v)) {
          point.color = NO_COLOUR;
          missing++;
        } else {
          point.color = key ? key[point.v].color : signedColor(point.v, cLow, cHigh);
        }
      }
    }

    const marginLeft = 56 + AXIS_LABEL;
    const marginRight = 8;
    const marginBottom = 34;
    const marginTop = TOP_PAD + (fit ? FIT_CAPTION_BAND : 0) + (colouring ? KEY_BAND : 0);
    const plotWidth = width - marginLeft - marginRight;
    const plotHeight = height - marginTop - marginBottom;
    const xToPx = (value: number) => marginLeft + plotWidth * ((value - xLow) / (xHigh - xLow));
    const yToPx = (value: number) => marginTop + plotHeight * (1 - (value - yLow) / (yHigh - yLow));
    for (const point of points) {
      point.px = xToPx(point.x);
      point.py = yToPx(point.y);
    }

    context.font = '10px system-ui, sans-serif';
    for (let tick = 0; tick <= TICKS; tick++) {
      const fraction = tick / TICKS;
      const valueX = xLow + (xHigh - xLow) * fraction;
      const px = marginLeft + plotWidth * fraction;
      context.strokeStyle = '#e8e8e8';
      context.beginPath();
      context.moveTo(px, marginTop);
      context.lineTo(px, marginTop + plotHeight);
      context.stroke();
      context.fillStyle = '#666';
      context.textAlign = 'center';
      context.fillText(formatNumber(valueX), px, marginTop + plotHeight + 12);

      const valueY = yLow + (yHigh - yLow) * fraction;
      const py = marginTop + plotHeight * (1 - fraction);
      context.strokeStyle = '#e8e8e8';
      context.beginPath();
      context.moveTo(marginLeft, py);
      context.lineTo(marginLeft + plotWidth, py);
      context.stroke();
      context.fillStyle = '#666';
      context.textAlign = 'right';
      context.fillText(formatNumber(valueY), marginLeft - 6, py + 3);
    }
    context.textAlign = 'left';

    // Each axis is named and coloured by its series, pairing them without a
    // legend.
    context.fillStyle = xs.color;
    context.textAlign = 'center';
    context.fillText(
      clip(context, `${xs.name} (${axisLabel(xs)})`, plotWidth),
      marginLeft + plotWidth / 2,
      marginTop + plotHeight + 26,
    );
    context.save();
    context.translate(AXIS_LABEL - 4, marginTop + plotHeight / 2);
    context.rotate(-Math.PI / 2);
    context.fillStyle = ys.color;
    context.textAlign = 'center';
    context.fillText(clip(context, `${ys.name} (${axisLabel(ys)})`, plotHeight), 0, 0);
    context.restore();
    context.textAlign = 'left';

    context.globalAlpha = POINT_ALPHA;
    let fill = '';
    for (const point of points) {
      if (point.color !== fill) {
        fill = point.color;
        context.fillStyle = fill;
      }
      context.fillRect(
        point.px - POINT_SIZE / 2,
        point.py - POINT_SIZE / 2,
        POINT_SIZE,
        POINT_SIZE,
      );
    }
    context.globalAlpha = 1;

    // The fit last, over the points, or it is invisible.
    if (fit) {
      const line = fitLine(points);
      if (line.ok) {
        // Across the whole plotted x range, clipped because y can run far
        // outside the plot.
        context.save();
        context.beginPath();
        context.rect(marginLeft, marginTop, plotWidth, plotHeight);
        context.clip();
        context.strokeStyle = ys.color;
        context.lineWidth = 1.5;
        context.beginPath();
        context.moveTo(xToPx(xLow), yToPx(line.slope * xLow + line.intercept));
        context.lineTo(xToPx(xHigh), yToPx(line.slope * xHigh + line.intercept));
        context.stroke();
        context.restore();
      }
      // Drawn even when the fit failed: the refusal explains the missing line.
      context.fillStyle = line.ok ? ys.color : '#666';
      context.textAlign = 'left';
      context.font = '11px system-ui, sans-serif';
      context.fillText(clip(context, fitCaption(line), plotWidth), marginLeft, TOP_PAD + 11);
      context.font = '10px system-ui, sans-serif';
    }

    geometry = {
      marginLeft,
      marginTop,
      plotWidth,
      plotHeight,
      x: { name: xs.name, color: xs.color },
      y: { name: ys.name, color: ys.color },
      colouring,
      low: cLow,
      high: cHigh,
      xYears: pairing.x.map((slot) => slot.year),
      yYears: pairing.y.map((slot) => slot.year),
    };
    const key = keyOf(geometry);
    if (key) {
      drawKey(
        context,
        key,
        missing,
        marginLeft,
        plotWidth,
        TOP_PAD + (fit ? FIT_CAPTION_BAND : 0) + 11,
      );
    }
    hits = points;
  }

  /** Whether the pair draws, for the swap and fit. */
  function pairDraws(shown: PaneFrame): boolean {
    const layout = layoutOf(shown.drawable);
    return (
      layout.ok &&
      pairingOf(layout.pair[0], layout.pair[1], shown.input, layout.colouring?.series ?? null).ok
    );
  }

  return {
    surface: 'canvas',
    // The swap and fit need a pair that draws; "colour on" shows with three
    // drawn too, since it is how three become a pair. A scatter has no zoom
    // and no hour axis to download.
    controls(shown) {
      const count = shown.drawable.length;
      offerSeries(shown.drawable);
      const want = wanted();
      const offered =
        XY_COLOUR_BY.includes(want as XyColourBy) ||
        (count === 3 && shown.drawable.some((s) => colourKeyOf(s) === want));
      xyColour.value = offered ? want : 'none';
      return [
        ...(pairDraws(shown) ? (['xy'] as const) : []),
        ...(count === 2 || count === 3 ? (['xyColour'] as const) : []),
      ];
    },
    draw(next) {
      frame = next;
      tip.style.display = 'none';
      const layout = layoutOf(next.drawable);
      if (!layout.ok) {
        pair = null;
        colouring = null;
        clear();
        host.banner('refusal', layout.reason);
        return;
      }
      const [xs, ys] = layout.pair;
      colouring = layout.colouring;
      const pairing = pairingOf(xs, ys, next.input, colouring?.series ?? null);
      if (!pairing.ok) {
        pair = null;
        colouring = null;
        clear();
        host.banner('refusal', pairing.reason);
        return;
      }
      pair = [xs, ys];
      xySwap.title = `Put ${ys.name} on X and ${xs.name} on Y`;
      host.note(
        `X ${xs.name} / Y ${ys.name}` +
          (colouring?.series ? ` / colour ${colouring.series.name}` : ''),
      );
      draw(xs, ys, xyFit.checked);
      if (next.zeroText) host.banner('note', next.zeroText);
    },
    leave() {
      frame = null;
      pair = null;
      colouring = null;
      clear();
    },
    resize() {
      if (pair) draw(pair[0], pair[1], xyFit.checked);
    },
    hover,
    unhover() {
      tip.style.display = 'none';
    },
    figure: {
      // A pair or colour with the preview in it would lose a quantity.
      offered: () => !pair?.some((s) => s.dashed) && !colouring?.series?.dashed,
      capture() {
        if (!frame || !pair || !geometry) return null;
        const colourSeries = colouring?.series ?? null;
        const pairing = pairingOf(pair[0], pair[1], frame.input, colourSeries);
        if (!pairing.ok) return null;
        const pinned = pinnedOf(frame.input.series);
        const key = keyOf(geometry);
        // Each point's colour by its place in the kept values, as drawn.
        const colours = key ? new Array<string>(pairing.x.length * YEAR_SLOT_HOURS).fill('') : null;
        if (colours)
          for (const point of hits) colours[point.k * YEAR_SLOT_HOURS + point.hour] = point.color;
        const shot = figureShot(host, frame.input, {
          pane: 'xy',
          // X first, as the pane holds it after any swap. The colour series
          // is named by the key, not drawn as a line.
          ordered: [...pair, ...pinned.filter((s) => s.values === null)],
          // No zoom: a scatter's window is its pair's own values.
          xWindow: [0, 1],
          xy: {
            fit: xyFit.checked,
            ...pairYears(pairing),
            ...(key && colours
              ? {
                  colour: {
                    key,
                    colours,
                    ...(colourSeries
                      ? {
                          line: {
                            name: colourSeries.name,
                            facets: colourSeries.facets,
                            warnings: colourSeries.warnings,
                          },
                        }
                      : {}),
                  },
                }
              : {}),
          },
        });
        // Each side cut to its kept years, laid end to end, so the figure
        // pairs by index exactly as the pane did.
        const kept = [pairing.x, pairing.y];
        const lines = shot.capture.lines.map((line, side) =>
          side < 2 && line.values ? { ...line, values: keptValues(line.values, kept[side]) } : line,
        );
        // A pair has an hour only where both sides' years do: Feb 29 against
        // a non-leap year pairs nothing.
        let hours = 0;
        pairing.x.forEach((xSlot, k) => {
          const real = (slot: KeptSlot) => realHours(slot.year ?? NO_YEAR, 1);
          hours += Math.min(real(xSlot), real(pairing.y[k]));
        });
        return { ...shot, capture: { ...shot.capture, lines, realHours: hours } };
      },
    },
  };
}
