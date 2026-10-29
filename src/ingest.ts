// src/ingest.ts
//
// Ingest helpers that are the same for every table kind and both shapes: CSV
// line hygiene, the date-to-slot-day rule, a Case's year span and how a
// refusal names it, what a cube costs and how every picker and refusal words
// it, which file keeps a cell when a merge group's files overlap, the SIMD
// gate, the worker count, the dispatch loop, and the failure attribution that
// makes partial import safe. Nothing here knows what a column
// MEANS.

import {
  isLeapYear,
  SLOT_MONTH_LENGTHS,
  SLOT_MONTH_STARTS,
  YEAR_SLOT_HOURS,
  type YearSpan,
} from './model/calendar';
import { dayLabel } from './model/date-range';

// ---------------------------------------------------------------- CSV text

/** Strip a trailing CR (exports are CRLF, header included). */
export function stripCR(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** Strip a leading UTF-8 BOM, which otherwise makes the first header cell
 * `"﻿Date"` and every exact-name lookup fail silently. */
export function stripBOM(line: string): string {
  return line.startsWith('﻿') ? line.slice(1) : line;
}

/** The byte both parsers split rows on. */
export const NEWLINE = 10;

/** Index just past the first `\n` at or after `from`, or -1. */
export function afterNextNewline(bytes: Uint8Array, from: number): number {
  const at = bytes.indexOf(NEWLINE, Math.max(0, from));
  return at < 0 ? -1 : at + 1;
}

/** Day of the year slot (0-based, leap calendar: Feb 29 = 59, Mar 1 = 60 in
 * every year) for a 1-based month/day, or -1 for a day `year` lacks. The same
 * rule as `date_to_day` in `parser/common/fields.h`. */
export function dayOfYear(year: number, month: number, day: number): number {
  if (month < 1 || month > 12 || day < 1) return -1;
  if (day > SLOT_MONTH_LENGTHS[month - 1]) return -1;
  if (month === 2 && day === 29 && !isLeapYear(year)) return -1;
  return SLOT_MONTH_STARTS[month - 1] + day - 1;
}

// ---------------------------------------------------------------- year span

/** The most years a Case can span: both parsers place a row by a one-byte
 * offset from the first. */
export const MAX_CASE_YEARS = 256;

/** "2030", "2030-2032", "2030-2031, 2033 and 2036": consecutive years as runs. */
export function yearRuns(years: readonly number[]): string {
  const runs: string[] = [];
  for (let i = 0; i < years.length;) {
    let j = i;
    while (j + 1 < years.length && years[j + 1] === years[j] + 1) j++;
    runs.push(j === i ? `${years[i]}` : `${years[i]}-${years[j]}`);
    i = j + 1;
  }
  return runs.length === 1
    ? runs[0]
    : `${runs.slice(0, -1).join(', ')} and ${runs[runs.length - 1]}`;
}

/** The refusal for years inside a Case's span that no row is dated in, so
 * both shapes word a gap the same way. `who` opens the sentence ("x.csv has"
 * or "… together have"); both lists ascend. */
export function yearGapRefusal(
  who: string,
  years: readonly number[],
  missing: readonly number[],
): string {
  const gap = yearRuns(missing);
  return (
    `${who} rows for ${yearRuns(years)} but none for ${gap}. A Case is a contiguous run ` +
    `of years, so the load is refused rather than reading ${gap} as no data. Add the ` +
    `missing year's rows, or load each run of years as its own Case.`
  );
}

/**
 * The span of years `rowsByYear` covers, or why it is not one Case. A Case is
 * a contiguous run: a year inside it with no rows is refused, naming the
 * years, rather than read as a year of no data.
 */
export function yearSpanOf(
  who: string,
  rowsByYear: ReadonlyMap<number, number>,
): { span: YearSpan; refusal?: undefined } | { span?: undefined; refusal: string } {
  const years = [...rowsByYear.keys()].filter((y) => rowsByYear.get(y)! > 0).sort((a, b) => a - b);
  if (years.length === 0) {
    return {
      refusal:
        `${who} no row with a Date this reader can read (M/D/YYYY), so the Case's years are ` +
        `unknown and the load is refused.`,
    };
  }
  const firstYear = years[0];
  const numYears = years[years.length - 1] - firstYear + 1;
  if (numYears > MAX_CASE_YEARS) {
    return {
      refusal:
        `${who} rows dated ${firstYear} to ${firstYear + numYears - 1}, ${numYears} years. A Case ` +
        `spans at most ${MAX_CASE_YEARS} years, so the load is refused.`,
    };
  }
  const missing: number[] = [];
  for (let y = firstYear; y < firstYear + numYears; y++) if (!rowsByYear.get(y)) missing.push(y);
  if (missing.length > 0) return { refusal: yearGapRefusal(who, years, missing) };
  return { span: { firstYear, numYears } };
}

/** "1420 of 2036 (Feb 29, hour ending 5)": a span hour as its year's slot
 * hour, and as the file would date it. */
export function spanHourLabel(firstYear: number, spanHour: number): string {
  const hour = spanHour % YEAR_SLOT_HOURS;
  const year = firstYear + (spanHour - hour) / YEAR_SLOT_HOURS;
  return `${hour} of ${year} (${dayLabel(Math.floor(hour / 24))}, hour ending ${(hour % 24) + 1})`;
}

/** "2034" or "2034-2036": a span as a refusal names it. */
export function spanLabel(span: YearSpan): string {
  const last = span.firstYear + span.numYears - 1;
  return last === span.firstYear ? `${span.firstYear}` : `${span.firstYear}-${last}`;
}

// ---------------------------------------------------------------- cube cost

/** One factor of a cube's size other than its hours: a count and its noun. */
export interface CubeFactor {
  count: number;
  one: string;
  many: string;
}

/** What a cube asks for, and the product worded. */
export interface CubeCost {
  bytes: number;
  /** "3 metrics × 1,200 buses × 2 years × 8,784 h × 4 B = 253 MB". */
  arithmetic: string;
}

/**
 * The Float32 cube `factors` × `years` slots of 8,784 hours allocates. Every
 * picker, confirmation and allocation refusal words its number through this,
 * so the figure a picker shows is the product the refusal names. `years` is
 * summed over the cubes a batch builds, one per file.
 */
export function cubeCost(factors: readonly CubeFactor[], years: number): CubeCost {
  const terms = [...factors, { count: years, one: 'year', many: 'years' }];
  const bytes =
    terms.reduce((product, term) => product * term.count, 1) *
    YEAR_SLOT_HOURS *
    Float32Array.BYTES_PER_ELEMENT;
  const words = terms.map(
    (term) => `${term.count.toLocaleString()} ${term.count === 1 ? term.one : term.many}`,
  );
  return {
    bytes,
    arithmetic:
      `${words.join(' × ')} × ${YEAR_SLOT_HOURS.toLocaleString()} h × ` +
      `${Float32Array.BYTES_PER_ELEMENT} B = ${megabytes(bytes)} MB`,
  };
}

/** Every size the app shows, as the number before "MB". Decimal (10^6 B):
 * the arithmetic it ends is "× 4 B" and a file manager counts the same way,
 * so a MiB figure labelled MB would disagree with both. */
export function megabytes(bytes: number): string {
  const value = bytes / 1e6;
  return value < 10 ? value.toFixed(1) : Math.round(value).toLocaleString();
}

// ---------------------------------------------------------------- feature gate

/** The wasm-feature-detect SIMD128 probe: a module whose only proposal
 * instruction is `i8x16.splat`, so validation fails without SIMD. The exact
 * bytes matter: a variant that declares a v128 result and drops it is a type
 * error and validates false everywhere. */
// One wasm section per line, each labelled with what it encodes.
// prettier-ignore
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, // magic + version
  1, 4, 1, 96, 0, 0, // type: () -> ()
  3, 2, 1, 0, // one function of that type
  10, 9, 1, 7, 0, 65, 0, 253, 15, 26, 11, // i32.const 0; i8x16.splat; drop; end
]);

