// src/figure/thin.ts
//
// A year of hours is 8,760 points, and a figure is about 1,950 output pixels
// wide at 300 dpi. Drawing every hour makes a large SVG that Word is slow to
// place and that prints no differently. Thinning keeps, for every output
// pixel column, the lowest and highest value in it, which is everything a
// printed line can show at that column: a peak one hour wide survives.
//
// A NaN hour (filtered out, or missing) is a break, never bridged. Bridging
// it would draw a value across hours the pane leaves empty.

/** One unbroken run of a line: `[hour, value]` pairs in hour order. */
export type Run = [number, number][];

/**
 * `values` over the hours `from`..`to` (inclusive), for an x window
 * `x0`..`x1` drawn `columns` output pixels wide. Returns the unbroken runs,
 * each holding every column's minimum and maximum in hour order.
 */
export function thinLine(
  values: ArrayLike<number>,
  from: number,
  to: number,
  x0: number,
  x1: number,
  columns: number,
): Run[] {
  const runs: Run[] = [];
  const span = x1 - x0;
  const lastColumn = Math.max(0, columns - 1);
  let run: Run = [];
  let column = -1;
  let low = -1;
  let high = -1;

  const flushColumn = (): void => {
    if (column < 0) return;
    const first = Math.min(low, high);
    const second = Math.max(low, high);
    run.push([first, values[first]]);
    if (second !== first) run.push([second, values[second]]);
    column = -1;
  };
  const flushRun = (): void => {
    flushColumn();
    if (run.length > 0) runs.push(run);
    run = [];
  };

  for (let hour = from; hour <= to; hour++) {
    const value = values[hour];
    if (Number.isNaN(value)) {
      flushRun();
      continue;
    }
    const at = span > 0 ? Math.floor(((hour - x0) / span) * columns) : 0;
    const here = Math.min(lastColumn, Math.max(0, at));
    if (here !== column) {
      flushColumn();
      column = here;
      low = high = hour;
      continue;
    }
    if (value < values[low]) low = hour;
    if (value > values[high]) high = hour;
  }
  flushRun();
  return runs;
}

/**
 * Thinning for a stack: every band keeps the SAME hours, so a band's upper
 * edge and the next band's lower edge are one line and no sliver opens
 * between them. For each output column it keeps, for every running total,
 * its lowest and highest hour, so each band edge keeps its extremes. `totals`
 * are NaN together (an hour no line holds), and a NaN hour is a break.
 * Returns the unbroken runs as hours in order.
 */
export function thinShared(
  totals: readonly ArrayLike<number>[],
  from: number,
  to: number,
  x0: number,
  x1: number,
  columns: number,
): number[][] {
  const runs: number[][] = [];
  const top = totals[totals.length - 1];
  if (!top) return runs;
  const span = x1 - x0;
  const lastColumn = Math.max(0, columns - 1);
  let run: number[] = [];
  let column = -1;
  let low: number[] = [];
  let high: number[] = [];

  const flushColumn = (): void => {
    if (column < 0) return;
    run.push(...[...new Set([...low, ...high])].sort((a, b) => a - b));
    column = -1;
  };
  const flushRun = (): void => {
    flushColumn();
    if (run.length > 0) runs.push(run);
    run = [];
  };

  for (let hour = from; hour <= to; hour++) {
    if (Number.isNaN(top[hour])) {
      flushRun();
      continue;
    }
    const at = span > 0 ? Math.floor(((hour - x0) / span) * columns) : 0;
    const here = Math.min(lastColumn, Math.max(0, at));
    if (here !== column) {
      flushColumn();
      column = here;
      low = totals.map(() => hour);
      high = totals.map(() => hour);
      continue;
    }
    totals.forEach((total, i) => {
      if (total[hour] < total[low[i]]) low[i] = hour;
      if (total[hour] > total[high[i]]) high[i] = hour;
    });
  }
  flushRun();
  return runs;
}
