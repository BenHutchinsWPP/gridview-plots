// src/ui/panes/pane.ts
//
// One of the four chart panes: its surfaces, its banners and header note,
// and which chart type it shows. Every type is a `PaneAdapter`; the pane
// draws through the one its layout names, tears the old one down before the
// new one draws, and routes hover, click and resize to the drawn one only.
// Surfaces a pane shares between types (the canvas, its tip and tags) are
// released by the type leaving, so no hover can reach a type not on screen.
//
// Adapters arrive as factories, so this module loads without uPlot and
// `tests/test_panes.mjs` runs it in Node.

import type { SlotType } from '../charts';
import { emptyPaneText } from '../chart-format';
import { makeAxisTags } from '../chart-axis';
import type {
  FigureShot,
  PaneAdapter,
  PaneControl,
  PaneElements,
  PaneFrame,
  PaneHost,
} from './adapter';

/** What the host lends every pane. */
export interface PaneEnv {
  rerender(): void;
  datesChange: PaneHost['datesChange'];
}

export type AdapterFactories = Readonly<Record<SlotType, (host: PaneHost) => PaneAdapter>>;

export interface ChartPane {
  /** The type the next render draws. */
  setType(type: SlotType): void;
  /** Show the header controls the type uses, hide the rest. */
  showControls(frame: PaneFrame): void;
  render(frame: PaneFrame): void;
  resize(): void;
  /** The type has a figure and the pane as drawn allows one. */
  figureOffered(): boolean;
  figure(): FigureShot | null;
  timeWindow(): [number, number] | null;
}

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

/** Each control group's elements; a label wraps a checkbox or select. */
function controlElements(el: PaneElements): Record<PaneControl, (HTMLElement | null)[]> {
  return {
    zoom: [el.zoomReset],
    download: [el.download],
    limits: [el.limits.parentElement],
    dates: [el.follow.parentElement, el.overview.parentElement],
    box: [el.boxDim.parentElement, el.boxValues.parentElement],
    xy: [el.xySwap, el.xyFit.parentElement],
    interval: [
      el.intervalBy.parentElement,
      el.intervalColour.parentElement,
      el.intervalMean.parentElement,
      el.intervalBand.parentElement,
    ],
  };
}

export function createPane(
  index: number,
  elements: PaneElements,
  env: PaneEnv,
  factories: AdapterFactories,
  initial: SlotType,
): ChartPane {
  const { body } = elements;

  const uplotHost = document.createElement('div');
  uplotHost.className = 'pane-uplot-host';
  body.appendChild(uplotHost);

  const canvasHost = document.createElement('div');
  canvasHost.className = 'pane-canvas-host';
  canvasHost.style.position = 'relative';
  canvasHost.style.width = '100%';
  canvasHost.style.height = '100%';
  canvasHost.style.display = 'none';
  body.appendChild(canvasHost);

  const canvas = document.createElement('canvas');
  canvas.className = 'pane-canvas';
  canvasHost.appendChild(canvas);

  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.style.display = 'none';
  canvasHost.appendChild(tip);

  const tags = makeAxisTags(2);
  for (const tag of tags) canvasHost.appendChild(tag);

  const legendHost = document.createElement('div');
  legendHost.className = 'pane-legend-host';
  legendHost.style.display = 'none';
  body.appendChild(legendHost);

  const surfaces = { uplot: uplotHost, canvas: canvasHost, legend: legendHost };

  /**
   * The pane header's one line. **It names only what the SLOT knows**: which
   * series is on X, which the heatmap painted, that a time pane shows the
   * whole year. Case, entity, group and unit are the legend's, and restating
   * them here would drift. A per-kind header would be right for one kind and
   * silently wrong for mixed selections.
   */
  function note(text: string): void {
    if (!elements.note) return;
    elements.note.textContent = text;
    // A crowded header cuts the note short; hovering it reads the rest.
    elements.note.title = text;
  }

  const host: PaneHost = {
    index,
    body,
    uplotHost,
    canvas,
    tip,
    tags,
    legendHost,
    controls: elements,
    size: () => paneSize(body),
    banner: (kind, text) => banner(body, kind, text),
    note,
    rerender: () => env.rerender(),
    datesChange: (dates) => env.datesChange(dates),
  };

  const adapters = Object.fromEntries(
    Object.entries(factories).map(([type, make]) => [type, make(host)]),
  ) as Record<SlotType, PaneAdapter>;
  const groups = controlElements(elements);

  let type = initial;
  /** The adapter on screen, or null while the pane shows nothing. */
  let drawn: PaneAdapter | null = null;

  canvas.addEventListener('mousemove', (event) => drawn?.hover?.(event.offsetX, event.offsetY));
  canvas.addEventListener('mouseleave', () => drawn?.unhover?.());
  canvas.addEventListener('click', (event) => drawn?.click?.(event.offsetX, event.offsetY));
  elements.zoomReset.addEventListener('click', () => drawn?.resetZoom?.());
  elements.download.addEventListener('click', () => drawn?.download?.());

  function leave(): void {
    drawn?.leave();
    drawn = null;
  }

  return {
    setType(next) {
      type = next;
    },
    showControls(frame) {
      const shown = new Set(adapters[type].controls(frame));
      for (const [group, members] of Object.entries(groups)) {
        for (const member of members) {
          if (member) member.style.display = shown.has(group as PaneControl) ? '' : 'none';
        }
      }
    },
    render(frame) {
      body.querySelectorAll('.pane-banner').forEach((node) => node.remove());
      // Cleared, then written only by a type with something to say.
      note('');
      if (frame.drawable.length === 0) {
        leave();
        for (const surface of Object.values(surfaces)) surface.style.display = 'none';
        banner(body, 'refusal', emptyPaneText(frame.input));
        return;
      }
      const next = adapters[type];
      if (drawn !== next) leave();
      drawn = next;
      for (const [name, surface] of Object.entries(surfaces)) {
        surface.style.display = name === next.surface ? '' : 'none';
      }
      next.draw(frame);
    },
    resize() {
      drawn?.resize();
    },
    figureOffered() {
      return adapters[type].figure?.offered() ?? false;
    },
    figure() {
      return drawn?.figure?.capture() ?? null;
    },
    timeWindow() {
      return drawn?.timeWindow?.() ?? null;
    },
  };
}
