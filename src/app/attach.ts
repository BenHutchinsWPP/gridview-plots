// src/app/attach.ts
//
// The ingest host's attach: where a finished table lands on its Case slot,
// joined to the table already there or replacing it, and where the inventory
// learns its files. A table whose years extend its Case is held until the
// drop settles, because the Case's other tables must state the same years;
// `settle` attaches a Case's held set whole or refuses it whole. Handed the
// store and the inventory, it holds only the drop's held extensions, which
// are settled or discarded before the drop ends.
//
// Nothing here writes a committed table, and a held fresh table is never
// written either: a merge builds new arrays (`src/tables/append.ts`).

import { spanOfTable, type YearSpan } from '../model/calendar';
import {
  caseForName,
  slotKey,
  type CaseStore,
  type TableKind,
  type TableSlotKey,
} from '../model/case-model';
import type { Inventory } from '../inventory/store';
import { cubeCost } from '../ingest';
import type { Appended } from '../tables/append';
import { appendNotes } from '../tables/append';
import type { appendSizeOf, appendTableOf } from '../tables/registry';
import type { AllocationAsk } from '../ui/confirm-allocation';
import type { AttachMode, AttachResult, IngestOutcome, SlotSpan, TableSource } from './batch';
import { judgeSpan, resultingSpan, settleRefusal, settleSpans } from './extend';
import type { ImportPlan } from './import-plan';

export interface TableAttachDeps {
  store: Pick<CaseStore, 'listCases' | 'attachTable'>;
  inventory: Pick<Inventory, 'recordTable'>;
  append: typeof appendTableOf;
  appendSize: typeof appendSizeOf;
  /** `true` to go ahead with a merge of that size. */
  confirmMerge(ask: AllocationAsk): Promise<boolean>;
  /** "SAMPLE_X's Generator table": how a refusal names a Case's table. */
  tableLabel(caseId: string, slot: TableSlotKey): string;
}

/** One extension waiting for its drop to end. `span` is what the table will
 * state once it lands; `table` is the fresh table, as the engine built it. */
interface Held {
  caseId: string;
  slot: TableSlotKey;
  table: unknown;
  sources: readonly TableSource[];
  mode: AttachMode;
  span: YearSpan;
}

const namesOf = (sources: readonly TableSource[]): string =>
  sources.map((source) => source.file.name).join(' and ');

