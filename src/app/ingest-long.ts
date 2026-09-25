// src/app/ingest-long.ts
//
// The two LONG batches: Area's, and the one bus and generator share. The
// per-file-failure rule (P1-P3) is stated in `src/app/batch.ts`.
//
// Shape L must SCAN the entity axis out of every row before anyone knows how
// wide the cube is; `readLongPlans` is that shared prelude. Past it the two
// diverge in type: a long Area file becomes ONE `AreaTable`, a bus or
// generator file one table PER metric (`T` vs `T[]`, down into `Finalize`).
//
// They also differ in axis (Area merges into the app-wide area axis; the
// others keep their own), in metric union (only Area has calculated
// columns), and in picker state (long bus/generator metric choices are held
// apart from the entity choice their wide files make).

import type { TableKind, TableSlotKey } from '../model/case-model';
import { createSectionState, type SectionState } from '../ui/section-state';
import type { CasePlan, LongKind } from '../tables/long/pool';
import type { LongSignature } from '../tables/long/signature';
import type { PlanWarning } from '../ingest';
import {
  commitAll,
  countKept,
  emptyOutcome,
  fileNote,
  groupByCase,
  groupFiles,
  groupMembers,
  refusalOf,
  warningsOf,
  type Drop,
  type IngestHost,
  type IngestOutcome,
} from './batch';

/**
 * The long reader's surface, as these batches use it.
 *
 * `src/tables/long/pool.ts` satisfies this. Every call that needs a signature
 * NAMES one; the reader has no default, which would let a batch that forgot
 * its kind parse a bus export as area with the wrong entity column.
 */
