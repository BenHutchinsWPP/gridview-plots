// src/ui/charts.ts
//
// The four panes: three uPlot line charts (time, duration, stacked), three
// hand-drawn canvases (box plot, X-Y scatter, diurnal heatmap, each in its
// own module) and the legend table. A renderer only: main.ts computes
// everything it draws.
//
// uPlot instances are created ONCE and updated with setData(); recreating one
// per change or resize gives up the performance uPlot was chosen for.
//
// Shared by every kind, so it imports nothing from src/tables/. Per-kind
// behaviour arrives as `ChartsHooks`.

import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { HOURS_PER_YEAR } from '../model/calendar';
import { stackOrder, type SeriesSpec } from '../series/model';
import { contextLabel, subjectLabel, type SeriesFacets } from '../series/label';
import { within } from './dom';
import { CASE_COLORS } from './shell';
import { createBoxPlot, type BoxGeometry, type BoxHit } from './box-plot';
import { clip, emptyPaneText, formatNumber, hourLabel } from './chart-format';
import { makeAxisTags, placeAxisTag } from './chart-axis';
import { createXyPlot, type XyGeometry, type XyPoint } from './xy-plot';
import { createHeatmapPlot, type HeatmapGeometry } from './heatmap-plot';
import { createLinePanes } from './line-panes';
import { HOUR_COLUMNS, csvField, formatCell, hourFields } from './hourly-csv';
import { figureLines, type FigureCapture, type FigurePane } from '../figure/build';
import { saveBlob } from './download';

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
  /** 8,760 values, NaN where filtered out or missing; null when refused. */
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
  /** 8,760 values, NaN where unbounded or filtered; already masked. */
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
  /** The box pane's dimension. A string because the unions differ per kind. */
  boxDim: string;
  series: CaseSeries[];
  boxes: BoxGroup[];
  /** The selection cannot be drawn at all; every pane says so. */
  refusal?: string;
  /**
   * Interface limit lines, expanded and masked. Drawn on the TIME pane only:
   * other panes' x axes (rank, box, X-Y) do not carry a monthly limit.
   */
  limits?: DrawnLimit[];
  /** Whether any Case is loaded, so an empty pane can name the missing step. */
  hasCases: boolean;
}

/**
 * Kind-specific behaviour from the section that mounts the panes. **Keep it
 * small.** The drawer feeds series of every kind into these panes, so a
 * member must hold for any series, whichever kind mounted the section.
 */
export interface ChartsHooks {
  /** The y scale a unit is drawn on. */
  scaleOf(unit: string): string;
  /** Distinct y scales among the drawn lines, in first-seen order. */
  scalesOf(series: { unit: string }[]): { scale: string; label: string }[];
}

export type SlotType = 'time' | 'duration' | 'box' | 'stacked' | 'xy' | 'legend' | 'heatmap';

/** A layout is exactly FOUR slots, matching the pane hooks in `index.html`. */
export const DEFAULT_SLOTS: readonly SlotType[] = ['time', 'duration', 'box', 'stacked'];

export interface Charts {
  render(input: ChartsInput): void;
  /** The time pane's x window in hour-of-year, for the test harness. */
  timeWindow(): [number, number] | null;
  layout(): readonly SlotType[];
  setLayout(layout: readonly SlotType[]): void;
}

/** Spelled out so tests/test_dom_contract.mjs can match them against
 * index.html as text. */
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
const ZOOM_RESET_HOOKS = [
  '[data-el="zoom-reset-1"]',
  '[data-el="zoom-reset-2"]',
  '[data-el="zoom-reset-3"]',
  '[data-el="zoom-reset-4"]',
];
/** The X-Y swap, per pane header: any pane can be the X-Y slot. */
const XY_SWAP_HOOKS = [
  '[data-el="xy-swap-1"]',
  '[data-el="xy-swap-2"]',
  '[data-el="xy-swap-3"]',
  '[data-el="xy-swap-4"]',
];
/** The X-Y fit toggle, per pane: a fit belongs to the pair on that pane's
 * axes. */