export function createTableAttach(deps: TableAttachDeps) {
  const { store, inventory, confirmMerge, tableLabel } = deps;
  let queue: Held[] = [];
  let replacements: readonly ImportPlan[] = [];
  let originals = new Map<string, Set<string>>();

  const caseOf = (caseId: string) => store.listCases().find((entry) => entry.id === caseId);

  const occupant = (caseId: string, slot: TableSlotKey): unknown =>
    caseOf(caseId)?.tables.get(slotKey(slot))?.data;

  function replacing(caseId: string, slot: string): boolean {
    if (!originals.get(caseId)?.has(slot)) return false;
    return replacements.some(
      (plan) =>
        plan.caseName === caseOf(caseId)?.name &&
        (slot === slotKey(plan) ||
          (plan.shape === 'L' && plan.variant === undefined && slot.startsWith(`${plan.kind} `))),
    );
  }

  function spansOf(caseName: string): SlotSpan[] {
    const owner = caseForName(store.listCases(), caseName);
    return owner === undefined
      ? []
      : committedSpans(owner.id).filter((entry) => !replacing(owner.id, entry.slot));
  }

  function prepare(plans: readonly ImportPlan[]): void {
    replacements = plans.filter((plan) => plan.mode === 'replace');
    originals = new Map(store.listCases().map((owner) => [owner.id, new Set(owner.tables.keys())]));
  }

  /** The years the Case's committed tables state, outside `skip`. */
  function committedSpans(caseId: string, skip?: string): SlotSpan[] {
    const out: SlotSpan[] = [];
    for (const [key, entry] of caseOf(caseId)?.tables ?? []) {
      const span = spanOfTable(entry.data);
      if (span === null || key === skip) continue;
      out.push({ slot: key, span, holder: tableLabel(caseId, entry.key) });
    }
    return out;
  }

  /** Price a join, and refuse naming the cost when it is declined. */
  async function price(label: string, kind: TableKind, old: unknown, fresh: unknown) {
    const size = deps.appendSize(kind)(old, fresh);
    const first = size.factors[0];
    const cost = cubeCost(size.factors, size.numYears);
    const ok = await confirmMerge({
      what: `the merged ${label}`,
      cost,
      lever: `fewer ${first === undefined ? 'series' : first.many}`,
    });
    if (!ok) {
      throw new Error(
        `Joining the files to ${label} needs ${cost.arithmetic}, and it was not confirmed, ` +
          `so ${label} is kept as loaded.`,
      );
    }
  }

  const join = (kind: TableKind, old: unknown, fresh: unknown): Appended<unknown> =>
    deps.append(kind)(old, fresh);

  function commit(
    caseId: string,
    slot: TableSlotKey,
    table: unknown,
    sources: readonly TableSource[],
    merge: boolean,
  ): void {
    store.attachTable(caseId, slot, table, { replace: true });
    originals.get(caseId)?.delete(slotKey(slot));
    inventory.recordTable(caseId, slot, sources, { merge });
  }

  async function attach(
    caseId: string,
    slot: TableSlotKey,
    table: unknown,
    sources: readonly TableSource[],
    mode: AttachMode,
  ): Promise<AttachResult> {
    const key = slotKey(slot);
    const old = occupant(caseId, slot);
    const group = spanOfTable(table);
    if (group === null) throw new Error(`${namesOf(sources)}: the table states no years.`);
    const pending = queue
      .filter((entry) => entry.caseId === caseId && slotKey(entry.slot) === key)
      .at(-1);
    const slotSpan = pending?.span ?? (old === undefined ? null : spanOfTable(old));
    const committed = committedSpans(caseId, mode === 'replace' ? key : undefined);
    const others = committed.filter((entry) => !replacing(caseId, entry.slot));
    const verdict = judgeSpan(
      group,
      slotSpan,
      others[0] ?? null,
      mode,
      sources.map((source) => source.file.name),
    );
    if (!verdict.accept) throw new Error(verdict.note);
    // Planned replacements lend no old years. Hold their span changes until
    // the actual tables, including the long picker’s chosen slots, agree.
    const changesOthers = committed.some(
      (entry) => entry.span.firstYear !== group.firstYear || entry.span.numYears !== group.numYears,
    );
    if (
      verdict.extendsTo !== undefined ||
      pending !== undefined ||
      (mode === 'replace' && changesOthers)
    ) {
      queue.push({
        caseId,
        slot,
        table,
        sources,
        mode,
        span: resultingSpan(group, slotSpan, mode),
      });
      return { held: true, notes: [] };
    }
    const label = tableLabel(caseId, slot);
    if (mode === 'add' && old !== undefined) {
      await price(label, slot.kind, old, table);
      const joined = join(slot.kind, old, table);
      commit(caseId, slot, joined.table, sources, true);
      return { held: false, notes: appendNotes(namesOf(sources), label, joined) };
    }
    commit(caseId, slot, table, sources, false);
    return { held: false, notes: [] };
  }

  /** One Case's held set, all or nothing. Throws to refuse it. */
  async function settleCase(
    caseId: string,
    entries: readonly Held[],
  ): Promise<{ entry: Held; notes: string[] }[]> {
    const lastPerSlot = new Map(entries.map((entry) => [slotKey(entry.slot), entry]));
    const held = [...lastPerSlot.values()].map((entry) => ({
      slot: slotKey(entry.slot),
      span: entry.span,
      holder: tableLabel(caseId, entry.slot),
    }));
    const verdict = settleSpans(committedSpans(caseId), held);
    if (!verdict.accept) {
      throw new Error(
        settleRefusal(
          entries.map((entry) => namesOf(entry.sources)),
          verdict.target,
          verdict.differ,
        ),
      );
    }
    // Build all of them; a later slot may join an earlier held table.
    const built = new Map<string, unknown>();
    const done: { entry: Held; table: unknown; merge: boolean; notes: string[] }[] = [];
    for (const entry of entries) {
      const key = slotKey(entry.slot);
      const old = built.has(key) ? built.get(key) : occupant(caseId, entry.slot);
      if (entry.mode === 'add' && old !== undefined) {
        await price(tableLabel(caseId, entry.slot), entry.slot.kind, old, entry.table);
        const joined = join(entry.slot.kind, old, entry.table);
        built.set(key, joined.table);
        done.push({
          entry,
          table: joined.table,
          merge: true,
          notes: appendNotes(namesOf(entry.sources), tableLabel(caseId, entry.slot), joined),
        });
      } else {
        built.set(key, entry.table);
        done.push({ entry, table: entry.table, merge: false, notes: [] });
      }
    }
    for (const item of done) {
      commit(caseId, item.entry.slot, item.table, item.entry.sources, item.merge);
    }
    return done.map(({ entry, notes }) => ({ entry, notes }));
  }

  async function settle(): Promise<{ kind: TableKind; outcome: IngestOutcome }[]> {
    const outcomes = new Map<TableKind, IngestOutcome>();
    const outcomeOf = (kind: TableKind): IngestOutcome => {
      let outcome = outcomes.get(kind);
      if (outcome === undefined) {
        outcome = { failures: [], warnings: [] };
        outcomes.set(kind, outcome);
      }
      return outcome;
    };
    const byCase = new Map<string, Held[]>();
    for (const entry of queue) {
      byCase.set(entry.caseId, [...(byCase.get(entry.caseId) ?? []), entry]);
    }
    for (const [caseId, entries] of byCase) {
      try {
        for (const { entry, notes } of await settleCase(caseId, entries)) {
          const files = entry.sources.map((source) => source.file);
          outcomeOf(entry.slot.kind).warnings.push(...notes.map((note) => ({ files, note })));
          // A committed table with no notes still shows its kind.
          outcomeOf(entry.slot.kind);
        }
      } catch (error) {
        const note = error instanceof Error ? error.message : String(error);
        for (const entry of entries) {
          outcomeOf(entry.slot.kind).failures.push({
            files: entry.sources.map((source) => source.file),
            note,
          });
        }
      }
    }
    queue = [];
    return [...outcomes].map(([kind, outcome]) => ({ kind, outcome }));
  }

  function discard(): void {
    queue = [];
    replacements = [];
    originals.clear();
  }

  /** Held tables of `kind` rewritten (Area's axis moved under them). The
   * rewrite returns a new table; the held one is left as it was. */
  function reindexHeld(kind: TableKind, rewrite: (table: unknown) => unknown): void {
    queue = queue.map((entry) =>
      entry.slot.kind === kind ? { ...entry, table: rewrite(entry.table) } : entry,
    );
  }

  return { attach, settle, discard, reindexHeld, prepare, spansOf };
}
