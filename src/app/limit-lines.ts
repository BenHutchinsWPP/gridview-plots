// src/app/limit-lines.ts
//
// Which interface limits the app draws and says, read against the one limits
// store the root holds. A line is built from a DRAWN series, never from the
// store alone: no line, no limit, and the colour is the line's own. A kind
// receives limits as numbers (`interfaceRange`), never the store.

import { limitLinesFor, rangeLimitsOf, summedLimitLines } from '../limits/draw';
import type { LimitsStore } from '../limits/store';
import type { YearSpan } from '../model/calendar';
import type { TableRow } from '../model/case-model';
import type { RangeLimits } from '../series/range';
import { boundaryCoefficients, INTERFACE_GROUP_BY } from '../tables/interface/groups';
import { boundaryLimits } from '../tables/interface/limits';
import type { InterfaceTable } from '../tables/interface/types';
import type { CaseSeries, DrawnLimit } from '../ui/charts';

export interface LimitSource {
  limits: LimitsStore;
  interfaceRows(): TableRow<InterfaceTable>[];
  spanOfCase(caseId: string): YearSpan;
}

export function createLimitLines(source: LimitSource) {
  /** One path's hourly "% of range" limits in one Case, over `numYears`
   * from `year`. */
  function interfaceRange(
    caseId: string,
    interfaceName: string,
    year: number,
    numYears: number,
  ): RangeLimits {
    return rangeLimitsOf(source.limits.limitFor(caseId, interfaceName), year, numYears);
  }

  /** A path carries its published limits; a boundary its members' summed in
   * its directions. Each names its Case's first year, where a time axis
   * places it. */
  function limitLinesOf(entry: CaseSeries): DrawnLimit[] {
    const spec = entry.spec;
    if (spec === undefined || spec.source.kind !== 'interface') return [];
    const { caseId } = spec;
    const { firstYear, numYears } = source.spanOfCase(caseId);
    const placed = (lines: DrawnLimit[]) => lines.map((line) => ({ ...line, firstYear }));
    if (!('entity' in spec.subject)) {
      if (spec.subject.groupBy !== INTERFACE_GROUP_BY) return [];
      const row = source
        .interfaceRows()
        .find(
          (candidate) =>
            candidate.caseId === caseId && candidate.data.quantity === spec.source.quantity,
        );
      if (!row) return [];
      const limits = boundaryLimits(
        row.data,
        boundaryCoefficients(spec.subject.value, spec.subject.members),
        (member) => interfaceRange(caseId, member, firstYear, numYears),
      );
      return placed(
        summedLimitLines(limits, {
          label: entry.name,
          color: entry.color,
          unit: entry.unit,
          values: entry.values,
        }),
      );
    }
    return placed(
      limitLinesFor(source.limits, {
        caseId,
        interfaceName: String(spec.subject.entity),
        label: entry.name,
        color: entry.color,
        unit: entry.unit,
        year: firstYear,
        numYears,
        values: entry.values,
      }),
    );
  }

  return {
    interfaceRange,
    /** The dashed limit lines for what is on screen, from the drawn series. */
    limitLines(series: readonly CaseSeries[]): DrawnLimit[] {
      return series.flatMap((entry) =>
        limitLinesOf(entry).map((limit) => (entry.dashed ? { ...limit, preview: true } : limit)),
      );
    },
    /** How many of one Case's monitored interfaces the limits that apply to
     * it actually name. Silent when everything matched: a complete answer
     * needs no sentence, and a note per Case per drop would bury the ones
     * that matter. */
    limitMatchNotes(caseId: string, caseName: string): string[] {
      const names = new Set<string>();
      for (const row of source.interfaceRows()) {
        if (row.caseId !== caseId) continue;
        for (const name of row.data.interfaces) names.add(name);
      }
      if (names.size === 0) return [];
      const report = source.limits.matchReport(caseId, [...names]);
      if (report === null || report.matched === report.total) return [];
      return [
        `Case "${caseName}": ${report.matched.toLocaleString()} of ${report.total.toLocaleString()} ` +
          `monitored interface(s) were found in ${report.source}` +
          (report.matched === 0
            ? ` — no limits will be drawn for this Case. The path names in the limits file do not ` +
              `match the ones in its export.`
            : `; the rest will draw no limit.`),
      ];
    },
  };
}
