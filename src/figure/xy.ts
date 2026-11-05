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
// output pixel are one mark: more would only lengthen the file. The caption
// says which years were paired, since two Cases of different years pair by
// position and their spans alone would not say so.
//
// Under the pane's "colour on", each point takes the colour the pane gave
// it, tinted as the pane's alpha draws it over white, and a key of swatches
// or a ramp takes the legend's place, as the interval figure's does.

import { fitCaption, fitLine, rampEnds, yearsText, type XyKey } from '../ui/panes/xy';
import { NO_COLOUR, signedColor } from '../ui/panes/xy-colour';
import { formatNumber } from '../ui/chart-format';
import { hex } from './heatmap';
import { MEASURE_SLACK } from './legend';
import { fullLabel, type SeriesFacets } from '../series/label';
import { niceScale, type FigureCapture, type FigureLine, type PaneRenderer } from './build';
import { line as svgLine, rect, text, tint } from './svg';
import { COLUMNS_PER_PT } from './time';

/** The pane's dark grey point at 40 % opacity, made opaque over white. */
const POINT_FILL = '#adadad';
const POINT_PT = 1.4;
/** Room one x tick label takes, in points. */
const X_TICK_ROOM_PT = 56;
/** The pane's point alpha, as a tint over the white page. */
const POINT_ALPHA = 0.4;
const KEY_PT = 8;
const KEY_ROW_PT = KEY_PT * 1.6;
const SWATCH_PT = 6;
const RAMP_PT = 90;
const RAMP_STEPS = 32;

/** A series' full label as a figure names it: its figure key in place of
 * its subject, so a group states its member count, as its legend key would. */
