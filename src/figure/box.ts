// src/figure/box.ts
//
// The box pane as a figure: one category per box-dimension value along x
// (month, hour of day, or one per series), each holding a box per line in
// the line's colour, as the pane draws them. Boxes span p25-p75 with the
// median across; whiskers reach the Tukey fences' furthest values. Where
// values lie beyond a whisker, a dot marks that extreme and the count of
// such values sits above the box, since a printed figure has no hover to
// ask. Value labels are written only when the pane's values box is ticked.
//
// A box's line is a capture index, so a figure never has to match boxes to
// lines by name or colour: two lines may share either.

import { formatNumber } from '../ui/chart-format';
import { BOX_FILL_ALPHA, BOX_STROKE_PT } from './legend';
import { circle, line, outlinedRect, text, tint } from './svg';
import type { FigureBoxes, MarkLine, PaneRenderer } from './build';

/** Values written beside a box, and outlier counts above it. */
const LABEL_PT = 6.5;
const LABEL_INK = '#333333';
/** A box is at most this wide, however few there are. */
const MAX_BOX_PT = 18;
const OUTLIER_R = 1.5;

/** Box widths and centres in a category `slot` points wide. */
function placeBoxes(count: number, slot: number): { width: number; offset: (i: number) => number } {
  const width = Math.max(2, Math.min(MAX_BOX_PT, (slot * 0.7) / Math.max(1, count)));
  return { width, offset: (i) => (i - (count - 1) / 2) * (width + 1) };
}

/** The lowest and highest kept value: the boxes partition a line's kept
 * hours, so these are its lowest box minimum and highest box maximum. */
function keptExtent(values: ArrayLike<number>): [number, number] {
  let low = Infinity;
  let high = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (Number.isNaN(value)) continue;
    if (value < low) low = value;
    if (value > high) high = value;
  }
  return [low, high];
}

export function boxPane(
  boxes: FigureBoxes | undefined,
  drawnIndex: (captured: number) => number,
): PaneRenderer {
  if (!boxes) throw new Error('a box figure needs the pane’s boxes');
  // Only boxes of drawn lines with values: the preview's box leaves with it,
  // and a category left empty is not a category.
  const groups = boxes.groups
    .map((group) => ({
      label: group.label,
      boxes: group.boxes
        .map((box) => ({ drawn: drawnIndex(box.line), quantiles: box.quantiles }))
        .filter((box) => box.drawn >= 0 && box.quantiles.n > 0),
    }))
    .filter((group) => group.boxes.length > 0);
  const dimension = boxes.dimension.trim();
  const anyOutliers = groups.some((group) => group.boxes.some((box) => box.quantiles.outliers > 0));

  return {
    lead: (what) => `Box plot of ${what}${dimension ? ` by ${dimension}` : ''}`,
    xTitle: dimension ? dimension[0].toUpperCase() + dimension.slice(1) : undefined,
    boxSwatch: true,
    categorical: true,

    extent: (values) => keptExtent(values),

    hoursShown(lines) {
      const length = lines[0]?.length ?? 0;
      let count = 0;
      for (let hour = 0; hour < length; hour++) {
        if (lines.some((values) => !Number.isNaN(values[hour]))) count++;
      }
      return count;
    },

    xTicks: () =>
      groups.map((group, i) => ({
        at: (i + 0.5) / groups.length,
        label: group.label,
        room: 0.95 / groups.length,
      })),

    notes: () =>
      anyOutliers
        ? [
            'Whiskers reach the furthest value within 1.5 × IQR of the box; a dot marks a ' +
              'minimum or maximum beyond them, and the number above a box counts the values ' +
              'beyond its whiskers.',
          ]
        : [],

    marks(lines: readonly MarkLine[], _window, frame) {
      const out: string[] = [];
      const labels: string[] = [];
      const slot = frame.width / Math.max(1, groups.length);
      groups.forEach((group, g) => {
        const { width, offset } = placeBoxes(group.boxes.length, slot);
        group.boxes.forEach((box, b) => {
          const mark = lines[box.drawn];
          const q = box.quantiles;
          const y = mark.y;
          const centre = frame.left + slot * (g + 0.5) + offset(b);
          const stroke = { ...mark.stroke, width: BOX_STROKE_PT };
          const solid = { color: mark.stroke.color, width: BOX_STROKE_PT };
          const half = width / 2;
          out.push(
            outlinedRect(
              centre - half,
              y(q.p75),
              width,
              Math.max(0, y(q.p25) - y(q.p75)),
              tint(mark.stroke.color, BOX_FILL_ALPHA),
              stroke,
            ),
            line(centre - half, y(q.median), centre + half, y(q.median), {
              ...solid,
              width: BOX_STROKE_PT * 2,
            }),
            line(centre, y(q.p75), centre, y(q.upperWhisker), solid),
            line(centre, y(q.p25), centre, y(q.lowerWhisker), solid),
            line(centre - half / 2, y(q.upperWhisker), centre + half / 2, y(q.upperWhisker), solid),
            line(centre - half / 2, y(q.lowerWhisker), centre + half / 2, y(q.lowerWhisker), solid),
          );
          let top = y(q.upperWhisker);
          if (q.outliers > 0) {
            if (q.max > q.upperWhisker) {
              out.push(circle(centre, y(q.max), OUTLIER_R, mark.stroke.color));
              top = y(q.max) - OUTLIER_R;
            }
            if (q.min < q.lowerWhisker) {
              out.push(circle(centre, y(q.min), OUTLIER_R, mark.stroke.color));
            }
            labels.push(
              text(q.outliers.toLocaleString('en-US'), centre, top - 2, {
                size: LABEL_PT,
                anchor: 'middle',
                fill: LABEL_INK,
              }),
            );
          }
          if (boxes.values) {
            // As the pane places them: the upper numbers sit above their
            // level, the median across it, the lower ones below.
            const at = centre + half + 2;
            const shown: [number, number][] = [
              [q.max, -1],
              [q.p75, -1],
              [q.median, LABEL_PT * 0.35],
              [q.p25, LABEL_PT * 0.9],
              [q.min, LABEL_PT * 0.9],
            ];
            if (q.upperWhisker !== q.max) shown.push([q.upperWhisker, -1]);
            if (q.lowerWhisker !== q.min) shown.push([q.lowerWhisker, LABEL_PT * 0.9]);
            for (const [value, shift] of shown) {
              labels.push(
                text(formatNumber(value), at, y(value) + shift, {
                  size: LABEL_PT,
                  fill: LABEL_INK,
                }),
              );
            }
          }
        });
      });
      // Text over every box, so a neighbour's fill never hides a number.
      return [...out, ...labels];
    },
  };
}