/** There is no scalar JS fallback: feature-detect and refuse instead. */
export function hasSimd(): boolean {
  return typeof WebAssembly === 'object' && WebAssembly.validate(SIMD_PROBE);
}

export const NO_SIMD_MESSAGE =
  'This tool needs WebAssembly SIMD, which has shipped in Chrome and Edge since ' +
  'version 91 (May 2021). Please open it in an up-to-date Chrome or Edge.';

// ---------------------------------------------------------------- the pool

/**
 * The most workers either pool will build: a MEMORY cap. Each worker's wasm
 * memory is fixed at instantiation and never returned, so this multiplies the
 * per-instance cost (58.7 MB across both kinds) into what an idle tab holds:
 * 4 workers is 235 MB, 8 would be 470 MB.
 *
 * The throughput cost is smaller than halving suggests: blitting, cube
 * allocation and finalizing are serial on the main thread, and a fixed block
 * size means interface-width files rarely produce more than 4 blocks anyway.
 * Raising it is a memory decision first.
 */
export const POOL_CAP = 4;

/** Workers per pool. The two pools do not know about each other, but a drop
 * dispatches one kind at a time, so they do not overlap. */
export function poolSize(): number {
  const cores = typeof navigator === 'undefined' ? 4 : (navigator.hardwareConcurrency ?? 4);
  return Math.max(1, Math.min(cores, POOL_CAP));
}

