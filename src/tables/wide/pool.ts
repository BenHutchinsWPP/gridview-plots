// src/tables/wide/pool.ts
//
// Worker pool, file dispatch and cube assembly for the WIDE SHAPE. A kind
// supplies a `WideSpec` (numbers plus a noun) and a `finalize` callback; this
// module never learns which kind it reads (AGENTS.md, "Kind is not shape").
//
// The unit of work is a BYTE RANGE, not a case, so one dropped file uses every
// core and ten files queue into the same pool.
//
// Two things here are load-bearing for correctness:
//
//   * The cube is pre-filled with NaN, so "never written" reads as no data.
//     Zeros would turn a truncated file into plausible zero hours.
//   * Block size comes from the file's own row length and width, so a block
//     never holds more rows than the slab the parser was configured with.

import { HOURS_PER_YEAR } from '../../model/calendar';
import {
  dispatch,
  hasSimd,
  NO_SIMD_MESSAGE,
  partitionByFailure,
  poolSize,
  ready,
  type DispatchFailure,
  aboutPlans,
  type PlanWarning,
} from '../../ingest';

// Re-exported so kinds reach the dispatch surface through their own pool.ts.
// `caseIndex` on a DispatchFailure indexes THIS call's plans, never a Case id.
export { hasSimd, NO_SIMD_MESSAGE, partitionByFailure };
import { checkMergeGroup } from './merge';
import {
  buildColumnPlan,
  KEY_COLS,
  parseHeaderLine,
  parseTitleLine,
  unionSchema,
  wideSpec,
  type ColumnPlan,
  type HeaderInfo,
  type TitleInfo,
  type WideSpec,
} from './header';
import {
  isOverflowError,
  NEWLINE,
  type BlockPayload,
  maxRowsAt,
  PARSER_ABI,
  type ParserBudget,
  type SlabLayout,
} from './block';
import type { BlockMessage, BlockResult, InitMessage, WorkerReady } from './worker';

export { wideSpec };
export type { WideSpec, HeaderInfo, TitleInfo, ColumnPlan };

/** Measured: >= 8 MiB. 1 MiB blocks measure *worse* than plain streaming. */
export const BLOCK_TARGET_BYTES = 8 * 1024 * 1024;

/** The share of the slab's row capacity a block is cut to fill; the rest is
 * headroom for row-length variance. Depends on the file's width, since the
 * arena is fixed in bytes. Exported so scripts/bench-ingest.mjs measures the
 * block size the app actually dispatches. */
export function safeBlockRows(layout: SlabLayout): number {
  return Math.floor(layout.rows * 0.9);
}

/**
 * The slab shape one file is parsed at: as wide as its header, as tall as the
 * arena allows. Full height because `slab_fill_nan` clears exactly the
 * configured slab (no stale floats) and the arena is allocated anyway. Throws
 * when not even one row fits, stated in bytes.
 */
export function layoutFor(budget: ParserBudget, plan: ColumnPlan): SlabLayout {
  const metrics = plan.slabPlan.length;
  const rows = maxRowsAt(budget, metrics);
  if (rows === 0) {
    throw new Error(
      `This export declares ${metrics} entity columns, and one row of them needs ` +
        `${metrics * 4 + 3} B — more than the parser's whole ${budget.arenaBytes} B block ` +
        `arena. Split the export by column, or build the parser with a larger ARENA_MIB.`,
    );
  }
  return { metrics, rows };
}

/**
 * Enough for the preamble, the header and a first data row. Unlike the long
 * reader's doubling probe (`MAX_HEAD_PROBE_BYTES` in
 * `src/tables/long/pool.ts`), this is one fixed read: a wide header grows per
 * ENTITY, so this probe sets the width ceiling. `bench-ingest.mjs`'s
 * `head-probe-wall` probe bisects that ceiling; bus and generator widths sit
 * well inside it. The refusal names the constant and byte count, on the main
 * thread, before any worker exists.
 */
const HEAD_PROBE_BYTES = 256 * 1024;

/** Data rows sampled to size blocks; one row is too small a sample. */
const ROW_SAMPLE = 64;

