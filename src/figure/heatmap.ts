// src/figure/heatmap.ts
//
// The diurnal heatmap pane as a figure: one cell per hour, the slot's 366
// days Jan 1 to Dec 31 across and hour ending 1 to 24 up, painted on the pane's own colour
// scale (`heatmapScale`), so the figure cannot pick another palette for the
// same series. Cells are SVG rectangles, not an embedded bitmap, so the
// figure stays vector.
//
// A Case spanning several years is one band per year, first year on top,
// each labelled with its year above it (`say`, so an edit renames it) and
// all on one colour scale. The bands are laid out on the y axis itself, an
// hour a unit with a gap above each band for its label, so the hour ticks build draws
// land on each band's rows.
//
// A heatmap paints one series, so its key moves into the context line and a
// colour bar takes the legend's place. An hour with no value is painted as
// the pane paints it, and a footnote says what that grey means: a blank cell
// must not be read as zero.

import {
  MONTH_NAMES,
  SLOT_MONTH_LENGTHS,
  SLOT_MONTH_STARTS,
  YEAR_SLOT_DAYS,
  YEAR_SLOT_HOURS,
} from '../model/calendar';
import { formatNumber } from '../ui/chart-format';
import {
  HEATMAP_EMPTY,
  bandHourTicks,
  heatmapColor,
  heatmapEnds,
  heatmapScale,
  type HeatmapScale,
} from '../ui/panes/heatmap';
import { MEASURE_SLACK } from './legend';
import { line, outlinedRect, rect, text } from './svg';
import type { FigureCapture, PaneRenderer } from './build';

const HOURS_IN_DAY = 24;
/** The room above a labelled band for its year. */
const YEAR_GAP_PT = 11;
const YEAR_PT = 8;
const BAR_PT = 7;
const BAR_MAX_PT = 200;
const BAR_STEPS = 64;
const SCALE_PT = 8;
const TITLE_PT = 8.5;
const INK = '#333333';
/** Neighbouring cells overlap by about a 300 dpi pixel, so anti-aliasing
 * leaves no hairline of white between them. */
const SEAM_PT = 0.25;

/** The pane's `rgb(r,g,b)` as hex, which every SVG reader takes. */
export function hex(color: string): string {
  const match = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(color);
  if (!match) return color;
  return `#${match
    .slice(1)
    .map((channel) => Number(channel).toString(16).padStart(2, '0'))
    .join('')}`;
}

/** A scale number as the pane writes it (zero as `0`), with a true minus. */
function scaleLabel(value: number): string {
  return value === 0 ? '0' : formatNumber(value).replace('-', '−');
}

/**
 * Where `bands` bands sit on the y axis of a plot `plotHeight` tall: band k
 * from the bottom holds hour ending h at `k * stride + h`, and a labelled
 * band has room above it for its year. One unlabelled band is the
 * axis 0.5..24.5.
 */
function bandLayout(
  bands: number,
  labelled: boolean,
  plotHeight: number,
): { stride: number; bandPt: number } {
  const gapPt = labelled ? YEAR_GAP_PT : 0;
  const perHour = Math.max(0.1, (plotHeight - bands * gapPt) / (bands * HOURS_IN_DAY));
  return { stride: HOURS_IN_DAY + gapPt / perHour, bandPt: perHour * HOURS_IN_DAY };
}

