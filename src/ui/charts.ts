// src/ui/charts.ts
//
// The host of the four chart panes (`src/ui/panes/`). A renderer only:
// main.ts computes everything it draws. It resolves each pane's elements
// inside the section, holds the layout, feeds every pane the same render,
// and keeps what spans panes: the Figure button's offering rule, the dates a
// pane reports, the whole-year lines several panes may share, and the
// interval settings a bundle saves.
//
// Shared by every kind, so it imports nothing from src/tables/.

import 'uplot/dist/uPlot.min.css';
import type { SeriesSpec } from '../series/model';
import type { SeriesFacets } from '../series/label';
import { within } from './dom';
import { CASE_COLORS } from './shell';
import { figureLines, type FigureCapture } from '../figure/build';
import { sameSet, type DateSet } from '../model/date-range';
import type { PaneElements, PaneFrame } from './panes/adapter';
import { createPane, type AdapterFactories, type ChartPane } from './panes/pane';
import { createDurationAdapter, createStackedAdapter, createTimeAdapter } from './panes/line';
import { createBoxAdapter } from './panes/box';
import { createXyAdapter } from './panes/xy';
import { createHeatmapAdapter } from './panes/heatmap';
import { createIntervalAdapter, intervalSettings, restoreIntervalSettings } from './panes/interval';
import { createLegendAdapter } from './panes/legend';

/** The summary the legend renders. `sum` is optional: only units that may be
 * totalled over time have one. */
export interface Stats {
  n: number;
  mean: number;
  min: number;
  max: number;
  sd: number;
  sum?: number;
}

/** The five-number summary plus Tukey fences. Declared here, not imported, to
 * keep this module free of src/tables/. */
export interface Quantiles {
  n: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
  lowerWhisker: number;
  upperWhisker: number;
  outliers: number;
  /** p25 = median = p75: correct, but reads as a broken chart. */
  degenerate: boolean;
}

export interface CaseSeries {
  /** The in-plot name: only the facets that vary across the drawn set
   * (`src/series/label.ts`). `detail` is the standalone form. */
  name: string;
  color: string;
  /** Lines of different units get different y scales. */
  unit: string;
  /** 8,784 values (the year slot), NaN where filtered out or missing; null when refused. */
  values: Float32Array | null;
  /** Shown in place of a chart. */
  refusal?: string;
  warnings: string[];
  /** Kept values, sorted ascending. */
  sorted: Float32Array;
  n: number;
  stats: Stats;
  quantiles: Quantiles;
  /** Zero in every kept hour: data, not a load error. */
  allZero: boolean;
  /** The drawer's transient click-preview, drawn grey and dashed. Part of the
   * pane signature, or a pin replacing a preview would inherit its dashes. */
  dashed?: boolean;
  /** The browse row this line draws: how the Selected tab finds a pin's
   * stats when no tab lists the pin under its current view. */
  rowId?: string;
  /** A "% of range" line: which divisor it used (`src/series/range.ts`). */
  rangeLabel?: string;
  /** The SeriesSpec this line resolves, when resolved from a spec. */
  spec?: SeriesSpec;
  /** A grouped line's combined entity keys (summed, or for an Area
   * intensive metric weighted), read by `checkStackOverlap` and counted by a
   * print figure's key. */
  summed?: readonly (string | number)[];

  // Set by one kind, absent on the rest; read as present-or-absent, never by
  // branching on kind.

  /** Area. */
  metric?: string;
  /** Area: the weight column of this per-hour mean, named in the legend. */
  weightColumn?: string;
  /** Area: pooled sum(v*w)/sum(w), or null for columns that are not weighted. */
  pooled?: number | null;
  /** The full label: every facet needed to identify this series alone. */
  detail?: string;
  /** The facets `name` and `detail` were built from. Optional. */
  facets?: SeriesFacets;
  /** Interface: the case's full quantity, e.g. `Power Flow (MW)`. */
  quantity?: string;
}

