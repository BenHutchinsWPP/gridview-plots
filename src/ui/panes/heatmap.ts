// src/ui/panes/heatmap.ts
//
// The 24x366 diurnal heatmap chart type, hand-drawn because uPlot draws 1D
// ascending x-axes, not a matrix. Day of the leap-calendar slot across, hour
// of day up; a non-leap year's Feb 29 column is blank, as missing data is.
// A Case spanning several years is one band per year, stacked first year on
// top, each labelled with its year and all on one colour scale, so a colour
// reads the same in every year. The Years filter chooses the bands.
// Diverging palette when values span zero (flows, storage), sequential
// (viridis) when non-negative. One series: the pane names which of the drawn
// lines it painted. The scale and colour rules are exported for the print
// figure, so the two cannot paint one series differently.

import type { CaseSeries, ChartsInput } from '../charts';
import {
  MONTH_NAMES,
  SLOT_MONTH_LENGTHS,
  SLOT_MONTH_STARTS,
  YEAR_SLOT_DAYS,
  YEAR_SLOT_HOURS,
  realHours,
} from '../../model/calendar';
import { clip, formatNumber, hourLabel } from '../chart-format';
import {
  figureShot,
  hasYear,
  pinnedOf,
  yearsShown,
  type PaneAdapter,
  type PaneFrame,
  type PaneHost,
} from './adapter';

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
const HOUR_TICKS: readonly number[] = [1, 6, 12, 18, 24];
/** The room above each year's band that holds its label. */
const BAND_GAP = 14;
/** A band shorter than this gives an hour under a pixel and its rows merge,
 * so the pane refuses rather than draw hours that cannot be told apart. */
export const MIN_BAND_PX = 24;

/** The hour-ending ticks a band of `height` (px or pt) carries: fewer as
 * stacked years make each band shorter, so their labels never overprint. */
export function bandHourTicks(height: number, stacked: boolean): readonly number[] {
  if (!stacked || height >= 80) return HOUR_TICKS;
  return height >= 40 ? [1, 12, 24] : [12];
}

interface HeatmapGeometry {
  marginLeft: number;
  marginTop: number;
  plotWidth: number;
  /** Every band and the gaps between them. */
  plotHeight: number;
  bandHeight: number;
  gap: number;
  /** Each band's year, top to bottom; undefined for a line with no Case. */
  years: (number | undefined)[];
  /** The line's Case spans several years: each band names its year. */
  labelled: boolean;
  /** The bands' hours, one year slot after another, as painted. */
  shown: Float32Array;
  scale: HeatmapScale;
  series: CaseSeries;
}

/**
 * The year slots of `series` a heatmap stacks, first year on top: every slot
 * its values hold, less the years the Years filter drops. A line with no
 * Case is one unnamed band per slot.
 */
function bandsOf(
  series: CaseSeries,
  values: Float32Array,
  input: ChartsInput,
): { years: (number | undefined)[]; shown: Float32Array; labelled: boolean } {
  const slots = Math.max(1, Math.ceil(values.length / YEAR_SLOT_HOURS));
  const first = input.spanOf?.(series).firstYear;
  const kept: { slot: number; year: number | undefined }[] = [];
  for (let slot = 0; slot < slots; slot++) {
    const year = hasYear(first) ? first + slot : undefined;
    if (year !== undefined && input.years && !input.years.has(year)) continue;
    kept.push({ slot, year });
  }
  const shown = new Float32Array(kept.length * YEAR_SLOT_HOURS).fill(NaN);
  kept.forEach(({ slot }, band) => {
    const from = slot * YEAR_SLOT_HOURS;
    shown.set(
      values.subarray(from, Math.min(values.length, from + YEAR_SLOT_HOURS)),
      band * YEAR_SLOT_HOURS,
    );
  });
  return { years: kept.map((k) => k.year), shown, labelled: slots > 1 && hasYear(first) };
}

