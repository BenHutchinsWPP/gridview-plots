// src/app/batch.ts
//
// What every ingest batch does regardless of shape: the vocabulary both
// engines (`ingest-wide.ts`, `ingest-long.ts`) share, and what they need from
// the composition root.
//
// **One file's failure costs that file.** Exactly three steps are per-file:
// P1 the header read, P2 the commit, P3 the error attribution. Everything else
// runs ONCE over the survivors. A batch-wide step moved into a per-file loop
// is a defect: the entity union would differ per file, pickers would ask N
// times and drop later columns, and N dispatches on one pool could let a
// stale reply land in the wrong cube.

import type { TableSlotKey } from '../model/case-model';
import type { PlanWarning } from '../ingest';

/** One dropped table file as the Import Dialog left it: its Case name and slot
 * variant (possibly undefined). Nothing downstream re-derives either. */
export interface Drop {
  file: File;
  caseName: string;
  variant?: string;
}

/** What an engine needs from the composition root, passed in at wiring time
 * so an engine never reaches into app state. */
export interface IngestHost {
  /** Show (or clear, on `null`) the progress line. */
  setBusy(message: string | null): void;
  /** The Case a dialog-assigned name points at, created on first use. */
  caseIdForName(name: string): string;
  /** Attach a table to a Case slot, REPLACING any occupant: the dialog already
   * warned the user, and a throw would silently drop every later table.
   * `sources` are the files the table was built from: every member of its
   * merge group, in drop order. This is the only place a table's files are
   * known, so it is where the root records them; axis widening re-attaches
   * through the Case store directly and must not record again. */
  attach(caseId: string, slot: TableSlotKey, table: unknown, sources: readonly TableSource[]): void;
}

/** What a file's own header or scan offered, and how much of it the batch
 * kept. Measured once, at ingest: a later drop that widens the shared axis
 * changes the table, not what this file carried. */
export interface SourceCounts {
  /** What was counted: the picker's axis. Metrics for a long Area file,
   * entities for every wide file and for a long bus or generator file. */
  of: 'metrics' | 'entities';
  kept: number;
  inSource: number;
}

/** One file behind a table: the shape it was read as, and its counts. */
export interface TableSource {
  file: File;
  shape: 'W' | 'L';
  counts: SourceCounts;
}

/** How many of `offered` (trimmed, distinct, non-empty) are in `kept`. */
export function countKept(
  offered: readonly string[],
  kept: ReadonlySet<string> | null,
  of: SourceCounts['of'],
): SourceCounts {
  const names = new Set(offered.map((name) => name.trim()).filter((name) => name !== ''));
  let count = 0;
  for (const name of names) if (kept === null || kept.has(name)) count++;
  return { of, kept: count, inSource: names.size };
}

/**
 * What one engine run did, structured so the root can say which file each
 * note is about without reading filenames back out of the text.
 *
 * Field order is the order `outcomeNotes` renders them in.
 */
export interface IngestOutcome {
  /** Files turned away, each note with the files it cost: one file, or every
   * member of a merge group whose table could not be attached. */
  failures: { files: File[]; note: string }[];
  /** The user stopped the batch (a picker cancelled or emptied): nothing past
   * the header read loaded, and none of it was refused. `notes` may be empty
   * when the user's own click already said it. */
  stop?: { files: File[]; notes: string[] };
  /** The whole batch was refused (no SIMD, or a throw), after any per-file
   * failures. `files` are the drops that neither failed alone nor attached. */
  refusal?: { files: File[]; note: string };
  /** Notes about what loaded. `files` names the members a note concerns;
   * empty is batch-level (a retention note, a merge summary with no file). */
  warnings: { files: File[]; note: string }[];
}

/** An outcome with nothing in it. */
export function emptyOutcome(): IngestOutcome {
  return { failures: [], warnings: [] };
}

/** The notes the user reads: failures, a stop, a refusal, then warnings. */
export function outcomeNotes(outcome: IngestOutcome): string[] {
  return [
    ...outcome.failures.map((failure) => failure.note),
    ...(outcome.stop?.notes ?? []),
    ...(outcome.refusal === undefined ? [] : [outcome.refusal.note]),
    ...outcome.warnings.map((warning) => warning.note),
  ];
}

/** Pool warnings attributed to the files behind their plan indices. */
export function warningsOf(
  warnings: readonly PlanWarning[],
  fileOf: (planIndex: number) => File,
): IngestOutcome['warnings'] {
  return warnings.map((warning) => ({ files: warning.plans.map(fileOf), note: warning.message }));
}

/** The indexes of the drops that share `drops[index]`'s merge group, in drop
 * order: the files one committed table was built from. */
export function groupMembers(drops: readonly Drop[], index: number): number[] {
  const groupOf = groupByCase(drops);
  return groupOf.flatMap((group, i) => (group === groupOf[index] ? [i] : []));
}

/** `groupMembers`, as files. */
export function groupFiles(drops: readonly Drop[], index: number): File[] {
  return groupMembers(drops, index).map((i) => drops[i].file);
}

/** A batch refused whole: every drop not already failed or attached. */
export function refusalOf(
  drops: readonly Drop[],
  outcome: IngestOutcome,
  attached: ReadonlySet<File>,
  note: string,
): IngestOutcome['refusal'] {
  const failed = new Set(outcome.failures.flatMap((failure) => failure.files));
  return {
    files: drops
      .map((drop) => drop.file)
      .filter((file) => !failed.has(file) && !attached.has(file)),
    note,
  };
}

/** A note about one file, without repeating a filename the message already
 * opens with. */
export function fileNote(name: string, message: string): string {
  return message.startsWith(`${name}:`) ? message : `${name}: ${message}`;
}

/** Attach every finished table, letting one failure cost only its own file
 * (a bare loop's first throw would drop every later table silently). Returns
 * the index of each table that threw, with its message. */
export function commitAll<T>(
  tables: readonly T[],
  attach: (table: T, index: number) => void,
): { index: number; message: string }[] {
  const failures: { index: number; message: string }[] = [];
  tables.forEach((table, index) => {
    try {
      attach(table, index);
    } catch (error) {
      failures.push({ index, message: error instanceof Error ? error.message : String(error) });
    }
  });
  return failures;
}

/**
 * One group id per file: files the user gave the same study name AND slot
 * variant share one table (two halves of a year become a year). Never
 * inferred from filenames. The variant keeps Power Flow and Congestion Cost
 * of one Case apart.
 */
export function groupByCase(drops: readonly Drop[]): number[] {
  const ids = new Map<string, number>();
  return drops.map((drop) => {
    // NUL-separated: both halves are free text, and a collision would weld
    // two studies onto one cube.
    const key = `${drop.caseName}\u0000${drop.variant ?? ''}`;
    const seen = ids.get(key);
    if (seen !== undefined) return seen;
    ids.set(key, ids.size);
    return ids.size - 1;
  });
}
