// src/ui/xy-plot.ts
//
// The hand-drawn X-Y scatter pane. uPlot panes assume an ascending x of
// hour-of-year, which a scatter's x (one series' values) is not; drawing it
// directly is simpler than bending uPlot and its helpers around it. No state:
// arrays come from createCharts through `deps`, and it shares the box plot's
// canvas and hover tip. `fitLine` is exported for its own test, since the
// arithmetic is the half that can be silently wrong.

import type { CaseSeries } from './charts';

/** One plotted pair, with its canvas position for hover hit-testing. */
export interface XyPoint {
  x: number;
  y: number;
  hour: number;
  px: number;
  py: number;
}

/** The plot rectangle plus the two series' names and colours, for hovers. */
export interface XyGeometry {
  marginLeft: number;
  marginTop: number;
  plotWidth: number;
  plotHeight: number;
  x: { name: string; color: string };
  y: { name: string; color: string };
}

export interface XyPlotDeps {
  paneBodies: HTMLElement[];
  slotCanvases: HTMLCanvasElement[];
  slotTips: HTMLElement[];
  slotXyGeometry: (XyGeometry | null)[];
  slotXyHits: XyPoint[][];
  paneSize(body: HTMLElement): { width: number; height: number };
  scalesOf(series: { unit: string }[]): { scale: string; label: string }[];
  formatNumber(value: number): string;
  hourLabel(hour: number): string;
  banner(body: HTMLElement, kind: 'refusal' | 'note', text: string): void;
  clip(context: CanvasRenderingContext2D, text: string, maxWidth: number): string;
}

export interface XyPlot {
  draw(slotIndex: number, xs: CaseSeries, ys: CaseSeries, fit?: boolean): void;
  /** Erase the pane and drop its hover state, leaving the canvas hidden. */
  clear(slotIndex: number): void;
  hover(slotIndex: number, px: number, py: number): void;
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

export function createXyPlot(deps: XyPlotDeps): XyPlot {
  const {
    paneBodies,
    slotCanvases,
    slotTips,
    slotXyGeometry,
    slotXyHits,
    paneSize,
    scalesOf,
    formatNumber,
    hourLabel,
    banner,
    clip,
  } = deps;

  /** One axis's label from THAT series' scale rules: the axes are different
   * quantities, and a shared read would borrow the other axis's numbers. */
  function axisLabel(series: CaseSeries): string {
    return scalesOf([series])[0]?.label ?? series.unit;
  }

  function clear(slotIndex: number): void {
    slotXyGeometry[slotIndex] = null;
    slotXyHits[slotIndex] = [];
    slotTips[slotIndex].style.display = 'none';
    slotCanvases[slotIndex].style.display = 'none';
  }

  function hover(slotIndex: number, px: number, py: number): void {
    const geometry = slotXyGeometry[slotIndex];
    if (!geometry) return;
    let best = -1;
    let bestDistance = Infinity;
    slotXyHits[slotIndex].forEach((point, index) => {
      const distance = (point.px - px) ** 2 + (point.py - py) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    const tip = slotTips[slotIndex];
    if (best < 0 || bestDistance > HOVER_RADIUS_PX * HOVER_RADIUS_PX) {
      tip.style.display = 'none';
      return;
    }

    const point = slotXyHits[slotIndex][best];
    const head = document.createElement('div');
    head.className = 'chart-tip-x';
    head.textContent = hourLabel(point.hour);

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
    const right = px < paneBodies[slotIndex].clientWidth / 2;
    tip.style.left = right ? 'auto' : '6px';
    tip.style.right = right ? '6px' : 'auto';
  }

  function draw(slotIndex: number, xs: CaseSeries, ys: CaseSeries, fit = false): void {
    const body = paneBodies[slotIndex];
    body.querySelectorAll('.pane-banner').forEach((node) => node.remove());
    const { width, height } = paneSize(body);
    const ratio = window.devicePixelRatio || 1;
    const canvas = slotCanvases[slotIndex];
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
      const hours = Math.min(xv.length, yv.length);
      for (let hour = 0; hour < hours; hour++) {
        const x = xv[hour];
        const y = yv[hour];
        // A pair needs both sides; NaN on either leaves no point.
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        xLow = Math.min(xLow, x);
        xHigh = Math.max(xHigh, x);
        yLow = Math.min(yLow, y);
        yHigh = Math.max(yHigh, y);
        points.push({ x, y, hour, px: 0, py: 0 });
      }
    }
    if (points.length === 0) {
      slotXyGeometry[slotIndex] = null;
      slotXyHits[slotIndex] = [];
      canvas.style.display = 'none';
      banner(
        body,
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

    slotXyGeometry[slotIndex] = {
      marginLeft,
      marginTop,
      plotWidth,
      plotHeight,
      x: { name: xs.name, color: xs.color },
      y: { name: ys.name, color: ys.color },
    };
    slotXyHits[slotIndex] = points;
  }

  return { draw, clear, hover };
}