/** The whole file is read through the pool; this is only the header probe. */
const decoder = new TextDecoder();

export interface CasePlan {
  file: File;
  header: HeaderInfo;
  /**
   * The lines above the column header, verbatim (CR kept). This module reads
   * only the title from `preamble[0]`; a kind may read more (the bus id row).
   */
  preamble: string[];
  title: TitleInfo;
  /** Byte offset of the first data row -- block 0 starts here, not at 0. */
  dataStart: number;
  year: number;
  /** The SHORTEST sampled data row, so a block's byte size bounds its row
   * count from above. */
  bytesPerRow: number;
}

export interface IngestResult<T> {
  /** One table per SURVIVING plan, in plan order; a plan with a failed block
   * is discarded, never committed half-filled. `ok` maps back to `plans`. */
  cases: T[];
  /** `cases[i]` was built from `plans[ok[i]]`. By index, never filename: one
   * drop may carry two files of the same name. */
  ok: number[];
  /** User-facing notes, each with the plans it is about. */
  warnings: PlanWarning[];
  /** One entry per plan that failed, in plan order. */
  failures: PlanFailure[];
}

/** A whole file's failure, already attributed back to its plan. */
export interface PlanFailure {
  /** Index into THIS call's `plans`. */
  index: number;
  /** The source file's name, for the note the user reads. */
  file: string;
  message: string;
}

// ---------------------------------------------------------------- header probe

/** Byte offset just past the `n`-th newline in `bytes`, or -1. */
function skipLines(bytes: Uint8Array, n: number): number {
  let at = 0;
  for (let i = 0; i < n; i++) {
    const nl = bytes.indexOf(NEWLINE, at);
    if (nl < 0) return -1;
    at = nl + 1;
  }
  return at;
}

/** The case label: the file name without its extension. */
export function caseNameOf(filename: string): string {
  return filename.replace(/\.[^.]+$/, '');
}

/**
 * Read one file's preamble, header, and enough rows to size blocks. The
 * header depth is a NUMBER the kind states, never inferred: a title line
 * contains commas, so a tolerant scan would accept it as a header and fail
 * somewhere less obvious.
 */
export async function readCasePlan(
  file: File,
  spec: WideSpec = wideSpec('entity'),
): Promise<CasePlan> {
  const preambleLines = spec.preambleLines;
  const probe = new Uint8Array(await file.slice(0, HEAD_PROBE_BYTES).arrayBuffer());

  const titleEnd = probe.indexOf(NEWLINE);
  if (titleEnd < 0) {
    throw new Error(`${file.name}: no line ending in the first ${HEAD_PROBE_BYTES} B.`);
  }
  const title = parseTitleLine(decoder.decode(probe.subarray(0, titleEnd)));

  const headerStart = skipLines(probe, preambleLines);
  if (headerStart < 0) {
    throw new Error(
      `${file.name}: fewer than ${preambleLines + 1} lines — a GridView ${spec.entityNoun} ` +
        `export of this shape opens with ${preambleLines} preamble lines and carries its ` +
        `column header on line ${preambleLines + 1}.`,
    );
  }
  const headerEnd = probe.indexOf(NEWLINE, headerStart);
  if (headerEnd < 0) {
    throw new Error(`${file.name}: no column header within the first ${HEAD_PROBE_BYTES} B.`);
  }
  const header = parseHeaderLine(
    decoder.decode(probe.subarray(headerStart, headerEnd)),
    spec.entityNoun,
  );
  const dataStart = headerEnd + 1;

  const rowEnd = probe.indexOf(NEWLINE, dataStart);
  if (rowEnd < 0) throw new Error(`${file.name}: header but no data rows.`);
  const firstRow = decoder.decode(probe.subarray(dataStart, rowEnd));

  // Date is `M/D/YYYY` parsed as integers, never a Date object (timezone
  // shifts). Any row's year will do: block.c checks every row against it and
  // refuses a file that spans two years.
  const year = Number(firstRow.split(',', 1)[0].split('/')[2]);
  if (!Number.isInteger(year) || year < 1900 || year > 2200) {
    throw new Error(`${file.name}: could not read a year from the first Date field.`);
  }

  // Blocks are cut in bytes but bounded in rows, so convert pessimistically
  // from the shortest sampled row. A shorter row can still overrun; the parser
  // refuses and ingest re-cuts smaller.
  let shortest = rowEnd - dataStart + 1;
  let cursor = rowEnd + 1;
  for (let seen = 1; seen < ROW_SAMPLE; seen++) {
    const next = probe.indexOf(NEWLINE, cursor);
    if (next < 0) break;
    shortest = Math.min(shortest, next - cursor + 1);
    cursor = next + 1;
  }

  // Split on the same newline the offsets used, so CRLF `\r` stays on each
  // line for the kind to trim.
  const preamble = decoder
    .decode(probe.subarray(0, headerStart))
    .split('\n')
    .slice(0, preambleLines);

  return { file, header, title, preamble, dataStart, year, bytesPerRow: Math.max(1, shortest) };
}

