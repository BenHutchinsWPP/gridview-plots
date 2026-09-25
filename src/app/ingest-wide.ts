// src/app/ingest-wide.ts
//
// One wide batch, for any kind: read a case plan per file, ask the kind which
// entities to build on, issue ONE dispatch, attribute failures by index,
// commit the survivors. One sequence, so no kind's copy can quietly drop a
// step.
//
// **This module never learns which kind it is running.** It takes a reader, a
// noun for messages, and three callbacks (entity set, post-parse adoption,
// slot). The per-file-failure rule (P1-P3) is stated in `./batch.ts`.

import type { TableSlotKey } from '../model/case-model';
import type { CasePlan, IngestResult } from '../tables/wide/pool';
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
 * The surface each kind's wide module exposes: numbers and bytes, no kind
 * token. `unionOf` and `coverageOf` stay out, so this engine can never reach
 * a header and start interpreting one.
 */
export interface WideReader<T> {
  hasSimd(): boolean;
  NO_SIMD_MESSAGE: string;
  readCasePlan(file: File): Promise<CasePlan>;
  ingest(
    plans: CasePlan[],
    retained: string[],
    onProgress?: (done: number, total: number) => void,
    groupOf?: number[],
  ): Promise<IngestResult<T>>;
}

/**
 * A kind's answer to "which entities?": `entities` (never empty) builds on
 * them; `stop` loads nothing and says exactly these notes (empty for a
 * cancelled picker). A cancelled picker never falls back to the whole axis:
 * that is the allocation the pickers exist to prevent.
 */
export type WideEntities = { entities: string[]; stop?: undefined } | { stop: string[] };

/** One kind's wide batch: its reader, its nouns, and its three decisions. */
export interface WideBatch<T, D extends Drop> {
  reader: WideReader<T>;
  /** Singular, for "Reading 3 bus headers…" and "Parsing bus block 2 of 9…". */
  noun: string;
  /** Plural, for "Parsing buses…". Irregular plurals are held, not derived. */
  plural: string;
  /** Which entities the cubes are built on, over the plans that survived P1. */
  entities(plans: CasePlan[]): Promise<WideEntities>;
  /** Run ONCE after the parse, only when something committed. Area widens the
   * shared axis and reindexes loaded cubes here. */
  adopt?(entities: string[]): void;
  /** The slot one finished table lands on, from its own drop. */
  slot(drop: D): TableSlotKey;
  /** Called once after the commit. */
  refresh(): void;
}

export type RunWideBatch = <T, D extends Drop>(
  batch: WideBatch<T, D>,
  drops: D[],
) => Promise<IngestOutcome>;

/** Build the runner. Returns its outcome rather than writing notes, so one
 * kind cannot overwrite another's account of the same drop. */
export function createWideIngest(host: IngestHost): RunWideBatch {
  return async function run<T, D extends Drop>(
    batch: WideBatch<T, D>,
    drops: D[],
  ): Promise<IngestOutcome> {
    /** Per-file failures in drop order, reported even if the batch throws. */
    const outcome = emptyOutcome();
    const attached = new Set<File>();
    if (!batch.reader.hasSimd()) {
      outcome.refusal = refusalOf(drops, outcome, attached, batch.reader.NO_SIMD_MESSAGE);
      return outcome;
    }
    try {
      const plural = drops.length === 1 ? '' : 's';
      host.setBusy(`Reading ${drops.length} ${batch.noun} header${plural}…`);
      // P1.
      const plans: CasePlan[] = [];
      const kept: D[] = [];
      for (const drop of drops) {
        try {
          plans.push(await batch.reader.readCasePlan(drop.file));
          kept.push(drop);
        } catch (error) {
          outcome.failures.push({
            files: [drop.file],
            note: fileNote(drop.file.name, error instanceof Error ? error.message : String(error)),
          });
        }
      }
      if (plans.length === 0) return outcome;

      const answer = await batch.entities(plans);
      if (answer.stop !== undefined) {
        outcome.stop = { files: kept.map((drop) => drop.file), notes: answer.stop };
        return outcome;
      }
      const entities = answer.entities;

      // ONE dispatch; `ingest` cannot return while a worker awaits a reply.
      // Files given one study name (the Import Dialog's answer, never a
      // filename guess) are read into one table.
      host.setBusy(`Parsing ${batch.plural}…`);
      const result = await batch.reader.ingest(
        plans,
        entities,
        (done, total) => {
          host.setBusy(`Parsing ${batch.noun} block ${done} of ${total}…`);
        },
        groupByCase(kept),
      );
      // P3: `index` is the plan's, and `kept[i]` is `plans[i]`'s drop.
      for (const failure of result.failures) {
        outcome.failures.push({
          files: [kept[failure.index].file],
          note: fileNote(failure.file, failure.message),
        });
      }

      if (result.cases.length > 0) batch.adopt?.(entities);

      // P2. `result.cases[i]` came from `plans[result.ok[i]]`, the first
      // member of its merge group; the table's sources are the whole group.
      const retained = new Set(entities.map((name) => name.trim()));
      const commits = commitAll(result.cases, (table, index) => {
        const at = result.ok[index];
        const drop = kept[at];
        const sources = groupMembers(kept, at).map((member) => ({
          file: kept[member].file,
          shape: 'W' as const,
          counts: countKept(plans[member].header.entityNames, retained, 'entities'),
        }));
        host.attach(host.caseIdForName(drop.caseName), batch.slot(drop), table, sources);
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
      outcome.refusal = refusalOf(
        drops,
        outcome,
        attached,
        error instanceof Error ? error.message : String(error),
      );
      return outcome;
    } finally {
      host.setBusy(null);
    }
  };
}
