// src/ui/panes/heatmap.ts
//
// The 24x366 diurnal heatmap chart type, hand-drawn because uPlot draws 1D
// ascending x-axes, not a matrix. Day of the leap-calendar slot across, hour
// of day up; a non-leap year's Feb 29 column is blank, as missing data is.
// Diverging palette when values span zero (flows, storage), sequential
// (viridis) when non-negative. One series: the pane names which of the drawn
// lines it painted. The scale and colour rules are exported for the print
// figure, so the two cannot paint one series differently.

import type { CaseSeries } from '../charts';
import {
  MONTH_NAMES,
  SLOT_MONTH_LENGTHS,
  SLOT_MONTH_STARTS,
  YEAR_SLOT_DAYS,
} from '../../model/calendar';
import { clip, formatNumber, hourLabel } from '../chart-format';
import { figureShot, pinnedOf, type PaneAdapter, type PaneFrame, type PaneHost } from './adapter';

interface HeatmapGeometry {
  marginLeft: number;
  marginTop: number;
  plotWidth: number;
  plotHeight: number;
  scale: HeatmapScale;
  series: CaseSeries;
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

export function createHeatmapAdapter(host: PaneHost): PaneAdapter {
  const { body, canvas, tip } = host;
  let frame: PaneFrame | null = null;
  let geometry: HeatmapGeometry | null = null;
  // Track the hovered cell to draw a cursor outline without repainting the entire matrix
  let hoveredCell = { day: -1, hour: -1 };

  function clear(): void {
    geometry = null;
    hoveredCell = { day: -1, hour: -1 };
    tip.style.display = 'none';
    canvas.style.display = 'none';
  }

  function clearHover(): void {
    tip.style.display = 'none';
    if (hoveredCell.day >= 0) {
      hoveredCell = { day: -1, hour: -1 };
      if (geometry) draw(geometry.series);
    }
  }

  function hover(px: number, py: number): void {
    if (!geometry) return;

    const { marginLeft, marginTop, plotWidth, plotHeight, series } = geometry;
    const values = series.values;
    if (!values) return;

    const inside =
      px >= marginLeft &&
      px <= marginLeft + plotWidth &&
      py >= marginTop &&
      py <= marginTop + plotHeight;

    if (!inside) {
      clearHover();
      return;
    }

    // X is the slot's day (0..365, Jan 1 to Dec 31, Feb 29 = 59)
    const d = Math.max(
      0,
      Math.min(YEAR_SLOT_DAYS - 1, Math.floor(((px - marginLeft) / plotWidth) * YEAR_SLOT_DAYS)),
    );
    // Y is Hour of Day (Hour 24 at top, Hour 1 at bottom)
    const r = Math.max(
      0,
      Math.min(HOURS_IN_DAY - 1, Math.floor(((py - marginTop) / plotHeight) * HOURS_IN_DAY)),
    );
    const h = HOURS_IN_DAY - 1 - r;

    const prev = hoveredCell;
    if (prev.day !== d || prev.hour !== h) {
      hoveredCell = { day: d, hour: h };
      renderWithCursor(geometry, d, h);
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

    const right = px < body.clientWidth / 2;
    tip.style.left = right ? 'auto' : '6px';
    tip.style.right = right ? '6px' : 'auto';
  }

  function draw(series: CaseSeries): void {
    body.querySelectorAll('.pane-banner').forEach((node) => node.remove());

    const values = series.values;
    if (!values || values.length === 0) {
      clear();
      host.banner('refusal', `No hourly values available for ${series.name}.`);
      return;
    }

    const scale = heatmapScale(values);
    if (!scale) {
      clear();
      host.banner('refusal', `All values in ${series.name} are blank or non-finite.`);
      return;
    }
    const { width, height } = host.size();
    const ratio = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    canvas.style.display = '';

    const plotWidth = Math.max(48, width - MARGIN_LEFT - MARGIN_RIGHT);
    const plotHeight = Math.max(24, height - MARGIN_TOP - MARGIN_BOTTOM);

    const drawn: HeatmapGeometry = {
      marginLeft: MARGIN_LEFT,
      marginTop: MARGIN_TOP,
      plotWidth,
      plotHeight,
      scale,
      series,
    };

    geometry = drawn;
    hoveredCell = { day: -1, hour: -1 };

    renderWithCursor(drawn, -1, -1);
  }

  function renderWithCursor(drawn: HeatmapGeometry, cursorDay: number, cursorHour: number): void {
    const context = canvas.getContext('2d');
    if (!context) return;

    const ratio = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    context.save();
    context.scale(ratio, ratio);

    const { width, height } = host.size();
    context.clearRect(0, 0, width, height);

    const { marginLeft, marginTop, plotWidth, plotHeight, scale, series } = drawn;
    const values = series.values ?? [];

    const [low, high] = heatmapEnds(scale);

    // Precalculate day X positions (366 days across plotWidth)
    const dayX: number[] = new Array(YEAR_SLOT_DAYS + 1);
    for (let d = 0; d <= YEAR_SLOT_DAYS; d++) {
      dayX[d] = marginLeft + Math.round((d * plotWidth) / YEAR_SLOT_DAYS);
    }

    // Precalculate hour Y positions (24 hours across plotHeight, Hour 24 at top, Hour 1 at bottom)
    const hourY: number[] = new Array(HOURS_IN_DAY + 1);
    for (let r = 0; r <= HOURS_IN_DAY; r++) {
      hourY[r] = marginTop + Math.round((r * plotHeight) / HOURS_IN_DAY);
    }

    // Render 8,784 cells (X = day 0..365, Y = row 0..23 for hours 24..1)
    for (let d = 0; d < YEAR_SLOT_DAYS; d++) {
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

    for (let m = 0; m < 12; m++) {
      const startDay = SLOT_MONTH_STARTS[m];
      const mLen = SLOT_MONTH_LENGTHS[m];

      const xStart = dayX[startDay];
      const xMid = Math.round(marginLeft + ((startDay + mLen / 2) * plotWidth) / YEAR_SLOT_DAYS);

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

  return {
    surface: 'canvas',
    controls: () => [],
    draw(next) {
      frame = next;
      tip.style.display = 'none';
      const { drawable, zeroText } = next;
      const s = drawable[0];
      host.note(`${s.name}${drawable.length > 1 ? ` (1 of ${drawable.length})` : ''}`);
      draw(s);
      if (zeroText) host.banner('note', zeroText);
    },
    leave() {
      frame = null;
      clear();
    },
    resize() {
      if (geometry) draw(geometry.series);
    },
    hover,
    unhover() {
      tip.style.display = 'none';
      if (geometry) clearHover();
    },
    figure: {
      offered: () => true,
      capture() {
        // The one series the pane painted, first; the pinned lines it left
        // out ride along, named as such.
        const painted = geometry?.series;
        if (!frame || !painted || painted.dashed) return null;
        const pinned = pinnedOf(frame.input.series);
        return figureShot(host, frame.input, {
          pane: 'heatmap',
          ordered: [painted, ...pinned.filter((s) => s !== painted)],
          xWindow: [0, 1],
          onlyOne: 'A heatmap paints one series.',
        });
      },
    },
  };
}
