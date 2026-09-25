// src/ui/heatmap-plot.ts
//
// The 24x365 diurnal heatmap pane, hand-drawn because uPlot draws 1D
// ascending x-axes, not a matrix. Hour of day across, Jan 1..Dec 31 down.
// Diverging palette when values span zero (flows, storage), sequential
// (viridis) when non-negative. Geometry and hovers are owned by charts.ts via
// `deps`, so the pane holds no state across redraws.

import type { CaseSeries } from './charts';
import { MONTH_NAMES, MONTH_LENGTHS } from '../model/calendar';

export interface HeatmapGeometry {
  marginLeft: number;
  marginTop: number;
  plotWidth: number;
  plotHeight: number;
  scale: HeatmapScale;
  series: CaseSeries;
}

export interface HeatmapPlotDeps {
  paneBodies: HTMLElement[];
  slotCanvases: HTMLCanvasElement[];
  slotTips: HTMLElement[];
  slotHeatmapGeometry: (HeatmapGeometry | null)[];
  paneSize(body: HTMLElement): { width: number; height: number };
  formatNumber(value: number): string;
  hourLabel(hour: number): string;
  banner(body: HTMLElement, kind: 'refusal' | 'note', text: string): void;
  clip(context: CanvasRenderingContext2D, text: string, maxWidth: number): string;
}

export interface HeatmapPlot {
  draw(slotIndex: number, series: CaseSeries): void;
  clear(slotIndex: number): void;
  hover(slotIndex: number, px: number, py: number): void;
  clearHover(slotIndex: number): void;
}

// ----------------------------------------------------------- color palettes

type Rgb = [number, number, number];

// Viridis color ramp stops (t: 0.0 to 1.0)
const VIRIDIS_STOPS: readonly { t: number; rgb: Rgb }[] = [
  { t: 0.0, rgb: [68, 1, 84] },
  { t: 0.25, rgb: [59, 82, 139] },
  { t: 0.5, rgb: [33, 145, 140] },
  { t: 0.75, rgb: [94, 201, 98] },
  { t: 1.0, rgb: [253, 231, 37] },
];

// Cool-Warm diverging stops (negative blue -> neutral off-white -> positive red)
const COOLWARM_STOPS: readonly { t: number; rgb: Rgb }[] = [
  { t: 0.0, rgb: [33, 102, 172] },
  { t: 0.25, rgb: [103, 169, 207] },
  { t: 0.5, rgb: [247, 247, 247] },
  { t: 0.75, rgb: [239, 138, 98] },
  { t: 1.0, rgb: [178, 24, 43] },
];

function interpolatePalette(t: number, stops: readonly { t: number; rgb: Rgb }[]): string {
  const clamped = Math.max(0, Math.min(1, t));
  for (let i = 0; i < stops.length - 1; i++) {
    const s0 = stops[i];
    const s1 = stops[i + 1];
    if (clamped <= s1.t) {
      const f = (clamped - s0.t) / (s1.t - s0.t);
      const r = Math.round(s0.rgb[0] + f * (s1.rgb[0] - s0.rgb[0]));
      const g = Math.round(s0.rgb[1] + f * (s1.rgb[1] - s0.rgb[1]));
      const b = Math.round(s0.rgb[2] + f * (s1.rgb[2] - s0.rgb[2]));
      return `rgb(${r},${g},${b})`;
    }
  }
  const last = stops[stops.length - 1].rgb;
  return `rgb(${last[0]},${last[1]},${last[2]})`;
}

export function viridisColor(t: number): string {
  return interpolatePalette(t, VIRIDIS_STOPS);
}

export function coolwarmColor(t: number): string {
  return interpolatePalette(t, COOLWARM_STOPS);
}

/** A cell with no value: filtered out or missing, never zero. */
export const HEATMAP_EMPTY = '#f0f0f0';

/** The colour scale a series is painted on. Shared with the print figure,
 * so the two cannot choose different palettes for one series. */
export interface HeatmapScale {
  readonly min: number;
  readonly max: number;
  /** Values span zero: blue below, red above, symmetric about zero. */
  readonly diverging: boolean;
}