function xyAxisTitle(entry: Pick<FigureLine, 'name' | 'facets'>): string {
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

/** The hours both series hold, as pairs, with each one's place. */
function pairsOf(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
): { x: number; y: number; at: number }[] {
  const out: { x: number; y: number; at: number }[] = [];
  const hours = Math.min(xs.length, ys.length);
  for (let hour = 0; hour < hours; hour++) {
    const x = xs[hour];
    const y = ys[hour];
    if (Number.isFinite(x) && Number.isFinite(y)) out.push({ x, y, at: hour });
  }
  return out;
}

type KeyEntry =
  | { kind: 'swatch'; id: string; color: string; label: string }
  | { kind: 'ramp'; from: number; to: number; low: number; high: number };

/** The key's title, then its entries: every category, or the ramp, and the
 * points with no colour when there are any. */
function keyEntries(key: XyKey, missing: number): KeyEntry[] {
  const entries: KeyEntry[] =
    key.kind === 'signed'
      ? [
          {
            kind: 'ramp',
            from: rampEnds(key)[0],
            to: rampEnds(key)[1],
            low: key.low,
            high: key.high,
          },
        ]
      : key.items.map((item, i) => ({
          kind: 'swatch',
          id: `legend.key[${i}]`,
          color: tint(hex(item.color), POINT_ALPHA),
          label: item.label,
        }));
  if (missing > 0) {
    entries.push({
      kind: 'swatch',
      id: 'legend.missing',
      color: tint(NO_COLOUR, POINT_ALPHA),
      label: `no colour value (${missing.toLocaleString('en-US')} h)`,
    });
  }
  return entries;
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
  const colour = capture.xy.colour;
  const fillOf = (at: number): string => {
    const drawn = colour?.colours[at];
    return drawn ? tint(hex(drawn), POINT_ALPHA) : POINT_FILL;
  };
  const missing = colour ? pairs.filter((p) => colour.colours[p.at] === NO_COLOUR).length : 0;
  const xScale = (plotWidth: number) => {
    const [low, high] = finiteExtent(xs);
    return niceScale(low, high, Math.max(3, Math.min(8, Math.round(plotWidth / X_TICK_ROOM_PT))));
  };

  const paired = capture.xy.years;
  const years = !paired
    ? null
    : paired.x.every((year, k) => year === paired.y[k])
      ? `paired by hour, ${yearsText(paired.x)}`
      : `paired by hour, ${yearsText(paired.x)} against ${yearsText(paired.y)}`;

  return {
    lead: (what) => `X-Y scatter of ${what}`,
    years,
    xTitle: xyAxisTitle(xLine),
    yAxis: {
      title: xyAxisTitle(yLine),
      scale: (tickCount) => {
        const [low, high] = finiteExtent(ys);
        return niceScale(low, high, tickCount);
      },
    },
    context: () => (fit ? fitCaption(fit).replace(/ {2,}/g, ', ') : ''),
    legendBlock({ left, width, measure, say }) {
      if (!colour) return { height: 0, draw: () => [] };
      // Each text through `say` now, so an edit resizes its entry.
      // A colour series is titled as an axis is: its unit and a group's
      // member count.
      const named = colour.line ? xyAxisTitle(colour.line) : colour.key.title;
      const title = `${say('legend.title', named)}:`;
      type Placed = { entry: KeyEntry; texts: string[]; width: number };
      const placed: Placed[] = keyEntries(colour.key, missing).map((entry) => {
        if (entry.kind === 'ramp') {
          const texts = [
            say('legend.from', formatNumber(entry.from)),
            say('legend.to', formatNumber(entry.to)),
          ];
          const w = measure(texts[0], KEY_PT) * MEASURE_SLACK + 8 + RAMP_PT;
          return { entry, texts, width: w + measure(texts[1], KEY_PT) * MEASURE_SLACK };
        }
        const texts = [say(entry.id, entry.label)];
        return { entry, texts, width: SWATCH_PT + 3 + measure(texts[0], KEY_PT) * MEASURE_SLACK };
      });
      // The title first on the first row, then entries flowed to the width.
      const titleWidth = measure(title, KEY_PT) * MEASURE_SLACK + 6;
      const rows: Placed[][] = [[]];
      let used = titleWidth;
      for (const item of placed) {
        if (rows[rows.length - 1].length > 0 && used + item.width > width) {
          rows.push([]);
          used = titleWidth;
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
            const baseline = middle + KEY_PT * 0.35;
            if (r === 0) out.push(text(title, left, baseline, { size: KEY_PT }));
            let x = left + titleWidth;
            for (const { entry, texts, width: w } of row) {
              if (entry.kind === 'ramp') {
                out.push(text(texts[0], x, baseline, { size: KEY_PT }));
                const rampLeft = x + measure(texts[0], KEY_PT) * MEASURE_SLACK + 4;
                for (let k = 0; k < RAMP_STEPS; k++) {
                  const value = entry.from + ((entry.to - entry.from) * (k + 0.5)) / RAMP_STEPS;
                  out.push(
                    rect(
                      rampLeft + (k * RAMP_PT) / RAMP_STEPS,
                      middle - 3,
                      RAMP_PT / RAMP_STEPS + (k < RAMP_STEPS - 1 ? 0.25 : 0),
                      6,
                      tint(signedColor(value, entry.low, entry.high), POINT_ALPHA),
                    ),
                  );
                }
                out.push(text(texts[1], rampLeft + RAMP_PT + 4, baseline, { size: KEY_PT }));
              } else {
                out.push(
                  rect(x, middle - SWATCH_PT / 2, SWATCH_PT, SWATCH_PT, entry.color),
                  text(texts[0], x + SWATCH_PT + 3, baseline, { size: KEY_PT }),
                );
              }
              x += w + 10;
            }
          });
          return out;
        },
      };
    },

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
      for (const { x, y, at } of pairs) {
        const px = xOf(x);
        const py = yOf(y);
        const fill = fillOf(at);
        // One mark per output pixel and colour: two colours on one pixel
        // both show, the later on top, as the pane draws them.
        const key = `${Math.round(px * COLUMNS_PER_PT)},${Math.round(py * COLUMNS_PER_PT)},${fill}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(rect(px - POINT_PT / 2, py - POINT_PT / 2, POINT_PT, POINT_PT, fill));
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
