// tests/test_partial_import.mjs — per-file partial failure.
//
// What it covers is the
// The ATTRIBUTION half: `partitionByFailure(plans, failures)`, the pure
// function both pools use to decide which files commit and which are named
// back to the user. It needs no worker, no wasm and no File, which is exactly
// why the attribution was factored out of `ingest` in the first place.
//
// The rule it guards: a block failure is attributed
// to its file through `caseIndex` and through NOTHING else -- not the
// filename, which one drop can legitimately carry twice from two folders, and
// not the order the failures arrived in, which is whatever order the workers
// happened to finish in.
//
// The rule it guards: a file with ANY failed block is excluded, its
// half-filled accumulator discarded. Its siblings still commit.
//
// Run: node test_partial_import.mjs

import assert from 'node:assert/strict';
import './test_loader.mjs';

const areaPool = await import('../src/tables/long/pool.ts');
const interfacePool = await import('../src/tables/interface/pool.ts');

let checks = 0;
function ok(label) {
  checks++;
  console.log(`ok - ${label}`);
}

/** A plan stands in for a `CasePlan`: `partitionByFailure` reads nothing off
 * it but `file.name`, and takes it structurally so this file can. */
function planFor(name) {
  return { file: { name } };
}

// One copy of this function now lives in `src/ingest.ts` and both pools
// re-export it -- no table-kind module imports another table-kind module, so
// neither pool can own it. Every case below still runs against BOTH re-exports:
// they must stay the same function, because a divergence would be a divergence
// in what "this file failed" means between the area and interface paths.
const IMPLEMENTATIONS = [
  ['area', areaPool.partitionByFailure],
  ['interface', interfacePool.partitionByFailure],
];

// ---------------------------------------------------------------- the split

// Three files. The middle one fails TWICE (a truncated file fails every block
// after the tear), and its failures do not arrive first or last.
const plans = [planFor('run-a.csv'), planFor('run-b.csv'), planFor('run-c.csv')];
const failures = [
  { blockId: 7, caseIndex: 1, message: 'run-b.csv: block 7 ended mid-row.' },
  { blockId: 3, caseIndex: 1, message: 'run-b.csv: block 3 ended mid-row.' },
];

for (const [kind, partitionByFailure] of IMPLEMENTATIONS) {
  const { ok: survived, failed } = partitionByFailure(plans, failures);

  assert.deepEqual(survived, [0, 2], `${kind}: the two clean files survive, by index`);
  ok(`${kind}: a sibling file's failure does not stop the files that parsed`);

  assert.equal(failed.length, 1, `${kind}: the failed file is reported ONCE, not once per block`);
  assert.deepEqual(failed[0], {
    index: 1,
    // The FIRST message recorded for that file, not the lowest blockId and not
    // the last to arrive: fifty notes about one truncated file is not an
    // account of what happened.
    message: 'run-b.csv: block 7 ended mid-row.',
  });
  ok(`${kind}: a file with two failed blocks is reported once, with its first message`);

  // No index is lost and none is duplicated: every plan is on exactly one
  // side of the split. A lost index silently drops a file the user dropped;
  // a duplicated one would attach the same table to two Cases.
  const seen = [...survived, ...failed.map((entry) => entry.index)].sort((a, b) => a - b);
  assert.deepEqual(seen, [0, 1, 2], `${kind}: every plan lands on exactly one side`);
  ok(`${kind}: no plan index is lost or duplicated across the split`);
}

// ---------------------------------------------------------------- by index only

// Two files of the SAME name from two folders, which one drop can carry.
// Attribution by filename would blame both; attribution by caseIndex blames
// the one whose block actually failed.
for (const [kind, partitionByFailure] of IMPLEMENTATIONS) {
  const sameName = [planFor('01.csv'), planFor('01.csv')];
  // caseIndex: 1 -- not 0 -- so a filename-based (findIndex-by-name)
  // implementation, which would resolve either failure to index 0 (the
  // FIRST name match), is distinguishable from the real caseIndex-based one.
  const { ok: survived, failed } = partitionByFailure(sameName, [
    { blockId: 0, caseIndex: 1, message: 'block 0 refused' },
  ]);
  assert.deepEqual(survived, [0]);
  assert.deepEqual(failed, [{ index: 1, message: 'block 0 refused' }]);
  ok(`${kind}: two files of one name are told apart by caseIndex, not by filename`);
}

// ---------------------------------------------------------------- degenerate

for (const [kind, partitionByFailure] of IMPLEMENTATIONS) {
  assert.deepEqual(partitionByFailure(plans, []), { ok: [0, 1, 2], failed: [] });
  ok(`${kind}: a batch with no failures commits every file`);

  const everything = partitionByFailure(plans, [
    { blockId: 0, caseIndex: 0, message: 'a' },
    { blockId: 1, caseIndex: 1, message: 'b' },
    { blockId: 2, caseIndex: 2, message: 'c' },
  ]);
  assert.deepEqual(everything.ok, []);
  assert.deepEqual(
    everything.failed.map((entry) => entry.index),
    [0, 1, 2],
    'the failures are reported in PLAN order, not arrival order',
  );
  ok(`${kind}: a batch where every file failed commits nothing and names all three`);

  assert.deepEqual(partitionByFailure([], []), { ok: [], failed: [] });
  ok(`${kind}: an empty batch is empty on both sides`);
}

// ---------------------------------------------------------------- unattributable

// A failure whose caseIndex belongs to no plan cannot be attributed. Dropping
// it would commit a file whose blocks did not parse -- the silent
// wrong-numbers outcome the whole split exists to prevent -- so it is refused
// loudly instead.
for (const [kind, partitionByFailure] of IMPLEMENTATIONS) {
  for (const bad of [3, -1, 1.5, Number.NaN, undefined]) {
    assert.throws(
      () => partitionByFailure(plans, [{ blockId: 0, caseIndex: bad, message: 'x' }]),
      /caseIndex/,
      `${kind}: caseIndex ${String(bad)} is refused rather than silently dropped`,
    );
  }
  ok(`${kind}: a failure that cannot be attributed to a plan is refused, not ignored`);
}

console.log(`1..${checks}`);