/** Every entity any dropped file carries, in first-seen order. */
export function unionOf(plans: CasePlan[]): string[] {
  return unionSchema(plans.map((p) => p.header));
}

/** Which of `plans` carries each entity -- what the picker shows next to a
 * column that only some files have. */
export function coverageOf(plans: CasePlan[]): Map<string, string[]> {
  const coverage = new Map<string, string[]>();
  for (const plan of plans) {
    const name = caseNameOf(plan.file.name);
    for (const column of plan.header.entityNames) {
      const seen = coverage.get(column);
      if (seen) seen.push(name);
      else coverage.set(column, [name]);
    }
  }
  return coverage;
}

// ---------------------------------------------------------------- the pool

/** The pool and the budget its wasm build reported; every per-file layout is
 * sized against it. */
interface ParserPool {
  workers: Worker[];
  budget: ParserBudget;
}

let poolPromise: Promise<ParserPool> | null = null;

async function createPool(): Promise<ParserPool> {
  if (!hasSimd()) throw new Error(NO_SIMD_MESSAGE);

  // Compiled once and cloned to every worker -- see src/tables/long/pool.ts.
  // The ABI is in the URL, as in src/tables/long/pool.ts.
  const module = await WebAssembly.compileStreaming(fetch(`./wide-block.wasm?abi=${PARSER_ABI}`));

  const workers: Worker[] = [];
  let budget: ParserBudget | null = null;
  for (let i = 0; i < poolSize(); i++) {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    const init: InitMessage = { kind: 'init', module };
    const reply = await ready<WorkerReady>(worker, init);
    // Every worker instantiated the same module, so this cannot legitimately
    // differ. Checked anyway: a mismatch would blit planes at the wrong stride
    // with every number plausible.
    if (budget && reply.budget.arenaBytes !== budget.arenaBytes) {
      throw new Error(
        `worker ${i} reports a ${reply.budget.arenaBytes} B block arena, but earlier workers ` +
          `in this pool report ${budget.arenaBytes} B. One pool is one compiled module, so ` +
          `this cannot be reconciled.`,
      );
    }
    budget ??= reply.budget;
    workers.push(worker);
  }
  if (!budget) throw new Error('the parser pool was built with no workers.');
  return { workers, budget };
}

/** The pool. Workers hold no per-study state (planes are located by the JS
 * column plan), so one pool serves the whole page and can warm early. */
export function warmPool(): void {
  if (!poolPromise && hasSimd()) poolPromise = createPool();
}

function pool(): Promise<ParserPool> {
  if (!poolPromise) poolPromise = createPool();
  return poolPromise;
}

// ---------------------------------------------------------------- cube assembly

export interface CaseAccumulator {
  plan: ColumnPlan;
  cube: Float32Array;
  /** Per-hour TOU code, 0xFF until a row covers the hour. */
  tou: Uint8Array;
  hourSeen: Uint8Array;
  /** One bit per HOUR: has a row claimed it? A wide row is one whole hour, so
   * no per-entity bit is needed. A merge group shares it, so two files
   * covering the same hour are refused like two rows of one file. */
  covered: Uint8Array;
  feb29: number;
}

