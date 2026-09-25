// src/figure/xy.ts
//
// The X-Y pane as a figure: one point per hour both series hold, the first
// capture line on x and the second on y, in the pane's order after any swap.
// Each axis title is its series' full label, so the pair needs no legend and
// no context line; with the pane's fit on, the context line's place holds the
// fit's equation and R², as the pane writes it above its plot, and the fit
// line is drawn in the Y series' colour.
//
// The fit is the pane's own `fitLine` over the same pairs, so the figure
// cannot state a different equation from the app. Points on one 300 dpi
// output pixel are one mark: more would only lengthen the file.

import { fitCaption, fitLine } from '../ui/xy-plot';
import { fullLabel, type SeriesFacets } from '../series/label';
import { niceScale, type FigureCapture, type FigureLine, type PaneRenderer } from './build';
import { line as svgLine, rect } from './svg';
import { COLUMNS_PER_PT } from './time';

/** The pane's dark grey point at 40 % opacity, made opaque over white. */
const POINT_FILL = '#adadad';
const POINT_PT = 1.4;
/** Room one x tick label takes, in points. */
const X_TICK_ROOM_PT = 56;

/** A series' full label as a figure names it: its figure key in place of
 * its subject, so a group states its member count, as its legend key would. */
export function xyAxisTitle(entry: FigureLine): string {
  const facets: SeriesFacets | undefined = entry.facets;
  if (!facets) return entry.name;
  const figured = facets.figureSubject
    ? { ...facets, subject: facets.figureSubject, groupBy: undefined }
    : facets;
  // `fullLabel` names the unit only when the quantity does not; an axis
  // must always carry one.
  const label = fullLabel(figured);
  return facets.range || !facets.unit || label.includes(facets.unit)
    ? label
    : `${label} (${facets.unit})`;
}

/** The hours both series hold, as pairs. */
function pairsOf(xs: ArrayLike<number>, ys: ArrayLike<number>): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const hours = Math.min(xs.length, ys.length);
  for (let hour = 0; hour < hours; hour++) {
    const x = xs[hour];
    const y = ys[hour];
    if (Number.isFinite(x) && Number.isFinite(y)) out.push({ x, y });
  }
  return out;
}

function finiteExtent(values: ArrayLike<number>): [number, number] {
  let low = Infinity;
  let high = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (!Number.isFinite(value)) continue;
    if (value < low) low = value;
    if (value > high) high = value;
  }
  return [low, high];
}

export function xyPane(
  capture: FigureCapture,
  drawnIndex: (captured: number) => number,
): PaneRenderer {
  if (!capture.xy) throw new Error('an X-Y figure needs the pane’s X-Y state');
  const xAt = drawnIndex(0);
  const yAt = drawnIndex(1);
  if (xAt < 0 || yAt < 0) throw new Error('an X-Y figure needs both series drawn');
  const [xLine, yLine] = capture.lines;
  const pairs = pairsOf(xLine.values ?? [], yLine.values ?? []);
  const xs = pairs.map((p) => p.x);
  const ys = pairs.map((p) => p.y);
  const fit = capture.xy.fit ? fitLine(pairs) : null;
  const xScale = (plotWidth: number) => {
    const [low, high] = finiteExtent(xs);
    return niceScale(low, high, Math.max(3, Math.min(8, Math.round(plotWidth / X_TICK_ROOM_PT))));
  };

  return {
    lead: (what) => `X-Y scatter of ${what}`,
    xTitle: xyAxisTitle(xLine),
    yAxis: {
      title: xyAxisTitle(yLine),
      scale: (tickCount) => {
        const [low, high] = finiteExtent(ys);
        return niceScale(low, high, tickCount);
      },
    },
    context: () => (fit ? fitCaption(fit).replace(/ {2,}/g, ', ') : ''),
    legendBlock: () => ({ height: 0, draw: () => [] }),

    extent: (values) => finiteExtent(values),

    hoursShown: () => pairs.length,

    xTicks(_window, plotWidth) {
      const scale = xScale(plotWidth);
      return scale.ticks.map((tick, i) => ({
        at: (tick - scale.min) / (scale.max - scale.min),
        label: scale.labels[i],
      }));
    },

    marks(lines, _window, frame) {
      const scale = xScale(frame.width);
      const xOf = (x: number) =>
        frame.left + ((x - scale.min) / (scale.max - scale.min)) * frame.width;
      const yOf = lines[yAt].y;
      const out: string[] = [];
      const seen = new Set<string>();
      for (const { x, y } of pairs) {
        const px = xOf(x);
        const py = yOf(y);
        const key = `${Math.round(px * COLUMNS_PER_PT)},${Math.round(py * COLUMNS_PER_PT)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(rect(px - POINT_PT / 2, py - POINT_PT / 2, POINT_PT, POINT_PT, POINT_FILL));
      }
      if (fit?.ok) {
        // Across the data's x range, cropped to the plot: y can run far out.
        const top = frame.top;
        const bottom = frame.top + frame.height;
        const [x0, x1] = finiteExtent(xs);
        const at = (x: number) => [xOf(x), yOf(fit.slope * x + fit.intercept)] as const;
        const segment = cropY(at(x0), at(x1), top, bottom);
        if (segment) {
          out.push(
            svgLine(segment[0][0], segment[0][1], segment[1][0], segment[1][1], {
              ...lines[yAt].stroke,
              dash: undefined,
            }),
          );
        }
      }
      return out;
    },
  };
}

type Point = readonly [number, number];

/** The part of a segment between two heights, or null when none is. */
function cropY(a: Point, b: Point, top: number, bottom: number): [Point, Point] | null {
  const dy = b[1] - a[1];
  if (dy === 0) return a[1] >= top && a[1] <= bottom ? [a, b] : null;
  const tAt = (y: number) => (y - a[1]) / dy;
  const [t0, t1] = [tAt(top), tAt(bottom)].sort((p, q) => p - q);
  const from = Math.max(0, t0);
  const to = Math.min(1, t1);
  if (from > to) return null;
  const point = (t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + dy * t];
  return [point(from), point(to)];
}
