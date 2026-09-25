// tests/test_interface_attempt.mjs — the wide ingest pass (attempt +
// shrink-retry) under Node, via `ingestWithWorkers()` with stub workers
// (`makeStubWorker()` from test_pool_dispatch.mjs, extended to answer init
// and block messages). All plans are synthetic.
//
//   1. A retryable overflow ABORTS the attempt, and the retry starts from
//      EMPTY accumulators (smaller cut, more jobs, only the retry's rows).
//   2. An overflow at the smallest cut does not abort: every job runs and the
//      failure is attributed to its caseIndex.
//   3. A non-overflow failure never aborts; a sibling file still commits.
//   4. At settle, no stub has an in-flight job or stale listener.

import assert from 'node:assert/strict';
import './test_loader.mjs';
import { exportCsv, interfaceNames } from './test_fixtures_interface.mjs';

const { ingestWithWorkers, readCasePlan, unionOf } =
  await import('../src/tables/interface/pool.ts');

/** Interfaces per synthetic file. Named before the budget below, which is
 * sized from it. */
const NAMES_PER_FILE = 2;

/**
 * The byte budget the stubs report: a literal (no wasm here), sized so two
 * interfaces lay out at 4,096 rows and a year needs several blocks to cut,
 * retry and abort. The real arena would fit the year in one block.
 */
const SLAB_ROWS = 4096;
const BUDGET = {
  arenaBytes: SLAB_ROWS * (NAMES_PER_FILE * 4 + 3),
  inbufBytes: 12 * 1024 * 1024,
  abi: 3,
};
const { OVERFLOW_MARKER } = await import('../src/tables/interface/block.ts');
const { HOURS_PER_YEAR } = await import('../src/model/calendar.ts');

let checks = 0;
function ok(label) {
  checks++;
  console.log(`ok - ${label}`);
}

// ---------------------------------------------------------------- fixtures

// Two synthetic files, a full year each, so the block cut yields several
// jobs per file.
const NAMES = interfaceNames(NAMES_PER_FILE);
const FILE_A = new File([exportCsv({ names: NAMES, days: 365, hours: 24, seed: 1 })], 'case_a.csv');
const FILE_B = new File([exportCsv({ names: NAMES, days: 365, hours: 24, seed: 2 })], 'case_b.csv');

const PLANS = [await readCasePlan(FILE_A), await readCasePlan(FILE_B)];
const RETAINED = unionOf(PLANS);
assert.equal(RETAINED.length, 2, 'the two synthetic files share one 2-interface axis');

// ---------------------------------------------------------------- stub workers

/** The test_pool_dispatch.mjs stub, also answering `init` with `ready` and
 * `block` via `script`, replying on a macrotask so a job is truly in flight. */
function makeStubWorker(script) {
  let listeners = [];
  let inFlight = 0;
  return {
    postMessage(job) {
      inFlight++;
      setTimeout(() => {
        inFlight--;
        const data = job.kind === 'init' ? { kind: 'ready' } : script(job);
        const event = { data };
        // A real EventTarget snapshots the listener list for one dispatch; a
        // handler added later does not see this event, but one added earlier
        // and never removed does.
        for (const fn of listeners.slice()) fn(event);
      }, job.delay ?? 1);
    },
    addEventListener(type, fn) {
      if (type === 'message') listeners.push(fn);
    },
    removeEventListener(type, fn) {
      if (type === 'message') listeners = listeners.filter((l) => l !== fn);
    },
    get inFlight() {
      return inFlight;
    },
    get listenerCount() {
      return listeners.length;
    },
  };
}

/** Assert no stub is mid-job or still listening (behaviour 4). */
function assertSettled(workers, when) {
  for (const [i, worker] of workers.entries()) {
    assert.equal(worker.inFlight, 0, `${when}: worker ${i} has no in-flight job`);
    assert.equal(worker.listenerCount, 0, `${when}: worker ${i} has no stale listener`);
  }
}

/**
 * The scripted pool: records jobs, groups them into ATTEMPTS (a new
 * `blockId === 0` starts one), and answers each. `fail(job, ctx)` may return
 * an error; otherwise a job replies one row at hour `ctx.seq`, value
 * `attempt*1000 + seq*10 + plane`, so hours repeat only ACROSS attempts,
 * which the duplicate check refuses if a retry reuses an accumulator.
 */
function scriptedPool({ workerCount = 2, fail = () => null } = {}) {
  const attempts = [];
  const script = (job) => {
    let attempt = attempts[attempts.length - 1];
    if (job.blockId === 0 || attempt === undefined) {
      attempt = { jobs: [], perCase: new Map() };
      attempts.push(attempt);
    }
    attempt.jobs.push(job);
    const seq = attempt.perCase.get(job.caseIndex) ?? 0;
    attempt.perCase.set(job.caseIndex, seq + 1);

    const ctx = { attempt: attempts.length, seq };
    const message = fail(job, ctx);
    if (message !== null) return { kind: 'error', message };

    const planes = job.activePlanes.length;
    const data = new Float32Array(planes);
    for (let p = 0; p < planes; p++) data[p] = attempts.length * 1000 + seq * 10 + p;
    return {
      kind: 'done',
      blockId: job.blockId,
      caseIndex: job.caseIndex,
      rows: 1,
      data,
      rowHour: Uint16Array.from([seq % HOURS_PER_YEAR]),
      rowTou: Uint8Array.from([0]),
      feb29: 0,
    };
  };
  const workers = Array.from({ length: workerCount }, () => makeStubWorker(script));
  return { workers, attempts };
}

