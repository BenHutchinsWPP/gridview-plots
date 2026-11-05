// src/ui/panes/xy-colour.ts
//
// What an X-Y point's colour means: a calendar field of its hour, or a third
// series' value at that hour. One rule for the pane and its print figure,
// which takes each point's colour from the capture rather than deciding
// again. Months run round the season colours, each season's middle month on its season's colour, so a
// month reads as its season and still as itself. Hours run round the day
// on four colours, the morning and evening load peaks on opposite hues.
// Rejected: a rainbow wheel, whose many hues hide which hours are near; and
// a ramp folded about midsummer or midday, which gives April and October,
// or 8 AM and 4 PM, one colour.
//
// A series colours on blue (its most negative value) through black (0) to
// red (its most positive), each side scaled to its own extreme, so 0 is
// black whatever the range and a series that never goes negative shows no
// blue. Rejected: a ramp from minimum to maximum, under which the colour of
// zero moves with the data.

import {
  MONTH_NAMES,
  SEASON_NAMES,
  buildCalendar,
  getHourOfDay,
  getMonth,
  getSeason,
} from '../../model/calendar';

/** What a pane colours its points on. `series` names a drawn line. The
 * strings are wire format: a bundle saves them per pane (`xyColours`). */
export type XyColourBy = 'none' | 'season' | 'month' | 'hourOfDay';
export const XY_COLOUR_BY: readonly XyColourBy[] = ['none', 'season', 'month', 'hourOfDay'];
/** A saved series choice: this prefix and the line's row id or full label. */
export const XY_SERIES_PREFIX = 'series:';

/** Winter blue, spring green, summer amber, fall brown: apart in hue and in
 * lightness, so they read apart without colour vision too. */
export const SEASON_COLORS = ['#0072b2', '#009e73', '#e69f00', '#8c510a'] as const;
/** A point whose hour has no value in the colour series: drawn, so every pair still shows, and counted in the key. */
export const NO_COLOUR = '#9a9a9a';
const NEGATIVE = [0x1f, 0x4e, 0xff] as const;
const POSITIVE = [0xff, 0x1f, 0x1f] as const;

/** Whether a saved choice is one this build can draw. */
export function knownColourBy(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (XY_COLOUR_BY.includes(value as XyColourBy) ||
      (value.startsWith(XY_SERIES_PREFIX) && value.length > XY_SERIES_PREFIX.length))
  );
}

/** Month `index` (0 = Jan) between the season colours: Jan, Apr, Jul and
 * Oct are Winter, Spring, Summer and Fall exactly, and each month after
 * them a third of the way on to the next season's colour. */
export function monthColor(index: number): string {
  const anchor = Math.floor(index / 3);
  const t = (index % 3) / 3;
  return mix(SEASON_COLORS[anchor], SEASON_COLORS[(anchor + 1) % 4], t);
}

function hexOf(rgb: readonly number[]): string {
  return `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

/** The hour-of-day cycle's anchors, by hour ending: night muted purple,
 * the morning peak green, midday yellow, the evening peak red, and round to
 * purple. The two load peaks sit on opposite hues, so 8 AM never reads as
 * 6 PM, and neighbouring hours blend. No anchor is pale: points are drawn
 * at 0.4 alpha on white. */
const HOUR_ANCHORS: readonly (readonly [number, string])[] = [
  [1, '#5e4b7a'],
  [7.5, '#2e9e4f'],
  [13, '#d9b310'],
  [18.5, '#d03a2f'],
  [25, '#5e4b7a'],
];

/** Hour ending 1-24 on the day's cycle, HE 24 beside HE 1. */
export function hourColor(hourEnding: number): string {
  const next = HOUR_ANCHORS.findIndex(([at]) => at > hourEnding);
  const [fromAt, from] = HOUR_ANCHORS[next - 1];
  const [toAt, to] = HOUR_ANCHORS[next];
  return mix(from, to, (hourEnding - fromAt) / (toAt - fromAt));
}

/** `from` toward `to` by `t`, both `#rrggbb`. */
function mix(from: string, to: string, t: number): string {
  const rgb = (color: string) => [1, 3, 5].map((at) => parseInt(color.slice(at, at + 2), 16));
  const a = rgb(from);
  const b = rgb(to);
  return hexOf(a.map((c, i) => c + (b[i] - c) * t));
}

/** A series value's colour: black at 0, blue at `low`, red at `high`. */
export function signedColor(value: number, low: number, high: number): string {
  const end = value < 0 ? NEGATIVE : POSITIVE;
  const extreme = value < 0 ? low : high;
  const t = extreme === 0 ? 0 : Math.max(0, Math.min(1, value / extreme));
  return hexOf(end.map((c) => c * t));
}

/** A calendar field's categories, in key order. */
export function calendarKey(by: Exclude<XyColourBy, 'none'>): { color: string; label: string }[] {
  if (by === 'season') return SEASON_NAMES.map((label, i) => ({ color: SEASON_COLORS[i], label }));
  if (by === 'month') return MONTH_NAMES.map((label, i) => ({ color: monthColor(i), label }));
  return Array.from({ length: 24 }, (_, i) => ({ color: hourColor(i + 1), label: `HE ${i + 1}` }));
}

/** Any leap year: season, month and hour of day are the same at a slot
 * hour in every year, so a point's colour never depends on its year. */
const ANY_YEAR = 2000;

/** The category of slot hour `hour`, as an index into `calendarKey(by)`. */
export function calendarIndex(by: Exclude<XyColourBy, 'none'>, hour: number): number {
  const entry = buildCalendar(ANY_YEAR, 1)[hour];
  if (by === 'season') return getSeason(entry);
  if (by === 'month') return getMonth(entry) - 1;
  return getHourOfDay(entry) - 1;
}
