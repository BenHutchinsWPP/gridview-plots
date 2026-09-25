// src/limits/store.ts
//
// The session's interface limits: one shared table, plus a table per Case.
// THE ONE RULE: a Case's own limits win; failing that, the shared ones;
// failing that, none. That fallback covers "many runs, one published file",
// "each run its own", and a mix, with no mode switch.
//
// Unlike reference lists (src/lookups/store.ts), a per-case limit describes
// ONE RUN, so it dies with its Case (`dropCaseLimits`); the shared half lives
// like a lookup. A second shared file REPLACES rather than merges, with an
// announcement: two limits files disagreeing is exactly what the analyst
// needs kept visible.

import type { InterfaceLimit, LimitTable } from './types';

/** What loading limits makes possible, one line, for the Contents panel. */
export const LIMITS_ENABLES = 'Interface % of range, and limit lines on interface charts';

/** Build the session's limits store. A factory, not a module-level `let`: the
 * composition root holds app state (AGENTS.md), and tests get a fresh store. */
export function createLimitsStore() {
  let shared: LimitTable | undefined;
  const byCase = new Map<string, LimitTable>();

  /** The shared table, for the envelope and the load note. */
  function sharedLimits(): LimitTable | undefined {
    return shared;
  }

  /** Every per-case table, keyed by synthetic Case id, never the editable
   * name. */
  function caseLimits(): ReadonlyMap<string, LimitTable> {
    return byCase;
  }

  /** True when anything is loaded (the limits toggle's default). */
  function hasLimits(): boolean {
    return shared !== undefined || byCase.size > 0;
  }

  /** Install the shared table; returns the source it replaced, or null, for
   * the caller to announce. */
  function setSharedLimits(table: LimitTable): string | null {
    const replaced = shared?.source ?? null;
    shared = table;
    return replaced;
  }

  /** Install one Case's table; returns the source it replaced, or null. */
  function setCaseLimits(caseId: string, table: LimitTable): string | null {
    const replaced = byCase.get(caseId)?.source ?? null;
    byCase.set(caseId, table);
    return replaced;
  }

  /** A per-case limit dies with its Case; the shared table is untouched. */
  function dropCaseLimits(caseId: string): void {
    byCase.delete(caseId);
  }

  /** The table that applies to one Case, by the fallback above. */
  function limitsForCase(caseId: string): LimitTable | undefined {
    return byCase.get(caseId) ?? shared;
  }

  /** One interface's limits in one Case, joined on TRIMMED name. A path with
   * no row draws nothing and says nothing per series; `matchReport` counts it
   * per file instead. */
  function limitFor(caseId: string, interfaceName: string): InterfaceLimit | undefined {
    return limitsForCase(caseId)?.byInterface.get(interfaceName.trim());
  }

  /** How many of a Case's interfaces the applicable table matches, so a file
   * matching nothing (names differing between exports) is one load sentence,
   * not a chart that silently draws no limits. */
  function matchReport(
    caseId: string,
    interfaceNames: readonly string[],
  ): { source: string; matched: number; total: number } | null {
    const table = limitsForCase(caseId);
    if (table === undefined) return null;
    let matched = 0;
    for (const name of interfaceNames) if (table.byInterface.has(name.trim())) matched++;
    return { source: table.source, matched, total: interfaceNames.length };
  }

  /** Restore from a bundle, replacing (not merging) the session's. */
  function adoptLimits(
    restoredShared: LimitTable | undefined,
    restoredByCase: Iterable<[string, LimitTable]>,
  ): void {
    shared = restoredShared;
    byCase.clear();
    for (const [caseId, table] of restoredByCase) byCase.set(caseId, table);
  }

  /** Tests, and `adoptRestoredCases` when a bundle carried no limits at all. */
  function clearLimits(): void {
    shared = undefined;
    byCase.clear();
  }

  return {
    sharedLimits,
    caseLimits,
    hasLimits,
    setSharedLimits,
    setCaseLimits,
    dropCaseLimits,
    limitsForCase,
    limitFor,
    matchReport,
    adoptLimits,
    clearLimits,
  };
}

export type LimitsStore = ReturnType<typeof createLimitsStore>;
