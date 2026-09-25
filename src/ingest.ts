// src/ingest.ts
//
// Ingest helpers that are the same for every table kind: CSV line hygiene,
// the non-leap calendar, the SIMD gate, the worker count, the dispatch loop,
// and the failure attribution that makes partial import safe. Nothing here
// knows what a column MEANS.

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

/** Cumulative days before each month, non-leap (the table both `block.c`
 * files use). */
const CUM = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

/** Day-of-year (0-based) for a 1-based month/day, or -1 for Feb 29 / invalid. */
export function dayOfYear(month: number, day: number): number {
  if (month < 1 || month > 12 || day < 1 || day > 31) return -1;
  if (month === 2 && day === 29) return -1; // Feb 29 is dropped at ingest
  return CUM[month - 1] + day - 1;
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
