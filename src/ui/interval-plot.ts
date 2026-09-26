// src/ui/interval-plot.ts
//
// The interval pane: one series cut into days, weeks or months
// (`src/series/interval.ts`), every period drawn over one shared axis and
// coloured from the earliest period to the latest, so a drift through the
// year reads as a change of colour. Hand-drawn, because uPlot would need a
// series per period and a year of days is 365 of them.
//
// One series, as the heatmap: the pane names which of the drawn lines it
// took. Geometry and the picked period are owned by charts.ts via `deps`.

import type { CaseSeries } from './charts';
import { DAY_NAMES, MONTH_NAMES } from '../model/calendar';
import {
  axisHours,
  axisLabel,
  cutPeriods,
  periodMonth,
  periodSummary,
  type IntervalLength,
  type Period,
} from '../series/interval';
import { viridisColor } from './heatmap-plot';

export type IntervalColour = 'time' | 'weekday' | 'month';

export interface IntervalOptions {
  length: IntervalLength;
  colour: IntervalColour;
  mean: boolean;
  band: boolean;
}

export interface IntervalGeometry {
  series: CaseSeries;
  options: IntervalOptions;
  periods: Period[];
  span: number;
  summary: ReturnType<typeof periodSummary>;
  /** The series' own weekdays, 0 = Monday. */
  weekday: (day: number) => number;
  low: number;
  high: number;
  plotLeft: number;
  plotTop: number;
  plotWidth: number;
  plotHeight: number;
  /** The period clicked out over the rest, by label. */
  picked: string | null;
}

export interface IntervalPlotDeps {
  paneBodies: HTMLElement[];
  slotCanvases: HTMLCanvasElement[];
  slotTips: HTMLElement[];
  slotIntervalGeometry: (IntervalGeometry | null)[];
  paneSize(body: HTMLElement): { width: number; height: number };
  formatNumber(value: number): string;
  clip(context: CanvasRenderingContext2D, text: string, maxWidth: number): string;
}

export interface IntervalPlot {
  draw(
    slot: number,
    series: CaseSeries,
    options: IntervalOptions,
    weekday: (day: number) => number,
  ): void;
  /** Repaint at the pane's current size, keeping the pick. */
  redraw(slot: number): void;
  clear(slot: number): void;
  hover(slot: number, px: number, py: number): void;
  clearHover(slot: number): void;
  /** Pick the period under the pointer, or drop the pick. */
  click(slot: number, px: number, py: number): void;
}

/** Which colours a length can take: a week always starts on a Monday and a
 * month holds every weekday, so only a day has one; only a day or a week
 * sits inside one month. */
export function coloursFor(length: IntervalLength): IntervalColour[] {
  if (length === 'day') return ['time', 'weekday', 'month'];
  if (length === 'week') return ['time', 'month'];
  return ['time'];
}

export const WEEKDAY_COLORS = [
  '#1f77b4',
  '#2ca02c',
  '#9467bd',
  '#8c564b',
  '#17becf',
  '#ff7f0e',
  '#d62728',
];
/** Winter dark, summer yellow, on the heatmap's ramp. */
export const monthColor = (month: number): string =>
  viridisColor(0.5 - 0.5 * Math.cos((2 * Math.PI * (month - 0.5)) / 12));
const MEAN = '#1a1a1a';
/** Within this many px of a line, the pointer names it. */
const HIT = 12;

const MARGIN = { left: 56, right: 12, top: 10, bottom: 46 };
/** Each further row of the key takes this much from the plot. */
const LEGEND_ROW = 14;

/** At this many periods or fewer, "early → late" names each period in its
 * own colour: shades of one ramp are hard to tell apart for a handful of
 * picked days. */
export const NAMED_PERIODS_MAX = 10;

/** Ten colours told apart at a glance, the order the app draws Cases in. */
export const PERIOD_COLORS = [
  '#1f77b4',
  '#ff7f0e',
  '#2ca02c',
  '#d62728',
  '#9467bd',
  '#8c564b',
  '#e377c2',
  '#7f7f7f',
  '#bcbd22',
  '#17becf',
];

/** Whether the key names each period rather than showing the ramp. */
export function namesPeriods(colour: IntervalColour, count: number): boolean {
  return colour === 'time' && count <= NAMED_PERIODS_MAX;
}

/** A period's colour: the one rule the pane and its print figure share. */
export function periodColour(
  colour: IntervalColour,
  periods: readonly Period[],
  index: number,
  weekday: (day: number) => number,
): string {
  const period = periods[index];
  if (colour === 'weekday') return WEEKDAY_COLORS[weekday(period.startDay)];
  if (colour === 'month') return monthColor(periodMonth(period));
  if (namesPeriods(colour, periods.length)) return PERIOD_COLORS[index];
  return viridisColor(periods.length <= 1 ? 0 : index / (periods.length - 1));
}

