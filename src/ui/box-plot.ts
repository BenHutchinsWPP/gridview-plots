// src/ui/box-plot.ts
//
// The hand-drawn canvas box plot pane, split out of charts.ts because it is
// the one pane uPlot does not draw. It has no state of its own: every array
// it reads or writes is owned by createCharts and handed in through `deps`,
// shared by reference so a hover computed in charts.ts's canvas listeners and
// a draw computed here stay the same array.

import type { BoxGroup, ChartsInput, Quantiles } from './charts';
import { emptyPaneText } from './chart-format';

export interface BoxHit {
  centre: number;
  label: string;
  name: string;
  unit: string;
  color: string;
  quantiles: Quantiles;
}

export interface BoxGeometry {
  units: string[];
  range: Map<string, { low: number; high: number }>;
  marginLeft: number;
  marginTop: number;
  plotWidth: number;
  plotHeight: number;
}

export interface BoxPlotDeps {
  paneBodies: HTMLElement[];
  slotCanvases: HTMLCanvasElement[];
  slotBoxTips: HTMLElement[];
  slotBoxGeometry: (BoxGeometry | null)[];
  slotBoxHits: BoxHit[][];
  slotHoveredBox: number[];
  boxValuesCheck: HTMLInputElement;
  paneSize(body: HTMLElement): { width: number; height: number };
  scaleOf(unit: string): string;
  scalesOf(series: { unit: string }[]): { scale: string; label: string }[];
  formatNumber(value: number): string;
  banner(body: HTMLElement, kind: 'refusal' | 'note', text: string): void;
  clip(context: CanvasRenderingContext2D, text: string, maxWidth: number): string;
}

export interface BoxPlot {
  draw(slotIndex: number, input: ChartsInput, keepHover?: boolean): void;
  showTip(slotIndex: number, hit: BoxHit, pointerX: number): void;
}

export function createBoxPlot(deps: BoxPlotDeps): BoxPlot {
  const {
    paneBodies,
    slotCanvases,
    slotBoxTips,
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
  } = deps;

  function showTip(slotIndex: number, hit: BoxHit, pointerX: number): void {
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

    const tip = slotBoxTips[slotIndex];
    tip.replaceChildren(...(hit.name === hit.label ? [head] : [head, title]), ...body);
    tip.style.display = '';
    const right = pointerX < paneBodies[slotIndex].clientWidth / 2;
    tip.style.left = right ? 'auto' : '6px';
    tip.style.right = right ? '6px' : 'auto';
  }

  function draw(slotIndex: number, input: ChartsInput, keepHover = false): void {
    if (!keepHover) {
      slotHoveredBox[slotIndex] = -1;
      slotBoxTips[slotIndex].style.display = 'none';
    }
    const body = paneBodies[slotIndex];
    body.querySelectorAll('.pane-banner').forEach((node) => node.remove());
    const { width, height } = paneSize(body);
    const ratio = window.devicePixelRatio || 1;
    const canvas = slotCanvases[slotIndex];
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const groups: BoxGroup[] = input.boxes.filter((group) =>
      group.boxes.some((box) => box.quantiles.n > 0),
    );
    if (groups.length === 0) {
      slotBoxGeometry[slotIndex] = null;
      slotBoxHits[slotIndex] = [];
      canvas.style.display = 'none';
      // No series at all is the empty pane every slot shares, and a resize
      // lands here with none; series the filters emptied are this pane's own.
      banner(
        body,
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

    slotBoxGeometry[slotIndex] = {
      units: units.map((u) => u.scale),
      range,
      marginLeft,
      marginTop,
      plotWidth,
      plotHeight,
    };

    const hits: BoxHit[] = [];
    const hovered = slotHoveredBox[slotIndex];
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

        const hitIndex = hits.length;
        hits.push({
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

        if (boxValuesCheck.checked) {
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

    slotBoxHits[slotIndex] = hits;

    if (groups.every((group) => group.boxes.every((box) => box.quantiles.degenerate))) {
      banner(
        body,
        'note',
        'Every box is degenerate: p25 = median = p75. That is what a constant or ' +
          'mostly-zero column looks like, and it is the data.',
      );
    }
  }

  return { draw, showTip };
}
