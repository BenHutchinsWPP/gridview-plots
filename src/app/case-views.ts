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
  caseLabel,
  rowsOfKind,
  slotLabel,
  type CaseStore,
  type TableRow,
} from '../model/case-model';
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

  /** A case's calendar year, for the box-plot partition: the first table that
   * states one (the Import Dialog keeps one run's tables to one year). */
  function yearOfCase(caseId: string): number {
    for (const slot of ownerOf(caseId)?.tables.values() ?? []) {
      const year = (slot.data as { year?: number } | null)?.year;
      if (typeof year === 'number') return year;
    }
    return NO_YEAR;
  }

  /** The loaded Cases' distinct years, ascending: only years a table states.
   * Not `yearOfCase`, whose fallback is a real year and would read as one. */
  function loadedYears(): number[] {
    const years = new Set<number>();
    for (const owner of store.listCases()) {
      for (const slot of owner.tables.values()) {
        const year = (slot.data as { year?: number } | null)?.year;
        if (typeof year === 'number') {
          years.add(year);
          break;
        }
      }
    }
    return [...years].sort((a, b) => a - b);
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
    yearOfCase,
    loadedYears,
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
