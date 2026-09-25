// tests/test_pool_dispatch.mjs — dispatch() settledness, with stub workers.
//
// `runJob` resolves on a worker's first message without checking `blockId`,
// so dispatch() must not return while any loop still awaits a reply, or a new
// batch could be answered by a stale listener.
//
//   (a) dispatch() rejects with the failing block's own message.
//   (b) when it settles, no stub has an in-flight job or stale listener.
//   (c) a second dispatch() on the same stubs sees none of the first's
//       messages.

import assert from 'node:assert/strict';
import './test_loader.mjs';

const { dispatch } = await import('../src/tables/long/pool.ts');

let checks = 0;
function ok(label) {
  checks++;
  console.log(`ok - ${label}`);
}

/** A stub worker with the surface `runJob` uses, replying on a macrotask so a
 * job is really in flight for a tick. */
function makeStubWorker() {
  let listeners = [];
  let inFlight = 0;
  return {
    postMessage(job) {
      inFlight++;
      const delay = job.delay ?? 4;
      setTimeout(() => {
        inFlight--;
        const data = job.errorMessage
          ? { kind: 'error', message: job.errorMessage }
          : { kind: 'done', blockId: job.blockId, caseIndex: job.caseIndex };
        const event = { data };
        // Snapshot the listeners, as a real EventTarget does per dispatch.
        for (const fn of listeners.slice()) fn(event);
      }, delay);
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

// ---------------------------------------------------------------- (a) + (b)

const workers = [makeStubWorker(), makeStubWorker()];

// 4 jobs over 2 workers: block 2 fails while block 3 is still in flight.
const ERROR_MESSAGE = 'block 2 refused: synthetic failure';
const firstBatch = [
  { kind: 'block', blockId: 0, caseIndex: 0, delay: 4 },
  { kind: 'block', blockId: 1, caseIndex: 1, delay: 4 },
  { kind: 'block', blockId: 2, caseIndex: 2, errorMessage: ERROR_MESSAGE, delay: 0 },
  { kind: 'block', blockId: 3, caseIndex: 3, delay: 10 },
];

const results1 = [];
let caught = null;
try {
  await dispatch(workers, firstBatch, 'done', (result) => results1.push(result));
} catch (error) {
  caught = error;
}

assert.ok(caught instanceof Error, 'dispatch() rejected rather than resolving');
assert.equal(caught.message, ERROR_MESSAGE);
ok("dispatch() rejects with the failing block's own message");

// Block 4 never existed, so blocks 0, 1 and 3 are the only ones that can have
// completed; block 2 failed and, with abortOnError defaulting true, no
// worker picks up further work after it.
assert.equal(results1.length, 3, 'the 3 jobs in flight before/at the failure all completed');
assert.deepEqual(
  results1.map((r) => r.blockId).sort((a, b) => a - b),
  [0, 1, 3],
);

for (const [i, worker] of workers.entries()) {
  assert.equal(
    worker.inFlight,
    0,
    `worker ${i} has no outstanding in-flight job once dispatch() has settled`,
  );
  assert.equal(
    worker.listenerCount,
    0,
    `worker ${i} has no stale listener once dispatch() has settled`,
  );
}
ok(
  'at the moment dispatch() settles, no stub has an outstanding in-flight job (or a stale listener)',
);

// ---------------------------------------------------------------- (c)

const secondBatch = [
  { kind: 'block', blockId: 100, caseIndex: 0, delay: 2 },
  { kind: 'block', blockId: 101, caseIndex: 1, delay: 2 },
];
const results2 = [];
const failures2 = await dispatch(workers, secondBatch, 'done', (result) => results2.push(result));

assert.deepEqual(
  failures2,
  [],
  'the second dispatch over the same stubs has no failures of its own',
);
assert.equal(
  results2.length,
  secondBatch.length,
  "the second dispatch delivers exactly its own jobs' results",
);
for (const result of results2) {
  assert.ok(
    result.blockId >= 100,
    `result ${result.blockId} belongs to the second batch, not a message left over from the first`,
  );
}
for (const [i, worker] of workers.entries()) {
  assert.equal(
    worker.inFlight,
    0,
    `worker ${i} has no outstanding job after the second dispatch either`,
  );
  assert.equal(
    worker.listenerCount,
    0,
    `worker ${i} has no listener left registered after the second dispatch`,
  );
}
ok('a second dispatch over the same stubs receives no message left over from the first');

// ---------------------------------------------------------------- abortOnError: false

// Both Area passes pass `abortOnError: false`, because a
// sibling file's block failure must not stop the batch. Every job still runs,
// and every failure is collected rather than only the first.
const workers2 = [makeStubWorker()];
const thirdBatch = [
  { kind: 'block', blockId: 200, caseIndex: 0, errorMessage: 'first failure', delay: 2 },
  { kind: 'block', blockId: 201, caseIndex: 1, delay: 2 },
  { kind: 'block', blockId: 202, caseIndex: 2, errorMessage: 'second failure', delay: 2 },
];
const results3 = [];
const failures3 = await dispatch(workers2, thirdBatch, 'done', (result) => results3.push(result), {
  abortOnError: false,
});
assert.deepEqual(
  results3.map((r) => r.blockId),
  [201],
);
assert.deepEqual(
  // caseIndex is the attribution mechanism per-file failure depends on (a block
  // failure maps back to its file only through it) -- assert it, not just
  // blockId and message.
  failures3.map((f) => ({ blockId: f.blockId, caseIndex: f.caseIndex, message: f.message })),
  [
    { blockId: 200, caseIndex: 0, message: 'first failure' },
    { blockId: 202, caseIndex: 2, message: 'second failure' },
  ],
);
ok('abortOnError: false runs every job and returns every failure instead of throwing');

// ------------------------------------------- abortOnError: false, several workers

// Several files interleaved, one failing early; the rest still run, and
// results and failures are asserted per case via `caseIndex`.
const workers3 = [makeStubWorker(), makeStubWorker(), makeStubWorker()];
const fourthBatch = [
  // file 0: two blocks, both fine.
  { kind: 'block', blockId: 300, caseIndex: 0, delay: 6 },
  { kind: 'block', blockId: 301, caseIndex: 0, delay: 2 },
  // file 1: fails on its FIRST block and again on its second -- a truncated
  // file fails every block after the tear.
  { kind: 'block', blockId: 310, caseIndex: 1, errorMessage: 'file 1 block 310 refused', delay: 0 },
  { kind: 'block', blockId: 311, caseIndex: 1, errorMessage: 'file 1 block 311 refused', delay: 1 },
  // file 2: two blocks, both fine, both dispatched AFTER file 1 has failed.
  { kind: 'block', blockId: 320, caseIndex: 2, delay: 3 },
  { kind: 'block', blockId: 321, caseIndex: 2, delay: 8 },
];

const results4 = [];
const failures4 = await dispatch(workers3, fourthBatch, 'done', (result) => results4.push(result), {
  abortOnError: false,
});

assert.deepEqual(
  results4.map((r) => r.blockId).sort((a, b) => a - b),
  [300, 301, 320, 321],
  'every block of the files that did not fail completed, including blocks queued after the failure',
);
assert.deepEqual(
  failures4.map((f) => f.caseIndex),
  [1, 1],
  "both of the failing file's blocks are reported, and no other file is blamed",
);
assert.deepEqual(
  failures4.map((f) => f.blockId).sort((a, b) => a - b),
  [310, 311],
);
ok('abortOnError: false lets sibling files finish while one file fails every block');

// When dispatch() settles, no worker awaits a reply and no listener remains.
for (const [i, worker] of workers3.entries()) {
  assert.equal(worker.inFlight, 0, `worker ${i} has no in-flight job after the failing batch`);
  assert.equal(
    worker.listenerCount,
    0,
    `worker ${i} has no stale listener after the failing batch`,
  );
}
ok('a batch with failures still leaves every worker loop settled before dispatch() returns');

// ---------------------------------------------------------------- abortOnError: predicate

// (1) A matching predicate aborts the batch, but dispatch() RETURNS the
// failure rather than throwing it -- only the literal `true` throws -- and
// jobs queued after the abort point never run.
const workers4 = [makeStubWorker(), makeStubWorker()];
const PREDICATE_MESSAGE = 'boom-predicate';
const fifthBatch = [
  { kind: 'block', blockId: 400, caseIndex: 0, delay: 4 },
  { kind: 'block', blockId: 401, caseIndex: 1, errorMessage: PREDICATE_MESSAGE, delay: 0 },
  { kind: 'block', blockId: 402, caseIndex: 2, delay: 20 },
  { kind: 'block', blockId: 403, caseIndex: 3, delay: 20 },
];
const results5 = [];
let threw5 = null;
let failures5 = null;
try {
  failures5 = await dispatch(workers4, fifthBatch, 'done', (result) => results5.push(result), {
    abortOnError: (failure) => failure.message === PREDICATE_MESSAGE,
  });
} catch (error) {
  threw5 = error;
}
assert.equal(threw5, null, 'a matching predicate does not make dispatch() throw');
assert.deepEqual(
  failures5.map((f) => ({ blockId: f.blockId, caseIndex: f.caseIndex, message: f.message })),
  [{ blockId: 401, caseIndex: 1, message: PREDICATE_MESSAGE }],
);
assert.deepEqual(
  results5.map((r) => r.blockId).sort((a, b) => a - b),
  [400],
  'blocks queued after the abort point never ran',
);
ok('a matching predicate aborts and dispatch() returns the failure instead of throwing');

// The same settledness under the predicate form.
for (const [i, worker] of workers4.entries()) {
  assert.equal(
    worker.inFlight,
    0,
    `predicate abort: worker ${i} has no in-flight job once dispatch() has settled`,
  );
  assert.equal(
    worker.listenerCount,
    0,
    `predicate abort: worker ${i} has no stale listener once dispatch() has settled`,
  );
}
const settleBatch = [
  { kind: 'block', blockId: 500, caseIndex: 0, delay: 2 },
  { kind: 'block', blockId: 501, caseIndex: 1, delay: 2 },
];
const resultsSettle = [];
const failuresSettle = await dispatch(workers4, settleBatch, 'done', (result) =>
  resultsSettle.push(result),
);
assert.deepEqual(failuresSettle, []);
assert.deepEqual(
  resultsSettle.map((r) => r.blockId).sort((a, b) => a - b),
  [500, 501],
);
ok(
  "predicate abort settles cleanly: a later dispatch over the same stubs sees none of the aborted batch's messages",
);

// (2) A non-matching predicate does NOT abort: every job runs and every
// failure returns (bare truthiness would abort after the first).
const workers5 = [makeStubWorker()];
const sixthBatch = [
  { kind: 'block', blockId: 600, caseIndex: 0, errorMessage: 'first failure', delay: 2 },
  { kind: 'block', blockId: 601, caseIndex: 1, delay: 2 },
  { kind: 'block', blockId: 602, caseIndex: 2, errorMessage: 'second failure', delay: 2 },
  { kind: 'block', blockId: 603, caseIndex: 3, delay: 2 },
];
const results6 = [];
const failures6 = await dispatch(workers5, sixthBatch, 'done', (result) => results6.push(result), {
  abortOnError: () => false,
});
assert.deepEqual(
  results6.map((r) => r.blockId).sort((a, b) => a - b),
  [601, 603],
  'every non-failing job ran, including the one queued after the second failure',
);
assert.deepEqual(
  failures6.map((f) => ({ blockId: f.blockId, caseIndex: f.caseIndex, message: f.message })),
  [
    { blockId: 600, caseIndex: 0, message: 'first failure' },
    { blockId: 602, caseIndex: 2, message: 'second failure' },
  ],
);
ok('a non-matching predicate never aborts: every job runs and every failure is returned');

// (4) The predicate is called with a real DispatchFailure -- blockId,
// caseIndex and message matching the job that actually failed.
const seen = [];
const workers6 = [makeStubWorker()];
const seventhBatch = [
  { kind: 'block', blockId: 700, caseIndex: 9, errorMessage: 'predicate-arg-check', delay: 1 },
];
await dispatch(workers6, seventhBatch, 'done', () => {}, {
  abortOnError: (failure) => {
    seen.push(failure);
    return true;
  },
});
assert.equal(seen.length, 1, 'the predicate was consulted exactly once for the one failure');
assert.deepEqual(seen[0], { blockId: 700, caseIndex: 9, message: 'predicate-arg-check' });
ok('the predicate is called with a real DispatchFailure (blockId, caseIndex, message)');

console.log(`1..${checks}`);
