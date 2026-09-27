// src/ui/panes/box.ts
//
// The box plot chart type, hand-drawn on the pane's canvas because it is the
// one summary uPlot does not draw. A pane's boxes are cut on that pane's own
// dimension (`ChartsInput.boxes`); its hover dims every box but the one under
// the pointer and tags each y axis with the value at the pointer's height.

import { scaleOf, scalesOf } from '../../series/scales';
import type { BoxGroup, ChartsInput, Quantiles } from '../charts';
import { clip, emptyPaneText, formatNumber } from '../chart-format';
import { placeAxisTag } from '../chart-axis';
import { figureShot, pinnedOf, type PaneAdapter, type PaneFrame, type PaneHost } from './adapter';

interface BoxHit {
  centre: number;
  label: string;
  name: string;
  unit: string;
  color: string;
  quantiles: Quantiles;
}

interface BoxGeometry {
  units: string[];
  range: Map<string, { low: number; high: number }>;
  marginLeft: number;
  marginTop: number;
  plotWidth: number;
  plotHeight: number;
}

export function createBoxAdapter(host: PaneHost): PaneAdapter {
  const { canvas, tip, tags } = host;
  const { boxDim, boxValues } = host.controls;
  let frame: PaneFrame | null = null;
  let geometry: BoxGeometry | null = null;
  let hits: BoxHit[] = [];
  let hovered = -1;

  boxValues.addEventListener('change', () => {
    if (frame) draw(frame.input);
  });

  function showTip(hit: BoxHit, pointerX: number): void {
    const head = document.createElement('div');
    head.className = 'chart-tip-x';
    head.textContent = hit.label;

    const title = document.createElement('div');
    title.className = 'chart-tip-row';
    const dot = document.createElement('span');
    dot.className = 'chart-tip-dot';
    dot.style.background = hit.color;
    title.appendChild(dot);
    const name = document.createElement('span');
    name.className = 'chart-tip-name';
    name.textContent = hit.name;
    title.appendChild(name);

    const q = hit.quantiles;
    const rows: [string, number | string][] = [
      ['max', q.max],
      ['upper whisker', q.upperWhisker],
      ['p75', q.p75],
      ['median', q.median],
      ['p25', q.p25],
      ['lower whisker', q.lowerWhisker],
      ['min', q.min],
      ['n', q.n.toLocaleString()],
    ];
    if (q.outliers > 0) rows.push(['outliers', q.outliers.toLocaleString()]);

    const body = rows.map(([key, value]) => {
      const row = document.createElement('div');
      row.className = 'chart-tip-row';
      const label = document.createElement('span');
      label.className = 'chart-tip-name';
      label.textContent = key;
      row.appendChild(label);
      const number = document.createElement('b');
      number.textContent = typeof value === 'string' ? value : formatNumber(value);
      row.appendChild(number);
      return row;
    });

    if (hit.unit) {
      const unit = document.createElement('div');
      unit.className = 'chart-tip-x';
      unit.style.marginTop = '2px';
      unit.style.marginBottom = '0';
      unit.textContent = hit.unit;
      body.push(unit);
    }

    tip.replaceChildren(...(hit.name === hit.label ? [head] : [head, title]), ...body);
    tip.style.display = '';
    const right = pointerX < host.body.clientWidth / 2;
    tip.style.left = right ? 'auto' : '6px';
    tip.style.right = right ? '6px' : 'auto';
  }

  function draw(input: ChartsInput, keepHover = false): void {
    if (!keepHover) {
      hovered = -1;
      tip.style.display = 'none';
    }
    host.body.querySelectorAll('.pane-banner').forEach((node) => node.remove());
    const { width, height } = host.size();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const groups: BoxGroup[] = input
      .boxes(host.index)
      .filter((group) => group.boxes.some((box) => box.quantiles.n > 0));
    if (groups.length === 0) {
      geometry = null;
      hits = [];
      canvas.style.display = 'none';
      // No series at all is the empty pane every type shares; series the
      // filters emptied are this pane's own.
      host.banner(
        'refusal',
        input.series.length === 0
          ? emptyPaneText(input)
          : (input.series[0]?.refusal ?? 'Nothing to plot with these filters.'),
      );
      return;
    }
    canvas.style.display = '';

    const units = scalesOf(groups.flatMap((group) => group.boxes));
    const range = new Map<string, { low: number; high: number }>();
    for (const group of groups) {
      for (const box of group.boxes) {
        if (box.quantiles.n === 0) continue;
        const seen = range.get(scaleOf(box.unit)) ?? { low: Infinity, high: -Infinity };
        seen.low = Math.min(seen.low, box.quantiles.min);
        seen.high = Math.max(seen.high, box.quantiles.max);
        range.set(scaleOf(box.unit), seen);
      }
    }
    for (const seen of range.values()) {
      if (seen.low === seen.high) {
        seen.low -= 1;
        seen.high += 1;
      }
    }

    const AXIS_LABEL = 16;
    const marginLeft = 56 + AXIS_LABEL;
    const marginRight = units.length > 1 ? 56 + AXIS_LABEL : 8;
    const marginBottom = 22;
    const marginTop = 10;
    const plotHeight = height - marginTop - marginBottom;
    const plotWidth = width - marginLeft - marginRight;
    const y = (value: number, scale: string) => {
      const seen = range.get(scale) ?? { low: 0, high: 1 };
      return marginTop + plotHeight * (1 - (value - seen.low) / (seen.high - seen.low));
    };

    context.font = '10px system-ui, sans-serif';
    context.fillStyle = '#666';
    units.slice(0, 2).forEach(({ scale, label }, index) => {
      const seen = range.get(scale);
      if (!seen) return;
      for (let tick = 0; tick <= 4; tick++) {
        const value = seen.low + ((seen.high - seen.low) * tick) / 4;
        const py = y(value, scale);
        if (index === 0) {
          context.strokeStyle = '#e8e8e8';
          context.beginPath();
          context.moveTo(marginLeft, py);
          context.lineTo(marginLeft + plotWidth, py);
          context.stroke();
          context.textAlign = 'right';
          context.fillText(formatNumber(value), marginLeft - 6, py + 3);
          context.textAlign = 'left';
        } else {
          context.fillText(formatNumber(value), marginLeft + plotWidth + 6, py + 3);
        }
      }

      if (label) {
        context.save();
        context.translate(
          index === 0 ? AXIS_LABEL - 4 : marginLeft + plotWidth + 56 + AXIS_LABEL - 4,
          marginTop + plotHeight / 2,
        );
        context.rotate(-Math.PI / 2);
        context.textAlign = 'center';
        context.fillText(label, 0, 0);
        context.restore();
        context.textAlign = 'left';
      }
    });

    geometry = {
      units: units.map((u) => u.scale),
      range,
      marginLeft,
      marginTop,
      plotWidth,
      plotHeight,
    };

    const drawnHits: BoxHit[] = [];
    const anyHover = hovered >= 0;

    const slot = plotWidth / groups.length;
    groups.forEach((group, groupIndex) => {
      const drawn = group.boxes.filter((box) => box.quantiles.n > 0);
      const boxWidth = Math.max(2, Math.min(24, (slot * 0.7) / Math.max(1, drawn.length)));
      drawn.forEach((box, boxIndex) => {
        const centre =
          marginLeft +
          slot * (groupIndex + 0.5) +
          (boxIndex - (drawn.length - 1) / 2) * (boxWidth + 1);
        const q = box.quantiles;

        const hitIndex = drawnHits.length;
        drawnHits.push({
          centre,
          label: group.label,
          name: box.name,
          unit: box.unit,
          color: box.color,
          quantiles: q,
        });
        const isHovered = hitIndex === hovered;
        const dimmed = anyHover && !isHovered;
        const strokeAlpha = dimmed ? 0.3 : 1;
        const fillAlpha = isHovered ? 0.5 : dimmed ? 0.08 : 0.25;

        context.strokeStyle = box.color;
        context.fillStyle = box.color;
        context.lineWidth = isHovered ? 2 : 1;
        context.globalAlpha = fillAlpha;
        context.fillRect(
          centre - boxWidth / 2,
          y(q.p75, scaleOf(box.unit)),
          boxWidth,
          y(q.p25, scaleOf(box.unit)) - y(q.p75, scaleOf(box.unit)),
        );
        context.globalAlpha = strokeAlpha;
        context.strokeRect(
          centre - boxWidth / 2,
          y(q.p75, scaleOf(box.unit)),
          boxWidth,
          y(q.p25, scaleOf(box.unit)) - y(q.p75, scaleOf(box.unit)),
        );

        context.beginPath();
        context.moveTo(centre - boxWidth / 2, y(q.median, scaleOf(box.unit)));
        context.lineTo(centre + boxWidth / 2, y(q.median, scaleOf(box.unit)));
        context.moveTo(centre, y(q.p75, scaleOf(box.unit)));
        context.lineTo(centre, y(q.upperWhisker, scaleOf(box.unit)));
        context.moveTo(centre, y(q.p25, scaleOf(box.unit)));
        context.lineTo(centre, y(q.lowerWhisker, scaleOf(box.unit)));
        context.moveTo(centre - boxWidth / 4, y(q.upperWhisker, scaleOf(box.unit)));
        context.lineTo(centre + boxWidth / 4, y(q.upperWhisker, scaleOf(box.unit)));
        context.moveTo(centre - boxWidth / 4, y(q.lowerWhisker, scaleOf(box.unit)));
        context.lineTo(centre + boxWidth / 4, y(q.lowerWhisker, scaleOf(box.unit)));
        context.stroke();

        context.globalAlpha = 1;
        context.lineWidth = 1;

        if (q.outliers > 0) {
          context.globalAlpha = dimmed ? 0.2 : 0.6;
          context.beginPath();
          context.arc(centre, y(q.max, scaleOf(box.unit)), 1.5, 0, Math.PI * 2);
          context.arc(centre, y(q.min, scaleOf(box.unit)), 1.5, 0, Math.PI * 2);
          context.fill();
          context.globalAlpha = 1;
        }

        if (boxValues.checked) {
          context.fillStyle = '#333';
          context.textAlign = 'left';
          const at = centre + boxWidth / 2 + 3;
          const labels: [number, number][] = [
            [q.max, -1],
            [q.p75, -1],
            [q.median, 3],
            [q.p25, 7],
            [q.min, 7],
          ];
          if (q.upperWhisker !== q.max) labels.push([q.upperWhisker, -1]);
          if (q.lowerWhisker !== q.min) labels.push([q.lowerWhisker, 7]);
          for (const [value, offset] of labels) {
            context.fillText(formatNumber(value), at, y(value, scaleOf(box.unit)) + offset);
          }
          context.fillStyle = box.color;
        }
      });

      context.fillStyle = '#666';
      context.textAlign = 'center';
      context.fillText(
        clip(context, group.label, slot - 4),
        marginLeft + slot * (groupIndex + 0.5),
        height - 6,
      );
      context.textAlign = 'left';
    });

    hits = drawnHits;

    if (groups.every((group) => group.boxes.every((box) => box.quantiles.degenerate))) {
      host.banner(
        'note',
        'Every box is degenerate: p25 = median = p75. That is what a constant or ' +
          'mostly-zero column looks like, and it is the data.',
      );
    }
  }

  function hover(x: number, y: number): void {
    if (!geometry) return;
    const { units, range, marginLeft, marginTop, plotWidth, plotHeight } = geometry;
    const inside =
      y >= marginTop &&
      y <= marginTop + plotHeight &&
      x >= marginLeft &&
      x <= marginLeft + plotWidth;
    const fraction = 1 - (y - marginTop) / plotHeight;

    tags.forEach((tag, tagIndex) => {
      const unit = units[tagIndex];
      const scale = unit === undefined ? undefined : range.get(unit);
      placeAxisTag(
        tag,
        tagIndex,
        !inside || !scale ? null : scale.low + (scale.high - scale.low) * fraction,
        y,
        marginLeft,
        marginLeft + plotWidth,
      );
    });

    let nearest = -1;
    if (inside) {
      let best = Infinity;
      hits.forEach((hit, hitIndex) => {
        const distance = Math.abs(x - hit.centre);
        if (distance < best) {
          best = distance;
          nearest = hitIndex;
        }
      });
    }
    if (nearest !== hovered) {
      hovered = nearest;
      if (frame) draw(frame.input, true);
    }
    if (nearest < 0) tip.style.display = 'none';
    else showTip(hits[nearest], x);
  }

  /** The dimension's label, from the select's own option text (one option is
   * the mounting kind's axis word). */
  function dimensionLabel(): string {
    return boxDim.selectedOptions[0]?.textContent?.trim() || boxDim.value;
  }

  return {
    surface: 'canvas',
    controls: () => ['box'],
    draw(next) {
      frame = next;
      draw(next.input);
    },
    leave() {
      frame = null;
      geometry = null;
      hits = [];
      hovered = -1;
      tip.style.display = 'none';
      for (const tag of tags) tag.style.display = 'none';
    },
    resize() {
      if (frame) draw(frame.input);
    },
    hover,
    unhover() {
      for (const tag of tags) tag.style.display = 'none';
      tip.style.display = 'none';
      if (hovered >= 0) {
        hovered = -1;
        if (frame) draw(frame.input, true);
      }
    },
    figure: {
      offered: () => true,
      capture() {
        if (!frame) return null;
        const { input } = frame;
        const ordered = pinnedOf(input.series);
        return figureShot(host, input, {
          pane: 'box',
          ordered,
          // No zoom: a box pane's window is its categories.
          xWindow: [0, 1],
          // Each box by the capture line it summarises, the preview's left
          // out: a box names its line only by name and colour, which the
          // pane's lines keep unique.
          boxes: {
            // A category per line (the `case` cut) is each line under its
            // own name: no dimension to title the axis or the caption with.
            dimension: input
              .boxes(host.index)
              .every((group) => group.boxes.length === 1 && group.boxes[0].name === group.label)
              ? ''
              : dimensionLabel(),
            values: boxValues.checked,
            groups: input.boxes(host.index).map((group) => ({
              label: group.label,
              boxes: group.boxes.flatMap((box) => {
                const line = ordered.findIndex((s) => s.name === box.name && s.color === box.color);
                return line < 0 ? [] : [{ line, quantiles: { ...box.quantiles } }];
              }),
            })),
          },
        });
      },
    },
  };
}