/**
 * One interface limit, expanded to hours. NOT a `CaseSeries`: it is an
 * annotation, so it must stay out of the legend, stats, box and X-Y panes and
 * the ten-line cap.
 */
export interface DrawnLimit {
  /** Hover readout name: the series it bounds, plus the side. */
  name: string;
  /** Exactly the bounded line's colour. */
  color: string;
  /** The bounded series' unit, so both share a y scale. */
  unit: string;
  /** 8,784 values (the year slot), NaN where unbounded or filtered; already masked. */
  values: Float32Array;
  /** A boundary's members' limits summed (`summedLimitLines`). */
  summed?: boolean;
  /** Bounds the drawer's click-preview, so a figure leaves it out with it. */
  preview?: boolean;
}

export interface BoxGroup {
  label: string;
  boxes: { color: string; name: string; unit: string; quantiles: Quantiles }[];
}

export interface ChartsInput {
  /** Each pane's box dimension, by pane. A string because the unions differ
   * per kind. */
  boxDims: readonly string[];
  series: CaseSeries[];
  /** A pane's boxes, cut on that pane's dimension when a box pane asks: a
   * cut is a pass over every line, and a render per animation frame (a date
   * drag) must not pay it for panes that draw none. */
  boxes(pane: number): readonly BoxGroup[];
  /** The selection cannot be drawn at all; every pane says so. */
  refusal?: string;
  /**
   * Interface limit lines, expanded and masked. Drawn on the TIME pane only:
   * other panes' x axes (rank, box, X-Y) do not carry a monthly limit.
   */
  limits?: DrawnLimit[];
  /** Whether any Case is loaded, so an empty pane can name the missing step. */
  hasCases: boolean;
  /** The rail's dates, the window a year overview draws. */
  dates: DateSet | null;
  /** A drawn line's calendar year, for the interval pane's weeks. */
  yearOf?: (series: CaseSeries) => number;
  /** The drawn lines with the dates cleared, for a year overview. Asked only
   * when a pane shows one: it is a second resolve of every line. */
  overview?: () => readonly CaseSeries[];
  /** Those lines' limits: a time pane showing the whole year draws them. */
  overviewLimits?: () => DrawnLimit[];
}

export type SlotType =
  'time' | 'duration' | 'box' | 'stacked' | 'xy' | 'legend' | 'heatmap' | 'interval';

/** A layout is exactly FOUR slots, matching the pane hooks in `index.html`. */
const DEFAULT_SLOTS: readonly SlotType[] = ['time', 'duration', 'box', 'stacked'];

export interface Charts {
  render(input: ChartsInput): void;
  /** The time pane's x window in hour-of-year, for the test harness. */
  timeWindow(): [number, number] | null;
  layout(): readonly SlotType[];
  setLayout(layout: readonly SlotType[]): void;
  /** Each pane's interval settings, by pane, for a bundle. */
  intervals(): PaneInterval[];
  /** Put back saved interval settings; a value this build does not know,
   * or a pane with none saved, takes the default. */
  setIntervals(saved: readonly PaneInterval[] | undefined): void;
}

/** One pane's interval settings, as a bundle carries them. */
export interface PaneInterval {
  readonly length: string;
  readonly colour: string;
  readonly mean: boolean;
  readonly band: boolean;
}

/** Every chart type a pane can show, and the adapter that draws it. */
const ADAPTERS: AdapterFactories = {
  time: createTimeAdapter,
  duration: createDurationAdapter,
  stacked: createStackedAdapter,
  box: createBoxAdapter,
  xy: createXyAdapter,
  heatmap: createHeatmapAdapter,
  interval: createIntervalAdapter,
  legend: createLegendAdapter,
};

