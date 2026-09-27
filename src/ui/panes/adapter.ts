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

import type { DateSet } from '../../model/date-range';
import type { FigureCapture, FigurePane } from '../../figure/build';
import type { CaseSeries, ChartsInput, DrawnLimit } from '../charts';

/** A group of header controls a type shows. The pane owns the elements. */
export type PaneControl = 'zoom' | 'download' | 'limits' | 'dates' | 'box' | 'xy' | 'interval';

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
  /** A drag on this pane chose new dates. */
  datesChange(dates: DateSet): void;
}

/** What a Figure click hands the section. */
export interface FigureShot {
  readonly capture: FigureCapture;
  /** `wholeYear`: a time pane not following the dates. */
  readonly shown: { wholeYear: boolean };
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
  },
): FigureShot {
  const { onlyOne } = spec;
  const lines = spec.ordered.map((s, n) => ({
    name: s.name,
    facets: s.facets,
    color: s.color,
    unit: s.unit,
    ...(onlyOne && n > 0 && s.values
      ? { values: null, refusal: onlyOne }
      : { values: s.values ? s.values.slice() : null, refusal: s.refusal }),
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
          values: limit.values.slice(),
          summed: limit.summed,
        }))
    : [];
  return {
    capture: {
      pane: spec.pane,
      lines,
      xWindow: spec.xWindow,
      limits,
      boxes: spec.boxes,
      xy: spec.xy,
      interval: spec.interval,
    },
    shown: { wholeYear: spec.wholeYear ?? false },
  };
}
