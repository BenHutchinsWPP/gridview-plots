// src/ui/panes/xy.ts
//
// The X-Y scatter chart type. uPlot panes assume an ascending x of
// hour-of-year, which a scatter's x (one series' values) is not; drawing it
// directly is simpler than bending uPlot and its helpers around it. It draws
// exactly two series or refuses: plotting the first two of five would
// misstate what was compared. `fitLine` is exported for its own test and the
// print figure, since the arithmetic is the half that can be silently wrong.
//
// Cases of several years pair by position: the kth year each side keeps
// under the Years filter against the other's kth, hour by hour within the
// slot, so 2034 can be read against 2035. Rejected: pairing only the years
// both sides share, which would leave two Cases of different years nothing
// to compare. Different counts of kept years have no pairing and refuse.

import { YEAR_SLOT_HOURS, realHours } from '../../model/calendar';
import { NO_YEAR } from '../../app/boxes';
import { scalesOf } from '../../series/scales';
import type { CaseSeries, ChartsInput } from '../charts';
import { clip, formatNumber, hourLabel } from '../chart-format';
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
  px: number;
  py: number;
}

/** The plot rectangle plus the two series' names and colours, for hovers. */
interface XyGeometry {
  marginLeft: number;
  marginTop: number;
  plotWidth: number;
  plotHeight: number;
  x: { name: string; color: string };
  y: { name: string; color: string };
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

function pairingOf(xs: CaseSeries, ys: CaseSeries, input: ChartsInput): Pairing {
  const x = keptSlots(xs, input);
  const y = keptSlots(ys, input);
  if (x.length === y.length) return { ok: true, x, y };
  const side = (series: CaseSeries, kept: KeptSlot[]): string => {
    if (kept.length === 0) return `${series.name} keeps no year`;
    const years = datedYears(kept);
    if (years.length < kept.length) {
      return `${series.name} holds ${kept.length === 1 ? 'one undated year' : `${kept.length} undated years`}`;
    }
    const whole = Math.max(1, Math.ceil((series.values?.length ?? 0) / YEAR_SLOT_HOURS));
    return `${series.name} ${kept.length < whole ? 'keeps' : 'spans'} ${yearsText(years)}`;
  };
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

export function createXyAdapter(host: PaneHost): PaneAdapter {
  const { body, canvas, tip } = host;
  const { xySwap, xyFit } = host.controls;
  let frame: PaneFrame | null = null;
  let geometry: XyGeometry | null = null;
  let hits: XyPoint[] = [];
  /** The pair as drawn, X first, for the resize path and the Figure. */
  let pair: [CaseSeries, CaseSeries] | null = null;
  /** The series this pane last put on X, by its FULL label, or null for
   * selection order. A label, not an index, so a changed selection cannot
   * reassign the user's choice; not `name`, which is relative to the other
   * drawn line and moves when it does. Kept across types. */
  let xLabel: string | null = null;

  // Redraw this pane only; the fit changes nothing else.
  xyFit.addEventListener('change', () => {
    if (pair) draw(pair[0], pair[1], xyFit.checked);
  });
  xySwap.addEventListener('click', () => {
    if (!frame || frame.drawable.length !== 2) return;
    const next = xyPair(frame.drawable)[1];
    xLabel = next.detail ?? next.name;
    host.rerender();
  });

  /** The ordered pair to draw. A stored X no longer selected falls back to
   * selection order. */
  function xyPair(drawable: CaseSeries[]): [CaseSeries, CaseSeries] {
    const stored = xLabel;
    const x = stored == null ? -1 : drawable.findIndex((s) => (s.detail ?? s.name) === stored);
    const xAxis = x >= 0 ? x : 0;
    return [drawable[xAxis], drawable[1 - xAxis]];
  }

  /** One axis's label from THAT series' scale rules: the axes are different
   * quantities, and a shared read would borrow the other axis's numbers. */
  function axisLabel(series: CaseSeries): string {
    return scalesOf([series])[0]?.label ?? series.unit;
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

    const rows = [geometry.x, geometry.y].map((axis, side) => {
      const row = document.createElement('div');
      row.className = 'chart-tip-row';
      const dot = document.createElement('span');
      dot.className = 'chart-tip-dot';
      dot.style.background = axis.color;
      row.appendChild(dot);
      const name = document.createElement('span');
      name.className = 'chart-tip-name';
      name.textContent = axis.name;
      row.appendChild(name);
      const number = document.createElement('b');
      number.textContent = formatNumber(side === 0 ? point.x : point.y);
      row.appendChild(number);
      return row;
    });

    tip.replaceChildren(head, ...rows);
    tip.style.display = '';
    const right = px < body.clientWidth / 2;
    tip.style.left = right ? 'auto' : '6px';
    tip.style.right = right ? '6px' : 'auto';
  }

  function draw(xs: CaseSeries, ys: CaseSeries, fit = false): void {
    if (!frame) return;
    const pairing = pairingOf(xs, ys, frame.input);
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
    const points: XyPoint[] = [];
    let xLow = Infinity;
    let xHigh = -Infinity;
    let yLow = Infinity;
    let yHigh = -Infinity;
    if (xv && yv) {
      pairing.x.forEach((xSlot, k) => {
        const xFrom = xSlot.slot * YEAR_SLOT_HOURS;
        const yFrom = pairing.y[k].slot * YEAR_SLOT_HOURS;
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
          points.push({ x, y, hour, k, px: 0, py: 0 });
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

    const marginLeft = 56 + AXIS_LABEL;
    const marginRight = 8;
    const marginBottom = 34;
    const marginTop = 10 + (fit ? FIT_CAPTION_BAND : 0);
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
    context.fillStyle = '#333';
    for (const point of points) {
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
      context.fillText(
        clip(context, fitCaption(line), plotWidth),
        marginLeft,
        marginTop - FIT_CAPTION_BAND + 11,
      );
      context.font = '10px system-ui, sans-serif';
    }

    geometry = {
      marginLeft,
      marginTop,
      plotWidth,
      plotHeight,
      x: { name: xs.name, color: xs.color },
      y: { name: ys.name, color: ys.color },
      xYears: pairing.x.map((slot) => slot.year),
      yYears: pairing.y.map((slot) => slot.year),
    };
    hits = points;
  }

  return {
    surface: 'canvas',
    // The swap and fit need exactly two series that pair; a scatter has no
    // zoom and no hour axis to download.
    controls: (shown) =>
      shown.drawable.length === 2 && pairingOf(shown.drawable[0], shown.drawable[1], shown.input).ok
        ? ['xy']
        : [],
    draw(next) {
      frame = next;
      tip.style.display = 'none';
      const { drawable, zeroText } = next;
      if (drawable.length !== 2) {
        pair = null;
        clear();
        host.banner(
          'refusal',
          `Select exactly two series to plot one against the other — ${
            drawable.length === 1 ? '1 is' : `${drawable.length} are`
          } drawn.`,
        );
        return;
      }
      const [xs, ys] = xyPair(drawable);
      const pairing = pairingOf(xs, ys, next.input);
      if (!pairing.ok) {
        pair = null;
        clear();
        host.banner('refusal', pairing.reason);
        return;
      }
      pair = [xs, ys];
      xySwap.title = `Put ${ys.name} on X and ${xs.name} on Y`;
      host.note(`X ${xs.name} / Y ${ys.name}`);
      draw(xs, ys, xyFit.checked);
      if (zeroText) host.banner('note', zeroText);
    },
    leave() {
      frame = null;
      pair = null;
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
      // A pair with the preview in it would lose an axis.
      offered: () => !pair?.some((s) => s.dashed),
      capture() {
        if (!frame || !pair) return null;
        const pairing = pairingOf(pair[0], pair[1], frame.input);
        if (!pairing.ok) return null;
        const pinned = pinnedOf(frame.input.series);
        const shot = figureShot(host, frame.input, {
          pane: 'xy',
          // X first, as the pane holds it after any swap.
          ordered: [...pair, ...pinned.filter((s) => s.values === null)],
          // No zoom: a scatter's window is its pair's own values.
          xWindow: [0, 1],
          xy: { fit: xyFit.checked, ...pairYears(pairing) },
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