// Each pane's hooks, spelled out so tests/test_dom_contract.mjs can match
// them against index.html as text. Any pane can hold any chart type, so each
// header carries every type's controls.
const PANE_HOOKS = ['[data-pane="1"]', '[data-pane="2"]', '[data-pane="3"]', '[data-pane="4"]'];
const PANE_BODY_HOOKS = [
  '[data-pane="1-body"]',
  '[data-pane="2-body"]',
  '[data-pane="3-body"]',
  '[data-pane="4-body"]',
];
const SLOT_TYPE_HOOKS = [
  '[data-el="slot-type-1"]',
  '[data-el="slot-type-2"]',
  '[data-el="slot-type-3"]',
  '[data-el="slot-type-4"]',
];
const FIGURE_HOOKS = [
  '[data-el="figure-1"]',
  '[data-el="figure-2"]',
  '[data-el="figure-3"]',
  '[data-el="figure-4"]',
];
const ZOOM_RESET_HOOKS = [
  '[data-el="zoom-reset-1"]',
  '[data-el="zoom-reset-2"]',
  '[data-el="zoom-reset-3"]',
  '[data-el="zoom-reset-4"]',
];
const DOWNLOAD_HOOKS = [
  '[data-el="download-1"]',
  '[data-el="download-2"]',
  '[data-el="download-3"]',
  '[data-el="download-4"]',
];
const LIMITS_CHECK_HOOKS = [
  '[data-el="limits-check-1"]',
  '[data-el="limits-check-2"]',
  '[data-el="limits-check-3"]',
  '[data-el="limits-check-4"]',
];
const FOLLOW_DATES_CHECK_HOOKS = [
  '[data-el="follow-dates-check-1"]',
  '[data-el="follow-dates-check-2"]',
  '[data-el="follow-dates-check-3"]',
  '[data-el="follow-dates-check-4"]',
];
const OVERVIEW_CHECK_HOOKS = [
  '[data-el="overview-check-1"]',
  '[data-el="overview-check-2"]',
  '[data-el="overview-check-3"]',
  '[data-el="overview-check-4"]',
];
/** The strip a time pane's overview shows under its body. */
const OVERVIEW_HOOKS = [
  '[data-el="overview-1"]',
  '[data-el="overview-2"]',
  '[data-el="overview-3"]',
  '[data-el="overview-4"]',
];
/** A box pane's own dimension: two box panes may cut differently. */
const BOX_DIM_SELECT_HOOKS = [
  '[data-el="box-dim-select-1"]',
  '[data-el="box-dim-select-2"]',
  '[data-el="box-dim-select-3"]',
  '[data-el="box-dim-select-4"]',
];
const BOX_VALUES_CHECK_HOOKS = [
  '[data-el="box-values-check-1"]',
  '[data-el="box-values-check-2"]',
  '[data-el="box-values-check-3"]',
  '[data-el="box-values-check-4"]',
];
const XY_SWAP_HOOKS = [
  '[data-el="xy-swap-1"]',
  '[data-el="xy-swap-2"]',
  '[data-el="xy-swap-3"]',
  '[data-el="xy-swap-4"]',
];
/** A fit belongs to the pair on that pane's axes. */
const XY_FIT_HOOKS = [
  '[data-el="xy-fit-1"]',
  '[data-el="xy-fit-2"]',
  '[data-el="xy-fit-3"]',
  '[data-el="xy-fit-4"]',
];
const INTERVAL_BY_HOOKS = [
  '[data-el="interval-by-1"]',
  '[data-el="interval-by-2"]',
  '[data-el="interval-by-3"]',
  '[data-el="interval-by-4"]',
];
const INTERVAL_COLOUR_HOOKS = [
  '[data-el="interval-colour-1"]',
  '[data-el="interval-colour-2"]',
  '[data-el="interval-colour-3"]',
  '[data-el="interval-colour-4"]',
];
const INTERVAL_MEAN_HOOKS = [
  '[data-el="interval-mean-1"]',
  '[data-el="interval-mean-2"]',
  '[data-el="interval-mean-3"]',
  '[data-el="interval-mean-4"]',
];
const INTERVAL_BAND_HOOKS = [
  '[data-el="interval-band-1"]',
  '[data-el="interval-band-2"]',
  '[data-el="interval-band-3"]',
  '[data-el="interval-band-4"]',
];
const CHART_AREA_HOOK = '[data-el="chart-area"]';