export function createAccumulator(plan: ColumnPlan): CaseAccumulator {
  const cube = new Float32Array(plan.entities.length * HOURS_PER_YEAR);
  cube.fill(NaN);
  return {
    plan,
    cube,
    tou: new Uint8Array(HOURS_PER_YEAR).fill(0xff),
    hourSeen: new Uint8Array(HOURS_PER_YEAR),
    covered: new Uint8Array(Math.ceil(HOURS_PER_YEAR / 8)),
    feb29: 0,
  };
}

/**
 * Scatter one block's rows into the cube at each row's own hour, so any row
 * order loads identically. Plane-outer, row-inner on purpose: one entity's
 * year is a contiguous run, so the writes stay in cache.
 */
export function blitBlock(
  accumulator: CaseAccumulator,
  block: BlockPayload,
  columnPlan: ColumnPlan = accumulator.plan,
): void {
  const { cube, covered } = accumulator;
  // The block's OWN file's plan. It differs from the group's only in a merge
  // group, where files with different columns fill one cube.
  const plan = columnPlan;
  const { rows, data, rowHour, rowTou } = block;
  accumulator.feb29 += block.feb29;
  if (rows === 0) return;

  // Claim each hour before writing: two rows for one hour would otherwise keep
  // whichever worker finished last.
  for (let r = 0; r < rows; r++) {
    const hour = rowHour[r];
    const byte = hour >> 3;
    const mask = 1 << (hour & 7);
    if (covered[byte] & mask) {
      throw new Error(
        `Two rows both describe hour ${hour} of the year. One case is one calendar year, so an ` +
          `hour cannot appear twice; two exports concatenated into one file look like this, and ` +
          `so do two files given one study name that cover the same part of the year. ` +
          `Load them as separate studies.`,
      );
    }
    covered[byte] |= mask;
    accumulator.tou[hour] = rowTou[r];
    accumulator.hourSeen[hour] = 1;
  }

  for (let p = 0; p < plan.activePlanes.length; p++) {
    const base = plan.slabPlan[plan.activePlanes[p]] * HOURS_PER_YEAR;
    const src = p * rows;
    for (let r = 0; r < rows; r++) cube[base + rowHour[r]] = data[src + r];
  }
}

/**
 * What a finished wide parse yields before any kind gives it meaning. Units,
 * slot keys and aggregation rules never reach this module.
 */
export interface WideCase {
  cube: Float32Array;
  /** The cube's entity axis, in cube-index order. */
  entities: string[];
  /** One byte per entity: 1 = this file's header carried it. */
  presence: Uint8Array;
  /** Per-hour TOU code, length 8760, read from the file. */
  tou: Uint8Array;
  /** One byte per hour: 1 = some row covered it (unioned across a merge
   * group). */
  hoursPresent: Uint8Array;
  year: number;
  title: TitleInfo;
}

/**
 * Close one accumulator and report what the SHAPE can see going wrong:
 * missing columns, uncovered hours, dropped Feb 29 rows, a title that
 * disagrees with the rows. Warnings about meaning belong to the kind's own
 * finalizer.
 */
export function finalizeWide(
  accumulator: CaseAccumulator,
  name: string,
  year: number,
  title: TitleInfo,
  spec: WideSpec,
): { data: WideCase; warnings: string[] } {
  const { plan, cube } = accumulator;
  const warnings: string[] = [];

  const absent = plan.entities.filter((_, i) => !plan.presence[i]);
  if (absent.length > 0) {
    warnings.push(
      `${name}: ${absent.length} selected ${spec.entityNoun}(s) are not in this export ` +
        `(${absent.slice(0, 3).join(', ')}${absent.length > 3 ? ', …' : ''}).`,
    );
  }
  let covered = 0;
  for (let h = 0; h < HOURS_PER_YEAR; h++) covered += accumulator.hourSeen[h];
  if (covered < HOURS_PER_YEAR) {
    warnings.push(
      `${name}: covers ${covered.toLocaleString()} of ${HOURS_PER_YEAR.toLocaleString()} hours; ` +
        `the rest read as no-data.`,
    );
  }
  // A leap year is stated rather than silent.
  if (accumulator.feb29 > 0) {
    warnings.push(
      `${name}: ${year} is a leap year — ${accumulator.feb29.toLocaleString()} Feb 29 row(s) ` +
        `were dropped at ingest so every case is exactly ${HOURS_PER_YEAR.toLocaleString()} ` +
        `hours.`,
    );
  }
  if (title.quantity === '') {
    warnings.push(
      `${name}: the title line does not name a quantity, so this case has no unit. Its ` +
        `series still plot, on an axis of their own.`,
    );
  } else if (title.year !== null && title.year !== year) {
    warnings.push(
      `${name}: the title line says year ${title.year} but the first data row is ${year}. ` +
        `The data rows win.`,
    );
  }

  return {
    data: {
      cube,
      entities: plan.entities,
      presence: plan.presence.slice(),
      tou: accumulator.tou,
      hoursPresent: accumulator.hourSeen,
      year,
      title,
    },
    warnings,
  };
}

