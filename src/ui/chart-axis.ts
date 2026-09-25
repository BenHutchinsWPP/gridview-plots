// src/ui/chart-axis.ts
//
// The value tag pinned to a y axis at the cursor's height: the reading the eye
// is trying to take off the axis anyway, without tracing a line back to it.
//
// Here rather than in `charts.ts` because `placeAxisTag` is shared with the
// hand-drawn box canvas, which has no uPlot in it at all. The two differ only
// in how a pixel becomes a value -- uPlot's `posToVal` against a linear
// interpolation over the box plot's own scale -- and everything after that is
// one function. `addAxisReadout` is the uPlot half, and is the only part of
// this file that knows what a uPlot is.

import type uPlot from 'uplot';
import { formatNumber } from './chart-format';

/** `count` hidden value tags, one per y scale. */
export function makeAxisTags(count: number): HTMLElement[] {
  return Array.from({ length: count }, () => {
    const tag = document.createElement('div');
    tag.className = 'axis-tag';
    tag.style.display = 'none';
    return tag;
  });
}

/**
 * Place one axis value tag, or hide it when there is no reading. Index 0 sits
 * just outside the plot's left edge and index 1 just outside its right --
 * positioned from the plot area's own edges, the only geometry that holds
 * whatever the axis gutters end up sized at.
 *
 * Shared by the uPlot panes and the hand-drawn box canvas. They differ only in
 * how a pixel becomes a value (uPlot's posToVal vs a linear interpolation over
 * the box plot's own scale); everything after that is this function.
 */
export function placeAxisTag(
  tag: HTMLElement,
  index: number,
  value: number | null,
  top: number,
  plotLeft: number,
  plotRight: number,
): void {
  if (value === null || !Number.isFinite(value)) {
    tag.style.display = 'none';
    return;
  }
  tag.textContent = formatNumber(value);
  tag.style.display = '';
  tag.style.top = `${top}px`;
  tag.style.left = `${index === 0 ? plotLeft - 4 : plotRight + 4}px`;
  tag.style.transform = index === 0 ? 'translate(-100%, -50%)' : 'translateY(-50%)';
}

/**
 * A value box pinned to the y axis at the cursor's height -- the reading the
 * eye is trying to take off the axis anyway, without tracing a line back to
 * it. One per scale, so a two-unit chart labels both sides.
 */
export function addAxisReadout(options: uPlot.Options, scales: string[]): void {
  const tags = makeAxisTags(Math.min(scales.length, 2));

  options.hooks = {
    ...options.hooks,
    setCursor: [
      ...(options.hooks?.setCursor ?? []),
      (self) => {
        const ratio = devicePixelRatio || 1;
        const top = self.cursor.top ?? -1;
        const left = self.cursor.left ?? -1;
        const off = top < 0 || left < 0;
        tags.forEach((tag, index) => {
          if (tag.parentElement !== self.root) self.root.appendChild(tag);
          placeAxisTag(
            tag,
            index,
            off ? null : self.posToVal(top, scales[index]),
            self.bbox.top / ratio + top,
            self.bbox.left / ratio,
            (self.bbox.left + self.bbox.width) / ratio,
          );
        });
      },
    ],
  };
}