export function heatmapPane(
  capture: FigureCapture,
  drawnIndex: (captured: number) => number,
): PaneRenderer {
  const at = drawnIndex(0);
  if (at < 0) throw new Error('a heatmap figure needs its series drawn');
  const values = capture.lines[0].values ?? [];
  const years = capture.years ?? null;
  const bands = years?.length ?? Math.max(1, Math.ceil(values.length / YEAR_SLOT_HOURS));
  const labelled = years !== null;
  const scale: HeatmapScale = heatmapScale(values) ?? { min: 0, max: 1, diverging: false };
  let empty = false;
  let shown = 0;
  for (let hour = 0; hour < values.length; hour++) {
    if (Number.isFinite(values[hour])) shown++;
    else empty = true;
  }

  return {
    lead: (what) => `Diurnal heatmap of ${what}`,
    categorical: true,
    context: (shared, keys) => [shared, keys[0] ?? ''].filter(Boolean).join(' · '),
    yAxis: {
      title: 'Hour ending',
      scale(_count, plotHeight) {
        const { stride, bandPt } = bandLayout(bands, labelled, plotHeight);
        const hours = bandHourTicks(bandPt, bands > 1);
        const ticks: number[] = [];
        const labels: string[] = [];
        for (let k = 0; k < bands; k++) {
          for (const hour of hours) {
            ticks.push(k * stride + hour);
            labels.push(String(hour));
          }
        }
        return { min: 0.5, max: bands * stride + 0.5, ticks, labels };
      },
    },

    extent(line) {
      let low = Infinity;
      let high = -Infinity;
      for (let i = 0; i < line.length; i++) {
        const value = line[i];
        if (!Number.isFinite(value)) continue;
        if (value < low) low = value;
        if (value > high) high = value;
      }
      return [low, high];
    },

    hoursShown: () => shown,

    notes: () =>
      empty ? ['Grey cells are hours with no value (filtered out or missing), not zero.'] : [],

    xTicks() {
      return MONTH_NAMES.map((label, month) => ({
        at: (SLOT_MONTH_STARTS[month] + SLOT_MONTH_LENGTHS[month] / 2) / YEAR_SLOT_DAYS,
        label,
      }));
    },

    legendBlock({ left, width, measure, say, valueTitle }) {
      const title = say('axis.color', valueTitle);
      const barLeft = left + measure(title, TITLE_PT) * MEASURE_SLACK + 8;
      const barWidth = Math.max(40, Math.min(BAR_MAX_PT, left + width - barLeft - 16));
      const [low, high] = heatmapEnds(scale);
      const ticks: [number, number][] = [
        [0, low],
        [0.5, scale.diverging ? 0 : (low + high) / 2],
        [1, high],
      ];
      return {
        height: BAR_PT + 3 + SCALE_PT * 1.3,
        draw(top) {
          const out = [text(title, left, top + BAR_PT - 0.5, { size: TITLE_PT })];
          const step = barWidth / BAR_STEPS;
          for (let k = 0; k < BAR_STEPS; k++) {
            const value = low + ((high - low) * (k + 0.5)) / BAR_STEPS;
            const overlap = k < BAR_STEPS - 1 ? SEAM_PT : 0;
            out.push(
              rect(
                barLeft + k * step,
                top,
                step + overlap,
                BAR_PT,
                hex(heatmapColor(value, scale)),
              ),
            );
          }
          out.push(
            outlinedRect(barLeft, top, barWidth, BAR_PT, 'none', { color: '#999999', width: 0.5 }),
          );
          for (const [fraction, value] of ticks) {
            const x = barLeft + fraction * barWidth;
            out.push(
              line(x, top + BAR_PT, x, top + BAR_PT + 2, { color: '#999999', width: 0.5 }),
              text(scaleLabel(value), x, top + BAR_PT + 2 + SCALE_PT, {
                size: SCALE_PT,
                anchor: 'middle',
                fill: INK,
              }),
            );
          }
          return out;
        },
      };
    },

    marks(lines, _window, frame, say) {
      const y = lines[at].y;
      const { stride } = bandLayout(bands, labelled, frame.height);
      const cellWidth = frame.width / YEAR_SLOT_DAYS;
      const out: string[] = [];
      for (let band = 0; band < bands; band++) {
        // The first year on top: band 0 is the highest on the axis.
        const base = (bands - 1 - band) * stride;
        const slot = band * YEAR_SLOT_HOURS;
        for (let day = 0; day < YEAR_SLOT_DAYS; day++) {
          const x = frame.left + day * cellWidth;
          const w = cellWidth + (day < YEAR_SLOT_DAYS - 1 ? SEAM_PT : 0);
          for (let hour = 0; hour < HOURS_IN_DAY; hour++) {
            // Hour ending `hour + 1` spans half an hour either side of it;
            // a band's top row is drawn exactly to its edge.
            const top = y(base + hour + 1.5);
            const h = y(base + hour + 0.5) - top + (hour > 0 ? SEAM_PT : 0);
            const value = values[slot + day * HOURS_IN_DAY + hour];
            const fill = Number.isFinite(value) ? hex(heatmapColor(value, scale)) : HEATMAP_EMPTY;
            out.push(rect(x, top, w, h, fill));
          }
        }
        const top = y(base + HOURS_IN_DAY + 0.5);
        out.push(
          outlinedRect(frame.left, top, frame.width, y(base + 0.5) - top, 'none', {
            color: '#d0d0d0',
            width: 0.5,
          }),
        );
        if (years) {
          out.push(
            text(say(`axis.year[${band}]`, String(years[band])), frame.left, top - 2.5, {
              size: YEAR_PT,
              fill: INK,
            }),
          );
        }
      }
      // Month boundaries, below the plot as the pane marks them.
      const bottom = frame.top + frame.height;
      for (const day of SLOT_MONTH_STARTS.slice(1)) {
        const x = frame.left + day * cellWidth;
        out.push(line(x, bottom, x, bottom + 3, { color: '#999999', width: 0.5 }));
      }
      return out;
    },
  };
}