// ---------------------------------------------------------------- ingest

function blocksFor(
  plan: CasePlan,
  caseIndex: number,
  activePlanes: Int32Array,
  nextId: () => number,
  shrink: number,
  layout: SlabLayout,
): BlockMessage[] {
  // A wider export has longer rows AND a shorter slab, so the bound comes from
  // this file's rows and layout. `bytesPerRow` is the shortest sampled row, so
  // this over-estimates rows per block.
  const blockBytes = Math.max(
    plan.bytesPerRow,
    Math.floor(Math.min(BLOCK_TARGET_BYTES, safeBlockRows(layout) * plan.bytesPerRow) / shrink),
  );

  const jobs: BlockMessage[] = [];
  for (let start = plan.dataStart; start < plan.file.size; start += blockBytes) {
    jobs.push({
      kind: 'block',
      blockId: nextId(),
      caseIndex,
      file: plan.file,
      start,
      end: Math.min(start + blockBytes, plan.file.size),
      skipPartialFirstRow: start !== plan.dataStart,
      activePlanes,
      layout,
      year: plan.year,
    });
  }
  return jobs;
}

/**
 * Parse every plan into its own cube. `retained` is the entity axis (picker
 * answer, or the union for everything). Files need not share columns: each
 * case carries a presence bitmap.
 *
 * Plans with the same `groupOf` id share ONE accumulator and become ONE table,
 * which is how a year exported in halves loads as a year:
 *
 *   * The duplicate check spans the group, because `covered` is per group.
 *   * The blit uses each FILE's column plan; members share only the axis.
 *   * A group commits whole or not at all. Half a merged year committed as a
 *     whole one is the failure this exists to prevent.
 */
export async function ingest<T>(
  plans: CasePlan[],
  retained: string[],
  spec: WideSpec,
  finalize: Finalize<T>,
  onProgress?: (done: number, total: number) => void,
  groupOf: number[] = plans.map((_, i) => i),
): Promise<IngestResult<T>> {
  // Above the pool: a drop with no wide file must not compile wasm or report
  // NO_SIMD_MESSAGE.
  if (plans.length === 0) return { cases: [], ok: [], warnings: [], failures: [] };
  // Before the pool for the same reason. `ingestWithWorkers` repeats the check
  // for its direct callers.
  requireEntities(retained, spec);
  const { workers, budget } = await pool();
  return ingestWithWorkers(workers, budget, plans, retained, spec, finalize, onProgress, groupOf);
}

/**
 * How a kind turns one finished wide parse into its table: the whole
 * kind-specific surface on this side of the seam. Nothing it returns comes
 * back into this module.
 */
export type Finalize<T> = (wide: WideCase, plan: CasePlan) => { data: T; warnings: string[] };

/** Trim `retained` and refuse an empty selection, before any pool is touched. */
function requireEntities(retained: string[], spec: WideSpec): string[] {
  const entities = retained.map((name) => name.trim());
  if (entities.length === 0) {
    throw new Error(`No ${spec.entityNoun}s selected — there would be nothing to plot.`);
  }
  return entities;
}

/**
 * `ingest` against a GIVEN set of workers and budget, so
 * `tests/test_interface_attempt.mjs` can drive the retry loop, abort
 * predicate and failure attribution with stubs and no wasm.
 */
