// src/tables/long/pool.ts
//
// The LONG shape's reader: worker pool, file dispatch and cube assembly for an
// `entity x metric x 8760` cube. It knows only numbers (key-column count,
// entity column, slab width); what a kind decides lives in its own `long.ts`
// (`src/tables/area/long.ts` is the worked example).
//
// The unit of work is a BYTE RANGE, so one file uses every core. The cube is
// pre-filled with NaN so "never written" reads as no data, never as zeros.

import { HOURS_PER_YEAR } from '../../model/calendar';
import {
  dispatch,
  hasSimd,
  NO_SIMD_MESSAGE,
  partitionByFailure,
  poolSize,
  ready,
  aboutPlans,
  type PlanWarning,
} from '../../ingest';

// Re-exported so kinds reach the dispatch surface through their pool.ts.
// `caseIndex` on a failure indexes THIS call's plans, never a Case id.
export { dispatch, hasSimd, NO_SIMD_MESSAGE, partitionByFailure };
import { checkMergeGroup, unionMetricNames } from './merge';
import {
  entityHashes,
  buildColumnPlan,
  parseHeaderLine,
  unionSchema,
  type ColumnPlan,
  type LongSignature,
} from './header';
import type { CaseAccumulator, CasePlan, LongKind } from './kind';
export type { CaseAccumulator, CasePlan, LongKind };
import { PARSER_ABI, type BlockPayload, type KeyLayout } from './block';
import type {
  AxisMessage,
  BlockMessage,
  BlockResult,
  InitMessage,
  LayoutMessage,
  ScanMessage,
  ScanResult,
} from './worker';

/** >= 8 MiB: 1 MiB blocks measure *worse* than plain streaming. */
export const BLOCK_TARGET_BYTES = 8 * 1024 * 1024;

/**
 * Initial header probe, doubled up to `MAX_HEAD_PROBE_BYTES` until the header
 * and one data row fit. A long header grows per METRIC, not per entity, so in
 * practice it never doubles. (The wide reader's fixed probe is where the real
 * width wall is.)
 */
const HEAD_PROBE_BYTES = 256 * 1024;
const MAX_HEAD_PROBE_BYTES = 16 * 1024 * 1024;

const decoder = new TextDecoder();

export interface IngestResult<T> {
  /** One table per SURVIVING plan; a plan with a failed block is discarded,
   * never committed half-filled. `ok` maps back to `plans`. */
  cases: T[];
  /** `cases[i]` was built from `plans[ok[i]]`. By index, never filename. */
  ok: number[];
  /** User-facing notes, each with the plans it is about; the retention
   * notes are about the retained set and name no plan. */
  warnings: PlanWarning[];
  failures: PlanFailure[];
}

/** A whole file's failure, already attributed back to its plan. */
export interface PlanFailure {
  /** Index into THIS call's `plans`. */
  index: number;
  file: string;
  message: string;
}

/** What `discoverEntities` found. It fills `plan.entities` and
 * `plan.rowsPerBlock` in place and produces no tables. */
export interface ScanOutcome {
  /** Indices into `plans`, ascending: the plans whose axis was read. */
  ok: number[];
  failures: PlanFailure[];
}

/**
 * Read one file's header and enough of its first row to size blocks. `sig` is
 * the same object `src/detect.ts` matched the file on, so detection and
 * ingest agree on where the metrics start.
 */
export async function readCasePlan(file: File, sig: LongSignature): Promise<CasePlan> {
  for (let probeBytes = HEAD_PROBE_BYTES; ; probeBytes *= 2) {
    const probe = new Uint8Array(await file.slice(0, probeBytes).arrayBuffer());
    const headerEnd = probe.indexOf(10);
    if (headerEnd < 0) {
      if (probeBytes < MAX_HEAD_PROBE_BYTES && probe.length === probeBytes) continue;
      throw new Error(`${file.name}: no line ending in the first ${probeBytes} B.`);
    }
    const header = parseHeaderLine(decoder.decode(probe.subarray(0, headerEnd)), sig);
    const dataStart = headerEnd + 1;

    const rowEnd = probe.indexOf(10, dataStart);
    if (rowEnd < 0) {
      if (probeBytes < MAX_HEAD_PROBE_BYTES && probe.length === probeBytes) continue;
      throw new Error(
        `${file.name}: header but no complete data row in the first ${probeBytes} B.`,
      );
    }
    const firstRow = decoder.decode(probe.subarray(dataStart, rowEnd));

    // Date is `M/D/YYYY` parsed as integers, never a Date object (timezones).
    const year = Number(firstRow.split(',', 1)[0].split('/')[2]);
    if (!Number.isInteger(year) || year < 1900 || year > 2200) {
      throw new Error(`${file.name}: could not read a year from the first Date field.`);
    }

    // The entities are read from every row by discoverEntities(), never
    // guessed from this probe.
    return { file, label: file.name, header, dataStart, year, entities: [], rowsPerBlock: [] };
  }
}

