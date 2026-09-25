// src/figure/heatmap.ts
//
// The diurnal heatmap pane as a figure: one cell per hour, days Jan 1 to
// Dec 31 across and hour ending 1 to 24 up, painted on the pane's own colour
// scale (`heatmapScale`), so the figure cannot pick another palette for the
// same series. Cells are SVG rectangles, not an embedded bitmap, so the
// figure stays vector.
//
// A heatmap paints one series, so its key moves into the context line and a
// colour bar takes the legend's place. An hour with no value is painted as
// the pane paints it, and a footnote says what that grey means: a blank cell
// must not be read as zero.

import { MONTH_LENGTHS, MONTH_NAMES } from '../model/calendar';
import { formatNumber } from '../ui/chart-format';
import {
  HEATMAP_EMPTY,
  heatmapColor,
  heatmapEnds,
  heatmapScale,
  type HeatmapScale,
} from '../ui/heatmap-plot';
import { MEASURE_SLACK } from './legend';
import { line, outlinedRect, rect, text } from './svg';
import type { FigureCapture, PaneRenderer } from './build';

const HOURS_IN_DAY = 24;
const DAYS = 365;
const HOUR_TICKS = [1, 6, 12, 18, 24];
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
function hex(color: string): string {
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

export function heatmapPane(
  capture: FigureCapture,
  drawnIndex: (captured: number) => number,
): PaneRenderer {
  const at = drawnIndex(0);
  if (at < 0) throw new Error('a heatmap figure needs its series drawn');
  const values = capture.lines[0].values ?? [];
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
      scale: () => ({
        min: 0.5,
        max: HOURS_IN_DAY + 0.5,
        ticks: HOUR_TICKS,
        labels: HOUR_TICKS.map(String),
      }),
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
      let day = 0;
      return MONTH_NAMES.map((label, month) => {
        const middle = day + MONTH_LENGTHS[month] / 2;
        day += MONTH_LENGTHS[month];
        return { at: middle / DAYS, label };
      });
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

    marks(lines, _window, frame) {
      const y = lines[at].y;
      const cellWidth = frame.width / DAYS;
      const out: string[] = [];
      for (let day = 0; day < DAYS; day++) {
        const x = frame.left + day * cellWidth;
        const w = cellWidth + (day < DAYS - 1 ? SEAM_PT : 0);
        for (let hour = 0; hour < HOURS_IN_DAY; hour++) {
          // Hour ending `hour + 1` spans half an hour either side of it;
          // the top row is drawn exactly to the frame.
          const top = y(hour + 1.5);
          const h = y(hour + 0.5) - top + (hour > 0 ? SEAM_PT : 0);
          const value = values[day * HOURS_IN_DAY + hour];
          const fill = Number.isFinite(value) ? hex(heatmapColor(value, scale)) : HEATMAP_EMPTY;
          out.push(rect(x, top, w, h, fill));
        }
      }
      out.push(
        outlinedRect(frame.left, frame.top, frame.width, frame.height, 'none', {
          color: '#d0d0d0',
          width: 0.5,
        }),
      );
      // Month boundaries, below the plot as the pane marks them.
      const bottom = frame.top + frame.height;
      let day = 0;
      for (const length of MONTH_LENGTHS.slice(0, -1)) {
        day += length;
        const x = frame.left + day * cellWidth;
        out.push(line(x, bottom, x, bottom + 3, { color: '#999999', width: 0.5 }));
      }
      return out;
    },
  };
}
