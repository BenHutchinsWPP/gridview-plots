// src/tables/interface/limits.ts
//
// A boundary's "% of range" limits: its member paths' limits summed in the
// group's directions. The one place the swap is written; the groups tab and
// the drawn group line both call it, so they cannot disagree.
//
//   * **A reversed member's sides swap and change sign.** Its flow is taken ×
//     −1, so its MIN bounds the group from above (−MIN) and its MAX from
//     below (−MAX). Signed arithmetic, never absolute: a MIN ≥ 0 is a floor,
//     and stays one after the swap.
//   * **A side is NaN in any hour a contributing member has none there** (no
//     row, no side, or a sentinel month). A partial sum would be a plausible
//     wrong limit; NaN sends that hour to the peak, and the label says so.
//   * **The sum is a best case, labelled as a sum.** A boundary's own rating
//     is often below its paths' summed ratings (simultaneous limits,
//     nomograms). Dividing by the group's peak instead was rejected because
//     it answers nothing about the limits the analyst loaded.

import { sideAt, type RangeLimits } from '../../series/range';
import { planeLength } from './kernels';
import type { InterfaceTable } from './types';

/** One contributing member: its sign in the group (±1) and its own limits. */
export interface SignedLimits {
  readonly sign: number;
  readonly limits: RangeLimits;
}

/** The `rangeLabel` noun for a divisor built here. */
export const SUMMED_LIMITS = 'summed limits';

/**
 * The group's hourly limits. A side NaN in every hour is omitted, so a group
 * none of whose members has a limit is `{}`, exactly as an unlimited path.
 * The members' hourly sides set the length and must agree; `hours` (the
 * table's plane length) is the length when every side is a constant.
 */
export function summedLimits(members: readonly SignedLimits[], hours: number): RangeLimits {
  if (members.length === 0) return {};
  let hourly = 0;
  for (const { limits } of members) {
    for (const side of [limits.upper, limits.lower]) {
      if (side === undefined || typeof side === 'number') continue;
      if (hourly !== 0 && side.length !== hourly) {
        throw new Error(`member limits of ${side.length} h and ${hourly} h in one group`);
      }
      hourly = side.length;
    }
  }
  if (hourly !== 0) hours = hourly;
  const upper = new Float32Array(hours);
  const lower = new Float32Array(hours);
  let anyUpper = false;
  let anyLower = false;
  for (let hour = 0; hour < hours; hour++) {
    let up = 0;
    let low = 0;
    for (const { sign, limits } of members) {
      const max = sideAt(limits.upper, hour);
      const min = sideAt(limits.lower, hour);
      // NaN propagates, which is the rule: one unlimited member, no sum.
      up += sign > 0 ? sign * max : sign * min;
      low += sign > 0 ? sign * min : sign * max;
    }
    upper[hour] = up;
    lower[hour] = low;
    if (!Number.isNaN(up)) anyUpper = true;
    if (!Number.isNaN(low)) anyLower = true;
  }
  return { ...(anyUpper ? { upper } : {}), ...(anyLower ? { lower } : {}) };
}

/**
 * A drawn boundary's limits: `summedLimits` over the members this table
 * carries with hours, which are the ones its sum took. `rangeOf` is one
 * path's limits in this table's Case and year, from the root.
 */
export function boundaryLimits(
  data: InterfaceTable,
  coefficients: ReadonlyMap<string | number, number>,
  rangeOf: (member: string) => RangeLimits,
): RangeLimits {
  const members: SignedLimits[] = [];
  for (let i = 0; i < data.interfaces.length; i++) {
    const sign = coefficients.get(data.interfaces[i]);
    if (sign !== undefined && data.presence[i] === 1) {
      members.push({ sign, limits: rangeOf(String(data.interfaces[i])) });
    }
  }
  return summedLimits(members, planeLength(data));
}