/**
 * Every metric column some file in the drop carries, and nothing else. A kind
 * that calculates extra columns appends them itself (see
 * `src/tables/area/long.ts`); adding them here would offer metrics nothing
 * fills.
 */
export function unionMetricsOf(plans: CasePlan[]): string[] {
  return unionSchema(plans.map((p) => p.header));
}

let poolPromise: Promise<Worker[]> | null = null;
/** The axis the workers' hash tables currently hold, joined. */
let poolAxis = '';
/** The key layout the workers' modules are currently set to, `keyCols:entityCol`. */
let poolLayout = '';

async function createPool(): Promise<Worker[]> {
  if (!hasSimd()) throw new Error(NO_SIMD_MESSAGE);

  // Compiled once and cloned to every worker: one fetch and one compile, not N.
  // The ABI is in the URL: the file keeps its name across deploys, so without
  // it a cached older parser meets newer JS and refuses every long file.
  const module = await WebAssembly.compileStreaming(fetch(`./long-block.wasm?abi=${PARSER_ABI}`));

  const workers: Worker[] = [];
  for (let i = 0; i < poolSize(); i++) {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    const init: InitMessage = { kind: 'init', module };
    await ready(worker, init);
    workers.push(worker);
  }
  poolAxis = '';
  poolLayout = '';
  return workers;
}

/** The pool. Built once, before any axis is known: the axis comes from the
 * data, so the workers must run first. */
function pool(): Promise<Worker[]> {
  if (!poolPromise) poolPromise = createPool();
  return poolPromise;
}

/** Load an axis into every worker's hash table unless it already holds it.
 * A stale axis routes rows into the wrong planes. */
async function useAxis(workers: Worker[], areas: string[]): Promise<void> {
  const key = areas.join(',');
  if (poolAxis === key) return;
  const axis: AxisMessage = { kind: 'axis', entityHashes: entityHashes(areas) };
  // allSettled, not all: `ready` installs a one-shot handler, and every one
  // must settle before reacting, or a leftover handler would catch a later
  // message meant for the next call.
  const results = await Promise.allSettled(workers.map((worker) => ready(worker, axis)));
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) {
    throw failure.reason instanceof Error ? failure.reason : new Error(String(failure.reason));
  }
  poolAxis = key;
}

/**
 * The key layout a batch's files carry, read off their headers (never a
 * parameter that could disagree with the column plan). Files that disagree
 * are refused by name.
 */
export function layoutOf(plans: CasePlan[]): KeyLayout {
  const first = plans[0].header;
  const odd = plans.find(
    (plan) => plan.header.keyCols !== first.keyCols || plan.header.entityCol !== first.entityCol,
  );
  if (odd) {
    throw new Error(
      `${plans[0].file.name} has ${first.keyCols} key columns and ${odd.file.name} has ` +
        `${odd.header.keyCols}. One batch is one table kind; load them separately.`,
    );
  }
  return { keyCols: first.keyCols, entityCol: first.entityCol };
}

/** Point every worker at the batch's key layout before either pass; a stale
 * layout reads bytes at the wrong offsets silently. */
async function useLayout(workers: Worker[], layout: KeyLayout): Promise<void> {
  const key = `${layout.keyCols}:${layout.entityCol}`;
  if (poolLayout === key) return;
  const message: LayoutMessage = { kind: 'layout', ...layout };
  // allSettled for the same reason useAxis uses it.
  const results = await Promise.allSettled(workers.map((worker) => ready(worker, message)));
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) {
    throw failure.reason instanceof Error ? failure.reason : new Error(String(failure.reason));
  }
  poolLayout = key;
}

/**
 * The one allocation a long ingest makes: up to `entities x metrics x 8760`
 * floats (1.65 GB for a full 8-metric bus study). No size cap, because a fixed
 * cap would refuse files that fit on a bigger device. The caller catches the
 * `RangeError` and refuses with the arithmetic, naming the metrics to untick.
 */
export function createAccumulator(plan: ColumnPlan, entityCount: number): CaseAccumulator {
  const cube = new Float32Array(entityCount * plan.metrics.length * HOURS_PER_YEAR);
  cube.fill(NaN);
  return {
    plan,
    entityCount,
    cube,
    tou: new Uint8Array(HOURS_PER_YEAR).fill(0xff),
    entitySeen: new Uint8Array(entityCount),
    hourSeen: new Uint8Array(HOURS_PER_YEAR),
    covered: new Uint8Array(Math.ceil((entityCount * HOURS_PER_YEAR) / 8)),
  };
}

