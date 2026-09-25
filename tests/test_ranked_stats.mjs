// tests/test_ranked_stats.mjs — the browse table's one masked pass:
//
//   * It agrees value for value with per-series `stats`/`quantiles`.
//   * A row the case lacks is blank (n = 0), never NaN among real numbers.
//   * Blank rows sort last in both directions.
//   * It touches only the planes it is handed.

import assert from 'node:assert/strict';
import './test_loader.mjs';

const {
  RANKED,
  RANKED_FIELDS,
  applyMask,
  createScratch,
  quantiles,
  rankedRow,
  rankedStats,
  stats,
} = await import('../src/kernels.ts');
const { HOURS_PER_YEAR } = await import('../src/model/calendar.ts');

const HOURS = HOURS_PER_YEAR;
let checks = 0;
function ok(label) {
  checks++;
  console.log(`ok - ${label}`);
}

/** A cube of `entities` planes, plane `e` filled by `fill(e, hour)`.
 * `absent` names entity indexes whose plane is all NaN. */
function makeCube(entities, fill, absent = []) {
  const cube = new Float32Array(entities * HOURS);
  for (let e = 0; e < entities; e++) {
    const gone = absent.includes(e);
    for (let h = 0; h < HOURS; h++) {
      cube[e * HOURS + h] = gone ? NaN : fill(e, h);
    }
  }
  return cube;
}

function allHours() {
  return new Uint8Array(HOURS).fill(1);
}

/** The per-series path, run row by row: what the ranked pass must reproduce. */
function oracle(cube, start, mask) {
  const scratch = createScratch();
  const n = applyMask(cube.subarray(start, start + HOURS), mask, scratch);
  const summary = stats(scratch, n);
  const spread = quantiles(scratch, n);
  return { ...summary, p25: spread.p25, p75: spread.p75 };
}

// --- 1. Every row agrees with the per-series path ---------------------------
{
  const entities = 6;
  const cube = makeCube(entities, (e, h) => Math.sin(h / 97) * (e + 1) * 10 + e);
  const mask = allHours();
  const starts = Int32Array.from({ length: entities }, (_, e) => e * HOURS);
  const result = rankedStats(cube, starts, mask);

  assert.equal(result.length, entities * RANKED_FIELDS);
  for (let e = 0; e < entities; e++) {
    const expected = oracle(cube, e * HOURS, mask);
    const got = rankedRow(result, e);
    assert.equal(got.n, expected.n);
    for (const field of ['mean', 'min', 'max', 'sd', 'p25', 'p75', 'sum']) {
      assert.equal(got[field], expected[field], `${field} for row ${e}`);
    }
  }
  ok('every ranked row reproduces the per-series stats and quantiles exactly');
}

// --- 2. Hand-checkable arithmetic on one flat plane -------------------------
{
  // One plane of 0,1,2,...,8759 — mean, min, max and the quartiles are all
  // known without running the code under test.
  const cube = makeCube(1, (_e, h) => h);
  const result = rankedStats(cube, Int32Array.of(0), allHours());
  const row = rankedRow(result, 0);
  assert.equal(row.n, HOURS);
  assert.equal(row.min, 0);
  assert.equal(row.max, HOURS - 1);
  assert.equal(row.mean, (HOURS - 1) / 2);
  assert.equal(row.sum, ((HOURS - 1) * HOURS) / 2);
  assert.equal(row.p25, 0.25 * (HOURS - 1));
  assert.equal(row.p75, 0.75 * (HOURS - 1));
  ok('a 0..8759 ramp gives the quartiles and the total arithmetic predicts');
}

// --- 3. The mask is honoured, and it changes the answer ---------------------
{
  const cube = makeCube(1, (_e, h) => h);
  const mask = new Uint8Array(HOURS);
  for (let h = 0; h < 24; h++) mask[h] = 1; // the first day only
  const row = rankedRow(rankedStats(cube, Int32Array.of(0), mask), 0);
  assert.equal(row.n, 24);
  assert.equal(row.min, 0);
  assert.equal(row.max, 23);
  assert.equal(row.mean, 11.5);
  ok('stats are over the hours the mask keeps, not the whole year');
}