/** Number words for "narrow one of the N". Four is the most any kind has. */
const AXIS_COUNT_WORDS = ['none', 'one', 'two', 'three', 'four'];

/**
 * The drawn-series cap: ten, from `CASE_COLORS.length`, because a ten-entry
 * legend is the most a reader can learn. A kind passes its axes as data, so
 * no kind branch lives here. Returns the message, or null when it fits.
 */
export function seriesCapMessage(
  drawn: number,
  axes: ReadonlyArray<{ label: string; count: number }>,
): string | null {
  if (drawn <= CASE_COLORS.length) return null;
  const product = axes.map((axis) => `${axis.count} ${axis.label}`).join(' × ');
  return (
    `${drawn} series selected (${product}). ${CASE_COLORS.length} is the most that ` +
    `can be told apart by colour — narrow one of the ${AXIS_COUNT_WORDS[axes.length] ?? axes.length}.`
  );
}

/**
 * Mount the four panes into `root`, the section's own template clone. Every
 * lookup is scoped to it: a global id would give two sections one container.
 */
export function createCharts(
  root: HTMLElement,
  onBoxDimChange: (pane: number, dim: string) => void,
  options?: {
    /** A pane's Figure button: the pane as drawn at the click. */
    /** `wholeYear`: a time pane not following the dates, so the figure
     * shows every date. */
    onFigure?: (capture: FigureCapture, shown: { wholeYear: boolean }) => void;
    /** A drag-zoom with "follow dates" ticked, or a drag on a year overview. */
    onDatesChange?: (dates: DateSet) => void;
  },
): Charts {
  const currentLayout: SlotType[] = [...DEFAULT_SLOTS];

  const slotSelects = SLOT_TYPE_HOOKS.map((hook) => within<HTMLSelectElement>(root, hook));
  const figureBtns = FIGURE_HOOKS.map((hook) => within<HTMLButtonElement>(root, hook));
  const paneElements: PaneElements[] = [0, 1, 2, 3].map((i) => ({
    body: within(root, PANE_BODY_HOOKS[i]),
    note: within(root, PANE_HOOKS[i]).querySelector<HTMLElement>('.pane-note'),
    zoomReset: within<HTMLButtonElement>(root, ZOOM_RESET_HOOKS[i]),
    download: within<HTMLButtonElement>(root, DOWNLOAD_HOOKS[i]),
    limits: within<HTMLInputElement>(root, LIMITS_CHECK_HOOKS[i]),
    follow: within<HTMLInputElement>(root, FOLLOW_DATES_CHECK_HOOKS[i]),
    overview: within<HTMLInputElement>(root, OVERVIEW_CHECK_HOOKS[i]),
    overviewHost: within(root, OVERVIEW_HOOKS[i]),
    boxDim: within<HTMLSelectElement>(root, BOX_DIM_SELECT_HOOKS[i]),
    boxValues: within<HTMLInputElement>(root, BOX_VALUES_CHECK_HOOKS[i]),
    xySwap: within<HTMLButtonElement>(root, XY_SWAP_HOOKS[i]),
    xyFit: within<HTMLInputElement>(root, XY_FIT_HOOKS[i]),
    intervalBy: within<HTMLSelectElement>(root, INTERVAL_BY_HOOKS[i]),
    intervalColour: within<HTMLSelectElement>(root, INTERVAL_COLOUR_HOOKS[i]),
    intervalMean: within<HTMLInputElement>(root, INTERVAL_MEAN_HOOKS[i]),
    intervalBand: within<HTMLInputElement>(root, INTERVAL_BAND_HOOKS[i]),
  }));
  const paneBodies = paneElements.map((elements) => elements.body);
  let lastInput: ChartsInput | null = null;

  /** A new range from a pane, dropped when it is the one already applied, or
   * the zoom and the dates would re-trigger each other. */
  function datesFromPane(dates: DateSet): void {
    if (!lastInput || sameSet(dates, lastInput.dates)) return;
    options?.onDatesChange?.(dates);
  }

  const env = {
    rerender() {
      if (lastInput) rebuild(lastInput);
    },
    datesChange: datesFromPane,
  };
  const panes: ChartPane[] = paneElements.map((elements, i) =>
    createPane(i, elements, env, ADAPTERS, currentLayout[i]),
  );

  for (let i = 0; i < 4; i++) {
    slotSelects[i].value = currentLayout[i];
    slotSelects[i].addEventListener('change', () => {
      const chosen = slotSelects[i].value as SlotType;
      currentLayout[i] = chosen;
      panes[i].setType(chosen);
      if (lastInput) rebuild(lastInput);
    });

    figureBtns[i].addEventListener('click', () => {
      const shot = panes[i].figure();
      if (shot) options?.onFigure?.(shot.capture, shot.shown);
    });

    paneElements[i].boxDim.addEventListener('change', () =>
      onBoxDimChange(i, paneElements[i].boxDim.value),
    );
  }

  /**
   * Each pane's Figure button, decided AFTER the panes paint: a pane type with
   * a renderer, with a pinned line to draw (the preview alone is not a
   * figure), and no refusal banner in place of its chart. Reading the banner
   * rather than restating each pane's refusal rules keeps one owner for what
   * a pane refuses (too many units, a stack, the series cap, a whole
   * selection).
   */
  function updateFigureButtons(drawable: CaseSeries[]): void {
    for (let i = 0; i < 4; i++) {
      const offered =
        !!options?.onFigure &&
        panes[i].figureOffered() &&
        figureLines(drawable).length > 0 &&
        !paneBodies[i].querySelector('.pane-banner-refusal');
      figureBtns[i].style.display = offered ? '' : 'none';
    }
  }

  function rebuild(input: ChartsInput): void {
    const drawable = input.refusal ? [] : input.series.filter((s) => s.values !== null);

    const zeroCases = drawable.filter((s) => s.allZero).map((s) => s.name);
    const zeroText =
      zeroCases.length > 0
        ? `Zero in every selected hour: ${zeroCases.join(', ')}. That is the data, not a load error.`
        : null;

    let wholeYearLines: readonly CaseSeries[] | null = null;
    const frame: PaneFrame = {
      input,
      drawable,
      zeroText,
      wholeYear: () => (wholeYearLines ??= input.overview?.() ?? []),
    };

    // Each pane's controls depend on the layout and the drawn count, so they
    // are recomputed on every rebuild.
    for (const pane of panes) pane.showControls(frame);
    for (const pane of panes) pane.render(frame);
    updateFigureButtons(drawable);
  }

  let frame = 0;
  const observer = new ResizeObserver(() => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      for (const pane of panes) pane.resize();
    });
  });
  observer.observe(within(root, CHART_AREA_HOOK));
  for (const body of paneBodies) {
    observer.observe(body);
  }

  return {
    render(input) {
      lastInput = input;
      input.boxDims.forEach((dim, i) => {
        paneElements[i].boxDim.value = dim;
      });
      rebuild(input);
    },
    timeWindow() {
      for (const pane of panes) {
        const window = pane.timeWindow();
        if (window) return window;
      }
      return null;
    },
    layout() {
      return [...currentLayout];
    },
    intervals() {
      return paneElements.map(intervalSettings);
    },
    setIntervals(saved) {
      paneElements.forEach((elements, i) => restoreIntervalSettings(elements, saved?.[i]));
      if (lastInput) rebuild(lastInput);
    },
    setLayout(newLayout: readonly SlotType[]) {
      if (newLayout.length === 4) {
        for (let i = 0; i < 4; i++) {
          currentLayout[i] = newLayout[i];
          slotSelects[i].value = newLayout[i];
          panes[i].setType(newLayout[i]);
        }
        if (lastInput) rebuild(lastInput);
      }
    },
  };
}