/**
 * Scatter one block's rows into the cube, correct in any row order. Rows are
 * bucketed by entity first so writes stay inside one entity's contiguous
 * region of the cube; that is about twice as fast as unsorted writes.
 */
export function blitBlock(
  accumulator: CaseAccumulator,
  block: BlockPayload,
  columnPlan: ColumnPlan = accumulator.plan,
): void {
  const { cube, entityCount, covered } = accumulator;
  // The block's OWN file's plan. It differs from the accumulator's only in a
  // merge group, where files with different column orders fill one cube.
  const plan = columnPlan;
  const { rows, planes, values, rowEntity, rowHour } = block;

  for (let hour = 0; hour < block.tou.length; hour++) {
    const code = block.tou[hour];
    if (code === 0xff) continue;
    accumulator.tou[hour] = code;
    accumulator.hourSeen[hour] = 1;
  }
  for (let area = 0; area < entityCount; area++) {
    if (block.entitySeen[area]) accumulator.entitySeen[area] = 1;
  }
  if (rows === 0 || planes === 0) return;

  // Output plane -> cube offset, so the inner loop is an add and a load.
  const numMetrics = plan.metrics.length;
  const offsets = new Int32Array(planes);
  for (let p = 0; p < planes; p++) {
    offsets[p] = plan.slabPlan[plan.activePlanes[p]] * HOURS_PER_YEAR;
  }

  // Counting sort by area. O(rows), one pass to count and one to place.
  const counts = new Int32Array(entityCount + 1);
  for (let r = 0; r < rows; r++) counts[rowEntity[r] + 1]++;
  for (let a = 0; a < entityCount; a++) counts[a + 1] += counts[a];
  const order = new Int32Array(rows);
  for (let r = 0; r < rows; r++) order[counts[rowEntity[r]]++] = r;

  // When the retained planes are consecutive cube metrics, the offset is an
  // arithmetic step instead of a lookup: about a third of this loop's time.
  let step = 0;
  let stepped = planes > 0;
  for (let p = 1; p < planes && stepped; p++) {
    const delta = offsets[p] - offsets[p - 1];
    if (p === 1) step = delta;
    else if (delta !== step) stepped = false;
  }

  for (let i = 0; i < rows; i++) {
    const r = order[i];
    const area = rowEntity[r];
    const hour = rowHour[r];

    // A cell written twice is two rows for one (entity, hour): refuse rather
    // than keep whichever worker finished last.
    const bit = area * HOURS_PER_YEAR + hour;
    const byte = bit >> 3;
    const mask = 1 << (bit & 7);
    if (covered[byte] & mask) {
      throw new Error(
        `Two rows both describe area index ${area} at hour ${hour}. One case cannot hold the ` +
          `same area-hour twice; two exports concatenated into one file look like this. Load ` +
          `them as separate files.`,
      );
    }
    covered[byte] |= mask;

    const src = r * planes;
    let out = area * numMetrics * HOURS_PER_YEAR + hour;
    if (stepped) {
      out += offsets[0];
      for (let p = 0; p < planes; p++) {
        cube[out] = values[src + p];
        out += step;
      }
    } else {
      for (let p = 0; p < planes; p++) cube[out + offsets[p]] = values[src + p];
    }
  }
}

/** The byte ranges one file is cut into. Both passes use the same cut, so
 * scan and parse blocks cover the same rows. */
function rangesFor(plan: CasePlan): { start: number; end: number; skipPartialFirstRow: boolean }[] {
  const out = [];
  for (let start = plan.dataStart; start < plan.file.size; start += BLOCK_TARGET_BYTES) {
    out.push({
      start,
      end: Math.min(start + BLOCK_TARGET_BYTES, plan.file.size),
      skipPartialFirstRow: start !== plan.dataStart,
    });
  }
  return out;
}

function blocksFor(
  plan: CasePlan,
  caseIndex: number,
  activePlanes: Int32Array,
  entityCount: number,
  nextId: () => number,
): BlockMessage[] {
  const ranges = rangesFor(plan);
  if (plan.rowsPerBlock.length !== ranges.length) {
    throw new Error(
      `${plan.file.name}: discoverEntities() must run before ingest -- the parser is bounded by the ` +
        `row counts it produces.`,
    );
  }
  return ranges.map((range, i) => ({
    kind: 'block',
    blockId: nextId(),
    caseIndex,
    file: plan.file,
    ...range,
    activePlanes,
    entityCount,
    sourceMetricCount: plan.header.metricNames.length,
    maxRows: plan.rowsPerBlock[i],
  }));
}