/**
 * One note from a pool's ingest call and the plans it is about, by index into
 * THIS call's plans. A merge group's note names every member. An empty list
 * is batch-level: the note is about the retained set, not about any file.
 * Attributed here, where the structure is known, because a filename prefix
 * cannot tell two same-named files apart and several notes name no file.
 */
export interface PlanWarning {
  message: string;
  plans: number[];
}

/** Notes about one merge group (or file), attributed to every member. */
export function aboutPlans(messages: readonly string[], plans: readonly number[]): PlanWarning[] {
  return messages.map((message) => ({ message, plans: [...plans] }));
}

// ---------------------------------------------------------- merge groups

/**
 * Which file's value a cell keeps when the files of one merge group overlap.
 * Files may split a table by ROW (dates, regions) or by COLUMN (one export of
 * generators per region, Area metrics abc in one file and xyz in another), so
 * one cell can be offered by two files. The FIRST file in the group keeps it,
 * and an hour keeps the first file's TOU. Blocks finish in any order, so
 * "first" is decided from what each file has claimed so far, never from
 * arrival: a file writes a cell unless an earlier file carrying that column
 * has already claimed the row, and an earlier file arriving later overwrites.
 * A blank cell is still the file's: the rule is per row, which is what a
 * row-claim bit can answer without a rank per cell.
 *
 * A ROW is the shape's, numbered YEAR-MAJOR so one year's rows are one run:
 * a span hour (wide), `(yearOffset x entities + entity) x 8784 + slotHour`
 * (long). A COLUMN is a cube column: an entity (wide), a metric (long). Each
 * file holds one bit per row of ITS OWN years, which also refuses a row
 * repeated inside it, and one TOU byte per hour, so a file is held to its
 * own TOU whichever file's TOU the hour keeps.
 */
export class FirstFile {
  /** Per member: one bit per row of `from[m]..to[m]` it has claimed. */
  private readonly claimed: Uint8Array[];
  private readonly from: number[];
  private readonly to: number[];
  /** Per member, per column: its group in `groups[member]`, or -1. */
  readonly groupOf: Int32Array[];
  /** Per member: the columns that share one list of other carriers. */
  readonly groups: { earlier: number[]; others: number[] }[][];
  /** Per member: no other file carries any of its columns, so every row it
   * claims is written and the caller may skip `decide`. */
  readonly alone: boolean[];
  /** Per column: the members carrying it, in group order. */
  private readonly carriers: number[][];
  /** Per member, per column group: 1 once another file had one of its rows. */
  private readonly clashedGroups: Uint8Array[];
  /** Per hour of the span: rank + 1 of the file whose TOU it holds; 0 none. */
  private readonly touRank: Uint16Array;
  /** Per member, per hour of the span: the TOU it stated, 0xFF none yet. */
  private readonly fileTou: Uint8Array[];

  /**
   * `presence`: per member, per cube column, 1 = this file carries it.
   * `rows`: per member, the run of rows its years cover, each end on a year
   * boundary. `hours`: the span's hours, for TOU.
   */
  constructor(
    presence: readonly Uint8Array[],
    rows: readonly { from: number; to: number }[],
    hours: number,
  ) {
    const columns = presence[0]?.length ?? 0;
    this.from = rows.map((run) => run.from);
    this.to = rows.map((run) => run.to);
    this.claimed = rows.map((run) => new Uint8Array(Math.ceil((run.to - run.from) / 8)));
    this.carriers = [];
    for (let c = 0; c < columns; c++) {
      this.carriers.push(presence.flatMap((carries, m) => (carries[c] ? [m] : [])));
    }
    this.groupOf = presence.map(() => new Int32Array(columns).fill(-1));
    this.groups = presence.map((carries, m) => {
      const byKey = new Map<string, number>();
      const groups: { earlier: number[]; others: number[] }[] = [];
      for (let c = 0; c < columns; c++) {
        if (!carries[c]) continue;
        const others = this.carriers[c].filter((g) => g !== m);
        const key = others.join(',');
        let group = byKey.get(key);
        if (group === undefined) {
          group = groups.length;
          byKey.set(key, group);
          groups.push({ earlier: others.filter((g) => g < m), others });
        }
        this.groupOf[m][c] = group;
      }
      return groups;
    });
    this.alone = this.groups.map((groups) => groups.every((group) => group.others.length === 0));
    this.clashedGroups = this.groups.map((groups) => new Uint8Array(groups.length));
    this.touRank = new Uint16Array(hours);
    this.fileTou = presence.map(() => new Uint8Array(hours).fill(0xff));
  }