const XY_FIT_HOOKS = [
  '[data-el="xy-fit-1"]',
  '[data-el="xy-fit-2"]',
  '[data-el="xy-fit-3"]',
  '[data-el="xy-fit-4"]',
];
/** The Figure button, per pane header: any pane can hold an exportable chart. */
const FIGURE_HOOKS = [
  '[data-el="figure-1"]',
  '[data-el="figure-2"]',
  '[data-el="figure-3"]',
  '[data-el="figure-4"]',
];
/** The slot types a figure can be made of, and the renderer each uses. */
const FIGURE_PANES: Partial<Record<SlotType, FigurePane>> = {
  time: 'time',
  duration: 'duration',
  stacked: 'stacked',
  box: 'box',
  xy: 'xy',
  heatmap: 'heatmap',
};
const DOWNLOAD_HOOK = '[data-el="download-1"]';
const BOX_DIM_SELECT_HOOK = '[data-el="box-dim-select"]';
const BOX_VALUES_CHECK_HOOK = '[data-el="box-values-check"]';
const LIMITS_CHECK_HOOK = '[data-el="limits-check"]';
const CHART_AREA_HOOK = '[data-el="chart-area"]';

/**
 * The pane's banner stack. Positioned out of flow (`.pane-banners`) so a note
 * does not change `.pane-body`'s measured height and feed the next resize.
 */
function bannerStack(body: HTMLElement): HTMLElement {
  const held = body.querySelector<HTMLElement>('.pane-banners');
  if (held) return held;
  const stack = document.createElement('div');
  stack.className = 'pane-banners';
  body.appendChild(stack);
  return stack;
}

function banner(body: HTMLElement, kind: 'refusal' | 'note', text: string): void {
  const element = document.createElement('div');
  element.className = `pane-banner pane-banner-${kind}`;
  element.textContent = text;
  bannerStack(body).appendChild(element);
}

/**
 * The pane header's one line. **It names only what the SLOT knows**: which
 * series is on X, which the heatmap painted, which axis the boxes are cut on.
 * Case, entity, group and unit are the legend's, and restating them here
 * would drift. A per-kind header would be right for one kind and silently
 * wrong for mixed selections.
 */
