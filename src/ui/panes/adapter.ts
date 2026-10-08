// src/ui/panes/adapter.ts
//
// The contract between a chart pane and a chart type. A pane holds one
// adapter per type and one of them is drawn at a time; everything a type
// does (drawing, hover, resize, teardown, its Figure, its header controls)
// sits behind `PaneAdapter`, so the pane never asks which type it holds.
//
// `figureShot` is here because the capture rules every type shares (values
// copied, the preview left out, the limits box read) must not drift apart
// across seven adapters.

import { NO_YEAR } from '../../app/boxes';
import { YEAR_SLOT_HOURS, mostRealHours, realHours, type YearSpan } from '../../model/calendar';
import type { DateSet } from '../../model/date-range';
import type { FigureCapture, FigurePane } from '../../figure/build';
import type { SeriesFacets } from '../../series/label';
import type { CaseSeries, ChartsInput, DrawnLimit } from '../charts';

/** A Case's first year, when it names one: not the stand-in a line with no
 * Case is counted under, which no date of its may print. */
export function hasYear(year: number | undefined): year is number {
  return year !== undefined && year !== NO_YEAR;
}

/** A group of header controls a type shows. The pane owns the elements. */
export type PaneControl =
  'zoom' | 'download' | 'limits' | 'dates' | 'overlay' | 'box' | 'xy' | 'interval';

/** One render, as every pane sees it. */
export interface PaneFrame {
  readonly input: ChartsInput;
  /** The lines a chart may draw: none under a whole-selection refusal. */
  readonly drawable: CaseSeries[];
  /** The all-zero note, or null. */
  readonly zeroText: string | null;
  /** This render's lines with the dates cleared. A second resolve of every
   * line, so it is asked only by a pane that shows one, and once per render
   * however many panes ask. */
  wholeYear(): readonly CaseSeries[];
}

/** A pane header's elements, resolved by the host inside the section. */
export interface PaneElements {
  readonly body: HTMLElement;
  readonly note: HTMLElement | null;
  readonly zoomReset: HTMLButtonElement;
  readonly download: HTMLButtonElement;
  readonly limits: HTMLInputElement;
  readonly follow: HTMLInputElement;
  readonly overview: HTMLInputElement;
  readonly overviewHost: HTMLElement;
  readonly overlayYears: HTMLInputElement;
  readonly boxDim: HTMLSelectElement;
  readonly boxValues: HTMLInputElement;
  readonly xySwap: HTMLButtonElement;
  readonly xyFit: HTMLInputElement;
  readonly intervalBy: HTMLSelectElement;
  readonly intervalColour: HTMLSelectElement;
  readonly intervalMean: HTMLInputElement;
  readonly intervalBand: HTMLInputElement;
}

/** What an adapter draws with: its pane's surfaces, controls and helpers. */
export interface PaneHost {
  /** The pane's place in the layout, from 0: what `ChartsInput` is keyed by. */
  readonly index: number;
  readonly body: HTMLElement;
  readonly uplotHost: HTMLElement;
  /** Box, X-Y, heatmap and interval share this canvas, its tip and tags. */
  readonly canvas: HTMLCanvasElement;
  readonly tip: HTMLElement;
  readonly tags: readonly HTMLElement[];
  readonly legendHost: HTMLElement;
  readonly controls: PaneElements;
  /** The size a renderer paints at: never larger than the pane. */
  size(): { width: number; height: number };
  banner(kind: 'refusal' | 'note', text: string): void;
  /** The pane header's one line (see `createPane`). */
  note(text: string): void;
  /** Re-render every pane from the last input: for a control whose change
   * reaches past this pane's drawing. */
  rerender(): void;
  /** A drag on this pane chose new dates, or every date (null). */
  datesChange(dates: DateSet | null): void;
}

/** What a Figure click hands the section. */
export interface FigureShot {
  readonly capture: FigureCapture;
  /** `wholeYear`: a time pane not following the dates. `yearsOverlaid`:
   * a time pane under "overlay years", whose caption names the years. */
  readonly shown: { wholeYear: boolean; yearsOverlaid?: boolean };
}

export interface PaneFigure {
  /** Whether the pane as drawn can be captured. The host adds the rules
   * every type shares: a pinned line, and no refusal banner. */
  offered(): boolean;
  /** The pane as drawn, values copied; null when it cannot be captured. */
  capture(): FigureShot | null;
}