  /** Claim `row` for `member`; false when that member already claimed it (a
   * row repeated inside one file, which the caller refuses). Throws on a row
   * outside the member's own years, which its parse should have refused. */
  claim(member: number, row: number): boolean {
    const at = row - this.from[member];
    if (at < 0 || row >= this.to[member]) {
      throw new Error(`A row is dated outside the years its own file states.`);
    }
    // `>>> 3`, not `>> 3`: a run past 2^31 rows must not index negative.
    const bits = this.claimed[member];
    const byte = at >>> 3;
    const mask = 1 << (at & 7);
    if (bits[byte] & mask) return false;
    bits[byte] |= mask;
    return true;
  }

  private has(member: number, row: number): boolean {
    const at = row - this.from[member];
    if (at < 0 || row >= this.to[member]) return false;
    return (this.claimed[member][at >>> 3] & (1 << (at & 7))) !== 0;
  }

  /**
   * For each of `member`'s column groups, whether it writes `row`: 1 unless an
   * earlier carrier has claimed the row. Marks a clash on the group when any
   * other carrier has. `out` has one slot per group.
   */
  decide(member: number, row: number, out: Uint8Array): void {
    const groups = this.groups[member];
    for (let g = 0; g < groups.length; g++) {
      const { earlier, others } = groups[g];
      let write = 1;
      for (let i = 0; i < earlier.length; i++) {
        if (this.has(earlier[i], row)) {
          write = 0;
          break;
        }
      }
      out[g] = write;
      if (this.clashedGroups[member][g]) continue;
      let clash = write === 0;
      for (let i = 0; i < others.length && !clash; i++) clash = this.has(others[i], row);
      if (clash) this.clashedGroups[member][g] = 1;
    }
  }

  /** Per column: 1 when two files both had a row for it. */
  clashed(): Uint8Array {
    const out = new Uint8Array(this.carriers.length);
    this.groupOf.forEach((groupOf, m) => {
      for (let c = 0; c < groupOf.length; c++) {
        if (groupOf[c] >= 0 && this.clashedGroups[m][groupOf[c]]) out[c] = 1;
      }
    });
    return out;
  }

  /**
   * Record `member`'s TOU for `hour`. 'conflict' when the member stated
   * another TOU for that hour before (one file disagreeing with itself, which
   * the caller refuses); 'set' when the hour takes it, because no earlier file
   * has stated one; 'skip' otherwise, a later file's TOU being ignored.
   */
  touFor(member: number, hour: number, code: number): 'set' | 'skip' | 'conflict' {
    const own = this.fileTou[member];
    const stated = own[hour];
    if (stated !== 0xff && stated !== code) return 'conflict';
    // A long file states each hour once per entity: the rank is settled.
    if (stated === code && this.touRank[hour] <= member + 1) return 'skip';
    own[hour] = code;
    const held = this.touRank[hour];
    if (held !== 0 && held <= member + 1) return held === member + 1 ? 'set' : 'skip';
    this.touRank[hour] = member + 1;
    return 'set';
  }

  /** The TOU `member` stated for `hour`, 0xFF none: what a conflict names. */
  statedTou(member: number, hour: number): number {
    return this.fileTou[member][hour];
  }

  /**
   * Columns without a row that another file had: those rows read as no-data
   * in that column. Only files that carry some column count as having rows,
   * so a file whose columns were all left out says nothing about the others.
   */
  shortColumns(): number[] {
    const hasColumns = this.groups.map((groups) => groups.length > 0);
    const verdict = new Map<string, boolean>();
    const short: number[] = [];
    this.carriers.forEach((carriers, c) => {
      if (carriers.length === 0) return;
      const outsiders = this.claimed.flatMap((_, m) =>
        hasColumns[m] && !carriers.includes(m) ? [m] : [],
      );
      if (outsiders.length === 0) return;
      const key = carriers.join(',');
      let isShort = verdict.get(key);
      if (isShort === undefined) {
        isShort = outsiders.some((m) => this.uncovered(m, carriers));
        verdict.set(key, isShort);
      }
      if (isShort) short.push(c);
    });
    return short;
  }

