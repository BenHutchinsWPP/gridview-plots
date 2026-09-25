// src/ui/browse-planes.ts
//
// Presence bitmap + scoped rows -> the plane starts `rankedStats` reads, with
// -1 for "not carried" spelled in one place (a kind spelling it 0 would rank
// absent entities as real data). Kind-neutral: it moves OFFSETS, and each
// kind's plane arithmetic arrives as a callback. It imports no table kind.

import { RANKED_FIELDS, createScratch, rankedStats, type RankMemo } from '../kernels';
import { normalizedCopy, type RangeLimits } from '../series/range';

/**
 * Where each scoped row's plane starts, or -1 where the case does not carry
 * it (an axis index of -1, or presence 0; the tab explains which). Only
 * scoped rows are passed, which is what makes bus width affordable. `out` is
 * reused when its length matches.
 */
export function planeStartsFor(
  rows: ArrayLike<number>,
  presence: Uint8Array,
  planeStart: (axisIndex: number) => number,
  out?: Int32Array,
): Int32Array {
  const starts = out && out.length === rows.length ? out : new Int32Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const axisIndex = rows[i];
    starts[i] = axisIndex >= 0 && presence[axisIndex] === 1 ? planeStart(axisIndex) : -1;
  }
  return starts;
}

/**
 * Rank every scoped row: one masked pass per table, with a shared scratch
 * buffer. `planesOf` supplies the kind's plane arithmetic. Rows must be laid
 * out table by table in `rowCounts` order, or they would be ranked against
 * the wrong mask.
 *
 * With `rangeOf` ("% of range"), each row is ranked from its plane divided
 * by that range, as a ratio. The divisor is taken over every hour, so it
 * cannot be applied to stats already masked.
 */
export function rankScopedRows<D extends { cube: Float32Array }>(input: {
  tables: readonly { data: D; mask: Uint8Array }[];
  rowCounts: readonly number[];
  /** Row `i`'s axis index, counted across all tables in order. */
  axisIndexOf: (row: number) => number;
  /** One table's presence and where an entity's 8,760 values begin. */
  planesOf: (data: D) => { presence: Uint8Array; planeStart: (axisIndex: number) => number };
  scratch: Float32Array;
  /** Rankings already computed, reused while a table's inputs hold still. */
  memo?: RankMemo;
  /** Row `i`'s limits for "% of range"; `{}` divides by its own peak. */
  rangeOf?: (row: number) => RangeLimits;
}): Float64Array {
  const { tables, rowCounts, axisIndexOf, planesOf, scratch, memo, rangeOf } = input;
  const total = rowCounts.reduce((sum, count) => sum + count, 0);
  const ranked = new Float64Array(total * RANKED_FIELDS);
  let at = 0;
  for (let t = 0; t < tables.length; t++) {
    const count = rowCounts[t];
    const table = tables[t];
    const axisIndexes = new Int32Array(count);
    for (let i = 0; i < count; i++) axisIndexes[i] = axisIndexOf(at + i);

    const planes = planesOf(table.data);
    const starts = planeStartsFor(axisIndexes, planes.presence, planes.planeStart);

    if (rangeOf) {
      for (let i = 0; i < count; i++) {
        rankInRange(
          table.data.cube,
          starts[i],
          table.mask,
          rangeOf(at + i),
          scratch,
          ranked,
          at + i,
        );
      }
    } else {
      rankedStats(
        table.data.cube,
        starts,
        table.mask,
        scratch,
        ranked.subarray(at * RANKED_FIELDS, (at + count) * RANKED_FIELDS),
        memo,
      );
    }
    at += count;
  }
  return ranked;
}

/** One plane's scratch for `rankInRange`: the divided copy, before masking. */
let planeScratch: Float32Array | undefined;

/**
 * Rank one row from its plane divided by its range, as `rankedStats` ranks a
 * one-plane cube. A plane start of -1 (not carried) is a NaN row. No memo:
 * `planeScratch` is rewritten for every row.
 */
function rankInRange(
  cube: Float32Array,
  start: number,
  mask: Uint8Array,
  limits: RangeLimits,
  scratch: Float32Array,
  ranked: Float64Array,
  row: number,
): void {
  planeScratch ??= createScratch();
  if (start >= 0) normalizedCopy(cube.subarray(start), limits, planeScratch);
  rankedStats(
    planeScratch,
    Int32Array.of(start < 0 ? -1 : 0),
    mask,
    scratch,
    ranked.subarray(row * RANKED_FIELDS, (row + 1) * RANKED_FIELDS),
  );
}
