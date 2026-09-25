// src/tables/interface/series.ts
//
// Interface's half of the series model: one `SeriesSpec` in, one drawn
// `CaseSeries` out, using this kind's axis and this kind's rules.
//
// This is the ONE place an interface line is built. Whatever draws it -- the
// section's picker today, the drawer's pins beside it, the four slots later --
// goes through here.
//
// What is this kind's own:
//
//   * **A grouped subject is a BOUNDARY, and only ever a hand-authored one.**
//     An arbitrary set of interfaces is still not a flow across anything --
//     two paths sharing a corridor double-count, two measured in opposite
//     directions cancel. What draws is a group somebody wrote down, naming
//     each member and the direction it counts in, and the sum is signed
//     (`src/tables/interface/groups.ts`). A `groupBy` this kind does not
//     recognise is refused rather than summed flat.
//   * **The frozen member set freezes MEMBERSHIP, not direction.** A narrowed
//     pin carries the names its stats were taken over, and the signs are read
//     from the map every time it draws. Reversing a member is not a change to
//     which paths a boundary holds, it is a change to what the boundary
//     MEANS, and every drawing of it follows.
//   * **"% of range" divides a path by its monthly limit** (`options.rangeOf`,
//     hour by hour), falling back to its own peak in a month with none, and a
//     group by its contributing members' limits summed in its directions
//     (`./limits.ts`). Only MW/MWh is divided by a limit; any other unit
//     divides by its own peak.

import { HOURS_PER_YEAR, buildCalendar, buildMask } from '../../model/calendar';
import {
  refusedSeries,
  type ResolveOptions,
  type SeriesBuffers,
  type SeriesSpec,
} from '../../series/model';
import type { Filters } from '../../model/types';
import type { CaseSeries } from '../../ui/charts';
import { applyMask, buildSeries, isAllZero, quantiles, stats } from './kernels';
import { reduceSignedMembers } from '../../lookups/reduce';
import { INTERFACE_GROUP_BY, boundaryCoefficients, membersOfGroup } from './groups';
import { isDirectional, isRated, spatialOf, spatialRefusal } from './rules';
import type { InterfaceTable } from './types';
import { PERCENT, normalizeToRange, rangeLabel } from '../../series/range';
import { SUMMED_LIMITS, boundaryLimits } from './limits';

export function resolveInterfaceSeries(
  spec: SeriesSpec,
  table: unknown,
  filters: Filters,
  buffers: SeriesBuffers,
  options: ResolveOptions,
): CaseSeries {
  const data = table as InterfaceTable;
  const unit = data.unit;

  const warnings: string[] = [];
  /** A group's members and signs, frozen set applied. */
  let coefficients: Map<string | number, number> | undefined;

  if (!('entity' in spec.subject)) {
    if (spec.subject.groupBy !== INTERFACE_GROUP_BY) {
      return refusedSeries(
        options,
        data.quantity,
        `There is no ${spec.subject.groupBy} figure to draw across interfaces: an arbitrary ` +
          'set of paths is not a boundary. Build a group, where each member states its ' +
          'direction.',
        buffers,
        unit,
      );
    }
    if (spatialOf(unit) === 'REFUSE') {
      const reason =
        spatialRefusal(data.quantity, unit) ??
        `"${data.quantity}" cannot be combined across interfaces.`;
      return refusedSeries(options, data.quantity, reason, buffers, unit);
    }

    const group = spec.subject.value;
    // The signs come from the MAP even for a frozen pin; the frozen set says
    // which members, and nothing else. See the header.
    const signs = boundaryCoefficients(group, spec.subject.members);
    coefficients = signs;
    const count = reduceSignedMembers(
      data.cube,
      data.presence,
      data.interfaces,
      signs,
      buffers.series,
    );
    if (count === 0) {
      return refusedSeries(
        options,
        data.quantity,
        `No path of group "${group}" is carried by ${options.tableLabel}.`,
        buffers,
        unit,
      );
    }
    const reversed = membersOfGroup(group).filter(
      (member) => member.direction === 'reversed' && signs.has(member.name),
    ).length;
    if (reversed > 0 && !isDirectional(unit)) {
      warnings.push(
        `"${data.quantity}" is not directional (${unit}), and ${reversed} member(s) of ` +
          `"${group}" are reversed, so they subtract. The group's directions are applied as ` +
          'written rather than silently ignored.',
      );
    }
  } else {
    const name = String(spec.subject.entity);
    const built = buildSeries(data, name, buffers.series, options.tableLabel);
    if (built.values === null) {
      const refused = refusedSeries(options, data.quantity, built.refusal ?? '', buffers, unit);
      return { ...refused, warnings: built.warnings };
    }
    warnings.push(...built.warnings);
  }

  buildMask(filters, buildCalendar(data.year), data.tou, buffers.mask);
  let rangeText: string | undefined;
  if (spec.perUnit) {
    const { rangeOf } = options;
    const { subject } = spec;
    const limits =
      !isRated(unit) || !rangeOf
        ? {}
        : 'entity' in subject
          ? rangeOf(String(subject.entity))
          : boundaryLimits(data, coefficients ?? new Map(), rangeOf);
    const use = normalizeToRange(buffers.series, limits, PERCENT, buffers.mask);
    rangeText = coefficients ? rangeLabel(use, SUMMED_LIMITS) : rangeLabel(use);
  }

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
  };
}