  /** Has `member` a row none of `carriers` has? Byte-wise: runs start on a
   * year boundary, and a year's rows are a multiple of 8. */
  private uncovered(member: number, carriers: number[]): boolean {
    const bits = this.claimed[member];
    const base = this.from[member];
    for (let i = 0; i < bits.length; i++) {
      if (!bits[i]) continue;
      let theirs = 0;
      for (const m of carriers) {
        const at = base + i * 8 - this.from[m];
        if (at >= 0 && base + i * 8 < this.to[m]) theirs |= this.claimed[m][at / 8];
      }
      if (bits[i] & ~theirs) return true;
    }
    return false;
  }
}

/** A block's file's place in its merge group. A one-file accumulator built
 * without `members` takes any plan as its file; in a group an unknown plan is
 * a caller passing another plan than the group was built from. */
export function memberIndex<P>(members: readonly P[], plan: P): number {
  const index = members.indexOf(plan);
  if (index >= 0) return index;
  if (members.length === 1) return 0;
  throw new Error('A block arrived for a file that is not in its merge group.');
}

/** Each member's run of rows when a year holds `rowsPerYear` of them,
 * relative to the group's span. */
export function memberRows(
  span: YearSpan,
  members: readonly YearSpan[],
  rowsPerYear: number,
): { from: number; to: number }[] {
  return members.map((member) => {
    const from = (member.firstYear - span.firstYear) * rowsPerYear;
    return { from, to: from + member.numYears * rowsPerYear };
  });
}

/** The two notes a merge group's overlap earns, worded once for both shapes.
 * `noun` is what a column is: "generator", "metric". */
export function firstFileNotes(
  name: string,
  merge: FirstFile,
  columnNames: readonly string[],
  noun: string,
): string[] {
  const few = (names: string[]) =>
    `${names.slice(0, 3).join(', ')}${names.length > 3 ? ', …' : ''}`;
  const notes: string[] = [];
  const clashedColumns = merge.clashed();
  const clashed = columnNames.filter((_, c) => clashedColumns[c]);
  if (clashed.length > 0) {
    notes.push(
      `${name}: ${clashed.length} ${noun}(s) are in more than one of these files for the same ` +
        `hours (${few(clashed)}); the first file's values were kept.`,
    );
  }
  const short = merge.shortColumns().map((c) => columnNames[c]);
  if (short.length > 0) {
    notes.push(
      `${name}: ${short.length} ${noun}(s) are in only some of these files (${few(short)}) and ` +
        `cover only the rows their own files did.`,
    );
  }
  return notes;
}

export interface DispatchFailure {
  blockId: number;
  caseIndex: number;
  message: string;
}

/**
 * Split a batch's plans into the committable and the failed. `caseIndex` is
 * the ONLY attribution (never filename, never failure order), so this is a
 * pure function tested without workers. A plan with several failed blocks is
 * reported once, with its first message. Shared by every pool because kinds
 * may not import each other.
 */
export function partitionByFailure(
  plans: readonly { file: { name: string } }[],
  failures: readonly DispatchFailure[],
): { ok: number[]; failed: { index: number; message: string }[] } {
  const firstMessage = new Map<number, string>();
  for (const failure of failures) {
    const index = failure.caseIndex;
    if (!Number.isInteger(index) || index < 0 || index >= plans.length) {
      // Unattributable: committing would include a file whose blocks did not
      // parse, so refuse loudly.
      throw new Error(
        `a block failure carries caseIndex ${index}, which is not one of the ${plans.length} ` +
          `plan(s) dispatched: ${failure.message}`,
      );
    }
    if (!firstMessage.has(index)) firstMessage.set(index, failure.message);
  }

  const ok: number[] = [];
  const failed: { index: number; message: string }[] = [];
  for (let index = 0; index < plans.length; index++) {
    const message = firstMessage.get(index);
    if (message === undefined) ok.push(index);
    else failed.push({ index, message });
  }
  return { ok, failed };
}

// ---------------------------------------------------------------- worker dispatch
//
// Generic over `{blockId, caseIndex}` jobs and `{kind}` replies, so every pool
// shares one copy. No kind's domain logic may be added here.