/** Jobs an attempt actually posted. */
function postedCount(attempt) {
  return attempt.jobs.length;
}

/**
 * Did this attempt run EVERY block it cut for `plan`? Checked by byte-range
 * contiguity from `dataStart` to `file.size`. Valid only for this file's
 * scenarios, where failures land at `seq === 0`: a failure on the LAST block
 * still lets that job finish, so an aborted attempt can still tile.
 */
function coversFile(attempt, caseIndex, plan) {
  const jobs = attempt.jobs
    .filter((j) => j.caseIndex === caseIndex)
    .sort((a, b) => a.start - b.start);
  if (jobs.length === 0) return false;
  if (jobs[0].start !== plan.dataStart) return false;
  for (let i = 1; i < jobs.length; i++) if (jobs[i].start !== jobs[i - 1].end) return false;
  return jobs[jobs.length - 1].end === plan.file.size;
}

const OVERFLOW_MESSAGE = `${OVERFLOW_MARKER}: 3 row(s) past the 4096-row block slab — this block held more rows than its byte length predicted.`;

// ------------------------------------------------- (1) overflow + retry, from empty

{
  // Case 0's FIRST block overflows on the first attempt only. `retryable` is
  // true at shrink 1, so that attempt must abort and the whole batch must be
  // re-cut smaller and re-parsed from empty cubes.
  const { workers, attempts } = scriptedPool({
    fail: (job, ctx) =>
      ctx.attempt === 1 && job.caseIndex === 0 && ctx.seq === 0 ? OVERFLOW_MESSAGE : null,
  });
  const result = await ingestWithWorkers(workers, BUDGET, PLANS, RETAINED);

  assert.equal(attempts.length, 2, 'the overflow triggered exactly one retry');
  const [first, second] = attempts;

  // (1a) the first attempt ABORTED: it never reached the tail of either file,
  // so neither file's byte range was covered.
  assert.equal(
    coversFile(first, 0, PLANS[0]),
    false,
    'the aborted attempt never ran case 0 to the end',
  );
  assert.equal(
    coversFile(first, 1, PLANS[1]),
    false,
    'the aborted attempt never ran case 1 to the end',
  );

  // (1b) the retry re-cut the batch SMALLER, ran every block of both files,
  // and so posted more jobs than the first attempt.
  assert.ok(coversFile(second, 0, PLANS[0]), 'the retry ran every block of case 0');
  assert.ok(coversFile(second, 1, PLANS[1]), 'the retry ran every block of case 1');
  assert.ok(
    postedCount(second) > postedCount(first),
    'the retry posted more jobs than the aborted attempt',
  );
  const firstSpan = first.jobs[0].end - first.jobs[0].start;
  const secondSpan = second.jobs[0].end - second.jobs[0].start;
  assert.ok(
    secondSpan < firstSpan,
    `the retry's block is smaller (${secondSpan} B < ${firstSpan} B)`,
  );

  // (1c) the retry ran EVERY job it cut, and nothing failed.
  assert.deepEqual(result.failures, [], 'the retry parsed clean, so no plan failed');
  assert.deepEqual(result.ok, [0, 1], 'both files committed');
  assert.equal(result.cases.length, 2);

  // (1d) The committed cubes hold ONLY the retry's rows.
  for (const table of result.cases) {
    for (let plane = 0; plane < 2; plane++) {
      assert.equal(
        table.cube[plane * HOURS_PER_YEAR + 0],
        2000 + 0 * 10 + plane,
        "hour 0 carries the RETRY's value, not the aborted attempt's",
      );
      assert.equal(
        table.cube[plane * HOURS_PER_YEAR + 1],
        2000 + 1 * 10 + plane,
        "hour 1 carries the RETRY's value",
      );
    }
    // An hour no job claimed is still NaN, not a plausible zero.
    assert.ok(Number.isNaN(table.cube[HOURS_PER_YEAR - 1]), 'unwritten hours stay NaN');
  }
  ok(
    'an overflow while retryable aborts the attempt and the retry re-runs, smaller, from EMPTY accumulators',
  );

  // ---------------------------------------------------------------- (4)
  assertSettled(workers, 'after a retrying ingest');
  ok('after a retry over the same workers, no stub has an in-flight job or a stale listener');

  // and the proof that nothing stale is left: a fresh ingest over the SAME
  // stubs sees only its own batch's replies.
  const clean = await ingestWithWorkers(workers, BUDGET, PLANS, RETAINED);
  assert.deepEqual(clean.failures, []);
  assert.deepEqual(clean.ok, [0, 1]);
  assert.equal(attempts.length, 3, 'the clean ingest was one further attempt');
  for (const table of clean.cases) {
    assert.equal(
      table.cube[0],
      3000,
      "the clean ingest's cube carries its own attempt's value, not a message left over from the retry",
    );
  }
  assertSettled(workers, 'after a clean ingest over the same workers');
  ok('a later ingest over the same stubs receives no message left over from the aborted attempt');
}