export async function ingestWithWorkers<T>(
  workers: Worker[],
  budget: ParserBudget,
  plans: CasePlan[],
  retained: string[],
  spec: WideSpec,
  finalize: Finalize<T>,
  onProgress?: (done: number, total: number) => void,
  groupOf: number[] = plans.map((_, i) => i),
): Promise<IngestResult<T>> {
  const entities = requireEntities(retained, spec);
  const warnings: PlanWarning[] = [];

  // `columnPlans[i]` locates FILE i's bytes; a group's plan describes the
  // shared cube (same axis, presence unioned).
  const columnPlans = plans.map((plan) => buildColumnPlan(plan.header, entities));
  const groups = groupsOf(plans, columnPlans, groupOf);

  // A refused group is reported before any bytes are read.
  const groupFailures: PlanFailure[] = [];
  for (const group of groups) {
    const check = checkMergeGroup(group.members.map((i) => plans[i]));
    warnings.push(...aboutPlans(check.warnings, group.members));
    if (check.refusal === undefined) continue;
    group.refused = true;
    for (const index of group.members) {
      groupFailures.push({ index, file: plans[index].file.name, message: check.refusal });
    }
  }
  // One layout per file: files of different widths parse at different shapes
  // on the same workers.
  const layouts = columnPlans.map((plan) => layoutFor(budget, plan));

  /**
   * One pass over every file at one block size, from empty accumulators (a
   * half-filled one would fail the duplicate check on a retry). When a smaller
   * cut remains, the first overflow ends the attempt, since the retry redoes
   * everything. Any other failure belongs to its FILE: recorded, and the other
   * files still parse and commit. Failures are returned, never thrown.
   */
  async function attempt(
    shrink: number,
    retryable: boolean,
  ): Promise<{ accumulators: (CaseAccumulator | null)[]; failures: DispatchFailure[] }> {
    const accumulators = groups.map((group) =>
      group.refused ? null : createAccumulator(group.plan),
    );
    let id = 0;
    const jobs: BlockMessage[] = [];
    plans.forEach((plan, index) => {
      if (accumulators[groupOf[index]] === null) return;
      jobs.push(
        ...blocksFor(
          plan,
          index,
          columnPlans[index].activePlanes,
          () => id++,
          shrink,
          layouts[index],
        ),
      );
    });

    // One dispatch per attempt. It does not return while a worker awaits a
    // reply, so a retry cannot be answered by a stale listener.
    const failures = await dispatch<BlockResult>(
      workers,
      jobs,
      'done',
      // The destination comes from the caseIndex the worker echoes. Inside a
      // merge group it is the GROUP's accumulator, located by this FILE's
      // plan. A refused blit is recorded against the file it came from.
      (result) =>
        blitBlock(
          accumulators[groupOf[result.caseIndex]] as CaseAccumulator,
          result,
          columnPlans[result.caseIndex],
        ),
      {
        onProgress,
        // Only an overflow a retry will redo ends the attempt. Anything else,
        // including an overflow at the smallest cut, belongs to one file and
        // the batch carries on.
        abortOnError: (failure) => retryable && isOverflowError(failure.message),
      },
    );

    return { accumulators, failures };
  }

  // A file whose rows shrink below everything sampled can still overrun the
  // slab. The fix is on this side, so re-cut smaller rather than surface an
  // error the user cannot act on. Four attempts reach 1/64th of the block.
  let accumulators: (CaseAccumulator | null)[];
  let blockFailures: DispatchFailure[];
  for (let shrink = 1; ; shrink *= 4) {
    // At 1/64th there is no smaller cut, so that attempt runs every job.
    const retryable = shrink < 64;
    const pass = await attempt(shrink, retryable);
    if (retryable && pass.failures.some((failure) => isOverflowError(failure.message))) {
      continue;
    }
    accumulators = pass.accumulators;
    blockFailures = pass.failures;
    break;
  }

  const { ok, failed } = partitionByFailure(plans, blockFailures);
  const failures: PlanFailure[] = [
    ...failed.map(({ index, message }) => ({ index, file: plans[index].file.name, message })),
    ...groupFailures,
  ];

  // Only a group with no failed block becomes a table. A half-filled cube
  // would read as ordinary no-data.
  const okSet = new Set(ok);
  const cases: T[] = [];
  /** One plan index per committed GROUP. */
  const committed: number[] = [];
  groups.forEach((group, g) => {
    const accumulator = accumulators[g];
    if (accumulator === null) return;
    if (!group.members.every((index) => okSet.has(index))) return;
    committed.push(group.members[0]);
    // The SHAPE's finalizer, then the KIND's.
    const shaped = finalizeWide(
      accumulator,
      group.label,
      group.repPlan.year,
      group.repPlan.title,
      spec,
    );
    const finalized = finalize(shaped.data, group.repPlan);
    cases.push(finalized.data);
    warnings.push(...aboutPlans([...shaped.warnings, ...finalized.warnings], group.members));
  });

  return { cases, ok: committed, warnings, failures };
}

