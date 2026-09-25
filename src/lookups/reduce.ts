// src/lookups/reduce.ts
//
// The entity-cube reduce kernels: bucket an axis by a lookup column, extract
// one bucket, or sum an explicit (optionally signed) member set.
//
//   1. An entity absent from the lookup gets an '(unlisted)' bucket, never
//      dropped or folded into another label.
//   2. A missing or blank value gets '(blank)'.
//   3. Enum dictionaries are sorted, so bucket order is deterministic.
//   4. Planes with presence 0 are skipped.
//
// The axis is an `ArrayLike` (Bus's is an `Int32Array`), read only by index.
// The member-set reduces share this file for the accumulate loop and the
// presence rule, so no two reduces disagree about an absent plane.

import { HOURS_PER_YEAR } from '../model/calendar';
import type { LookupColumn, LookupTable } from './types';

/**
 * Whether a group-by may bucket on a lookup column: only `enum`, which is
 * ingest's own low-cardinality category (declared in `src/lookups/schema.ts`
 * or measured by `classifyUnknown`). A float, date or free-text column
 * (`Latitude`, `Name`) makes one row per entity; a bool or int code
 * (`Monitored`, `Type`) has labels that name nothing. An int that IS a
 * category should be declared enum in the schema.
 */
export function isBucketable(column: LookupColumn): boolean {
  return column.kind === 'enum';
}

export interface BucketedBucket {
  readonly label: string;
  readonly series: Float32Array;
  readonly count: number;
}

export interface BucketedReduceResult {
  readonly buckets: readonly BucketedBucket[];
}

/** The bucket label an entity has under a lookup column. */
export function bucketLabelFor(
  entity: string | number,
  lookup: LookupTable | undefined,
  columnName: string,
): string {
  if (!lookup) return '(unlisted)';
  const row = lookup.index.get(entity);
  if (row === undefined) return '(unlisted)';
  const colIndex = lookup.byName.get(columnName);
  if (colIndex === undefined) return '(unlisted)';
  const column = lookup.columns[colIndex];
  if (column.kind === 'enum') {
    const code = column.codes[row];
    return code >= 0 ? column.labels[code] : '(blank)';
  }
  if (column.kind === 'text') {
    const val = column.values[row];
    return val && val.trim() !== '' ? val.trim() : '(blank)';
  }
  if (column.kind === 'int' || column.kind === 'float') {
    if (column.nulls[row] === 1) return '(blank)';
    return String(column.values[row]);
  }
  return '(blank)';
}

/**
 * Sum entity planes for one bucket value into `out`; returns how many
 * contributed. `summed` collects them. `members` (a frozen membership) only
 * RESTRICTS: a member whose label no longer matches is left out and counted,
 * never replaced by a different set.
 */
export function reduceSingleBucket(
  cube: Float32Array,
  presence: Uint8Array,
  entityNames: ArrayLike<string | number>,
  lookup: LookupTable | undefined,
  columnName: string,
  targetValue: string,
  out: Float32Array,
  members?: ReadonlySet<string | number>,
  labelOf?: (entity: string | number) => string,
  summed?: (string | number)[],
): number {
  out.fill(NaN);
  let count = 0;
  for (let i = 0; i < entityNames.length; i++) {
    if (presence[i] === 0) continue;
    const name = entityNames[i];
    const label = labelOf ? labelOf(name) : bucketLabelFor(name, lookup, columnName);
    if (label === targetValue && (!members || members.has(name))) {
      count++;
      summed?.push(name);
      const start = i * HOURS_PER_YEAR;
      for (let h = 0; h < HOURS_PER_YEAR; h++) {
        const val = cube[start + h];
        if (!Number.isNaN(val)) {
          out[h] = Number.isNaN(out[h]) ? val : out[h] + val;
        }
      }
    }
  }
  if (count === 0) out.fill(0);
  return count;
}

/**
 * Whether any entity with data passes `keep`: what every reduce here would
 * sum, asked without the sum. The Selected tab asks it per pin and per
 * variable, so it must not cost a plane pass.
 */
export function anyPresent(
  presence: Uint8Array,
  entityNames: ArrayLike<string | number>,
  keep: (name: string | number) => boolean,
): boolean {
  for (let i = 0; i < entityNames.length; i++) {
    if (presence[i] === 1 && keep(entityNames[i])) return true;
  }
  return false;
}