function headerNote(root: HTMLElement, pane: number, text: string): void {
  const header = within(root, PANE_HOOKS[pane - 1]).querySelector('.pane-note');
  if (header) header.textContent = text;
}

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
  onBoxDimChange: (dim: string) => void,
  hooks: ChartsHooks,
  options?: {
    initialLayout?: readonly SlotType[];
    onLayoutChange?: (layout: readonly SlotType[]) => void;
    /** A pane's Figure button: the pane as drawn at the click. */
    onFigure?: (capture: FigureCapture) => void;
  },
): Charts {
  const { scaleOf, scalesOf } = hooks;
  const currentLayout: SlotType[] = [
    ...(options?.initialLayout && options.initialLayout.length === 4
      ? options.initialLayout
      : DEFAULT_SLOTS),
  ];

  const paneBodies = PANE_BODY_HOOKS.map((hook) => within(root, hook));
  const slotSelects = SLOT_TYPE_HOOKS.map((hook) => within<HTMLSelectElement>(root, hook));
  const zoomResetBtns = ZOOM_RESET_HOOKS.map((hook) => within<HTMLButtonElement>(root, hook));
  const xySwapBtns = XY_SWAP_HOOKS.map((hook) => within<HTMLButtonElement>(root, hook));
  const xyFitChecks = XY_FIT_HOOKS.map((hook) => within<HTMLInputElement>(root, hook));
  const figureBtns = FIGURE_HOOKS.map((hook) => within<HTMLButtonElement>(root, hook));
  const download1Btn = within<HTMLButtonElement>(root, DOWNLOAD_HOOK);
  const boxDimSelect = within<HTMLSelectElement>(root, BOX_DIM_SELECT_HOOK);
  const boxValuesCheck = within<HTMLInputElement>(root, BOX_VALUES_CHECK_HOOK);
  // ONE limits switch per session: a limit belongs to the interface, not to
  // a selection. Visibility depends on render state, so `render` decides it.
  const limitsCheck = within<HTMLInputElement>(root, LIMITS_CHECK_HOOK);

  const slotUplotHosts: HTMLElement[] = [];
  // The box and X-Y panes share one canvas host per slot. Showing it clears
  // the other pane's hover state, so hover routing follows the live pane.
  const slotCanvasHosts: HTMLElement[] = [];
  const slotCanvases: HTMLCanvasElement[] = [];
  const slotTips: HTMLElement[] = [];
  const slotBoxTags: HTMLElement[][] = [];
  const slotLegendHosts: HTMLElement[] = [];

  const slotPlots: (uPlot | null)[] = [null, null, null, null];
  const slotSignatures: string[] = ['', '', '', ''];
  const slotTimeExtents: ([number, number] | null)[] = [null, null, null, null];

  const slotBoxGeometry: (BoxGeometry | null)[] = [null, null, null, null];

  const slotBoxHits: BoxHit[][] = [[], [], [], []];
  const slotHoveredBox: number[] = [-1, -1, -1, -1];

  const slotXyGeometry: (XyGeometry | null)[] = [null, null, null, null];
  const slotXyHits: XyPoint[][] = [[], [], [], []];
  const slotHeatmapGeometry: (HeatmapGeometry | null)[] = [null, null, null, null];
  /** Each X-Y pane's pair, for the resize path. */
  const slotXyPair: ([CaseSeries, CaseSeries] | null)[] = [null, null, null, null];
  /** The name this pane last put on X, or null for selection order. A name,
   * not an index, so a changed selection cannot reassign the user's choice. */
  const slotXyX: (string | null)[] = [null, null, null, null];
  let lastInput: ChartsInput | null = null;

  // Renderers paint at exactly this size, so it must never exceed the pane
  // (content would be clipped out of reach). The 1px floor is only for a
  // hidden pane, which measures zero.
  function paneSize(body: HTMLElement): { width: number; height: number } {
    const rect = body.getBoundingClientRect();
    return {
      width: Math.max(1, Math.floor(rect.width)),
      height: Math.max(1, Math.floor(rect.height)),
    };
  }

  const linePanes = createLinePanes({
    paneBodies,
    slotUplotHosts,
    slotCanvasHosts,
    slotLegendHosts,
    slotPlots,
    slotSignatures,
    slotTimeExtents,
    limitsCheck,
    paneSize,
    scaleOf,
    scalesOf,
    banner,
  });

  const boxPlot = createBoxPlot({
    paneBodies,
    slotCanvases,
    slotBoxTips: slotTips,
    slotBoxGeometry,
    slotBoxHits,
    slotHoveredBox,
    boxValuesCheck,
    paneSize,
    scaleOf,
    scalesOf,
    formatNumber,
    banner,
    clip,
  });

  const xyPlot = createXyPlot({
    paneBodies,
    slotCanvases,
    slotTips,
    slotXyGeometry,
    slotXyHits,
    paneSize,
    scalesOf,
    formatNumber,
    hourLabel,
    banner,
    clip,
  });

  const heatmapPlot = createHeatmapPlot({
    paneBodies,
    slotCanvases,
    slotTips,
    slotHeatmapGeometry,
    paneSize,
    formatNumber,
    hourLabel,
    banner,
    clip,
  });

  /** The ordered pair an X-Y pane draws. A stored X name no longer selected
   * falls back to selection order. */
  function xyPair(slot: number, drawable: CaseSeries[]): [CaseSeries, CaseSeries] {
    const stored = slotXyX[slot];
    // The FULL label: `name` is relative to the other lines and can change.
    const x = stored == null ? -1 : drawable.findIndex((s) => (s.detail ?? s.name) === stored);
    const xAxis = x >= 0 ? x : 0;
    return [drawable[xAxis], drawable[1 - xAxis]];
  }

  for (let i = 0; i < 4; i++) {
    const body = paneBodies[i];

    const uplotHost = document.createElement('div');
    uplotHost.className = 'pane-uplot-host';
    body.appendChild(uplotHost);
    slotUplotHosts.push(uplotHost);

    const canvasHost = document.createElement('div');
    canvasHost.className = 'pane-canvas-host';
    canvasHost.style.position = 'relative';
    canvasHost.style.width = '100%';
    canvasHost.style.height = '100%';
    canvasHost.style.display = 'none';
    body.appendChild(canvasHost);
    slotCanvasHosts.push(canvasHost);

    const canvas = document.createElement('canvas');
    canvas.className = 'pane-canvas';
    canvasHost.appendChild(canvas);
    slotCanvases.push(canvas);

    const tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.style.display = 'none';
    canvasHost.appendChild(tip);
    slotTips.push(tip);

    const tags = makeAxisTags(2);
    for (const tag of tags) canvasHost.appendChild(tag);
    slotBoxTags.push(tags);

    const legendHost = document.createElement('div');
    legendHost.className = 'pane-legend-host';
    legendHost.style.display = 'none';
    body.appendChild(legendHost);
    slotLegendHosts.push(legendHost);

    slotSelects[i].value = currentLayout[i];
    slotSelects[i].addEventListener('change', () => {
      const chosen = slotSelects[i].value as SlotType;
      currentLayout[i] = chosen;
      options?.onLayoutChange?.(currentLayout);
      if (lastInput) rebuild(lastInput);
    });

    zoomResetBtns[i].addEventListener('click', () => {
      const type = currentLayout[i];
      if (type === 'duration') {
        resetZoom(slotPlots[i], null);
      } else if (type === 'time' || type === 'stacked') {
        resetZoom(slotPlots[i], slotTimeExtents[i]);
      }
    });

    // Captured now, values copied: the pool reuses a line's buffer on the
    // next draw, and the dialog must keep showing what was clicked.
    figureBtns[i].addEventListener('click', () => {
      const pane = FIGURE_PANES[currentLayout[i]];
      if (!pane || !lastInput) return;
      // A box or X-Y pane has no zoom: its window is its categories or its
      // pair's own values.
      const scale =
        pane === 'box' || pane === 'xy' || pane === 'heatmap'
          ? { min: 0, max: 1 }
          : slotPlots[i]?.scales.x;
      if (scale?.min == null || scale.max == null) return;
      // Refused lines too: the figure names them in a footnote. A stack's
      // lines go bottom band first, in the order the pane stacked them; an
      // X-Y pair X first, as the pane holds it after any swap; a heatmap's
      // one series first, and the pinned lines it leaves out named as such.
      const pinned = lastInput.series.filter((s) => !s.dashed);
      const refused = pinned.filter((s) => s.values === null);
      const pair = slotXyPair[i];
      if (pane === 'xy' && !pair) return;
      const painted = slotHeatmapGeometry[i]?.series;
      if (pane === 'heatmap' && (!painted || painted.dashed)) return;
      const ordered =
        pane === 'stacked'
          ? [...stackOrder(pinned.filter((s) => s.values !== null)), ...refused]
          : pane === 'xy' && pair
            ? [...pair, ...refused]
            : pane === 'heatmap' && painted
              ? [painted, ...pinned.filter((s) => s !== painted)]
              : pinned;
      const lines = ordered.map((s, n) => ({
        name: s.name,
        facets: s.facets,
        color: s.color,
        unit: s.unit,
        ...(pane === 'heatmap' && n > 0 && s.values
          ? { values: null, refusal: 'A heatmap paints one series.' }
          : { values: s.values ? s.values.slice() : null, refusal: s.refusal }),
        warnings: [...s.warnings],
        weightColumn: s.weightColumn,
      }));
      // The limits the pane draws: none when its box is unticked, and never
      // the preview's, which leaves the figure with its line.
      const limits = limitsCheck.checked
        ? (lastInput.limits ?? [])
            .filter((limit) => !limit.preview)
            .map((limit) => ({
              color: limit.color,
              unit: limit.unit,
              values: limit.values.slice(),
              summed: limit.summed,
            }))
        : [];
      // Each box by the capture line it summarises, the preview's left out:
      // a box names its line only by name and colour, which the pane's
      // lines keep unique.
      const boxes =
        pane === 'box'
          ? {
              // A category per line (the `case` cut) is each line under its
              // own name: no dimension to title the axis or the caption with.
              dimension: lastInput.boxes.every(
                (group) => group.boxes.length === 1 && group.boxes[0].name === group.label,
              )
                ? ''
                : boxDimLabel(),
              values: boxValuesCheck.checked,
              groups: lastInput.boxes.map((group) => ({
                label: group.label,
                boxes: group.boxes.flatMap((box) => {
                  const line = ordered.findIndex(
                    (s) => s.name === box.name && s.color === box.color,
                  );
                  return line < 0 ? [] : [{ line, quantiles: { ...box.quantiles } }];
                }),
              })),
            }
          : undefined;
      const xy = pane === 'xy' ? { fit: xyFitChecks[i].checked } : undefined;
      options?.onFigure?.({ pane, lines, xWindow: [scale.min, scale.max], limits, boxes, xy });
    });

    // Redraw this pane only; the fit changes nothing else.
    xyFitChecks[i].addEventListener('change', () => {
      const pair = slotXyPair[i];
      if (currentLayout[i] === 'xy' && pair)
        xyPlot.draw(i, pair[0], pair[1], xyFitChecks[i].checked);
    });

    xySwapBtns[i].addEventListener('click', () => {
      if (!lastInput) return;
      const current = lastInput.refusal ? [] : lastInput.series.filter((s) => s.values !== null);
      if (current.length !== 2) return;
      const next = xyPair(i, current)[1];
      slotXyX[i] = next.detail ?? next.name;
      rebuild(lastInput);
    });

    canvas.addEventListener('mousemove', (event) => {
      if (slotXyGeometry[i]) {
        xyPlot.hover(i, event.offsetX, event.offsetY);
        return;
      }
      if (slotHeatmapGeometry[i]) {
        heatmapPlot.hover(i, event.offsetX, event.offsetY);
        return;
      }
      const geometry = slotBoxGeometry[i];
      if (!geometry) return;
      const y = event.offsetY;
      const inside =
        y >= geometry.marginTop &&
        y <= geometry.marginTop + geometry.plotHeight &&
        event.offsetX >= geometry.marginLeft &&
        event.offsetX <= geometry.marginLeft + geometry.plotWidth;
      const fraction = 1 - (y - geometry.marginTop) / geometry.plotHeight;

      slotBoxTags[i].forEach((tag, tagIndex) => {
        const unit = geometry.units[tagIndex];
        const scale = unit === undefined ? undefined : geometry.range.get(unit);
        placeAxisTag(
          tag,
          tagIndex,
          !inside || !scale ? null : scale.low + (scale.high - scale.low) * fraction,
          y,
          geometry.marginLeft,
          geometry.marginLeft + geometry.plotWidth,
        );
      });

      let nearest = -1;
      if (inside) {
        let best = Infinity;
        slotBoxHits[i].forEach((hit, hitIndex) => {
          const distance = Math.abs(event.offsetX - hit.centre);
          if (distance < best) {
            best = distance;
            nearest = hitIndex;
          }
        });
      }
      if (nearest !== slotHoveredBox[i]) {
        slotHoveredBox[i] = nearest;
        if (lastInput) boxPlot.draw(i, lastInput, true);
      }
      if (nearest < 0) slotTips[i].style.display = 'none';
      else boxPlot.showTip(i, slotBoxHits[i][nearest], event.offsetX);
    });

    canvas.addEventListener('mouseleave', () => {
      for (const tag of slotBoxTags[i]) tag.style.display = 'none';
      slotTips[i].style.display = 'none';
      if (slotHeatmapGeometry[i]) {
        heatmapPlot.clearHover(i);
      }
      if (slotHoveredBox[i] >= 0) {
        slotHoveredBox[i] = -1;
        if (lastInput) boxPlot.draw(i, lastInput, true);
      }
    });
  }

  boxDimSelect.addEventListener('change', () => onBoxDimChange(boxDimSelect.value));

  // A full re-render: limit lines are uPlot series, so hiding them rebuilds
  // the plot.
  limitsCheck.addEventListener('change', () => {
    if (lastInput) rebuild(lastInput);
  });

  boxValuesCheck.addEventListener('change', () => {
    if (lastInput) {
      for (let i = 0; i < 4; i++) {
        if (currentLayout[i] === 'box') boxPlot.draw(i, lastInput);
      }
    }
  });

  function resetZoom(plot: uPlot | null, extent: [number, number] | null): void {
    if (!plot) return;
    const x = plot.data[0];
    if (x.length === 0) return;
    const [min, max] = extent ?? [x[0], x[x.length - 1]];
    plot.setScale('x', { min, max });
  }

  download1Btn.addEventListener('click', () => {
    const plot = slotPlots[0];
    if (!plot || !lastInput) return;
    const drawn = lastInput.series.filter((s) => s.values !== null);
    const { min, max } = plot.scales.x;
    if (min == null || max == null || drawn.length === 0) return;

    const rows = [[...HOUR_COLUMNS, ...drawn.map((s) => csvField(s.name))].join(',')];
    for (
      let hour = Math.max(0, Math.ceil(min));
      hour <= Math.min(HOURS_PER_YEAR - 1, max);
      hour++
    ) {
      const values = drawn.map((s) => (s.values as Float32Array)[hour]);
      if (values.every((value) => Number.isNaN(value))) continue;
      rows.push(`${hourFields(hour)},${values.map(formatCell).join(',')}`);
    }

    saveBlob(new Blob([rows.join('\n') + '\n'], { type: 'text/csv' }), 'time-series.csv');
  });

  // Each pane's controls depend on the layout and the drawn count, so they
  // are recomputed on every rebuild.
  function updateSlotControls(input: ChartsInput, drawable: CaseSeries[]): void {
    for (let i = 0; i < 4; i++) {
      const slotType = currentLayout[i];
      // A scatter has no zoom and no hour axis; its swap needs exactly two
      // series.
      zoomResetBtns[i].style.display =
        slotType === 'box' || slotType === 'legend' || slotType === 'xy' || slotType === 'heatmap'
          ? 'none'
          : '';
      xySwapBtns[i].style.display = slotType === 'xy' && drawable.length === 2 ? '' : 'none';
      const fitLabel = xyFitChecks[i].parentElement;
      if (fitLabel) {
        fitLabel.style.display = slotType === 'xy' && drawable.length === 2 ? '' : 'none';
      }
      if (i === 0) {
        download1Btn.style.display = slotType === 'time' || slotType === 'stacked' ? '' : 'none';
      }
      if (i === 2) {
        if (boxDimSelect.parentElement) {
          boxDimSelect.parentElement.style.display = slotType === 'box' ? '' : 'none';
        }
        if (boxValuesCheck.parentElement) {
          boxValuesCheck.parentElement.style.display = slotType === 'box' ? '' : 'none';
        }
      }
    }

    // Decided over the whole layout (one session-wide switch), and hidden
    // until a limits file is loaded.
    if (limitsCheck.parentElement) {
      const anyTime = currentLayout.some((slot) => slot === 'time');
      limitsCheck.parentElement.style.display =
        anyTime && (input.limits?.length ?? 0) > 0 ? '' : 'none';
    }
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
        !!FIGURE_PANES[currentLayout[i]] &&
        figureLines(drawable).length > 0 &&
        // An X-Y pair with the preview in it would lose an axis.
        !(currentLayout[i] === 'xy' && slotXyPair[i]?.some((s) => s.dashed)) &&
        !paneBodies[i].querySelector('.pane-banner-refusal');
      figureBtns[i].style.display = offered ? '' : 'none';
    }
  }

  /** The box dimension's label, from the select's own option text (one
   * option is the mounting kind's axis word). */
  function boxDimLabel(): string {
    return boxDimSelect.selectedOptions[0]?.textContent?.trim() || boxDimSelect.value;
  }

  function rebuild(input: ChartsInput): void {
    const drawable = input.refusal ? [] : input.series.filter((s) => s.values !== null);

    updateSlotControls(input, drawable);

    const zeroCases = drawable.filter((s) => s.allZero).map((s) => s.name);
    const zeroText =
      zeroCases.length > 0
        ? `Zero in every selected hour: ${zeroCases.join(', ')}. That is the data, not a load error.`
        : null;

    const paneContext = { input, drawable, zeroText };

    renderSlots(paneContext);
    updateFigureButtons(drawable);
  }

  // What each of the four slots paints.
  function renderSlots(paneContext: {
    input: ChartsInput;
    drawable: CaseSeries[];
    zeroText: string | null;
  }): void {
    const { input, drawable, zeroText } = paneContext;
    for (let i = 0; i < 4; i++) {
      const slotType = currentLayout[i];
      const body = paneBodies[i];
      const uplotHost = slotUplotHosts[i];
      const canvasHost = slotCanvasHosts[i];
      const legendHost = slotLegendHosts[i];

      body.querySelectorAll('.pane-banner').forEach((node) => node.remove());
      // Cleared, then written only by a slot with something to say.
      headerNote(root, i + 1, '');

      if (drawable.length === 0) {
        uplotHost.style.display = 'none';
        canvasHost.style.display = 'none';
        legendHost.style.display = 'none';
        slotPlots[i]?.destroy();
        slotPlots[i] = null;
        slotSignatures[i] = '';
        banner(body, 'refusal', emptyPaneText(input));
        continue;
      }

      if (slotType === 'time') {
        linePanes.time(i, paneContext);
      } else if (slotType === 'duration') {
        linePanes.duration(i, paneContext);
      } else if (slotType === 'stacked') {
        linePanes.stacked(i, paneContext);
      } else if (slotType === 'box') {
        uplotHost.style.display = 'none';
        legendHost.style.display = 'none';
        slotPlots[i]?.destroy();
        slotPlots[i] = null;
        slotSignatures[i] = '';
        canvasHost.style.display = '';
        // Release the X-Y pane's hover state on the shared canvas.
        slotXyGeometry[i] = null;
        slotXyPair[i] = null;
        slotXyHits[i] = [];
        slotHeatmapGeometry[i] = null;
        // Which axis the boxes are cut on. Pane 3 is skipped because its
        // header already holds the dimension select.
        if (i !== 2) headerNote(root, i + 1, `by ${boxDimLabel()}`);
        boxPlot.draw(i, input);
      } else if (slotType === 'xy') {
        // Exactly two drawables or a refusal by name: plotting the first two
        // of five would misstate what was compared.
        uplotHost.style.display = 'none';
        legendHost.style.display = 'none';
        slotPlots[i]?.destroy();
        slotPlots[i] = null;
        slotSignatures[i] = '';
        canvasHost.style.display = '';
        // Release the box pane's hover state on the shared canvas.
        slotBoxGeometry[i] = null;
        slotHoveredBox[i] = -1;
        slotHeatmapGeometry[i] = null;
        if (drawable.length !== 2) {
          slotXyPair[i] = null;
          xyPlot.clear(i);
          banner(
            body,
            'refusal',
            `Select exactly two series to plot one against the other — ${
              drawable.length === 1 ? '1 is' : `${drawable.length} are`
            } drawn.`,
          );
          continue;
        }
        const [xs, ys] = xyPair(i, drawable);
        slotXyPair[i] = [xs, ys];
        xySwapBtns[i].title = `Put ${ys.name} on X and ${xs.name} on Y`;
        headerNote(root, i + 1, `X ${xs.name} / Y ${ys.name}`);
        xyPlot.draw(i, xs, ys, xyFitChecks[i].checked);
        if (zeroText) banner(body, 'note', zeroText);
      } else if (slotType === 'legend') {
        // The legend: for each line, the subject and beneath it the full
        // path (Case, kind, quantity, qualifiers), for a reader who cannot
        // tell lines apart by colour.
        uplotHost.style.display = 'none';
        canvasHost.style.display = 'none';
        slotPlots[i]?.destroy();
        slotPlots[i] = null;
        slotSignatures[i] = '';
        slotHeatmapGeometry[i] = null;

        const signature = drawable
          .map(
            (s) =>
              `${s.detail ?? s.name}|${s.color}|${s.stats.mean}|${s.stats.sd}|${s.weightColumn ?? ''}`,
          )
          .join(',');
        if (legendHost.dataset.signature !== signature) {
          legendHost.dataset.signature = signature;
          legendHost.replaceChildren();

          const table = document.createElement('table');
          table.className = 'pane-legend-table';

          const thead = document.createElement('thead');
          const headerRow = document.createElement('tr');
          for (const col of ['Series', 'Mean', '± SD', 'Min', 'Max', 'Unit']) {
            const th = document.createElement('th');
            th.textContent = col;
            headerRow.appendChild(th);
          }
          thead.appendChild(headerRow);
          table.appendChild(thead);

          const tbody = document.createElement('tbody');
          for (const s of drawable) {
            const tr = document.createElement('tr');
            tr.title = s.detail ?? s.name;

            const nameTd = document.createElement('td');
            nameTd.className = 'pane-legend-name';
            const swatch = document.createElement('span');
            swatch.className = 'pane-legend-swatch';
            swatch.style.background = s.color;

            // Without facets, fall back to the two strings the series has.
            const ident = document.createElement('span');
            ident.className = 'pane-legend-ident';
            const nameSpan = document.createElement('span');
            nameSpan.className = 'pane-legend-label';
            nameSpan.textContent = s.facets ? subjectLabel(s.facets) : s.name;
            ident.appendChild(nameSpan);

            const context = s.facets
              ? contextLabel(s.facets)
              : s.detail && s.detail !== s.name
                ? s.detail
                : '';
            // A weighted series' Mean is a mean of means, which the figure
            // alone cannot show, so name the weight.
            const line = s.weightColumn
              ? [context, `weighted mean by ${s.weightColumn}`].filter(Boolean).join(' · ')
              : context;
            if (line) {
              const contextSpan = document.createElement('span');
              contextSpan.className = 'pane-legend-context';
              contextSpan.textContent = line;
              contextSpan.title = line;
              ident.appendChild(contextSpan);
            }
            nameTd.append(swatch, ident);
            tr.appendChild(nameTd);

            const meanTd = document.createElement('td');
            meanTd.className = 'pane-legend-num';
            meanTd.textContent = s.n > 0 ? formatNumber(s.stats.mean) : '—';
            tr.appendChild(meanTd);

            const sdTd = document.createElement('td');
            sdTd.className = 'pane-legend-num';
            sdTd.textContent = s.n > 0 ? formatNumber(s.stats.sd) : '—';
            tr.appendChild(sdTd);

            const minTd = document.createElement('td');
            minTd.className = 'pane-legend-num';
            minTd.textContent = s.n > 0 ? formatNumber(s.stats.min) : '—';
            tr.appendChild(minTd);

            const maxTd = document.createElement('td');
            maxTd.className = 'pane-legend-num';
            maxTd.textContent = s.n > 0 ? formatNumber(s.stats.max) : '—';
            tr.appendChild(maxTd);

            const unitTd = document.createElement('td');
            unitTd.className = 'pane-legend-unit';
            unitTd.textContent = s.unit;
            tr.appendChild(unitTd);

            tbody.appendChild(tr);
          }
          table.appendChild(tbody);
          legendHost.appendChild(table);
        }

        legendHost.style.display = '';
      } else if (slotType === 'heatmap') {
        uplotHost.style.display = 'none';
        legendHost.style.display = 'none';
        slotPlots[i]?.destroy();
        slotPlots[i] = null;
        slotSignatures[i] = '';
        canvasHost.style.display = '';
        slotXyGeometry[i] = null;
        slotXyPair[i] = null;
        slotXyHits[i] = [];
        slotBoxGeometry[i] = null;
        slotHoveredBox[i] = -1;
        if (drawable.length === 0) {
          slotHeatmapGeometry[i] = null;
          heatmapPlot.clear(i);
          banner(
            body,
            'refusal',
            'Select a series in the Browse drawer to display its diurnal heatmap.',
          );
          continue;
        }
        const s = drawable[0];
        headerNote(
          root,
          i + 1,
          `${s.name}${drawable.length > 1 ? ` (1 of ${drawable.length})` : ''}`,
        );
        heatmapPlot.draw(i, s);
        if (zeroText) banner(body, 'note', zeroText);
      }
    }
  }

  let frame = 0;
  const observer = new ResizeObserver(() => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      for (let i = 0; i < 4; i++) {
        const body = paneBodies[i];
        const size = paneSize(body);
        if (slotPlots[i]) {
          slotPlots[i]!.setSize(size);
        } else if (currentLayout[i] === 'box' && lastInput) {
          boxPlot.draw(i, lastInput);
        } else if (currentLayout[i] === 'xy' && lastInput) {
          const pair = slotXyPair[i];
          if (pair) xyPlot.draw(i, pair[0], pair[1], xyFitChecks[i].checked);
        } else if (currentLayout[i] === 'heatmap' && slotHeatmapGeometry[i]) {
          heatmapPlot.draw(i, slotHeatmapGeometry[i]!.series);
        }
      }
    });
  });
  observer.observe(within(root, CHART_AREA_HOOK));
  for (const body of paneBodies) {
    observer.observe(body);
  }

  return {
    render(input) {
      lastInput = input;
      boxDimSelect.value = input.boxDim;
      rebuild(input);
    },
    timeWindow() {
      for (let i = 0; i < 4; i++) {
        if (currentLayout[i] === 'time' || currentLayout[i] === 'stacked') {
          const scale = slotPlots[i]?.scales.x;
          if (scale?.min != null && scale?.max != null) {
            return [scale.min, scale.max];
          }
        }
      }
      return null;
    },
    layout() {
      return [...currentLayout];
    },
    setLayout(newLayout: readonly SlotType[]) {
      if (newLayout.length === 4) {
        for (let i = 0; i < 4; i++) {
          currentLayout[i] = newLayout[i];
          slotSelects[i].value = newLayout[i];
        }
        if (lastInput) rebuild(lastInput);
      }
    },
  };
}
