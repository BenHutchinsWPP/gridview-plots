// src/figure/build.ts
//
// One pane, as drawn, becomes a print figure for a Word report: an SVG sized
// in inches for a Letter page, text in points, and every line identifiable
// from the figure alone (context line, axis titles, legend table, footnotes).
//
// **DOM-free, and the one drawing path.** It takes the pane's captured lines
// and a `measureText` callback, so it runs under Node with a fixed-width
// measurer, and a raster export is this SVG drawn onto a canvas: one renderer
// means the formats cannot disagree.
//
// **It imports no table kind and never branches on kind.** What a line is
// called comes from the facets each kind already builds (`placeFacts`).
//
// A pane type is a `PaneRenderer` in `PANES`: its data extent, its x ticks and
// its marks. The frame around it (context line, y axes, legend, footnotes) is
// shared, so a new pane type is one renderer, not a second layout.

import type { Quantiles } from '../kernels';
import { HOURS_PER_YEAR } from '../model/calendar';
import { subjectLabel, type SeriesFacets } from '../series/label';
import { scaleOf, scalesOf } from '../series/scales';
import { placeFacts } from './facts';
import { BOX_FILL_ALPHA, layoutLegend, wrapText } from './legend';
import { figureFileStem, suggestCaption } from './naming';
import { PT_PER_IN, line, svgDocument, text, tint, type StrokeStyle } from './svg';
import { boxPane } from './box';
import { DURATION_PANE } from './duration';
import { STACKED_PANE } from './stacked';
import { TIME_PANE } from './time';
import { heatmapPane } from './heatmap';
import { xyPane } from './xy';

/** Pane types that export. Grows as each pane type gets a renderer. */
export type FigurePane = 'time' | 'duration' | 'stacked' | 'box' | 'xy' | 'heatmap';

/** Width and height in inches. */
export interface FigureSize {
  readonly width: number;
  readonly height: number;
}

/** Two figures and their captions fit on one portrait Letter page inside 1"
 * margins at `half`; `full` is for one figure that earns more height. */
export const FIGURE_SIZES = {
  half: { width: 6.5, height: 3.75 },
  full: { width: 6.5, height: 5 },
} as const satisfies Record<string, FigureSize>;

/** One line as the pane drew it. `CaseSeries` satisfies it. */
export interface FigureLine {
  readonly name: string;
  readonly facets?: SeriesFacets;
  readonly color: string;
  readonly unit: string;
  /** 8,760 values, NaN where the pane shows a gap; null when refused. */
  readonly values: ArrayLike<number> | null;
  /** The drawer's grey click-preview: never part of a figure. */
  readonly dashed?: boolean;
  /** Why the pane left the line out, when `values` is null. */
  readonly refusal?: string;
  /** Caveats the line was drawn with, footnoted with a mark on its row. */
  readonly warnings?: readonly string[];
  /** An Area weighted mean's weight column. */
  readonly weightColumn?: string;
}

/** One interface limit line as the pane drew it, in its line's colour. */
export interface FigureLimit {
  readonly color: string;
  readonly unit: string;
  /** 8,760 values, NaN where unbounded or filtered. */
  readonly values: ArrayLike<number>;
  /** A boundary's members' limits summed: named as a best case. */
  readonly summed?: boolean;
}

/** One box's five numbers and fences, as the pane computed them. */
export type FigureQuantiles = Readonly<Omit<Quantiles, 'degenerate'>>;

/** A box pane as drawn: its categories left to right, each box by the
 * capture line it summarises. */
export interface FigureBoxes {
  /** The dimension the boxes are cut on, as the pane's select names it. */
  readonly dimension: string;
  /** The pane's values box: each box's numbers written beside it. */
  readonly values: boolean;
  readonly groups: readonly {
    readonly label: string;
    readonly boxes: readonly {
      /** Index into `FigureCapture.lines`. */
      readonly line: number;
      readonly quantiles: FigureQuantiles;
    }[];
  }[];
}

