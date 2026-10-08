// src/app/case-views.ts
//
// What the rest of the app reads off the Case store: each kind's rows, the
// Case labels, the years the loaded tables state. Every call reads the store
// afresh rather than caching, because a stale copy is how a removed Case comes
// back in a chart. The root hands in its one store; this module holds nothing.

import type { CaseNames } from '../ui/browse-model';
import type { CaseChoice } from '../ui/browse-retarget';
import type { AreaTable } from '../tables/area/types';
import type { BusTable } from '../tables/bus/types';
import type { GeneratorTable } from '../tables/generator/types';
import type { InterfaceTable } from '../tables/interface/types';
import {
  byCaseName,
  caseForName,
  caseLabel,
  rowsOfKind,
  slotKey,
  slotLabel,
  type CaseStore,
  type TableRow,
  type TableSlotKey,
} from '../model/case-model';
import { spanOfTable, type YearSpan } from '../model/calendar';
import type { HeldSpan } from './batch';
import { NO_YEAR } from './boxes';

/** One loaded Area table together with the Case that owns it. */
export interface AreaCase {
  id: string;
  /** The Case's name -- a LABEL, never an identity. */
  name: string;
  /** The Case's own colour, fixed when it was made and looked up by id, so a
   * list sorted for display cannot recolour a single line. */
  color: string;
  data: AreaTable;
}

export type CaseViews = ReturnType<typeof createCaseViews>;

export function createCaseViews(store: CaseStore) {
  const ownerOf = (caseId: string) => store.listCases().find((entry) => entry.id === caseId);

  /** Every loaded Area table, by case name as a reader expects to find them.
   * Sorting here is safe because the colour travels ON the case. */
  function areaCases(): AreaCase[] {
    const byId = new Map(store.listCases().map((entry) => [entry.id, entry] as const));
    const out: AreaCase[] = [];
    for (const { caseId, data } of store.tablesOfKind('area')) {
      const owner = byId.get(caseId);
      if (owner)
        out.push({
          id: owner.id,
          name: caseLabel(owner),
          color: owner.color,
          data: data as AreaTable,
        });
    }
    return out.sort(byCaseName);
  }

  /** The first table's span that states one. Every table of a Case spans
   * the same years: an ingest batch refuses a file whose span differs from
   * its Case's before it attaches (`keepSpans` in `./batch.ts`, through
   * `heldSpan` below). */
  function statedSpan(owner: { tables: Map<string, { data: unknown }> }): YearSpan | null {
    for (const slot of owner.tables.values()) {
      const span = spanOfTable(slot.data);
      if (span !== null) return span;
    }
    return null;
  }

  /** The span the named Case's tables state outside `replacing`, and which
   * table states it. The Case is found as `caseIdForName` in `main.ts` finds
   * it, so the check reads the Case the table would attach to. */
  function heldSpan(caseName: string, replacing: readonly TableSlotKey[]): HeldSpan | null {
    const owner = caseForName(store.listCases(), caseName);
    if (owner === undefined) return null;
    const skip = new Set(replacing.map(slotKey));
    for (const [key, slot] of owner.tables) {
      if (skip.has(key)) continue;
      const span = spanOfTable(slot.data);
      if (span === null) continue;
      const kind = slot.key.kind.charAt(0).toUpperCase() + slot.key.kind.slice(1);
      const table = slot.key.variant ? `${kind} ${slot.key.variant}` : kind;
      return { span, holder: `${caseLabel(owner)}'s ${table} table` };
    }
    return null;
  }

  /** A Case's years, for the box-plot partition and every hour count. */
  function spanOfCase(caseId: string): YearSpan {
    const owner = ownerOf(caseId);
    return (owner && statedSpan(owner)) ?? { firstYear: NO_YEAR, numYears: 1 };
  }

  /** Every year of the loaded Cases' spans, distinct and ascending: only years
   * a table states. Not `spanOfCase`, whose fallback is a real year and would
   * read as one. */
  function loadedYears(): number[] {
    const years = new Set<number>();
    for (const owner of store.listCases()) {
      const span = statedSpan(owner);
      if (span === null) continue;
      for (let y = 0; y < span.numYears; y++) years.add(span.firstYear + y);
    }
    return [...years].sort((a, b) => a - b);
  }

  /** Each loaded Case's span, for the date strip's hour count. Only Cases
   * whose tables state one, as `loadedYears`. */
  function loadedSpans(): YearSpan[] {
    const spans: YearSpan[] = [];
    for (const owner of store.listCases()) {
      const span = statedSpan(owner);
      if (span !== null) spans.push(span);
    }
    return spans;
  }

  /** Case names both ways, for a frozen filter chosen in another Case. A Case
   * no longer loaded reads as its name. */
  const caseNames: CaseNames = {
    nameOf: (caseId) => ownerOf(caseId)?.name,
    labelOfName(name) {
      const owner = store.listCases().find((entry) => entry.name === name);
      return owner ? caseLabel(owner) : name;
    },
  };

  const views = {
    areaCases,
    /** One Area table per Case, so the Case's name alone names the row. */
    areaRows: (): TableRow<AreaTable>[] =>
      rowsOfKind<AreaTable>(store, 'area', (owner) => caseLabel(owner)),
    interfaceRows: (): TableRow<InterfaceTable>[] =>
      rowsOfKind<InterfaceTable>(store, 'interface', slotLabel),
    busRows: (): TableRow<BusTable>[] => rowsOfKind<BusTable>(store, 'bus', slotLabel),
    generatorRows: (): TableRow<GeneratorTable>[] =>
      rowsOfKind<GeneratorTable>(store, 'generator', slotLabel),
    /** Id -> the label to show for it, first loaded table wins. A name is a
     * label and may repeat; the id is the identity, so this is one-way only. */
    busNames(): Map<number, string> {
      const names = new Map<number, string>();
      for (const row of views.busRows()) {
        row.data.buses.forEach((id, index) => {
          if (!names.has(id)) names.set(id, row.data.names[index] ?? '');
        });
      }
      return names;
    },
    spanOfCase,
    heldSpan,
    loadedYears,
    loadedSpans,
    /** A Case's label by id. A Case already gone (a row outliving it) says so
     * rather than showing its id. */
    caseLabel(caseId: string): string {
      const owner = ownerOf(caseId);
      return owner ? caseLabel(owner) : 'a Case no longer loaded';
    },
    caseNames,
    /** Every loaded Case in load order, as the Selected tab's Case switch
     * offers it. */
    caseChoices: (): CaseChoice[] =>
      store
        .listCases()
        .map((entry) => ({ id: entry.id, name: entry.name, label: caseLabel(entry) })),
  };
  return views;
}
