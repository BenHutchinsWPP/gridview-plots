// src/app/browse-scope.ts
//
// What each browse tab is scoped to: one variable's rows, for the given
// cases, under the hour filter. The same arithmetic for every kind, generic
// over the kind's row type so this module never learns what it holds.

import {
  buildCalendar,
  buildMask,
  DAY_NAMES,
  HOURS_PER_YEAR,
  MONTH_NAMES,
} from '../model/calendar';
import type { Filters } from '../model/types';

/** What every kind's row already is, and all this scoping needs. */
export interface BrowseKindRow {
  key: string;
  caseId: string;
  slotKey: string;
  data: { quantity?: string; metrics?: string[]; year: number; tou: Uint8Array };
}
/** What a Case is called, by id, at scope time. */
export interface ScopedCase {
  /** The key a by-Case bucket's group value (and so a pin's row id) uses. */
  readonly name: string;
  /** What every cell and label shows (`caseLabel`). */
  readonly label: string;
}

/** One (case, slot) table a tab lists. */
export interface ScopedTable<D> {
  caseId: string;
  caseName: string;
  caseLabel: string;
  slotKey: string;
  data: D;
  mask: Uint8Array;
}

/** One kind's scope: the quantities it has loaded, the one its tab is showing,
 * and the (case, slot) tables that survive both. */
export interface BrowseScope<D> {
  variables: string[];
  /** Loaded quantities `offers` refused, so the tab can say why they are
   * missing. */
  withheld: string[];
  variable: string;
  tables: ScopedTable<D>[];
  /** Everything a rebuilt tab reads; sorts, filters and tab switches move
   * none of it. */
  signature: string;
}

/**
 * A stable number per OBJECT, for the rebuild signature. A slot key outlives
 * its table (a re-drop replaces the table under the same key), so a
 * signature of keys alone would keep ranking the old file. WeakMap, so
 * replaced tables are still collected.
 */
const identities = new WeakMap<object, number>();
let nextIdentity = 0;
export function identityOf(value: object): number {
  let id = identities.get(value);
  if (id === undefined) {
    id = ++nextIdentity;
    identities.set(value, id);
  }
  return id;
}

/** The hour filters as a stable string, for the rebuild signature. */
function filtersKey(filters: Filters): string {
  const part = (set: ReadonlySet<number | string> | null): string =>
    set === null ? '*' : [...set].map(String).sort().join('+');
  return [
    part(filters.months),
    part(filters.daysOfMonth),
    part(filters.hoursOfDay),
    part(filters.daysOfWeek),
    part(filters.seasons),
    part(filters.tou),
  ].join('/');
}

/**
 * The hour filters as a sentence for the CSV descriptor, in the rail's
 * vocabulary, hours hour-ending. No constraint reads "all hours": that is a
 * fact about every number in the file.
 */
export function filtersLabel(filters: Filters): string {
  const numbers = (set: ReadonlySet<number> | null): string =>
    set === null ? '' : [...set].sort((a, b) => a - b).join(', ');
  const words = (set: ReadonlySet<string> | null): string =>
    set === null ? '' : [...set].sort().join(', ');
  const parts: string[] = [];
  const months = filters.months && [...filters.months].sort((a, b) => a - b);
  if (months) parts.push(`Month: ${months.map((m) => MONTH_NAMES[m - 1] ?? m).join(', ')}`);
  const dom = numbers(filters.daysOfMonth);
  if (dom) parts.push(`Day of Month: ${dom}`);
  const hours = numbers(filters.hoursOfDay);
  if (hours) parts.push(`Hour (HE): ${hours}`);
  const days = filters.daysOfWeek && [...filters.daysOfWeek].sort((a, b) => a - b);
  if (days) parts.push(`Day: ${days.map((d) => DAY_NAMES[d] ?? d).join(', ')}`);
  const seasons = words(filters.seasons);
  if (seasons) parts.push(`Season: ${seasons}`);
  const tou = words(filters.tou);
  if (tou) parts.push(`TOU: ${tou}`);
  return parts.length === 0 ? 'all hours' : parts.join(' · ');
}