// ------------------------------------------- (2) overflow at the smallest cut

{
  // Case 0's first block overflows on EVERY attempt. shrink goes 1, 4, 16, 64;
  // at 64 `retryable` is false, so that attempt must NOT abort: every
  // remaining job runs and the overflow is recorded against case 0.
  const { workers, attempts } = scriptedPool({
    fail: (job, ctx) => (job.caseIndex === 0 && ctx.seq === 0 ? OVERFLOW_MESSAGE : null),
  });
  const result = await ingestWithWorkers(workers, BUDGET, PLANS, RETAINED);

  assert.equal(attempts.length, 4, 'four attempts: shrink 1, 4, 16, 64, and then no smaller cut');
  const last = attempts[3];

  // The final attempt ran every block for both files; the three before it,
  // still retryable, aborted.
  for (const attempt of attempts.slice(0, 3)) {
    assert.equal(
      coversFile(attempt, 1, PLANS[1]),
      false,
      'a retryable overflow aborted its attempt',
    );
  }
  assert.ok(
    coversFile(last, 0, PLANS[0]),
    'the unretryable attempt still ran every remaining block of case 0',
  );
  assert.ok(
    coversFile(last, 1, PLANS[1]),
    'the unretryable attempt ran every block of the sibling file',
  );
  assert.ok(
    postedCount(last) > 4 * postedCount(attempts[2]),
    'the final attempt is the one that ran the batch',
  );

  // The failure belongs to case 0 and to case 0 alone.
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].index, 0, 'the overflow is attributed to its own caseIndex');
  assert.equal(result.failures[0].file, 'case_a.csv');
  assert.ok(result.failures[0].message.includes(OVERFLOW_MARKER));
  assert.deepEqual(result.ok, [1], 'the sibling file still commits');
  assert.equal(result.cases.length, 1);
  assert.equal(result.cases[0].cube[0], 4000, "the committed cube holds the FINAL attempt's rows");
  ok(
    'an overflow at the smallest cut is recorded against its own file and does NOT abort the batch',
  );

  assertSettled(workers, 'after an unretryable overflow');
  ok('an unretryable-overflow batch leaves every worker loop settled');
}

// ------------------------------------------- (3) a non-overflow failure never aborts

{
  // Case 0's first block fails with an ordinary parse refusal. There is no
  // smaller cut that fixes it, so there must be exactly ONE attempt, it must
  // run every job, and case 1 must commit in full.
  const REFUSAL = 'row 12: Hour "25" is outside hour-ending 1-24.';
  const { workers, attempts } = scriptedPool({
    fail: (job, ctx) => (job.caseIndex === 0 && ctx.seq === 0 ? REFUSAL : null),
  });
  const result = await ingestWithWorkers(workers, BUDGET, PLANS, RETAINED);

  assert.equal(attempts.length, 1, 'a non-overflow failure is not retried at a smaller block size');
  const only = attempts[0];

  // Every block of BOTH files ran — the failing file's remaining blocks and,
  // above all, the sibling's, right through to the last byte of each.
  assert.ok(coversFile(only, 0, PLANS[0]), "the failing file's remaining blocks still ran");
  assert.ok(
    coversFile(only, 1, PLANS[1]),
    "the sibling file's blocks all ran despite case 0 failing",
  );
  const caseOneJobs = only.jobs.filter((j) => j.caseIndex === 1).length;
  assert.ok(caseOneJobs > 1, 'the sibling file really was cut into several blocks');

  assert.deepEqual(
    result.failures.map((f) => ({ index: f.index, file: f.file, message: f.message })),
    [{ index: 0, file: 'case_a.csv', message: REFUSAL }],
    'the refusal is attributed to its own file and no other file is blamed',
  );
  assert.deepEqual(result.ok, [1], 'the sibling file still commits (not silent data loss)');
  assert.equal(result.cases.length, 1);
  // Every one of the sibling's blocks landed: one row per job, hours 0..n-1.
  for (let seq = 0; seq < caseOneJobs; seq++) {
    assert.equal(
      result.cases[0].cube[seq],
      1000 + seq * 10,
      `the sibling's block ${seq} was blitted, so no job of its was skipped`,
    );
  }
  ok('a non-overflow failure never aborts: the sibling file runs every block and still commits');

  assertSettled(workers, 'after a non-overflow failure');
  ok('a batch with a non-retryable failure leaves every worker loop settled');
}

console.log(`1..${checks}`);