/**
 * Post a setup message and wait for the worker's `ready`, resolving WITH the
 * reply: only the worker instantiated the module, so what it reports about
 * itself (the wide pool's slab geometry) arrives here.
 */
export function ready<T extends { kind: 'ready' } = { kind: 'ready' }>(
  worker: Worker,
  message: { kind: string },
): Promise<T> {
  return new Promise((resolve, reject) => {
    const handler = (event: MessageEvent) => {
      worker.removeEventListener('message', handler);
      const reply = event.data as { kind?: string };
      if (reply?.kind === 'ready') resolve(reply as T);
      else reject(new Error(`worker ${message.kind} failed: ${JSON.stringify(event.data)}`));
    };
    worker.addEventListener('message', handler);
    worker.postMessage(message);
  });
}

/**
 * Post one job and resolve with the first reply of kind `want`. One-shot: the
 * listener goes on the FIRST message and `blockId` is not checked, which is
 * why `dispatch` must never return while a loop awaits a reply.
 */
function runJob<T extends { kind: string }>(
  worker: Worker,
  job: unknown,
  want: T['kind'],
): Promise<T> {
  return new Promise((resolve, reject) => {
    const handler = (event: MessageEvent) => {
      worker.removeEventListener('message', handler);
      // Typed structurally: `want` is only `string` here, so it cannot narrow.
      const message = event.data as { kind: string; message?: string };
      if (message.kind === want) resolve(message as T);
      else if (message.kind === 'error') reject(new Error(message.message));
      else reject(new Error(`unexpected worker message: ${message.kind}`));
    };
    worker.addEventListener('message', handler);
    worker.postMessage(job);
  });
}

export interface DispatchOptions {
  onProgress?: (done: number, total: number) => void;
  /**
   * `true` (default): the first failure stops loops taking NEW jobs (in-flight
   * ones finish) and `dispatch` throws once all settle. `false`: every job runs
   * and failures are returned, not thrown (a never-dispatched job would look
   * like a clean parse). A PREDICATE decides per failure whether to stop, and
   * failures are still returned. Test with `=== true`: a predicate is truthy,
   * so a bare truthiness check would abort on every failure.
   */
  abortOnError?: boolean | ((failure: DispatchFailure) => boolean);
}

/**
 * Hand `jobs` to `workers`, one in flight per worker, for every kind's pool.
 * The reply type is the one type argument; the job stays structural.
 *
 * `Promise.allSettled`, not `Promise.all`: `all` would return while other
 * loops still have one-shot listeners registered, and a new batch posted to
 * the same pool could then be answered by a stale listener and blitted into
 * the wrong cube with nothing thrown. So every loop catches its own failures
 * and `dispatch` returns only after all have settled.
 */
export async function dispatch<T extends { kind: string }>(
  workers: Worker[],
  jobs: readonly { blockId: number; caseIndex: number }[],
  want: T['kind'],
  onResult: (result: T) => void,
  opts?: DispatchOptions,
): Promise<DispatchFailure[]> {
  const abortOnError = opts?.abortOnError ?? true;
  let next = 0;
  let done = 0;
  let aborted = false;
  const failures: DispatchFailure[] = [];

  const outcomes = await Promise.allSettled(
    // One job in flight per worker, or their handlers would race.
    workers.map(async (worker) => {
      for (;;) {
        // Checked before taking the NEXT job; an in-flight job finishes.
        if (aborted) return;
        const index = next++;
        if (index >= jobs.length) return;
        const job = jobs[index];
        try {
          onResult(await runJob<T>(worker, job, want));
          opts?.onProgress?.(++done, jobs.length);
        } catch (error) {
          const failure: DispatchFailure = {
            blockId: job.blockId,
            caseIndex: job.caseIndex,
            message: error instanceof Error ? error.message : String(error),
          };
          failures.push(failure);
          if (
            abortOnError === true ||
            (typeof abortOnError === 'function' && abortOnError(failure))
          ) {
            aborted = true;
          }
        }
      }
    }),
  );

  // No loop rethrows, so none rejects; the point is that all have SETTLED.
  if (outcomes.some((outcome) => outcome.status === 'rejected')) {
    throw new Error('dispatch: a worker loop rejected, which it must not do.');
  }

  if (abortOnError === true && failures.length > 0) {
    const first = failures[0];
    // Keep caseIndex on the thrown error: it is the only file attribution.
    throw Object.assign(new Error(first.message), {
      blockId: first.blockId,
      caseIndex: first.caseIndex,
    });
  }
  return failures;
}
