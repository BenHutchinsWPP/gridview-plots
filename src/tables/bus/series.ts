// src/tables/bus/series.ts
//
// Bus's half of the series model, the ONE place a bus line is built.
//
//   * **The subject is an id** (`BusNumber`); anything else is refused rather
//     than coerced, since a name may repeat.
//   * **A grouped subject is one of three:** a `CASE_GROUP_BY` bucket (every
//     bus the table carries), a `BUS_GROUP_BY` authored membership, or a
//     BusList column's label. The first two join no lookup column.
//   * **A frozen bus-group membership is a set of IDS**, not names, for the
//     same reason.
//   * **"% of range" divides by the line's own peak/trough**, in any unit: a
//     bus has no limit. An LMP in $/MWh is normalized, not refused.

import { HOURS_PER_YEAR, buildCalendar, buildMask } from '../../model/calendar';
import {
  CASE_GROUP_BY,
  refusedSeries,
  type ResolveOptions,
  type SeriesBuffers,
  type SeriesSpec,
} from '../../series/model';
import type { Filters } from '../../model/types';
import type { CaseSeries } from '../../ui/charts';
import { applyMask, buildSeries, busIndex, isAllZero, quantiles, stats } from './kernels';
import { spatialOf, spatialRefusal, unitOf } from './rules';
import { lookupFor } from '../../lookups/store';
import { reduceMembers, reduceSingleBucket } from '../../lookups/reduce';
import { BUS_GROUP_BY, busesInGroup } from './groups';
import type { BusTable } from './types';
import { PERCENT, normalizeToRange, rangeLabel } from '../../series/range';

/** Id -> cube index per TABLE OBJECT: a re-ingested slot is a new object, so
 * a stale index cannot survive a re-import. */
/** What this kind's group members are called when counted (`14 buses`). */
export const MEMBER_NOUN = { one: 'bus', many: 'buses' };

const indexes = new WeakMap<BusTable, Map<number, number>>();

function busIndexOf(data: BusTable): Map<number, number> {
  let index = indexes.get(data);
  if (!index) {
    index = busIndex(data);
    indexes.set(data, index);
  }
  return index;
}

export function resolveBusSeries(
  spec: SeriesSpec,
  table: unknown,
  filters: Filters,
  buffers: SeriesBuffers,
  options: ResolveOptions,
): CaseSeries {
  const data = table as BusTable;
  const unit = unitOf(data.quantity);

  let warnings: string[] = [];
  // The buses a grouped line summed, for `checkStackOverlap`, which cannot
  // ask this kind what a Bus Group holds. See Generator's resolver.
  const summed: (string | number)[] | undefined = 'entity' in spec.subject ? undefined : [];

  if (!('entity' in spec.subject)) {
    if (spatialOf(unit) === 'REFUSE') {
      const reason =
        spatialRefusal(data.quantity, unit) ??
        `"${data.quantity}" cannot be combined across buses.`;
      return refusedSeries(options, data.quantity, reason, buffers, unit);
    }
    // A frozen member set is the pin's truth and the map's current
    // membership is only the fallback -- the same rule Generator's resolver
    // draws a user-authored group by. Ids, not names: see the header.
    const members =
      spec.subject.members !== undefined
        ? new Set<string | number>(spec.subject.members.map(Number))
        : undefined;

    const groupValue = spec.subject.value;
    if (spec.subject.groupBy === CASE_GROUP_BY) {
      // Every bus: a constant label makes each bus match, and the frozen
      // member set still narrows it. Avoids a fifth accumulate loop.
      const count = reduceSingleBucket(
        data.cube,
        data.presence,
        data.buses,
        undefined,
        CASE_GROUP_BY,
        groupValue,
        buffers.series,
        members,
        () => groupValue,
        summed,
      );
      if (count === 0) {
        return refusedSeries(
          options,
          data.quantity,
          `${options.tableLabel} carries no bus for "${groupValue}".`,
          buffers,
          unit,
        );
      }
    } else if (spec.subject.groupBy === BUS_GROUP_BY) {
      const ids = members ?? new Set<string | number>(busesInGroup(spec.subject.value));
      const count = reduceMembers(
        data.cube,
        data.presence,
        data.buses,
        ids,
        buffers.series,
        summed,
      );
      if (count === 0) {
        return refusedSeries(
          options,
          data.quantity,
          `No bus of group "${spec.subject.value}" is carried by ${options.tableLabel}.`,
          buffers,
          unit,
        );
      }
    } else {
      const lookup = lookupFor('buslist');
      if (!lookup) {
        return refusedSeries(
          options,
          data.quantity,
          `Grouping buses by ${spec.subject.groupBy} needs BusList.csv to be loaded.`,
          buffers,
          unit,
        );
      }
      const count = reduceSingleBucket(
        data.cube,
        data.presence,
        data.buses,
        lookup,
        spec.subject.groupBy,
        spec.subject.value,
        buffers.series,
        members,
        undefined,
        summed,
      );
      if (count === 0) {
        return refusedSeries(
          options,
          data.quantity,
          `No buses in ${options.tableLabel} match ${spec.subject.groupBy} = "${spec.subject.value}".`,
          buffers,
          unit,
        );
      }
    }
  } else {
    // The id, never a name. A spec whose subject is text names a bus this kind
    // cannot identify -- possibly two of them -- so it is refused by name.
    const busId = Number(spec.subject.entity);
    if (!Number.isInteger(busId)) {
      return refusedSeries(
        options,
        data.quantity,
        `"${String(spec.subject.entity)}" is not a bus number. A bus name is a label and may ` +
          'repeat, so the BusNumber is the only thing that identifies one.',
        buffers,
        unit,
      );
    }

    const built = buildSeries(data, busId, busIndexOf(data), buffers.series, options.tableLabel);
    if (built.values === null) {
      const refused = refusedSeries(options, data.quantity, built.refusal ?? '', buffers, unit);
      return { ...refused, warnings: built.warnings };
    }
    warnings = built.warnings;
  }

  buildMask(filters, buildCalendar(data.year), data.tou, buffers.mask);
  // Taken after a group is summed: the peak of the sum, not of its members.
  const rangeText = spec.perUnit
    ? rangeLabel(normalizeToRange(buffers.series, {}, PERCENT, buffers.mask))
    : undefined;

  for (let hour = 0; hour < HOURS_PER_YEAR; hour++) {
    buffers.display[hour] = buffers.mask[hour] === 1 ? buffers.series[hour] : NaN;
  }

  const n = applyMask(buffers.series, buffers.mask, buffers.gathered);
  const summary = stats(buffers.gathered, n);
  const allZero = isAllZero(buffers.gathered, n);
  const spread = quantiles(buffers.gathered, n);
  return {
    name: options.name,
    detail: options.detail,
    color: options.color,
    dashed: options.dashed,
    unit: rangeText ? '%' : unit,
    quantity: data.quantity,
    values: buffers.display,
    warnings,
    sorted: buffers.gathered,
    n,
    stats: summary,
    quantiles: spread,
    allZero,
    ...(rangeText ? { rangeLabel: rangeText } : {}),
    summed,
  };
}