function colourOf(geometry: IntervalGeometry, index: number): string {
  return periodColour(geometry.options.colour, geometry.periods, index, geometry.weekday);
}

/** Round steps, 1, 2 or 5 times a power of ten, about five across. */
function niceTicks(low: number, high: number): { low: number; high: number; step: number } {
  const raw = (high - low) / 5 || Math.abs(high) || 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((f) => f * magnitude).find((v) => v >= raw) ?? raw;
  return { low: Math.floor(low / step) * step, high: Math.ceil(high / step) * step, step };
}

export function createIntervalPlot(deps: IntervalPlotDeps): IntervalPlot {
  const { paneBodies, slotCanvases, slotTips, slotIntervalGeometry, paneSize, formatNumber, clip } =
    deps;

  function clear(slot: number): void {
    slotIntervalGeometry[slot] = null;
    slotTips[slot].style.display = 'none';
  }

  function draw(
    slot: number,
    series: CaseSeries,
    options: IntervalOptions,
    weekday: (day: number) => number,
  ): void {
    const previous = slotIntervalGeometry[slot];
    const periods = cutPeriods(series.values ?? [], options.length, weekday);
    const span = axisHours(options.length);
    const summary = periodSummary(periods, span);
    let low = Infinity;
    let high = -Infinity;
    for (const period of periods) {
      for (const value of period.values) {
        if (Number.isNaN(value)) continue;
        if (value < low) low = value;
        if (value > high) high = value;
      }
    }
    if (!Number.isFinite(low)) {
      low = 0;
      high = 1;
    }
    const ticks = niceTicks(low, high);
    // A pick survives a redraw only while its period is still drawn.
    const picked =
      previous &&
      previous.series.name === series.name &&
      previous.options.length === options.length &&
      periods.some((p) => p.label === previous.picked)
        ? previous.picked
        : null;
    slotIntervalGeometry[slot] = {
      series,
      options,
      periods,
      span,
      summary,
      weekday,
      low: ticks.low,
      high: ticks.high === ticks.low ? ticks.low + ticks.step : ticks.high,
      plotLeft: MARGIN.left,
      plotTop: MARGIN.top,
      plotWidth: 0,
      plotHeight: 0,
      picked,
    };
    redraw(slot);
  }

  function redraw(slot: number): void {
    const geometry = slotIntervalGeometry[slot];
    if (!geometry) return;
    const { width, height } = paneSize(paneBodies[slot]);
    const ratio = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const canvas = slotCanvases[slot];
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    canvas.style.display = '';
    const context = canvas.getContext('2d');
    if (!context) return;
    context.save();
    context.scale(ratio, ratio);
    context.clearRect(0, 0, width, height);

    geometry.plotWidth = Math.max(40, width - MARGIN.left - MARGIN.right);
    context.font = '10px system-ui, -apple-system, sans-serif';
    const rows = legendRows(context, geometry, width - MARGIN.left - MARGIN.right);
    const bottom = MARGIN.bottom + (rows.length - 1) * LEGEND_ROW;
    geometry.plotHeight = Math.max(40, height - MARGIN.top - bottom);
    const { periods, span, summary, options, low, high, plotLeft, plotTop, plotWidth, plotHeight } =
      geometry;
    const x = (k: number): number => plotLeft + (k / (span - 1)) * plotWidth;
    const y = (v: number): number => plotTop + (1 - (v - low) / (high - low)) * plotHeight;
    const step = niceTicks(low, high).step;

    // Grid and y axis.
    context.font = '10px system-ui, -apple-system, sans-serif';
    context.lineWidth = 1;
    context.fillStyle = '#666666';
    context.textAlign = 'right';
    context.textBaseline = 'middle';
    for (let v = low; v <= high + step / 2; v += step) {
      context.strokeStyle = '#e8e8e8';
      context.beginPath();
      context.moveTo(plotLeft, Math.round(y(v)) + 0.5);
      context.lineTo(plotLeft + plotWidth, Math.round(y(v)) + 0.5);
      context.stroke();
      context.fillText(formatNumber(v), plotLeft - 6, y(v));
    }
    context.save();
    context.translate(12, plotTop + plotHeight / 2);
    context.rotate(-Math.PI / 2);
    context.textAlign = 'center';
    context.fillText(clip(context, geometry.series.unit, plotHeight), 0, 0);
    context.restore();

    // X axis: hours of a day, days of a week, or days of a month, with a
    // divider at each day for the longer two.
    context.textAlign = 'center';
    context.textBaseline = 'top';
    const labelY = plotTop + plotHeight + 6;
    if (options.length === 'day') {
      for (const k of [0, 3, 6, 9, 12, 15, 18, 21, 23])
        context.fillText(`HE ${k + 1}`, x(k), labelY);
    } else {
      const days = span / 24;
      for (let d = 1; d < days; d++) {
        context.strokeStyle = '#f0f0f0';
        context.beginPath();
        context.moveTo(Math.round(x(d * 24 - 0.5)) + 0.5, plotTop);
        context.lineTo(Math.round(x(d * 24 - 0.5)) + 0.5, plotTop + plotHeight);
        context.stroke();
      }
      const labelled =
        options.length === 'week' ? [0, 1, 2, 3, 4, 5, 6] : [0, 4, 9, 14, 19, 24, 30];
      for (const d of labelled) {
        const text = options.length === 'week' ? DAY_NAMES[d] : `day ${d + 1}`;
        context.fillText(text, x(d * 24 + 11.5), labelY);
      }
    }

    context.save();
    context.beginPath();
    context.rect(plotLeft, plotTop, plotWidth, plotHeight);
    context.clip();
    context.lineJoin = 'round';

    const trace = (values: Float32Array): void => {
      context.beginPath();
      let pen = false;
      for (let k = 0; k < span; k++) {
        const value = values[k];
        if (Number.isNaN(value)) {
          pen = false;
          continue;
        }
        if (pen) context.lineTo(x(k), y(value));
        else context.moveTo(x(k), y(value));
        pen = true;
      }
    };

    if (options.band) {
      context.fillStyle = 'rgba(26, 26, 26, 0.12)';
      let start = -1;
      for (let k = 0; k <= span; k++) {
        const kept = k < span && !Number.isNaN(summary.p10[k]);
        if (kept && start < 0) start = k;
        if (!kept && start >= 0) {
          context.beginPath();
          for (let i = start; i < k; i++) context.lineTo(x(i), y(summary.p90[i]));
          for (let i = k - 1; i >= start; i--) context.lineTo(x(i), y(summary.p10[i]));
          context.closePath();
          context.fill();
          start = -1;
        }
      }
    }

    // Earliest first, so the latest period sits on top.
    const alpha = periods.length > 120 ? 0.35 : periods.length > 30 ? 0.55 : 0.85;
    context.lineWidth = 1;
    periods.forEach((period, index) => {
      context.globalAlpha = geometry.picked === null ? alpha : 0.18;
      context.strokeStyle = colourOf(geometry, index);
      trace(period.values);
      context.stroke();
    });
    context.globalAlpha = 1;
    if (options.mean) {
      context.strokeStyle = MEAN;
      context.lineWidth = 2.2;
      trace(summary.mean);
      context.stroke();
    }
    // In its own colour, thick, over the faded rest: a fixed pick colour
    // would be some weekday's or month's colour too.
    const picked = periods.findIndex((p) => p.label === geometry.picked);
    if (picked >= 0) {
      context.strokeStyle = '#ffffff';
      context.lineWidth = 4.5;
      trace(periods[picked].values);
      context.stroke();
      context.strokeStyle = colourOf(geometry, picked);
      context.lineWidth = 2.5;
      trace(periods[picked].values);
      context.stroke();
    }
    context.restore();

    context.textAlign = 'left';
    context.textBaseline = 'middle';
    rows.forEach((row, r) => {
      let x = geometry.plotLeft;
      const baseline = height - 10 - (rows.length - 1 - r) * LEGEND_ROW;
      for (const item of row) {
        item.draw(x, baseline);
        x += item.width + 10;
      }
    });
    context.restore();
  }

  /** The key along the bottom: the ramp from first to last period, or the
   * weekday or month swatches, then the mean and band, flowed into rows that
   * fit the pane. Laid out before the plot, which gives it the height. */
  function legendRows(
    context: CanvasRenderingContext2D,
    geometry: IntervalGeometry,
    room: number,
  ): { width: number; draw(x: number, baseline: number): void }[][] {
    const { periods, options, plotWidth } = geometry;
    type Item = { width: number; draw(x: number, baseline: number): void };
    const items: Item[] = [];
    const label = (value: string, x: number, baseline: number): void => {
      context.fillStyle = '#666666';
      context.fillText(value, x, baseline);
    };
    const swatch = (color: string, value: string, filled = false): Item => ({
      width: 18 + context.measureText(value).width,
      draw(x, baseline) {
        context.fillStyle = color;
        if (filled) context.fillRect(x, baseline - 5, 14, 10);
        else context.fillRect(x, baseline - 1.5, 14, 3);
        label(value, x + 18, baseline);
      },
    });
    if (namesPeriods(options.colour, periods.length)) {
      periods.forEach((period, i) => items.push(swatch(PERIOD_COLORS[i], period.label)));
    } else if (options.colour === 'time' && periods.length > 0) {
      const first = periods[0].label;
      const last = periods[periods.length - 1].label;
      const ramp = Math.min(140, Math.max(40, plotWidth / 4));
      const firstWidth = context.measureText(first).width;
      items.push({
        width: firstWidth + 8 + ramp + 8 + context.measureText(last).width,
        draw(x, baseline) {
          label(first, x, baseline);
          const at = x + firstWidth + 8;
          const gradient = context.createLinearGradient(at, 0, at + ramp, 0);
          for (let i = 0; i <= 4; i++) gradient.addColorStop(i / 4, viridisColor(i / 4));
          context.fillStyle = gradient;
          context.fillRect(at, baseline - 4, ramp, 8);
          label(last, at + ramp + 8, baseline);
        },
      });
    } else if (options.colour === 'weekday') {
      DAY_NAMES.forEach((day, i) => items.push(swatch(WEEKDAY_COLORS[i], day)));
    } else if (options.colour === 'month') {
      MONTH_NAMES.forEach((month, i) => items.push(swatch(monthColor(i), month)));
    }
    if (options.mean) items.push(swatch(MEAN, 'mean'));
    if (options.band) items.push(swatch('rgba(26, 26, 26, 0.12)', 'p10–p90', true));
    const rows: Item[][] = [[]];
    let used = 0;
    for (const item of items) {
      if (used > 0 && used + item.width > room) {
        rows.push([]);
        used = 0;
      }
      rows[rows.length - 1].push(item);
      used += item.width + 10;
    }
    return rows;
  }

  /** The period whose line is nearest the pointer at its axis hour. */
  function nearest(
    geometry: IntervalGeometry,
    px: number,
    py: number,
  ): { period: Period; hour: number; value: number } | null {
    const { span, plotLeft, plotTop, plotWidth, plotHeight, low, high } = geometry;
    if (px < plotLeft || px > plotLeft + plotWidth || py < plotTop || py > plotTop + plotHeight) {
      return null;
    }
    const hour = Math.round(((px - plotLeft) / plotWidth) * (span - 1));
    let best: { period: Period; hour: number; value: number } | null = null;
    let distance = HIT;
    for (const period of geometry.periods) {
      const value = period.values[hour];
      if (Number.isNaN(value)) continue;
      const gap = Math.abs(plotTop + (1 - (value - low) / (high - low)) * plotHeight - py);
      if (gap < distance) {
        distance = gap;
        best = { period, hour, value };
      }
    }
    return best;
  }

  function hover(slot: number, px: number, py: number): void {
    const geometry = slotIntervalGeometry[slot];
    const tip = slotTips[slot];
    const hit = geometry && nearest(geometry, px, py);
    if (!geometry || !hit) {
      tip.style.display = 'none';
      return;
    }
    const head = document.createElement('div');
    head.className = 'chart-tip-x';
    head.textContent = `${hit.period.label} · ${axisLabel(geometry.options.length, hit.hour)}`;
    const row = document.createElement('div');
    row.className = 'chart-tip-row';
    const dot = document.createElement('span');
    dot.className = 'chart-tip-dot';
    dot.style.background = colourOf(geometry, geometry.periods.indexOf(hit.period));
    const name = document.createElement('span');
    name.className = 'chart-tip-name';
    name.textContent = geometry.series.name;
    const num = document.createElement('b');
    num.textContent = `${formatNumber(hit.value)} ${geometry.series.unit}`;
    row.append(dot, name, num);
    tip.replaceChildren(head, row);
    tip.style.display = '';
    const right = px < paneBodies[slot].clientWidth / 2;
    tip.style.left = right ? 'auto' : '6px';
    tip.style.right = right ? '6px' : 'auto';
  }

  function clearHover(slot: number): void {
    slotTips[slot].style.display = 'none';
  }

  function click(slot: number, px: number, py: number): void {
    const geometry = slotIntervalGeometry[slot];
    if (!geometry) return;
    const hit = nearest(geometry, px, py);
    geometry.picked = hit && hit.period.label !== geometry.picked ? hit.period.label : null;
    redraw(slot);
  }

  return { draw, redraw, clear, hover, clearHover, click };
}