/**
 * Sum an EXPLICIT member set (an authored group) into `out`, NaN where nothing
 * contributed; returns how many carried data. Absent or presence-0 members
 * contribute nothing, as in the bucketed forms.
 */
export function reduceMembers(
  cube: Float32Array,
  presence: Uint8Array,
  entityNames: ArrayLike<string | number>,
  members: ReadonlySet<string | number>,
  out: Float32Array,
  summed?: (string | number)[],
): number {
  out.fill(NaN);
  let count = 0;
  for (let i = 0; i < entityNames.length; i++) {
    if (presence[i] === 0) continue;
    const name = entityNames[i];
    if (!members.has(name)) continue;
    count++;
    summed?.push(name);
    const start = i * HOURS_PER_YEAR;
    for (let h = 0; h < HOURS_PER_YEAR; h++) {
      const val = cube[start + h];
      if (!Number.isNaN(val)) {
        out[h] = Number.isNaN(out[h]) ? val : out[h] + val;
      }
    }
  }
  if (count === 0) out.fill(0);
  return count;
}

/**
 * Sum a member set with a COEFFICIENT per member (a directed interface
 * group: a path measured the other way enters at -1). Separate from
 * `reduceMembers` so a forgotten map cannot silently turn a signed sum into
 * a plain one. A coefficient of 0 is honoured as written.
 */
export function reduceSignedMembers(
  cube: Float32Array,
  presence: Uint8Array,
  entityNames: ArrayLike<string | number>,
  coefficients: ReadonlyMap<string | number, number>,
  out: Float32Array,
): number {
  out.fill(NaN);
  let count = 0;
  for (let i = 0; i < entityNames.length; i++) {
    if (presence[i] === 0) continue;
    const coefficient = coefficients.get(entityNames[i]);
    if (coefficient === undefined) continue;
    count++;
    const start = i * HOURS_PER_YEAR;
    for (let h = 0; h < HOURS_PER_YEAR; h++) {
      const val = cube[start + h];
      if (!Number.isNaN(val)) {
        const term = val * coefficient;
        out[h] = Number.isNaN(out[h]) ? term : out[h] + term;
      }
    }
  }
  if (count === 0) out.fill(0);
  return count;
}

/** One pass over the cube for every value of a lookup column; returns only
 * buckets with a contributor. */
export function bucketedReduce(
  cube: Float32Array,
  presence: Uint8Array,
  entityNames: ArrayLike<string | number>,
  lookup: LookupTable | undefined,
  columnName: string,
  filter?: (name: string | number) => boolean,
  labelOf?: (entity: string | number) => string,
  seededLabels?: readonly string[],
): BucketedReduceResult {
  const bucketsMap = new Map<string, { count: number; series: Float32Array }>();

  if (seededLabels) {
    for (const label of seededLabels) {
      bucketsMap.set(label, { count: 0, series: new Float32Array(HOURS_PER_YEAR).fill(NaN) });
    }
  } else if (lookup) {
    const colIndex = lookup.byName.get(columnName);
    if (colIndex !== undefined) {
      const column = lookup.columns[colIndex];
      if (column.kind === 'enum') {
        for (const label of column.labels) {
          bucketsMap.set(label, { count: 0, series: new Float32Array(HOURS_PER_YEAR).fill(NaN) });
        }
      }
    }
  }

  for (let i = 0; i < entityNames.length; i++) {
    if (presence[i] === 0) continue;
    const name = entityNames[i];
    if (filter && !filter(name)) continue;
    const label = labelOf ? labelOf(name) : bucketLabelFor(name, lookup, columnName);
    let bucket = bucketsMap.get(label);
    if (!bucket) {
      bucket = { count: 0, series: new Float32Array(HOURS_PER_YEAR).fill(NaN) };
      bucketsMap.set(label, bucket);
    }
    bucket.count++;
    const start = i * HOURS_PER_YEAR;
    for (let h = 0; h < HOURS_PER_YEAR; h++) {
      const val = cube[start + h];
      if (!Number.isNaN(val)) {
        bucket.series[h] = Number.isNaN(bucket.series[h]) ? val : bucket.series[h] + val;
      }
    }
  }

  const result: BucketedBucket[] = [];
  for (const [label, entry] of bucketsMap) {
    if (entry.count > 0) {
      result.push({ label, series: entry.series, count: entry.count });
    }
  }
  return { buckets: result };
}