export interface LongReader {
  hasSimd(): boolean;
  NO_SIMD_MESSAGE: string;
  readCasePlan(file: File, sig: LongSignature): Promise<CasePlan>;
  discoverEntities(
    plans: CasePlan[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ ok: number[]; failures: PlanFailure[] }>;
}

/** A whole file's failure, by its index into the call's plans. */
interface PlanFailure {
  index: number;
  file: string;
  message: string;
}

/** Survivors of the header read and scan; `kept[i]` is `plans[i]`'s drop. */
interface LongPlans<D extends Drop> {
  plans: CasePlan[];
  kept: D[];
}

/**
 * The prelude: P1 (header read) and ONE entity scan over every surviving
 * file, so the axis sees all of them. Failures go on `outcome`.
 */
async function readLongPlans<D extends Drop>(
  reader: LongReader,
  host: IngestHost,
  drops: readonly D[],
  sig: LongSignature,
  noun: string,
  outcome: IngestOutcome,
): Promise<LongPlans<D>> {
  host.setBusy(`Reading ${drops.length} ${noun} header${drops.length === 1 ? '' : 's'}…`);
  // P1: an unparseable header drops that file, not the batch.
  let plans: CasePlan[] = [];
  let kept: D[] = [];
  for (const drop of drops) {
    try {
      plans.push(await reader.readCasePlan(drop.file, sig));
      kept.push(drop);
    } catch (error) {
      outcome.failures.push({
        files: [drop.file],
        note: fileNote(drop.file.name, error instanceof Error ? error.message : String(error)),
      });
    }
  }
  if (plans.length === 0) return { plans, kept };

  host.setBusy(`Reading the ${noun} axis…`);
  const scan = await reader.discoverEntities(plans, (done, total) => {
    host.setBusy(`Reading the ${noun} axis: block ${done} of ${total}…`);
  });
  pushFailures(outcome, scan.failures, kept);
  plans = scan.ok.map((index) => plans[index]);
  kept = scan.ok.map((index) => kept[index]);
  return { plans, kept };
}

/** P3: failures attributed through their plan index, never by filename. */
function pushFailures(
  outcome: IngestOutcome,
  failures: readonly PlanFailure[],
  kept: readonly Drop[],
): void {
  for (const failure of failures) {
    outcome.failures.push({
      files: [kept[failure.index].file],
      note: fileNote(failure.file, failure.message),
    });
  }
}

/** The outcome of a batch that threw, keeping every failure before the throw. */
function thrown(
  drops: readonly Drop[],
  outcome: IngestOutcome,
  attached: ReadonlySet<File>,
  error: unknown,
): IngestOutcome {
  outcome.refusal = refusalOf(
    drops,
    outcome,
    attached,
    error instanceof Error ? error.message : String(error),
  );
  return outcome;
}

interface LongResult<T> {
  cases: T[];
  ok: number[];
  warnings: PlanWarning[];
  failures: PlanFailure[];
}

/** What the Area long batch needs that no other kind does. */
export interface AreaLongBatch {
  reader: LongReader;
  sig: LongSignature;
  /** INCLUDING area's calculated columns. */
  union(plans: CasePlan[]): string[];
  /** The area axis: this batch's names merged into the one already loaded. */
  axis(plans: CasePlan[]): string[];
  /** Area's retain gate, or `null` when the user cancelled it. */
  retained(union: string[], fileCount: number, axisCount: number): Promise<string[] | null>;
  parse(
    plans: CasePlan[],
    retained: string[],
    axis: string[],
    onProgress: (done: number, total: number) => void,
    groupOf: number[],
  ): Promise<LongResult<unknown>>;
  /** Rebuild every already-loaded cube on the widened axis. ONCE per batch. */
  adoptAxis(axis: string[]): void;
  slot: TableSlotKey;
  refresh(): void;
}

/**
 * The Area long batch. Every batch-wide step runs ONCE. The axis is not
 * recomputed when a file fails later: its names leave harmless all-NaN
 * planes, while narrowing would reindex every loaded cube again. Do not "fix"
 * it.
 */
export function createAreaLongIngest(
  host: IngestHost,
  batch: AreaLongBatch,
): (drops: Drop[]) => Promise<IngestOutcome> {
  return async function ingestAreaFiles(drops: Drop[]): Promise<IngestOutcome> {
    /** Per-file failures in drop order, reported even if the batch throws. */
    const outcome = emptyOutcome();
    const attached = new Set<File>();
    if (!batch.reader.hasSimd()) {
      outcome.refusal = refusalOf(drops, outcome, attached, batch.reader.NO_SIMD_MESSAGE);
      return outcome;
    }
    try {
      const { plans, kept } = await readLongPlans(
        batch.reader,
        host,
        drops,
        batch.sig,
        'area',
        outcome,
      );
      if (plans.length === 0) return outcome;

      const axis = batch.axis(plans);
      // ONCE over the union: per file, the user would see N modals. `null`
      // means cancelled; other kinds' batches are unaffected.
      const retained = await batch.retained(batch.union(plans), plans.length, axis.length);
      if (retained === null) {
        outcome.stop = { files: kept.map((drop) => drop.file), notes: [] };
        return outcome;
      }

      // ONE dispatch; the parse cannot return while a worker awaits a reply.
      host.setBusy('Parsing…');
      const result = await batch.parse(
        plans,
        retained,
        axis,
        (done, total) => host.setBusy(`Parsing block ${done} of ${total}…`),
        groupByCase(kept),
      );
      pushFailures(outcome, result.failures, kept);

      // Skipped only when nothing committed.
      if (result.cases.length > 0) batch.adoptAxis(axis);

      // P2: only files with no failed block commit. `result.cases[i]` is
      // `plans[result.ok[i]]`'s table, the first member of its merge group.
      // A long Area file's picker chooses metrics, so that is what it counts.
      const keptMetrics = new Set(retained.map((name) => name.trim()));
      const commits = commitAll(result.cases, (table, index) => {
        const at = result.ok[index];
        const sources = groupMembers(kept, at).map((member) => ({
          file: kept[member].file,
          shape: 'L' as const,
          counts: countKept(plans[member].header.metricNames, keptMetrics, 'metrics'),
        }));
        host.attach(host.caseIdForName(kept[at].caseName), batch.slot, table, sources);
        for (const source of sources) attached.add(source.file);
      });
      for (const failure of commits) {
        outcome.failures.push({
          files: groupFiles(kept, result.ok[failure.index]),
          note: failure.message,
        });
      }
      batch.refresh();
      outcome.warnings = warningsOf(result.warnings, (index) => kept[index].file);
      return outcome;
    } catch (error) {
      return thrown(drops, outcome, attached, error);
    } finally {
      host.setBusy(null);
    }
  };
}

export interface EntityLongBatch {
  reader: LongReader;
  /** Open the metric picker; `null` when cancelled. A hook, not an import,
   * so this sequence runs without a DOM (`tests/test_ingest_batch.mjs`). */
  pickMetrics(request: {
    union: string[];
    noun: string;
    entityCount: number;
    fileCount: number;
    preselected: string[];
    /** The drop already answered: resolve the union without opening, after
     * pricing it. */
    everything: boolean;
  }): Promise<string[] | null>;
  /** Whether this drop chose "Load everything". A hook, not a field: it is a
   * fact about the drop in flight, and this descriptor is built at startup. */
  everything(): boolean;