export interface PaneAdapter {
  /** The pane surface this type draws on; the pane shows it and hides the
   * other two before `draw`. */
  readonly surface: 'uplot' | 'canvas' | 'legend';
  /** The header controls the type shows. Asked before `draw`, and also for
   * an empty frame. */
  controls(frame: PaneFrame): readonly PaneControl[];
  /** Draw the frame. Never handed an empty `drawable`: an empty pane is the
   * pane's to say, not a type's. */
  draw(frame: PaneFrame): void;
  /** The pane stops showing this type (another type, or nothing to draw):
   * release whatever it holds on the shared surfaces. */
  leave(): void;
  /** Repaint at the pane's new size. */
  resize(): void;
  hover?(x: number, y: number): void;
  unhover?(): void;
  click?(x: number, y: number): void;
  resetZoom?(): void;
  download?(): void;
  /** The x window in hour-of-year, for a pane with an hour axis. */
  timeWindow?(): [number, number] | null;
  /** Absent for a type with no figure renderer. */
  readonly figure?: PaneFigure;
}

/** The lines a figure may name: the preview is never part of one. */
export function pinnedOf(series: readonly CaseSeries[]): CaseSeries[] {
  return series.filter((s) => !s.dashed);
}

/**
 * A pane's Figure capture. Values are copied: the pool reuses a line's buffer
 * on the next draw, and the dialog must keep showing what was clicked.
 * Refused lines ride along, since the figure names them in a footnote.
 */
export function figureShot(
  host: PaneHost,
  input: ChartsInput,
  spec: {
    pane: FigurePane;
    /** In the order the pane drew them. */
    ordered: readonly CaseSeries[];
    xWindow: [number, number];
    /** The limits this pane drew, when they are not `input.limits`. */
    limits?: readonly DrawnLimit[] | null;
    /** A one-series type: every further drawn line is refused with this. */
    onlyOne?: string;
    boxes?: FigureCapture['boxes'];
    xy?: FigureCapture['xy'];
    interval?: FigureCapture['interval'];
    wholeYear?: boolean;
    /** A time or stacked pane's axis: each line and limit is placed on it as
     * the pane drew it, so the figure spans the same years. */
    axis?: FigureAxis | null;
  },
): FigureShot {
  const { onlyOne, axis } = spec;
  const copied = (values: Float32Array, year: number | undefined): Float32Array =>
    axis ? placedOn(axis, values, axis.offsetOf(year)) : values.slice();
  const shown = axis && hasYear(axis.origin) ? windowYears(axis, axis.origin, spec.xWindow) : null;
  const lines = spec.ordered.map((s, n) => ({
    name: s.name,
    facets: shown ? yearsShown(s.facets, shown) : s.facets,
    color: s.color,
    unit: s.unit,
    ...(onlyOne && n > 0 && s.values
      ? { values: null, refusal: onlyOne }
      : {
          values: s.values ? copied(s.values, input.spanOf?.(s).firstYear) : null,
          refusal: s.refusal,
        }),
    warnings: [...s.warnings],
    weightColumn: s.weightColumn,
  }));
  // None when the pane's box is unticked, and never the preview's, which
  // leaves the figure with its line.
  const limits = host.controls.limits.checked
    ? (spec.limits ?? input.limits ?? [])
        .filter((limit) => !limit.preview)
        .map((limit) => ({
          color: limit.color,
          unit: limit.unit,
          values: copied(limit.values, limit.firstYear),
          summed: limit.summed,
        }))
    : [];
  // The footnote's denominator, from the lines the figure draws: a refused
  // line or the preview is in no count.
  const spans = spec.ordered
    .filter((s, n) => lines[n].values !== null && !s.dashed)
    .map((s) => input.spanOf?.(s) ?? { firstYear: NO_YEAR, numYears: 1 });
  const counted = spans.length > 0 ? spans : [{ firstYear: NO_YEAR, numYears: 1 }];
  return {
    capture: {
      pane: spec.pane,
      lines,
      xWindow: spec.xWindow,
      ...(axis && hasYear(axis.origin) ? { firstYear: axis.origin } : {}),
      limits,
      realHours: axis ? axisRealHours(axis, counted, shown) : mostRealHours(counted),
      boxes: spec.boxes,
      xy: spec.xy,
      interval: spec.interval,
    },
    shown: { wholeYear: spec.wholeYear ?? false },
  };
}