/** One merge group, as `ingest` works it. */
interface MergeGroup {
  /** Plan indices, in the order the files were dropped. */
  members: number[];
  /** Every member's case name, so a note names each file in the group. */
  label: string;
  /** The cube's entity axis and presence: the group's union of columns against
   * the retained list, NOT any one member's. */
  plan: ColumnPlan;
  /** The first member with the union header, so the kind's `sourceColumns`
   * and labels cover every member's columns. */
  repPlan: CasePlan;
  refused?: boolean;
}

/**
 * Bucket plans by group id, keeping drop order. `groupOf` ids index
 * `accumulators` directly, so they must be dense and first-seen ordered, as
 * `groupByCase` in `main.ts` produces them.
 */
function groupsOf(plans: CasePlan[], columnPlans: ColumnPlan[], groupOf: number[]): MergeGroup[] {
  if (groupOf.length !== plans.length) {
    throw new Error(
      `ingest: groupOf has ${groupOf.length} entries for ${plans.length} plans; one group id ` +
        `per plan is the contract.`,
    );
  }
  const byId = new Map<number, number[]>();
  for (let i = 0; i < plans.length; i++) {
    const bucket = byId.get(groupOf[i]);
    if (bucket) bucket.push(i);
    else byId.set(groupOf[i], [i]);
  }
  return [...byId.values()].map((members) => {
    const first = plans[members[0]];
    const label = members.map((i) => caseNameOf(plans[i].file.name)).join(' + ');
    if (members.length === 1) {
      return { members, label, plan: columnPlans[members[0]], repPlan: first };
    }
    // A column only one half carries is still a plane, NaN for the other half.
    const presence = columnPlans[members[0]].presence.slice();
    for (const index of members.slice(1)) {
      const other = columnPlans[index].presence;
      for (let e = 0; e < presence.length; e++) presence[e] ||= other[e];
    }
    return {
      members,
      label,
      plan: { ...columnPlans[members[0]], presence },
      repPlan: { ...first, header: unionHeader(members.map((i) => plans[i])) },
    };
  });
}

/**
 * One header for the whole group: every member's entity columns in first-seen
 * order, `raw` index-aligned to `entityNames`. The alignment matters: the bus
 * finalizer pairs a name in `raw` with a number in `entityNames` by index.
 * Byte locations still come from each member's own header.
 */
export function unionHeader(members: readonly CasePlan[]): HeaderInfo {
  const first = members[0].header;
  const raw = first.raw.slice();
  const canonical = first.canonical.slice();
  const entityNames = first.entityNames.slice();
  const seen = new Set(entityNames);
  for (const member of members.slice(1)) {
    member.header.entityNames.forEach((name, i) => {
      if (seen.has(name)) return;
      seen.add(name);
      entityNames.push(name);
      raw.push(member.header.raw[i + KEY_COLS] ?? name);
      canonical.push(name);
    });
  }
  return { ...first, raw, canonical, entityNames };
}

/** Bytes one case's cube occupies: exactly what `createAccumulator` allocates. */
export function cubeBytesFor(entityCount: number): number {
  return entityCount * HOURS_PER_YEAR * Float32Array.BYTES_PER_ELEMENT;
}