// --- 4. A row the case does not carry is blank, not NaN-poisoned ------------
{
  const cube = makeCube(3, (e, h) => e * 100 + (h % 50), [1]);
  const starts = Int32Array.of(0, -1, 2 * HOURS);
  const result = rankedStats(cube, starts, allHours());
  const blank = rankedRow(result, 1);
  assert.equal(blank.n, 0);
  for (const field of ['mean', 'min', 'max', 'sd', 'p25', 'p75', 'sum']) {
    assert.ok(Number.isNaN(blank[field]), `${field} is NaN on an uncarried row`);
  }
  // The rows either side are untouched by their neighbour's absence.
  assert.equal(rankedRow(result, 0).n, HOURS);
  assert.equal(rankedRow(result, 2).n, HOURS);
  ok('a plane start of -1 is one blank row and does not touch its neighbours');
}

// --- 5. An all-NaN plane the caller did pass in is also blank ---------------
{
  const cube = makeCube(2, (e, h) => e + h, [0]);
  const result = rankedStats(cube, Int32Array.of(0, HOURS), allHours());
  assert.equal(rankedRow(result, 0).n, 0);
  assert.ok(Number.isNaN(rankedRow(result, 0).mean));
  assert.equal(rankedRow(result, 1).n, HOURS);
  ok('an all-NaN plane gathers to nothing rather than poisoning a mean');
}

// --- 6. Only the scoped rows are computed -----------------------------------
{
  const entities = 10;
  const cube = makeCube(entities, (e, _h) => e);
  const scoped = Int32Array.of(7 * HOURS, 2 * HOURS);
  const result = rankedStats(cube, scoped, allHours());
  assert.equal(result.length, 2 * RANKED_FIELDS);
  assert.equal(rankedRow(result, 0).mean, 7);
  assert.equal(rankedRow(result, 1).mean, 2);
  ok('the result is one row per scoped plane, in the order handed in');
}

// --- 7. The scratch buffer is reused, and reuse changes no answer -----------
{
  const cube = makeCube(4, (e, h) => (h * 7 + e * 13) % 211);
  const starts = Int32Array.from({ length: 4 }, (_, e) => e * HOURS);
  const mask = allHours();
  const scratch = createScratch();
  const out = new Float64Array(4 * RANKED_FIELDS);
  const shared = rankedStats(cube, starts, mask, scratch, out);
  assert.equal(shared, out, 'the supplied output buffer is the one returned');
  const fresh = rankedStats(cube, starts, mask);
  assert.deepEqual(Array.from(shared), Array.from(fresh));
  ok('a reused scratch and output buffer give the same numbers as fresh ones');
}

// --- 8. Field slots are what the table reads ------------------------------
{
  const cube = makeCube(1, (_e, h) => h);
  const result = rankedStats(cube, Int32Array.of(0), allHours());
  const row = rankedRow(result, 0);
  assert.equal(result[RANKED.n], row.n);
  assert.equal(result[RANKED.max], row.max);
  assert.equal(RANKED_FIELDS, Object.keys(RANKED).length);
  ok('the flat slots and the record accessor read the same row');
}