/** What a pane hands over when its Figure button is clicked. */
export interface FigureCapture {
  readonly pane: FigurePane;
  readonly lines: readonly FigureLine[];
  /** The pane's x window, in the pane's own x units: hour-of-year for time
   * and stacked, % of interval for duration. A stacked pane's lines come
   * bottom band first, in the pane's stack order. */
  readonly xWindow: readonly [number, number];
  /** The limit lines the pane draws: empty or absent when its limits box is
   * unticked, and never the preview's. */
  readonly limits?: readonly FigureLimit[];
  /** The box pane's boxes; required for a box figure. */
  readonly boxes?: FigureBoxes;
  /** The X-Y pane's state; required for an X-Y figure, whose first two
   * lines are the pair in the pane's order, X then Y. */
  readonly xy?: { readonly fit: boolean };
}

export interface FigureInput extends FigureCapture {
  /** The hour filter as a sentence (`filtersLabel`); `all hours` unfiltered. */
  readonly hourFilter: string;
  readonly size: FigureSize;
  /** A text's width in points at `fontPt`. The browser passes a canvas
   * measurer; tests pass a fixed-width one. */
  readonly measureText: (text: string, fontPt: number) => number;
  /** Per-export replacements by text id (`context`, `legend[r][c]`,
   * `legend[r][under]`, `footnote[i]`, `axis.x`, `axis.y[side]`, a heatmap's
   * `axis.color`, `caption`).
   * Never remembered: the next figure starts from the app's own labels. */
  readonly edits?: Readonly<Record<string, string>>;
  /** Every line its own dash pattern, for a greyscale printout. */
  readonly printDashes?: boolean;
}

/** One piece of figure text, by the id an edit names it with. */
export interface FigureText {
  readonly id: string;
  readonly text: string;
}

export interface Figure {
  readonly svg: string;
  /** Every text drawn, in drawing order, as drawn (edits applied). */
  readonly texts: readonly FigureText[];
  /** The plot area's height in points: what the legend and notes left. */
  readonly plotHeight: number;
  /** The plot has less than half the figure's height: a taller size reads
   * better. */
  readonly crowded: boolean;
  /** For Word's Insert Caption, and written into the file (edits applied). */
  readonly caption: string;
  /** The file's name without its extension (`naming.ts`). */
  readonly fileStem: string;
}

/** A y axis on round ticks: `niceScale`'s result. */
export type YScale = ReturnType<typeof niceScale>;

/** What a pane draws in place of the legend table. */
export interface LegendBlock {
  readonly height: number;
  draw(top: number): string[];
}