/**
 * Read the entity axis from every row's key column, and count each block's
 * rows. Guessing it from the first rows fails on shuffled or incomplete
 * exports. The scan skips metric fields whole, so it costs a small fraction
 * of the parse, and its row counts bound the parser's output exactly.
 */
export async function discoverEntities(
  plans: CasePlan[],
  onProgress?: (done: number, total: number) => void,
): Promise<ScanOutcome> {
  if (plans.length === 0) return { ok: [], failures: [] };

  let id = 0;
  const jobs: ScanMessage[] = [];
  const slotOf = new Map<number, { caseIndex: number; slot: number }>();
  plans.forEach((plan, caseIndex) => {
    rangesFor(plan).forEach((range, slot) => {
      slotOf.set(id, { caseIndex, slot });
      jobs.push({ kind: 'scan', blockId: id++, caseIndex, file: plan.file, ...range });
    });
  });

  const names = plans.map(() => new Set<string>());
  plans.forEach((plan) => {
    plan.rowsPerBlock = new Array(rangesFor(plan).length).fill(0);
  });

  // ONE dispatch over every plan's scan blocks, so the axis sees every file.
  // `abortOnError: false`: one unreadable file must not cost the batch its
  // axis; failures come back attributed by `caseIndex`.
  const workers = await pool();
  // Needed before the scan too: `scan_axis` walks to `entityCol`.
  await useLayout(workers, layoutOf(plans));
  const blockFailures = await dispatch<ScanResult>(
    workers,
    jobs,
    'scanned',
    (result) => {
      const at = slotOf.get(result.blockId)!;
      for (const name of result.names) names[at.caseIndex].add(name);
      plans[at.caseIndex].rowsPerBlock[at.slot] = result.rows;
    },
    { onProgress, abortOnError: false },
  );

  const { ok, failed } = partitionByFailure(plans, blockFailures);
  const failures: PlanFailure[] = failed.map(({ index, message }) => ({
    index,
    file: plans[index].file.name,
    message,
  }));

  const scanned: number[] = [];
  for (const index of ok) {
    const plan = plans[index];
    // An empty key column fails that FILE only; its siblings still load.
    if (names[index].size === 0) {
      failures.push({
        index,
        file: plan.file.name,
        message: `${plan.file.name}: no area names in the Name column.`,
      });
      continue;
    }
    plan.entities = [...names[index]];
    scanned.push(index);
  }
  // Notes in drop order, not worker-finish order.
  failures.sort((a, b) => a.index - b.index);

  return { ok: scanned, failures };
}

