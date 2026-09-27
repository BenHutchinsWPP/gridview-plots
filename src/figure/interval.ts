// src/figure/interval.ts
//
// The interval pane as a figure: one series cut into days, weeks or months
// (`src/series/interval.ts`), every period a thin line over one shared axis,
// in the pane's own colours (`periodColour`), so the figure cannot colour a
// period differently from the app.
//
// Faded lines are tinted toward white rather than drawn with opacity: a
// report is printed, and presentation attributes are the drawing path. The
// series is named in the context line and a key of ramp or swatches takes
// the legend table's place, as the heatmap's colour bar does.

import { DAY_NAMES, MONTH_NAMES } from '../model/calendar';
import { axisHours, cutPeriods, periodSummary, type IntervalLength } from '../series/interval';
import { viridisColor } from '../ui/panes/heatmap';
import {
  PERIOD_COLORS,
  WEEKDAY_COLORS,
  monthColor,
  namesPeriods,
  periodColour,
  type IntervalColour,
} from '../ui/panes/interval';
import { hex } from './heatmap';
import { MEASURE_SLACK } from './legend';
import { polygon, polyline, rect, text, tint } from './svg';
import type { FigureCapture, PaneRenderer } from './build';

/** What an interval figure recuts its series with, as the pane had it. */
export interface FigureInterval {
  readonly length: IntervalLength;
  readonly colour: IntervalColour;
  readonly mean: boolean;
  readonly band: boolean;
  /** The period picked out in the pane, by label. */
  readonly picked: string | null;
  /** Each day's weekday in the series' year, 0 = Monday, as the pane reads
   * them: a leap year's calendar drops Feb 29, so they cannot be counted on
   * from Jan 1. */
  readonly weekdays: readonly number[];
}

const KEY_PT = 8;
const KEY_ROW_PT = KEY_PT * 1.6;
const SWATCH_PT = 12;
const RAMP_PT = 90;
const RAMP_STEPS = 32;
const MEAN_INK = '#1a1a1a';
const BAND_FILL = tint('#1a1a1a', 0.14);
const PERIOD_PT = 0.6;
const NOUN: Record<IntervalLength, string> = { day: 'day', week: 'week', month: 'month' };
const LEAD: Record<IntervalLength, string> = {
  day: 'Daily profiles',
  week: 'Weekly profiles',
  month: 'Monthly profiles',
};