/** A plot area in points. */
export interface PlotFrame {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** One line ready for a renderer: values, stroke, and its y scale. */
export interface MarkLine {
  readonly values: ArrayLike<number>;
  readonly stroke: StrokeStyle;
  y(value: number): number;
}

export interface XTick {
  readonly at: number;
  readonly label: string;
  readonly room?: number;
}

/** What one pane type draws inside the shared frame. */
export interface PaneRenderer {
  /** The caption's phrasing of what is shown: `Hourly ${what}`. */
  lead(what: string): string;
  /** The x-axis title, when the pane draws one. */
  readonly xTitle?: string;
  /** The lowest and highest value a line shows in the window, or
   * [Infinity, -Infinity] when it shows none. */
  extent(values: ArrayLike<number>, window: readonly [number, number]): [number, number];
  /** Per line, the y range its marks take, when that is not the line's own
   * values (a stacked band sits on the bands below it). */
  yExtents?(
    values: readonly ArrayLike<number>[],
    window: readonly [number, number],
  ): [number, number][];
  /** The legend's row order as line indexes, when it is not pane order. */
  legendOrder?(count: number): number[];
  /** A filled box for a legend swatch, for a pane whose marks are boxes. */
  readonly boxSwatch?: boolean;
  /** x is categories, not a scale: no vertical grid through the marks. */
  readonly categorical?: boolean;
  /** Footnotes on how to read the pane's marks, after placement's own. */
  notes?(): string[];
  /** How many hours the figure shows, for the hours footnote. */
  hoursShown(lines: readonly ArrayLike<number>[], window: readonly [number, number]): number;
  /** x ticks, `at` as a fraction of the plot width. A tick with a `room`
   * (a fraction of the plot width) wraps its label to fit it. */
  xTicks(window: readonly [number, number], plotWidth: number): XTick[];
  marks(lines: readonly MarkLine[], window: readonly [number, number], frame: PlotFrame): string[];
  /** Whether the pane draws interface limit lines (`FigureCapture.limits`). */
  readonly drawsLimits?: boolean;
  /** The pane's one y axis, when it is not read off the lines' units (an
   * X-Y pane's Y series): every line is drawn against it. */
  readonly yAxis?: { readonly title: string; scale(tickCount: number): YScale };
  /** The context line, when the pane states it otherwise than as what every
   * line shares: `shared` is placement's line, `keys` each drawn line's key. */
  context?(shared: string, keys: readonly string[]): string;
  /** Drawn in place of the legend table, for a pane whose lines a table
   * would not explain (an X-Y pair is named by its axes, a heatmap's colours
   * by a colour bar). Footnotes stay. */
  legendBlock?(area: {
    readonly left: number;
    readonly width: number;
    /** What placement titles the value axis: quantity and unit. */
    readonly valueTitle: string;
    readonly measure: (text: string, fontPt: number) => number;
    readonly say: (id: string, text: string) => string;
  }): LegendBlock;
}

/**
 * Each pane type's renderer for one capture. `drawnIndex` maps a capture
 * line's index to its drawn line's, or -1 for a line not drawn.
 */
const PANES: Record<
  FigurePane,
  (capture: FigureCapture, drawnIndex: (captured: number) => number) => PaneRenderer
> = {
  time: () => TIME_PANE,
  duration: () => DURATION_PANE,
  stacked: () => STACKED_PANE,
  box: (capture, drawnIndex) => boxPane(capture.boxes, drawnIndex),
  xy: (capture, drawnIndex) => xyPane(capture, drawnIndex),
  heatmap: (capture, drawnIndex) => heatmapPane(capture, drawnIndex),
};

// Text in points at the figure's final size.
const CONTEXT_PT = 9;
const TICK_PT = 8;
const TITLE_PT = 9;
const NOTE_PT = 7.5;
const LEADING = 1.3;
/** About a pen width in print: thinner prints as a hairline. */
export const LINE_PT = 1.25;

/** A limit line's dash, in points: short dots, the pane's own look. */
export const LIMIT_DASH: readonly number[] = [1.5, 2.5];

/**
 * Line dashes, solid first: the nth line of one colour takes the nth, and with
 * print dashes the nth line of the figure does. **None may equal
 * `LIMIT_DASH`**: a limit is drawn in its line's colour, so a line in that
 * dash would read as a limit. Ten, as many as the pane can draw.
 */
export const LINE_DASHES: readonly (readonly number[])[] = [
  [],
  [6, 2.5],
  [2.5, 2.5],
  [9, 2.5, 2, 2.5],
  [12, 4],
  [4, 1.5],
  [6, 2, 2, 2, 2, 2],
  [15, 3],
  [3, 5],
  [8, 2.5, 8, 6],
];

/** The legend's name for limit lines, per the rule for a boundary's limits. */
const LIMITS_LABEL = 'limits';
const SUMMED_LIMITS_LABEL = 'summed limits (best case)';

const MARGIN = 6;
const GRID = '#dddddd';
const AXIS_INK = '#333333';
const NOTE_INK = '#444444';

/** The lines a figure draws: drawn by the pane, and not the preview. */
export function figureLines<T extends FigureLine>(lines: readonly T[]): T[] {
  return lines.filter((entry) => entry.values !== null && !entry.dashed);
}

export function buildFigure(input: FigureInput): Figure {
  const lines = figureLines(input.lines);
  if (lines.length === 0) throw new Error('a figure needs at least one drawn line');
  const scales = scalesOf(lines);
  if (scales.length > 2) throw new Error('a figure reads at most two y scales');
  const pane = PANES[input.pane](input, (captured) => lines.indexOf(input.lines[captured]));
  const window = input.xWindow;
  const sideOf = (unit: string) => scales.findIndex((s) => s.scale === scaleOf(unit));
  const sides = lines.map((entry) => sideOf(entry.unit));
  const values = lines.map((entry) => entry.values as ArrayLike<number>);
  const strokes = lineStrokes(lines, input.printDashes ?? false);
  // A limit is read against its line's axis; one on no drawn scale, or with
  // no value in the window, is not drawn and not named.
  const limits = (pane.drawsLimits ? (input.limits ?? []) : []).filter((limit) => {
    const [low, high] = pane.extent(limit.values, window);
    return sideOf(limit.unit) >= 0 && low <= high;
  });

  const texts: FigureText[] = [];
  const say = (id: string, fallback: string): string => {
    const shown = input.edits?.[id] ?? fallback;
    texts.push({ id, text: shown });
    return shown;
  };
  const measure = input.measureText;

  const facts = placeFacts(
    lines.map((entry, i) => ({
      name: entry.name,
      facets: entry.facets,
      unit: entry.unit,
      side: sides[i],
      weightColumn: entry.weightColumn,
      warnings: entry.warnings,
    })),
  );

  const width = input.size.width * PT_PER_IN;
  const height = input.size.height * PT_PER_IN;
  const contentWidth = width - 2 * MARGIN;

  const shared = pane.context ? pane.context(facts.context, facts.naming.keys) : facts.context;
  const context = shared ? say('context', shared) : '';
  const hours = pane.hoursShown(values, window);
  const notes = [
    ...facts.notes,
    ...(pane.notes?.() ?? []),
    ...missingNotes(input.lines, lines, values, pane, window, facts.naming.caseLabel),
    ...hoursNote(hours, input.hourFilter),
  ].map((note, i) => say(`footnote[${i}]`, note));
  const noteLines = notes.map((note) => wrapText(note, contentWidth, NOTE_PT, measure));
  const limitRows = limitLegendRows(limits);
  const order = pane.legendOrder?.(lines.length) ?? lines.map((_, i) => i);
  const legend = pane.legendBlock
    ? pane.legendBlock({
        left: MARGIN,
        width: contentWidth,
        valueTitle: facts.yTitles[0] ?? '',
        measure,
        say,
      })
    : layoutLegend(
        [
          ...order.map((i) => ({
            stroke: strokes[i],
            ...(pane.boxSwatch ? { fill: tint(strokes[i].color, BOX_FILL_ALPHA) } : {}),
          })),
          ...limitRows.map((row) => ({ stroke: row.stroke })),
        ],
        facts.columns.map((column) => ({
          ...column,
          cells: [
            ...order.map((i) => column.cells[i]),
            ...limitRows.map((row) => (column.key === 'key' ? row.label : '')),
          ],
        })),
        [...order.map((i) => facts.underRow[i]), ...limitRows.map(() => '')],
        MARGIN,
        contentWidth,
        measure,
        say,
      );
  const yTitles = pane.yAxis
    ? [say('axis.y[0]', pane.yAxis.title)]
    : facts.yTitles.map((title, side) => say(`axis.y[${side}]`, title));
  const xTitle = pane.xTitle ? say('axis.x', pane.xTitle) : '';

  // Top to bottom: context line, plot, x tick labels, legend, footnotes.
  const plotTop = MARGIN + (context ? CONTEXT_PT * LEADING + 4 : 0) + TICK_PT / 2;
  // A wrapped tick label takes more lines; sized here against the plot width
  // the y axes will roughly leave, before the y scale is known.
  const tickLines = (ticks: readonly XTick[], plotWidth: number): string[][] =>
    ticks.map((tick) =>
      tick.room ? wrapText(tick.label, tick.room * plotWidth, TICK_PT, measure) : [tick.label],
    );
  const roughWidth = contentWidth - TITLE_PT * LEADING - 40;
  const labelLines = Math.max(
    1,
    ...tickLines(pane.xTicks(window, roughWidth), roughWidth).map((parts) => parts.length),
  );
  const tickTitleAt = 4 + TICK_PT * LEADING * labelLines;
  const tickBand = tickTitleAt + (xTitle ? TITLE_PT * LEADING + 2 : 0);
  const legendTop = 6;
  const noteCount = noteLines.reduce((sum, parts) => sum + parts.length, 0);
  const notesHeight = noteCount > 0 ? 4 + noteCount * NOTE_PT * LEADING : 0;
  const room = height - plotTop - tickBand - legendTop - legend.height - notesHeight - MARGIN;
  const plotHeight = Math.max(24, room);

  // Each y scale's range over the lines read against it, ticked to fit.
  const tickCount = Math.max(3, Math.min(8, Math.round(plotHeight / 32)));
  const extents = pane.yExtents?.(values, window) ?? values.map((v) => pane.extent(v, window));
  const yScales = pane.yAxis
    ? [pane.yAxis.scale(tickCount)]
    : scales.map((_, side) => {
        let low = Infinity;
        let high = -Infinity;
        extents.forEach(([lo, hi], i) => {
          if (sides[i] !== side) return;
          low = Math.min(low, lo);
          high = Math.max(high, hi);
        });
        for (const limit of limits) {
          if (sideOf(limit.unit) !== side) continue;
          const [lo, hi] = pane.extent(limit.values, window);
          low = Math.min(low, lo);
          high = Math.max(high, hi);
        }
        return niceScale(low, high, tickCount);
      });
  const tickWidths = yScales.map((scale) =>
    Math.max(0, ...scale.labels.map((label) => measure(label, TICK_PT))),
  );
  // A y title longer than the plot is tall wraps into a second column of
  // text rather than running over the context line.
  const yTitleLines = yTitles.map((title) => wrapText(title, plotHeight, TITLE_PT, measure));
  const titleBand = (side: number) => yTitleLines[side].length * TITLE_PT * LEADING;
  const left = MARGIN + titleBand(0) + tickWidths[0] + 4;
  const right =
    yScales.length > 1 ? MARGIN + titleBand(1) + tickWidths[1] + 4 : MARGIN + TICK_PT * 1.5;
  const frame: PlotFrame = { left, top: plotTop, width: width - left - right, height: plotHeight };
  const bottom = frame.top + frame.height;
  const yOf = (side: number) => (value: number) => {
    const { min, max } = yScales[side];
    return bottom - ((value - min) / (max - min)) * frame.height;
  };

  const body: string[] = [];
  const grid = { color: GRID, width: 0.5 };
  const xTicks = pane.xTicks(window, frame.width);
  for (const tick of pane.categorical ? [] : xTicks) {
    const x = frame.left + tick.at * frame.width;
    body.push(line(x, frame.top, x, bottom, grid));
  }
  for (const tick of yScales[0].ticks) {
    const y = yOf(0)(tick);
    body.push(line(frame.left, y, frame.left + frame.width, y, grid));
  }
  body.push(
    line(frame.left, bottom, frame.left + frame.width, bottom, { color: '#999999', width: 0.5 }),
  );

  body.push(
    ...pane.marks(
      [
        ...lines.map((_, i) => ({
          values: values[i],
          stroke: strokes[i],
          y: yOf(pane.yAxis ? 0 : sides[i]),
        })),
        ...limits.map((limit) => ({
          values: limit.values,
          stroke: { color: limit.color, width: LINE_PT, dash: LIMIT_DASH },
          y: yOf(sideOf(limit.unit)),
        })),
      ],
      window,
      frame,
    ),
  );

  // x tick labels, kept inside the page at either end.
  const xLabels = tickLines(xTicks, frame.width);
  xTicks.forEach((tick, t) => {
    xLabels[t].forEach((part, k) => {
      const half = measure(part, TICK_PT) / 2;
      const x = Math.min(
        width - MARGIN - half,
        Math.max(MARGIN + half, frame.left + tick.at * frame.width),
      );
      body.push(
        text(part, x, bottom + 3 + TICK_PT + k * TICK_PT * LEADING, {
          size: TICK_PT,
          anchor: 'middle',
          fill: AXIS_INK,
        }),
      );
    });
  });
  if (xTitle) {
    body.push(
      text(xTitle, frame.left + frame.width / 2, bottom + tickTitleAt + 2 + TITLE_PT, {
        size: TITLE_PT,
        anchor: 'middle',
      }),
    );
  }
  // y tick labels and titles; a title reads bottom to top on either side.
  yScales.forEach((scale, side) => {
    const y = yOf(side);
    const middle = frame.top + frame.height / 2;
    scale.ticks.forEach((tick, i) => {
      const x = side === 0 ? frame.left - 3 : frame.left + frame.width + 3;
      body.push(
        text(scale.labels[i], x, y(tick) + TICK_PT * 0.35, {
          size: TICK_PT,
          anchor: side === 0 ? 'end' : 'start',
          fill: AXIS_INK,
        }),
      );
    });
    // Rotated to read bottom to top, a title's first line is its leftmost.
    const parts = yTitleLines[side];
    const titleX = side === 0 ? MARGIN + TITLE_PT * 0.8 : width - MARGIN - TITLE_PT * 0.25;
    const firstX = side === 0 ? titleX : titleX - (parts.length - 1) * TITLE_PT * LEADING;
    parts.forEach((part, k) =>
      body.push(
        text(part, firstX + k * TITLE_PT * LEADING, middle, {
          size: TITLE_PT,
          anchor: 'middle',
          rotate: -90,
        }),
      ),
    );
  });

  if (context) body.push(text(context, MARGIN, MARGIN + CONTEXT_PT, { size: CONTEXT_PT }));
  const legendAt = bottom + tickBand + legendTop;
  body.push(...legend.draw(legendAt));
  noteLines.flat().forEach((part, i) => {
    const baseline = legendAt + legend.height + 4 + NOTE_PT + i * NOTE_PT * LEADING;
    body.push(text(part, MARGIN, baseline, { size: NOTE_PT, fill: NOTE_INK }));
  });

  const caption = say(
    'caption',
    suggestCaption(facts.naming, (what) => pane.lead(what), input.hourFilter),
  );
  return {
    svg: svgDocument(input.size.width, input.size.height, body, {
      title: caption,
      desc: caption,
    }),
    texts,
    plotHeight,
    crowded: room < height / 2,
    caption,
    fileStem: figureFileStem(facts.naming, input.pane),
  };
}

/**
 * Each line's stroke. Lines that share a colour are told apart by dash, in
 * pane order; with `printDashes` every line is, for a greyscale printout.
 */
function lineStrokes(lines: readonly FigureLine[], printDashes: boolean): StrokeStyle[] {
  const seen = new Map<string, number>();
  return lines.map((entry, i) => {
    const nth = seen.get(entry.color) ?? 0;
    seen.set(entry.color, nth + 1);
    const dash = LINE_DASHES[(printDashes ? i : nth) % LINE_DASHES.length];
    return { color: entry.color, width: LINE_PT, ...(dash.length > 0 ? { dash } : {}) };
  });
}

/**
 * One legend row per kind of limit drawn, after the lines' rows so a line's
 * text ids do not move. Its swatch takes the limits' colour when they share
 * one, and a neutral ink when they bound lines of several colours.
 */
function limitLegendRows(limits: readonly FigureLimit[]): { label: string; stroke: StrokeStyle }[] {
  const rows: { label: string; stroke: StrokeStyle }[] = [];
  for (const [label, summed] of [
    [LIMITS_LABEL, false],
    [SUMMED_LIMITS_LABEL, true],
  ] as const) {
    const colors = new Set(limits.filter((l) => !!l.summed === summed).map((l) => l.color));
    if (colors.size === 0) continue;
    const color = colors.size === 1 ? [...colors][0] : NOTE_INK;
    rows.push({ label, stroke: { color, width: LINE_PT, dash: LIMIT_DASH } });
  }
  return rows;
}

/**
 * The pinned lines a reader would look for and not find: refused by the
 * pane, or drawn flat at zero (or not at all) over the hours shown. Named
 * with their Case when it is not the one the context line states.
 */
function missingNotes(
  captured: readonly FigureLine[],
  drawn: readonly FigureLine[],
  values: readonly ArrayLike<number>[],
  pane: PaneRenderer,
  window: readonly [number, number],
  sharedCase: string | null,
): string[] {
  const nameOf = (entry: FigureLine): string => {
    const key = entry.facets
      ? (entry.facets.figureSubject ?? subjectLabel(entry.facets))
      : entry.name;
    const caseLabel = entry.facets?.caseLabel;
    return caseLabel && caseLabel !== sharedCase ? `${caseLabel} · ${key}` : key;
  };
  const refused = captured
    .filter((entry) => entry.values === null && !entry.dashed)
    .map((entry) =>
      entry.refusal
        ? `Not drawn: ${nameOf(entry)}. ${entry.refusal}`
        : `Not drawn: ${nameOf(entry)}.`,
    );
  const zero: string[] = [];
  const empty: string[] = [];
  drawn.forEach((entry, i) => {
    const [low, high] = pane.extent(values[i], window);
    if (low > high) empty.push(nameOf(entry));
    else if (low === 0 && high === 0) zero.push(nameOf(entry));
  });
  return [
    ...refused,
    ...(zero.length > 0 ? [`Zero in every hour shown: ${zero.join(', ')}.`] : []),
    ...(empty.length > 0 ? [`No value in the hours shown: ${empty.join(', ')}.`] : []),
  ];
}

/** The hours footnote, left out when every hour of the year is shown. */
function hoursNote(shown: number, filter: string): string[] {
  if (shown >= HOURS_PER_YEAR) return [];
  const count = `${shown.toLocaleString('en-US')} of ${HOURS_PER_YEAR.toLocaleString('en-US')} hours`;
  return [
    filter && filter !== 'all hours'
      ? `Hours shown: ${filter} (${count})`
      : `Hours shown: ${count}`,
  ];
}

/** A y range on round ticks covering `low`..`high`, about `count` of them. */
export function niceScale(
  low: number,
  high: number,
  count: number,
): { min: number; max: number; ticks: number[]; labels: string[] } {
  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    low = 0;
    high = 1;
  }
  if (low === high) {
    const pad = Math.abs(low) * 0.1 || 1;
    low -= pad;
    high += pad;
  } else {
    // A line at the data's extreme would sit on the frame; a little room
    // keeps it off, without crossing zero for data that never does.
    const pad = (high - low) * 0.04;
    low = low >= 0 ? Math.max(0, low - pad) : low - pad;
    high = high <= 0 ? Math.min(0, high + pad) : high + pad;
  }
  const raw = (high - low) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => raw <= m * magnitude) ?? 10) * magnitude;
  const min = Math.floor(low / step) * step;
  const max = Math.ceil(high / step) * step;
  let decimals = 0;
  while (decimals < 6 && Math.abs(step * 10 ** decimals - Math.round(step * 10 ** decimals)) > 1e-9)
    decimals++;
  const ticks: number[] = [];
  for (let i = 0; min + i * step <= max + step * 1e-9; i++) {
    ticks.push(Number((min + i * step).toFixed(decimals)));
  }
  const labels = ticks.map((tick) =>
    tick
      .toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
      .replace('-', '−'),
  );
  return { min, max, ticks, labels };
}