/** A time or stacked pane's x axis, as the pane placed its lines on it. */
export interface FigureAxis {
  /** The year at x = 0; absent when no drawn line names one. */
  readonly origin: number | undefined;
  /** Whole year slots long. */
  readonly length: number;
  /** Where values starting in `year` place their first hour. */
  offsetOf(year: number | undefined): number;
}

/** The years an x window on a time axis touches, first and last. */
function windowYears(
  axis: FigureAxis,
  origin: number,
  [min, max]: readonly [number, number],
): [number, number] {
  const slot = (x: number) =>
    Math.floor(Math.max(0, Math.min(axis.length - 1, x)) / YEAR_SLOT_HOURS);
  return [origin + slot(Math.ceil(min)), origin + slot(Math.floor(max))];
}

/**
 * A line's years cut to the years the window shows (or a heatmap's bands):
 * the figure is cropped to the window, so its caption names those years, and
 * a zoom into one year names none, as a one-year Case does. No year shown, no
 * years.
 */
export function yearsShown(
  facets: SeriesFacets | undefined,
  [first, last]: [number, number],
): SeriesFacets | undefined {
  if (!facets?.years) return facets;
  const from = Math.max(first, facets.years.firstYear);
  const to = Math.min(last, facets.years.firstYear + facets.years.numYears - 1);
  const { years: _span, ...rest } = facets;
  return to < from ? rest : { ...rest, years: { firstYear: from, numYears: to - from + 1 } };
}

/**
 * A line's years cut to those the Years filter keeps (`keep`, null keeping
 * all), first to last, for a pane that draws the whole span with the dropped
 * years blank. Nothing kept leaves the years as they were.
 */
export function yearsKept(
  facets: SeriesFacets | undefined,
  keep: ReadonlySet<number> | null | undefined,
): SeriesFacets | undefined {
  const span = facets?.years;
  if (!span || !keep) return facets;
  const kept: number[] = [];
  for (let year = span.firstYear; year < span.firstYear + span.numYears; year++) {
    if (keep.has(year)) kept.push(year);
  }
  return kept.length > 0 ? yearsShown(facets, [kept[0], kept[kept.length - 1]]) : facets;
}

/**
 * The real hours of a line's years that the Years filter keeps, for a pane
 * that draws the whole span with the dropped years blank: its footnote
 * counts out of the kept years, as its caption names them. Null when nothing
 * narrows the span.
 */
export function keptRealHours(
  facets: SeriesFacets | undefined,
  keep: ReadonlySet<number> | null | undefined,
): number | null {
  const span = facets?.years;
  if (!span || !keep) return null;
  let hours = 0;
  for (let year = span.firstYear; year < span.firstYear + span.numYears; year++) {
    if (keep.has(year)) hours += realHours(year, 1);
  }
  return hours > 0 ? hours : null;
}

/** `values` from `offset` on an axis, NaN outside them. */
function placedOn(axis: FigureAxis, values: Float32Array, offset: number): Float32Array {
  const out = new Float32Array(axis.length).fill(NaN);
  const from = Math.max(0, offset);
  const to = Math.min(axis.length, offset + values.length);
  if (to > from) out.set(values.subarray(from - offset, to - offset), from);
  return out;
}

/**
 * The real hours of every year the drawn lines span on an axis, each year
 * once: lines of one year overlay, so two 2035 Cases count 8,760, and
 * lines of different years sit side by side, so 2035 beside 2036 counts
 * both. A line with no year sits in the origin's slot. Only the years the
 * window touches (`shown`) count, as the caption names them: a week of
 * 2036 is so many hours of 2036's 8,784, not of every year drawn.
 */
function axisRealHours(
  axis: FigureAxis,
  spans: readonly YearSpan[],
  shown: [number, number] | null,
): number {
  const years = new Set<number>();
  for (const span of spans) {
    const first = hasYear(span.firstYear) ? span.firstYear : (axis.origin ?? NO_YEAR);
    for (let n = 0; n < span.numYears; n++) {
      const year = first + n;
      if (!shown || (year >= shown[0] && year <= shown[1])) years.add(year);
    }
  }
  let hours = 0;
  for (const year of years) hours += realHours(year, 1);
  return hours;
}