export function unionEntities(plans: CasePlan[], base: readonly string[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const area of base) {
    const name = area.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  for (const plan of plans) {
    for (const area of plan.entities) {
      const name = area.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * Parse every plan into a cube. `retained` is the metric axis (picker answer,
 * or the union for everything). Plans sharing a `groupOf` id merge into one
 * table under the rules stated at `ingest` in `src/tables/wide/pool.ts`; here
 * `covered` is per (entity, hour) rather than per hour.
 */
export async function ingest<T>(
  plans: CasePlan[],
  retained: string[],
  areas: string[],
  kind: LongKind<T>,
  onProgress?: (done: number, total: number) => void,
  groupOf: number[] = plans.map((_, i) => i),
): Promise<IngestResult<T>> {
  if (plans.length === 0) return { cases: [], ok: [], warnings: [], failures: [] };

  const areaSet = new Set(areas);
  for (const plan of plans) {
    for (const area of plan.entities) {
      if (!areaSet.has(area)) {
        throw new Error(`${plan.file.name}: area "${area}" is not on the shared area axis.`);
      }
    }
  }

  const metrics = retained.map((name) => name.trim());
  const warnings: PlanWarning[] = (kind.retention ? kind.retention(metrics) : []).map(
    (message) => ({ message, plans: [] }),
  );

  // `columnPlans[i]` locates FILE i's bytes; a group's plan describes the
  // shared cube (members' columns intersected with `retained`).
  const columnPlans = plans.map((plan) => buildColumnPlan(plan.header, metrics));
  const groups = groupsOf(plans, groupOf, metrics);

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

  // Attempted, not bounded (see `createAccumulator`); a `RangeError` costs
  // only that group.
  const accumulators: (CaseAccumulator | null)[] = [];
  const allocationFailures: PlanFailure[] = [];
  groups.forEach((group) => {
    if (group.refused) {
      accumulators.push(null);
      return;
    }
    try {
      accumulators.push(createAccumulator(group.plan, areas.length));
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      accumulators.push(null);
      for (const index of group.members) {
        allocationFailures.push({
          index,
          file: plans[index].file.name,
          message: allocationRefusal(group.label, areas.length, group.plan.metrics.length),
        });
      }
    }
  });

  let id = 0;
  const jobs: BlockMessage[] = [];
  plans.forEach((plan, index) => {
    // A file with no cube gets no blocks: parsing it would fill nothing.
    if (accumulators[groupOf[index]] === null) return;
    jobs.push(...blocksFor(plan, index, columnPlans[index].activePlanes, areas.length, () => id++));
  });

  // ONE axis load and ONE dispatch for the whole batch: a dispatch per file
  // would rebuild every worker's hash table per file and risk a reply being
  // read by the wrong call.
  const workers = await pool();
  await useLayout(workers, layoutOf(plans));
  await useAxis(workers, areas);
  const blockFailures = await dispatch<BlockResult>(
    workers,
    jobs,
    'done',
    // A refused blit is recorded against the file it came from.
    (result) =>
      blitBlock(
        accumulators[groupOf[result.caseIndex]] as CaseAccumulator,
        result,
        columnPlans[result.caseIndex],
      ),
    { onProgress, abortOnError: false },
  );

  const { ok, failed } = partitionByFailure(plans, blockFailures);
  const failures: PlanFailure[] = [
    ...failed.map(({ index, message }) => ({ index, file: plans[index].file.name, message })),
    ...allocationFailures,
    ...groupFailures,
  ];

  // Only a group with no failed block becomes a table; a half-filled cube
  // would read as ordinary no-data.
  //
  // Failed groups' entity names stay on the axis, leaving some all-NaN,
  // presence-0 planes. Deliberate: kernels check presence first, and
  // narrowing now would force a second reindex of every loaded cube. Do not
  // "fix" it.
  const okSet = new Set(ok);
  const cases: T[] = [];
  /** One plan index per committed GROUP: its first member. */
  const committed: number[] = [];
  groups.forEach((group, g) => {
    const accumulator = accumulators[g];
    // A refused allocation has no blocks and is already in `failures`.
    if (accumulator === null) return;
    if (!group.members.every((index) => okSet.has(index))) return;
    committed.push(group.members[0]);
    const finalized = kind.finalize(accumulator, group.repPlan, areas);
    cases.push(finalized.data);
    warnings.push(...aboutPlans(finalized.warnings, group.members));
  });

  return { cases, ok: committed, warnings, failures };
}

/** One merge group, as `ingest` works it. */
interface MergeGroup {
  /** Plan indices, in drop order. */
  members: number[];
  label: string;
  /** The group's union of columns against `retained`, not any one member's. */
  plan: ColumnPlan;
  /** The first member with the union header, so notes name every file. */
  repPlan: CasePlan;
  refused?: boolean;
}

/** Bucket plans by group id, keeping drop order. Returns DENSE group indexes
 * (what `accumulators` uses); `groupOf` ids are only compared for equality. */
function groupsOf(plans: CasePlan[], groupOf: number[], metrics?: string[]): MergeGroup[] {
  if (groupOf.length !== plans.length) {
    throw new Error(
      `ingest: groupOf has ${groupOf.length} entries for ${plans.length} plans; one group id per ` +
        `plan is the contract.`,
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
    const label = members.map((i) => plans[i].file.name).join(' + ');
    const header =
      members.length === 1
        ? first.header
        : { ...first.header, metricNames: unionMetricNames(members.map((i) => plans[i])) };
    return {
      members,
      label,
      plan: buildColumnPlan(header, metrics ?? []),
      repPlan: { ...first, label, header },
    };
  });
}

/** An oversized cube's refusal, naming entities (fixed) and metrics (the
 * user's lever) separately. */
function allocationRefusal(file: string, entityCount: number, metricCount: number): string {
  const bytes = entityCount * metricCount * HOURS_PER_YEAR * 4;
  return (
    `${file}: could not allocate this file's cube -- ${entityCount.toLocaleString()} entities x ` +
    `${metricCount} retained metric${metricCount === 1 ? '' : 's'} x ${HOURS_PER_YEAR} hours x ` +
    `4 B = ${(bytes / (1024 * 1024)).toFixed(0)} MB in one array, which this browser refused. ` +
    `Nothing was loaded from it; drop it again keeping fewer metrics. The other files in this ` +
    `drop are unaffected.`
  );
}