  /** WITHOUT any kind's calculated columns. */
  union(plans: CasePlan[]): string[];
  /** This batch's own entity axis, never merged into the area axis. */
  axis(plans: CasePlan[]): string[];
  /** Tell this kind's metric state how many tables are loaded, so the
   * retained set is forgotten with the last table. */
  noteTablesChanged(state: SectionState): void;
  parse<T>(
    plans: CasePlan[],
    retained: string[],
    axis: string[],
    longKind: LongKind<T[]>,
    onProgress: (done: number, total: number) => void,
    groupOf: number[],
  ): Promise<LongResult<T[]>>;
  refresh(): void;
}

/**
 * The LONG bus and generator batch; nothing here asks which kind it is. One
 * file becomes one table per retained metric, keyed on its quantity. The
 * Import Dialog's `variant` is unused: a long export has no title line.
 */
export function createEntityLongIngest(
  host: IngestHost,
  batch: EntityLongBatch,
): <T extends { quantity?: string }>(
  drops: Drop[],
  kind: TableKind,
  longKind: LongKind<T[]>,
) => Promise<IngestOutcome> {
  /** The retained METRIC set per kind, held apart from the kind's retain
   * gate, which stores the ENTITY choice a wide drop makes. */
  const metricStates = new Map<TableKind, SectionState>();
  const stateFor = (kind: TableKind): SectionState => {
    const found = metricStates.get(kind);
    if (found) return found;
    const made = createSectionState(kind);
    metricStates.set(kind, made);
    return made;
  };

  return async function ingestLongFiles<T extends { quantity?: string }>(
    drops: Drop[],
    kind: TableKind,
    longKind: LongKind<T[]>,
  ): Promise<IngestOutcome> {
    const outcome = emptyOutcome();
    const attached = new Set<File>();
    if (!batch.reader.hasSimd()) {
      outcome.refusal = refusalOf(drops, outcome, attached, batch.reader.NO_SIMD_MESSAGE);
      return outcome;
    }
    const noun = longKind.sig.noun;
    try {
      const { plans, kept } = await readLongPlans(
        batch.reader,
        host,
        drops,
        longKind.sig,
        noun,
        outcome,
      );
      if (plans.length === 0) return outcome;

      const axis = batch.axis(plans);
      const union = batch.union(plans);
      const state = stateFor(kind);
      batch.noteTablesChanged(state);
      let retained = state.retainedColumns;
      // After the scan, since only then is the cube's width known. A drop
      // offering no new metric reuses the stored set. `everything` is tested
      // before `covers`, as in src/ui/retain-gate.ts: a covered "everything"
      // drop must still load the union. Either way the picker prices it.
      if (batch.everything() || !state.covers(union)) {
        const chosen = await batch.pickMetrics({
          union,
          noun,
          entityCount: axis.length,
          fileCount: plans.length,
          preselected: retained ?? [],
          everything: batch.everything(),
        });
        state.setRetained(chosen, union);
        // Cancelled: load nothing, never the whole metric set.
        if (chosen === null || chosen.length === 0) {
          outcome.stop = {
            files: kept.map((drop) => drop.file),
            notes: [
              `No ${noun} metric was selected, so no ${kind} table was loaded. Drop the file(s) ` +
                `again to choose.`,
            ],
          };
          return outcome;
        }
        retained = chosen;
      }

      host.setBusy(`Parsing ${noun}s…`);
      const result = await batch.parse<T>(
        plans,
        retained as string[],
        axis,
        longKind,
        (done, total) => host.setBusy(`Parsing ${noun} block ${done} of ${total}…`),
        groupByCase(kept),
      );
      pushFailures(outcome, result.failures, kept);

      // P2, flattened: tables attach one by one, so a refused slot costs only
      // that metric. Every metric table of one merge group has that group's
      // files behind it.
      // Every entity a long file's rows name is kept (the axis is their
      // union); its picker chose metrics, which are the slots.
      const attachments = result.cases.flatMap((tables, index) =>
        tables.map((table) => ({
          table,
          drop: kept[result.ok[index]],
          sources: groupMembers(kept, result.ok[index]).map((member) => ({
            file: kept[member].file,
            shape: 'L' as const,
            counts: countKept(plans[member].entities, null, 'entities'),
          })),
        })),
      );
      const commits = commitAll(attachments, ({ table, drop, sources }) => {
        const slot = { kind, variant: table.quantity };
        host.attach(host.caseIdForName(drop.caseName), slot, table, sources);
        for (const source of sources) attached.add(source.file);
      });
      for (const failure of commits) {
        outcome.failures.push({
          files: attachments[failure.index].sources.map((source) => source.file),
          note: failure.message,
        });
      }
      batch.refresh();
      outcome.warnings = warningsOf(result.warnings, (index) => kept[index].file);
      return outcome;
    } catch (error) {
      return thrown(drops, outcome, attached, error);
    } finally {
      host.setBusy(null);
    }
  };
}