export interface BrowseScopes {
  /**
   * One kind's scope; narrows only, touches no plane. `pairedWith` names the
   * tab whose variable this one FOLLOWS when its own no longer applies (an
   * entity tab and its groups tab show one variable). `offers` restricts what
   * the tab lists and its dropdown shows, given the scoped tables carrying
   * the quantity (Area's weighted mean needs its weight). Both are the
   * caller's, since only the kind knows what a quantity means.
   */
  scope<T extends BrowseKindRow>(
    rows: readonly T[],
    kind: string,
    cases: readonly string[],
    filters: Filters,
    caseNames: ReadonlyMap<string, ScopedCase>,
    pairedWith?: string,
    offers?: (variable: string, holders: readonly T['data'][]) => boolean,
  ): BrowseScope<T['data']>;
  set(kind: string, variable: string): void;
  /** Whether this kind's last scope offered `variable`, without re-running the
   * predicate. An unscoped kind refuses nothing. */
  offered(kind: string, variable: string): boolean;
}

/**
 * Per-kind variable memory and the scoping over it. The variable is
 * remembered PER KIND, so switching tabs never re-points another kind's
 * quantity. Masks are memoised per table OBJECT (WeakMap): restores and
 * re-drops replace tables, and a key-string memo would leak every mask.
 */
export function createBrowseScopes(): BrowseScopes {
  const variables = new Map<string, string>();
  const offeredByKind = new Map<string, readonly string[]>();
  const masks = new WeakMap<object, Uint8Array>();

  return {
    set: (kind, variable) => {
      variables.set(kind, variable);
    },

    offered: (kind, variable) => offeredByKind.get(kind)?.includes(variable) ?? true,

    scope(rows, kind, cases, filters, caseNames, pairedWith, offers) {
      const varsOf = (row: (typeof rows)[number]) =>
        row.data.metrics ? row.data.metrics : row.data.quantity ? [row.data.quantity] : [];

      // Variables come from the rows HANDED in: a remembered variable they no
      // longer carry must drop out, or the scope comes back empty silently.
      const enabled = new Set(cases);
      const enabledRows = rows.filter((row) => enabled.has(row.key) || enabled.has(row.caseId));
      const all = [...new Set(enabledRows.flatMap(varsOf))].sort();
      const holdersOf = (variable: string) =>
        enabledRows.filter((row) => varsOf(row).includes(variable)).map((row) => row.data);
      const offered = offers
        ? all.filter((variable) => offers(variable, holdersOf(variable)))
        : all;
      const withheld = all.filter((variable) => !offered.includes(variable));
      offeredByKind.set(kind, offered);

      let variable = variables.get(kind) ?? '';
      if (!offered.includes(variable)) {
        const paired = pairedWith === undefined ? undefined : variables.get(pairedWith);
        variable = paired !== undefined && offered.includes(paired) ? paired : (offered[0] ?? '');
        variables.set(kind, variable);
      }

      // One variable at a time, so a stat column means one unit.
      const scoped = enabledRows.filter((row) =>
        row.data.metrics ? row.data.metrics.includes(variable) : row.data.quantity === variable,
      );

      const tables = scoped.map((row) => {
        let mask = masks.get(row.data);
        if (!mask) {
          mask = new Uint8Array(HOURS_PER_YEAR);
          masks.set(row.data, mask);
        }
        buildMask(filters, buildCalendar(row.data.year), row.data.tou, mask);
        const named = caseNames.get(row.caseId);
        return {
          caseId: row.caseId,
          caseName: named?.name ?? row.caseId,
          caseLabel: named?.label ?? row.caseId,
          slotKey: row.slotKey,
          data: row.data,
          mask,
        };
      });

      return {
        variables: offered,
        withheld,
        variable,
        tables,
        // Each table's key, object and Case name and label: a build reads all.
        signature: [
          variable,
          tables
            .map(
              (table, i) =>
                `${scoped[i].key}#${identityOf(table.data)}#${table.caseName}#${table.caseLabel}`,
            )
            .join('\u0001'),
          filtersKey(filters),
          withheld.join('\u0001'),
        ].join(' / '),
      };
    },
  };
}