export function intervalPane(
  capture: FigureCapture,
  drawnIndex: (captured: number) => number,
): PaneRenderer {
  const at = drawnIndex(0);
  const spec = capture.interval;
  if (at < 0 || !spec) throw new Error('an interval figure needs its series and its settings');
  const values = capture.lines[0].values ?? [];
  const weekday = (day: number): number => spec.weekdays[day];
  const periods = cutPeriods(values, spec.length, weekday);
  const span = axisHours(spec.length);
  const summary = periodSummary(periods, span);
  const colours = periods.map((_, i) => hex(periodColour(spec.colour, periods, i, weekday)));
  const picked = periods.findIndex((period) => period.label === spec.picked);
  // More periods, paler lines, as the pane fades them.
  const alpha = periods.length > 120 ? 0.35 : periods.length > 30 ? 0.55 : 0.85;
  let shown = 0;
  for (let hour = 0; hour < values.length; hour++) if (Number.isFinite(values[hour])) shown++;
  const noun = NOUN[spec.length];
  const plural = periods.length === 1 ? noun : `${noun}s`;

  /** The key's entries, in order: a ramp or swatches, then the overlays. */
  type Entry =
    | { kind: 'ramp'; from: string; to: string }
    | { kind: 'swatch'; id: string; color: string; label: string; fill?: boolean };
  const entries: Entry[] = [];
  const named = namesPeriods(spec.colour, periods.length);
  if (named) {
    periods.forEach((period, i) =>
      entries.push({
        kind: 'swatch',
        id: `legend.key[${i}]`,
        color: PERIOD_COLORS[i],
        label: period.label,
      }),
    );
  } else if (spec.colour === 'time' && periods.length > 0) {
    entries.push({ kind: 'ramp', from: periods[0].label, to: periods[periods.length - 1].label });
  } else if (spec.colour === 'weekday') {
    DAY_NAMES.forEach((day, i) =>
      entries.push({
        kind: 'swatch',
        id: `legend.key[${i}]`,
        color: WEEKDAY_COLORS[i],
        label: day,
      }),
    );
  } else if (spec.colour === 'month') {
    MONTH_NAMES.forEach((month, i) =>
      entries.push({
        kind: 'swatch',
        id: `legend.key[${i}]`,
        color: hex(monthColor(i)),
        label: month,
      }),
    );
  }
  if (spec.mean) {
    entries.push({
      kind: 'swatch',
      id: 'legend.mean',
      color: MEAN_INK,
      label: `mean of the ${plural}`,
    });
  }
  if (spec.band) {
    entries.push({
      kind: 'swatch',
      id: 'legend.band',
      color: BAND_FILL,
      label: '10th–90th percentile',
      fill: true,
    });
  }
  if (picked >= 0) {
    entries.push({
      kind: 'swatch',
      id: 'legend.picked',
      color: colours[picked],
      label: periods[picked].label,
    });
  }

  const xOf = (frame: { left: number; width: number }, k: number): number =>
    frame.left + (k / (span - 1)) * frame.width;

  return {
    lead: (what) => `${LEAD[spec.length]} of ${what}`,
    xTitle:
      spec.length === 'day' ? 'Hour ending' : spec.length === 'month' ? 'Day of month' : undefined,
    context: (shared, keys) => [shared, keys[0] ?? ''].filter(Boolean).join(' · '),

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

    notes: () => [
      `Each line is one ${noun}, ${periods.length} ${plural} in all` +
        (spec.colour === 'time' && !named ? ', coloured from the earliest to the latest.' : '.'),
      ...(spec.length === 'week' ? ['Weeks run Monday to Sunday.'] : []),
    ],

    xTicks() {
      const at = (k: number) => k / (span - 1);
      if (spec.length === 'day') {
        return [1, 6, 12, 18, 24].map((he) => ({ at: at(he - 1), label: String(he) }));
      }
      if (spec.length === 'week') {
        return DAY_NAMES.map((day, d) => ({ at: at(d * 24 + 11.5), label: day }));
      }
      return [1, 5, 10, 15, 20, 25, 31].map((d) => ({
        at: at((d - 1) * 24 + 11.5),
        label: String(d),
      }));
    },

    legendBlock({ left, width, measure, say }) {
      // Each entry's text through `say` now, so an edit resizes its entry.
      type Placed = { entry: Entry; texts: string[]; width: number };
      const placed: Placed[] = entries.map((entry) => {
        if (entry.kind === 'ramp') {
          const texts = [say('legend.from', entry.from), say('legend.to', entry.to)];
          const w =
            measure(texts[0], KEY_PT) * MEASURE_SLACK +
            4 +
            RAMP_PT +
            4 +
            measure(texts[1], KEY_PT) * MEASURE_SLACK;
          return { entry, texts, width: w };
        }
        const texts = [say(entry.id, entry.label)];
        return { entry, texts, width: SWATCH_PT + 3 + measure(texts[0], KEY_PT) * MEASURE_SLACK };
      });
      // Flowed into rows that fit the width.
      const rows: Placed[][] = [[]];
      let used = 0;
      for (const item of placed) {
        if (used > 0 && used + item.width > width) {
          rows.push([]);
          used = 0;
        }
        rows[rows.length - 1].push(item);
        used += item.width + 10;
      }
      return {
        height: rows.length * KEY_ROW_PT,
        draw(top) {
          const out: string[] = [];
          rows.forEach((row, r) => {
            const middle = top + r * KEY_ROW_PT + KEY_PT * 0.6;
            let x = left;
            for (const { entry, texts, width: w } of row) {
              if (entry.kind === 'ramp') {
                out.push(text(texts[0], x, middle + KEY_PT * 0.35, { size: KEY_PT }));
                let rampLeft = x + measure(texts[0], KEY_PT) * MEASURE_SLACK + 4;
                for (let k = 0; k < RAMP_STEPS; k++) {
                  out.push(
                    rect(
                      rampLeft + (k * RAMP_PT) / RAMP_STEPS,
                      middle - 3,
                      RAMP_PT / RAMP_STEPS + (k < RAMP_STEPS - 1 ? 0.25 : 0),
                      6,
                      hex(viridisColor((k + 0.5) / RAMP_STEPS)),
                    ),
                  );
                }
                rampLeft += RAMP_PT + 4;
                out.push(text(texts[1], rampLeft, middle + KEY_PT * 0.35, { size: KEY_PT }));
              } else {
                out.push(
                  entry.fill
                    ? rect(x, middle - 3.5, SWATCH_PT, 7, entry.color)
                    : rect(x, middle - 1, SWATCH_PT, 2, entry.color),
                  text(texts[0], x + SWATCH_PT + 3, middle + KEY_PT * 0.35, { size: KEY_PT }),
                );
              }
              x += w + 10;
            }
          });
          return out;
        },
      };
    },

    marks(lines, _window, frame) {
      const y = lines[at].y;
      const out: string[] = [];
      /** Each unbroken run of `series` as points. */
      const runs = (series: ArrayLike<number>): [number, number][][] => {
        const found: [number, number][][] = [];
        let run: [number, number][] = [];
        for (let k = 0; k < span; k++) {
          const value = series[k];
          if (Number.isNaN(value)) {
            if (run.length > 1) found.push(run);
            run = [];
            continue;
          }
          run.push([xOf(frame, k), y(value)]);
        }
        if (run.length > 1) found.push(run);
        return found;
      };
      if (spec.band) {
        let start = -1;
        for (let k = 0; k <= span; k++) {
          const kept = k < span && !Number.isNaN(summary.p10[k]);
          if (kept && start < 0) start = k;
          if (!kept && start >= 0) {
            const points: [number, number][] = [];
            for (let i = start; i < k; i++) points.push([xOf(frame, i), y(summary.p90[i])]);
            for (let i = k - 1; i >= start; i--) points.push([xOf(frame, i), y(summary.p10[i])]);
            out.push(polygon(points, BAND_FILL));
            start = -1;
          }
        }
      }
      // Earliest first, so the latest sits on top, as in the pane.
      periods.forEach((period, i) => {
        const color = tint(colours[i], picked >= 0 ? 0.2 : alpha);
        for (const run of runs(period.values)) out.push(polyline(run, { color, width: PERIOD_PT }));
      });
      if (spec.mean) {
        for (const run of runs(summary.mean))
          out.push(polyline(run, { color: MEAN_INK, width: 1.6 }));
      }
      if (picked >= 0) {
        for (const run of runs(periods[picked].values)) {
          out.push(
            polyline(run, { color: '#ffffff', width: 2.6 }),
            polyline(run, { color: colours[picked], width: 1.4 }),
          );
        }
      }
      return out;
    },
  };
}