// ------------------------------------------------ quartiles by selection
//
// p25 and p75 are SELECTED, not sorted: the scratch buffer comes back
// unsorted, and the values match the sorted-array ones on tricky inputs.
{
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
  const plane = new Float32Array(HOURS);
  for (let h = 0; h < HOURS; h++) plane[h] = Math.round((next() - 0.3) * 10000) / 8;
  const scratch = createScratch();
  rankedStats(plane, Int32Array.of(0), allHours(), scratch);
  let ascending = true;
  for (let i = 1; i < HOURS && ascending; i++) ascending = scratch[i - 1] <= scratch[i];
  assert.equal(ascending, false, 'the ranking sorted a whole row to read two quartiles');
  ok('the ranking selects its quartiles rather than sorting each row');

  const patterns = {
    random: (h) => Math.round((next() - 0.5) * 2000) / 4,
    allZero: () => 0,
    twoValues: (h) => (h % 3 === 0 ? -5 : 5),
    ascending: (h) => h,
    descending: (h) => -h,
    sawtooth: (h) => h % 24,
    mostlyZeroWithSpikes: (h) => (h % 97 === 0 ? 1e6 : 0),
  };
  const sizes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 100, 101, 1000, HOURS];
  let compared = 0;
  for (const [name, value] of Object.entries(patterns)) {
    const cube = new Float32Array(HOURS);
    for (let h = 0; h < HOURS; h++) cube[h] = value(h);
    for (const n of sizes) {
      const mask = new Uint8Array(HOURS);
      mask.fill(1, 0, n);
      const row = rankedRow(rankedStats(cube, Int32Array.of(0), mask), 0);
      const gathered = createScratch();
      const expected = quantiles(gathered, applyMask(cube, mask, gathered));
      assert.ok(row.p25 === expected.p25, `${name}, n=${n}: p25 ${row.p25} vs ${expected.p25}`);
      assert.ok(row.p75 === expected.p75, `${name}, n=${n}: p75 ${row.p75} vs ${expected.p75}`);
      compared++;
    }
  }
  ok(`selected quartiles equal the sorted ones exactly (${compared} planes)`);
}

// ------------------------------------------------------ the kept ranking
//
// A committed cube never changes, so a ranking is memoised per cube, mask
// and plane starts. The test writes behind the memo's back (the app never
// does) to see whether a second call read the memo.
{
  const cube = new Float32Array(HOURS * 2);
  for (let h = 0; h < cube.length; h++) cube[h] = (h % 50) - 10;
  const starts = Int32Array.of(0, HOURS);
  const mask = allHours();
  const memo = { byCube: new WeakMap() };

  const first = rankedStats(cube, starts, mask, createScratch(), undefined, memo);
  const firstMean = rankedRow(first, 0).mean;
  first[RANKED.mean] = 12345; // a caller rewriting its result must not reach the memo
  cube.fill(1000, 0, HOURS);

  const again = rankedStats(cube, starts, mask, createScratch(), undefined, memo);
  assert.equal(rankedRow(again, 0).mean, firstMean, 'same cube, mask and starts: the kept answer');

  const narrower = new Uint8Array(mask);
  narrower[0] = 0;
  const recomputed = rankedStats(cube, starts, narrower, createScratch(), undefined, memo);
  assert.equal(rankedRow(recomputed, 0).mean, 1000, 'a different mask is a different question');

  const moved = rankedStats(cube, Int32Array.of(0), mask, createScratch(), undefined, memo);
  assert.equal(rankedRow(moved, 0).mean, 1000, 'different plane starts are a different question');

  const copy = cube.slice();
  const fresh = rankedStats(copy, starts, mask, createScratch(), undefined, memo);
  assert.equal(rankedRow(fresh, 0).mean, 1000, "another cube never reads this one's answers");
  ok('a kept ranking is reused only for the same cube, mask and plane starts');

  const { createRankMemo } = await import('../src/kernels.ts');
  assert.ok(createRankMemo().byCube instanceof WeakMap, 'held weakly, so a dropped Case takes it');
  const main = (await import('node:fs')).readFileSync(
    new URL('../src/main.ts', import.meta.url),
    'utf8',
  );
  for (const declare of [
    'declareAreaTabs',
    'declareGeneratorTabs',
    'declareBusTabs',
    'declareInterfaceTabs',
  ]) {
    const call = main.slice(main.indexOf(`...${declare}(`)).match(/^[\s\S]*?\n\s*(?:\.\.\.|\])/);
    assert.ok(call, `${declare} is called from main.ts`);
    assert.match(call[0], /browseRanks/, `${declare} is handed the kept rankings`);
  }
  ok("the composition root owns one kept-ranking memo and hands it to every kind's tabs");
}

console.log(`\n${checks} checks passed.`);