/** The scale for `values`, or null when no hour has a finite value. */
export function heatmapScale(values: ArrayLike<number>): HeatmapScale | null {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isFinite(v)) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (min === max) max = min + 1;
  return { min, max, diverging: min < 0 && max > 0 };
}

/** The value at each end of the scale's colour ramp. */
export function heatmapEnds(scale: HeatmapScale): [number, number] {
  const maxAbs = Math.max(Math.abs(scale.min), Math.abs(scale.max));
  return scale.diverging ? [-maxAbs, maxAbs] : [scale.min, scale.max];
}

/** One cell's colour, `HEATMAP_EMPTY` where it has no value. */
export function heatmapColor(value: number, scale: HeatmapScale): string {
  if (!Number.isFinite(value)) return HEATMAP_EMPTY;
  const [low, high] = heatmapEnds(scale);
  const t = (value - low) / (high - low);
  return scale.diverging ? coolwarmColor(t) : viridisColor(t);
}

// ----------------------------------------------------------------- geometry

const MARGIN_LEFT = 34;
const MARGIN_TOP = 22;
const MARGIN_BOTTOM = 36;
const MARGIN_RIGHT = 78;

const HOURS_IN_DAY = 24;
const DAYS_IN_YEAR = 365;

export function createHeatmapPlot(deps: HeatmapPlotDeps): HeatmapPlot {
  const {
    paneBodies,
    slotCanvases,
    slotTips,
    slotHeatmapGeometry,
    paneSize,
    formatNumber,
    hourLabel,
    clip,
  } = deps;

  // Track the hovered cell to draw a cursor outline without repainting the entire matrix
  const slotHoveredCell = Array.from({ length: 4 }, () => ({ day: -1, hour: -1 }));

  function clear(slotIndex: number): void {
    slotHeatmapGeometry[slotIndex] = null;
    slotHoveredCell[slotIndex] = { day: -1, hour: -1 };
    slotTips[slotIndex].style.display = 'none';
    slotCanvases[slotIndex].style.display = 'none';
  }

  function clearHover(slotIndex: number): void {
    slotTips[slotIndex].style.display = 'none';
    if (slotHoveredCell[slotIndex].day >= 0) {
      slotHoveredCell[slotIndex] = { day: -1, hour: -1 };
      const geom = slotHeatmapGeometry[slotIndex];
      if (geom) draw(slotIndex, geom.series);
    }
  }

  function hover(slotIndex: number, px: number, py: number): void {
    const geometry = slotHeatmapGeometry[slotIndex];
    if (!geometry) return;

    const { marginLeft, marginTop, plotWidth, plotHeight, series } = geometry;
    const values = series.values;
    if (!values) return;

    const inside =
      px >= marginLeft &&
      px <= marginLeft + plotWidth &&
      py >= marginTop &&
      py <= marginTop + plotHeight;

    const tip = slotTips[slotIndex];
    if (!inside) {
      clearHover(slotIndex);
      return;
    }

    // X is Day of Year (0..364, Jan 1 to Dec 31)
    const d = Math.max(
      0,
      Math.min(DAYS_IN_YEAR - 1, Math.floor(((px - marginLeft) / plotWidth) * DAYS_IN_YEAR)),
    );
    // Y is Hour of Day (Hour 24 at top, Hour 1 at bottom)
    const r = Math.max(
      0,
      Math.min(HOURS_IN_DAY - 1, Math.floor(((py - marginTop) / plotHeight) * HOURS_IN_DAY)),
    );
    const h = HOURS_IN_DAY - 1 - r;

    const prev = slotHoveredCell[slotIndex];
    if (prev.day !== d || prev.hour !== h) {
      slotHoveredCell[slotIndex] = { day: d, hour: h };
      renderWithCursor(slotIndex, geometry, d, h);
    }

    const hourIdx = d * HOURS_IN_DAY + h;
    const val = values[hourIdx];

    const head = document.createElement('div');
    head.className = 'chart-tip-x';
    head.textContent = `${hourLabel(hourIdx)} (Hour ${hourIdx + 1})`;

    const row = document.createElement('div');
    row.className = 'chart-tip-row';

    const dot = document.createElement('span');
    dot.className = 'chart-tip-dot';
    dot.style.background = series.color;
    row.appendChild(dot);

    const name = document.createElement('span');
    name.className = 'chart-tip-name';
    name.textContent = series.name;
    row.appendChild(name);

    const num = document.createElement('b');
    num.textContent = Number.isFinite(val) ? `${formatNumber(val)} ${series.unit}` : '—';
    row.appendChild(num);

    tip.replaceChildren(head, row);
    tip.style.display = '';

    const right = px < paneBodies[slotIndex].clientWidth / 2;
    tip.style.left = right ? 'auto' : '6px';
    tip.style.right = right ? '6px' : 'auto';
  }

  function draw(slotIndex: number, series: CaseSeries): void {
    const body = paneBodies[slotIndex];
    body.querySelectorAll('.pane-banner').forEach((node) => node.remove());

    const values = series.values;
    if (!values || values.length === 0) {
      clear(slotIndex);
      deps.banner(body, 'refusal', `No hourly values available for ${series.name}.`);
      return;
    }

    const scale = heatmapScale(values);
    if (!scale) {
      clear(slotIndex);
      deps.banner(body, 'refusal', `All values in ${series.name} are blank or non-finite.`);
      return;
    }
    const { width, height } = paneSize(body);
    const ratio = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const canvas = slotCanvases[slotIndex];
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    canvas.style.display = '';

    const plotWidth = Math.max(48, width - MARGIN_LEFT - MARGIN_RIGHT);
    const plotHeight = Math.max(24, height - MARGIN_TOP - MARGIN_BOTTOM);

    const geometry: HeatmapGeometry = {
      marginLeft: MARGIN_LEFT,
      marginTop: MARGIN_TOP,
      plotWidth,
      plotHeight,
      scale,
      series,
    };

    slotHeatmapGeometry[slotIndex] = geometry;
    slotHoveredCell[slotIndex] = { day: -1, hour: -1 };

    renderWithCursor(slotIndex, geometry, -1, -1);
  }

  function renderWithCursor(
    slotIndex: number,
    geometry: HeatmapGeometry,
    cursorDay: number,
    cursorHour: number,
  ): void {
    const canvas = slotCanvases[slotIndex];
    const context = canvas.getContext('2d');
    if (!context) return;

    const ratio = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    context.save();
    context.scale(ratio, ratio);

    const { width, height } = paneSize(paneBodies[slotIndex]);
    context.clearRect(0, 0, width, height);

    const { marginLeft, marginTop, plotWidth, plotHeight, scale, series } = geometry;
    const values = series.values ?? [];

    const [low, high] = heatmapEnds(scale);

    // Precalculate day X positions (365 days across plotWidth)
    const dayX: number[] = new Array(DAYS_IN_YEAR + 1);
    for (let d = 0; d <= DAYS_IN_YEAR; d++) {
      dayX[d] = marginLeft + Math.round((d * plotWidth) / DAYS_IN_YEAR);
    }

    // Precalculate hour Y positions (24 hours across plotHeight, Hour 24 at top, Hour 1 at bottom)
    const hourY: number[] = new Array(HOURS_IN_DAY + 1);
    for (let r = 0; r <= HOURS_IN_DAY; r++) {
      hourY[r] = marginTop + Math.round((r * plotHeight) / HOURS_IN_DAY);
    }

    // Render 8,760 cells (X = day 0..364, Y = row 0..23 for hours 24..1)
    for (let d = 0; d < DAYS_IN_YEAR; d++) {
      const x0 = dayX[d];
      const cellW = Math.max(1, dayX[d + 1] - x0);
      const dayOffset = d * HOURS_IN_DAY;

      for (let r = 0; r < HOURS_IN_DAY; r++) {
        const h = HOURS_IN_DAY - 1 - r;
        const y0 = hourY[r];
        const cellH = Math.max(1, hourY[r + 1] - y0);
        context.fillStyle = heatmapColor(values[dayOffset + h], scale);
        context.fillRect(x0, y0, cellW, cellH);
      }
    }

    // Border around heatmap plot area
    context.strokeStyle = '#d0d0d0';
    context.lineWidth = 1;
    context.strokeRect(marginLeft, marginTop, plotWidth, plotHeight);

    // Month boundary lines and labels on bottom X-axis
    context.font = '10px system-ui, -apple-system, sans-serif';
    context.fillStyle = '#666666';
    context.textAlign = 'center';
    context.textBaseline = 'top';

    let dayAccum = 0;
    for (let m = 0; m < 12; m++) {
      const startDay = dayAccum;
      const mLen = MONTH_LENGTHS[m];
      dayAccum += mLen;

      const xStart = dayX[startDay];
      const xMid = Math.round(marginLeft + ((startDay + mLen / 2) * plotWidth) / DAYS_IN_YEAR);

      // Boundary divider tick on bottom
      if (m > 0) {
        context.strokeStyle = '#c0c0c0';
        context.beginPath();
        context.moveTo(xStart, marginTop + plotHeight);
        context.lineTo(xStart, marginTop + plotHeight + 4);
        context.stroke();
      }

      context.fillText(MONTH_NAMES[m], xMid, marginTop + plotHeight + 5);
    }

    // Hour ticks and labels on left Y-axis (HE 1, 6, 12, 18, 24)
    context.textAlign = 'right';
    context.textBaseline = 'middle';
    const hourTicks = [1, 6, 12, 18, 24];
    for (const h of hourTicks) {
      const r = HOURS_IN_DAY - h;
      const yMid = Math.round(marginTop + ((r + 0.5) * plotHeight) / HOURS_IN_DAY);
      context.strokeStyle = '#c0c0c0';
      context.beginPath();
      context.moveTo(marginLeft - 4, yMid);
      context.lineTo(marginLeft, yMid);
      context.stroke();
      context.fillText(String(h), marginLeft - 6, yMid);
    }

    // Y-axis label (HE at top of Y-axis)
    context.textAlign = 'right';
    context.textBaseline = 'bottom';
    context.fillStyle = '#888888';
    context.fillText('HE', marginLeft - 6, marginTop - 2);

    // Colorbar on the right
    const barX = marginLeft + plotWidth + 14;
    const barW = 10;
    const barY = marginTop;
    const barH = plotHeight;

    const grad = context.createLinearGradient(0, barY + barH, 0, barY);
    for (const stop of scale.diverging ? COOLWARM_STOPS : VIRIDIS_STOPS) {
      grad.addColorStop(stop.t, `rgb(${stop.rgb[0]},${stop.rgb[1]},${stop.rgb[2]})`);
    }

    context.fillStyle = grad;
    context.fillRect(barX, barY, barW, barH);
    context.strokeStyle = '#d0d0d0';
    context.strokeRect(barX, barY, barW, barH);

    // Colorbar labels
    context.fillStyle = '#444444';
    context.font = '10px system-ui, -apple-system, sans-serif';
    context.textAlign = 'left';

    // Unit title above bar
    context.textBaseline = 'bottom';
    context.fillText(clip(context, series.unit, MARGIN_RIGHT - 18), barX, barY - 4);

    // Max, mid and min labels
    context.textBaseline = 'middle';
    const mid = scale.diverging ? '0' : formatNumber((low + high) / 2);
    context.fillText(formatNumber(high), barX + barW + 4, barY + 2);
    context.fillText(mid, barX + barW + 4, Math.round(barY + barH / 2));
    context.fillText(formatNumber(low), barX + barW + 4, barY + barH - 2);

    // Hover cursor highlight
    if (cursorDay >= 0 && cursorHour >= 0) {
      const cursorRow = HOURS_IN_DAY - 1 - cursorHour;
      const cx = dayX[cursorDay];
      const cy = hourY[cursorRow];
      const cw = Math.max(1, dayX[cursorDay + 1] - cx);
      const ch = Math.max(2, hourY[cursorRow + 1] - cy);

      context.strokeStyle = '#ffffff';
      context.lineWidth = 2;
      context.strokeRect(cx - 0.5, cy - 0.5, cw + 1, ch + 1);
      context.strokeStyle = '#000000';
      context.lineWidth = 1;
      context.strokeRect(cx - 0.5, cy - 0.5, cw + 1, ch + 1);
    }

    context.restore();
  }

  return { draw, clear, hover, clearHover };
}