export function createHeatmapAdapter(host: PaneHost): PaneAdapter {
  const { body, canvas, tip } = host;
  let frame: PaneFrame | null = null;
  let geometry: HeatmapGeometry | null = null;
  // Track the hovered cell to draw a cursor outline without repainting the entire matrix
  let hoveredCell = { band: -1, day: -1, hour: -1 };

  function clear(): void {
    geometry = null;
    hoveredCell = { band: -1, day: -1, hour: -1 };
    tip.style.display = 'none';
    canvas.style.display = 'none';
  }

  function clearHover(): void {
    tip.style.display = 'none';
    if (hoveredCell.day >= 0) {
      hoveredCell = { band: -1, day: -1, hour: -1 };
      if (geometry) renderWithCursor(geometry, -1, -1, -1);
    }
  }

  function hover(px: number, py: number): void {
    if (!geometry) return;

    const { marginLeft, marginTop, plotWidth, bandHeight, gap, years, shown, series } = geometry;

    // Which band, and where in it: a gap above a band holds no hour.
    const rel = py - marginTop;
    const band = Math.min(years.length - 1, Math.floor(rel / (bandHeight + gap)));
    const within = rel - band * (bandHeight + gap);
    const inside =
      px >= marginLeft && px <= marginLeft + plotWidth && rel >= 0 && within <= bandHeight;

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
      Math.min(HOURS_IN_DAY - 1, Math.floor((within / bandHeight) * HOURS_IN_DAY)),
    );
    const h = HOURS_IN_DAY - 1 - r;

    const prev = hoveredCell;
    if (prev.band !== band || prev.day !== d || prev.hour !== h) {
      hoveredCell = { band, day: d, hour: h };
      renderWithCursor(geometry, band, d, h);
    }

    const hourIdx = d * HOURS_IN_DAY + h;
    const val = shown[band * YEAR_SLOT_HOURS + hourIdx];

    const head = document.createElement('div');
    head.className = 'chart-tip-x';
    head.textContent = hourLabel(hourIdx, years[band]);

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

  function draw(series: CaseSeries, input: ChartsInput): void {
    body.querySelectorAll('.pane-banner').forEach((node) => node.remove());

    const values = series.values;
    if (!values || values.length === 0) {
      clear();
      host.banner('refusal', `No hourly values available for ${series.name}.`);
      return;
    }

    const { years, shown, labelled } = bandsOf(series, values, input);
    if (years.length === 0) {
      clear();
      host.banner('refusal', `The Years filter keeps no year of ${series.name}.`);
      return;
    }

    const scale = heatmapScale(shown);
    if (!scale) {
      clear();
      host.banner('refusal', `All values in ${series.name} are blank or non-finite.`);
      return;
    }
    const { width, height } = host.size();

    const plotWidth = Math.max(48, width - MARGIN_LEFT - MARGIN_RIGHT);
    const plotHeight = Math.max(24, height - MARGIN_TOP - MARGIN_BOTTOM);
    // The first band's label sits in the top margin, beside "HE".
    const gap = labelled ? BAND_GAP : 0;
    const bandHeight = (plotHeight - (years.length - 1) * gap) / years.length;
    if (years.length > 1 && bandHeight < MIN_BAND_PX) {
      clear();
      host.banner(
        'refusal',
        `${years.length} years of ${series.name} do not fit this pane: each year's band ` +
          `would be under ${MIN_BAND_PX} px, less than a pixel an hour. Keep fewer years ` +
          `with the Years filter, or give the pane more height.`,
      );
      return;
    }

    const ratio = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    canvas.style.display = '';

    const drawn: HeatmapGeometry = {
      marginLeft: MARGIN_LEFT,
      marginTop: MARGIN_TOP,
      plotWidth,
      plotHeight,
      bandHeight,
      gap,
      years,
      labelled,
      shown,
      scale,
      series,
    };

    geometry = drawn;
    hoveredCell = { band: -1, day: -1, hour: -1 };

    renderWithCursor(drawn, -1, -1, -1);
  }

  function renderWithCursor(
    drawn: HeatmapGeometry,
    cursorBand: number,
    cursorDay: number,
    cursorHour: number,
  ): void {
    const context = canvas.getContext('2d');
    if (!context) return;

    const ratio = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    context.save();
    context.scale(ratio, ratio);

    const { width, height } = host.size();
    context.clearRect(0, 0, width, height);

    const { marginLeft, marginTop, plotWidth, plotHeight, bandHeight, gap, years, labelled } =
      drawn;
    const { shown, scale, series } = drawn;

    const [low, high] = heatmapEnds(scale);

    // Precalculate day X positions (366 days across plotWidth)
    const dayX: number[] = new Array(YEAR_SLOT_DAYS + 1);
    for (let d = 0; d <= YEAR_SLOT_DAYS; d++) {
      dayX[d] = marginLeft + Math.round((d * plotWidth) / YEAR_SLOT_DAYS);
    }

    // A band's hour Y positions (Hour 24 at top, Hour 1 at bottom)
    const bandTop = (band: number) => marginTop + band * (bandHeight + gap);
    const hourYOf = (band: number): number[] => {
      const top = bandTop(band);
      const hourY: number[] = new Array(HOURS_IN_DAY + 1);
      for (let r = 0; r <= HOURS_IN_DAY; r++) {
        hourY[r] = Math.round(top + (r * bandHeight) / HOURS_IN_DAY);
      }
      return hourY;
    };

    const ticks = bandHourTicks(bandHeight, years.length > 1);
    context.font = '10px system-ui, -apple-system, sans-serif';

    for (let band = 0; band < years.length; band++) {
      const hourY = hourYOf(band);
      const slot = band * YEAR_SLOT_HOURS;

      // 8,784 cells a band (X = day 0..365, Y = row 0..23 for hours 24..1)
      for (let d = 0; d < YEAR_SLOT_DAYS; d++) {
        const x0 = dayX[d];
        const cellW = Math.max(1, dayX[d + 1] - x0);
        const dayOffset = slot + d * HOURS_IN_DAY;

        for (let r = 0; r < HOURS_IN_DAY; r++) {
          const h = HOURS_IN_DAY - 1 - r;
          const y0 = hourY[r];
          const cellH = Math.max(1, hourY[r + 1] - y0);
          context.fillStyle = heatmapColor(shown[dayOffset + h], scale);
          context.fillRect(x0, y0, cellW, cellH);
        }
      }

      // Border around the band
      context.strokeStyle = '#d0d0d0';
      context.lineWidth = 1;
      context.strokeRect(marginLeft, hourY[0], plotWidth, hourY[HOURS_IN_DAY] - hourY[0]);

      // Hour ticks and labels on the left Y-axis
      context.fillStyle = '#666666';
      context.textAlign = 'right';
      context.textBaseline = 'middle';
      for (const h of ticks) {
        const r = HOURS_IN_DAY - h;
        const yMid = Math.round((hourY[r] + hourY[r + 1]) / 2);
        context.strokeStyle = '#c0c0c0';
        context.beginPath();
        context.moveTo(marginLeft - 4, yMid);
        context.lineTo(marginLeft, yMid);
        context.stroke();
        context.fillText(String(h), marginLeft - 6, yMid);
      }

      // The band's year, above it
      const year = years[band];
      if (labelled && year !== undefined) {
        context.fillStyle = '#444444';
        context.textAlign = 'left';
        context.textBaseline = 'bottom';
        context.fillText(String(year), marginLeft, hourY[0] - 2);
      }
    }

    // Month boundary lines and labels on bottom X-axis
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

    // Y-axis label (HE at top of Y-axis)
    context.textAlign = 'right';
    context.textBaseline = 'bottom';
    context.fillStyle = '#888888';
    context.fillText('HE', marginLeft - 6, marginTop - 2);

    // One colorbar on the right, across every band
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
    if (cursorBand >= 0 && cursorDay >= 0 && cursorHour >= 0) {
      const hourY = hourYOf(cursorBand);
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

  function paint(next: PaneFrame): void {
    frame = next;
    tip.style.display = 'none';
    const { drawable, zeroText } = next;
    const s = drawable[0];
    host.note(`${s.name}${drawable.length > 1 ? ` (1 of ${drawable.length})` : ''}`);
    draw(s, next.input);
    if (zeroText) host.banner('note', zeroText);
  }

  return {
    surface: 'canvas',
    controls: () => [],
    draw: paint,
    leave() {
      frame = null;
      clear();
    },
    // From the frame, not the geometry: a refusal leaves no geometry, and a
    // band that did not fit may fit at the new size.
    resize() {
      if (frame) paint(frame);
    },
    hover,
    unhover() {
      tip.style.display = 'none';
      if (geometry) clearHover();
    },
    figure: {
      offered: () => true,
      capture() {
        // The one series the pane painted, first, as its bands hold it; the
        // pinned lines it left out ride along, named as such.
        const painted = geometry?.series;
        if (!frame || !geometry || !painted || painted.dashed) return null;
        const { years, shown, labelled } = geometry;
        const named = years.filter(hasYear);
        const banded: CaseSeries = {
          ...painted,
          values: shown,
          facets: labelled
            ? yearsShown(painted.facets, [named[0], named[named.length - 1]])
            : painted.facets,
        };
        const pinned = pinnedOf(frame.input.series);
        const shot = figureShot(host, frame.input, {
          pane: 'heatmap',
          ordered: [banded, ...pinned.filter((s) => s !== painted)],
          xWindow: [0, 1],
          onlyOne: 'A heatmap paints one series.',
        });
        // The real hours of the years drawn, not of every year the Case spans.
        const counted =
          named.length === years.length
            ? named.reduce((sum, year) => sum + realHours(year, 1), 0)
            : shot.capture.realHours * years.length;
        return {
          ...shot,
          capture: { ...shot.capture, realHours: counted, ...(labelled ? { years: named } : {}) },
        };
      },
    },
  };
}
