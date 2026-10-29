// tests/test_append.mjs
//
// The merge primitive behind a drop onto a loaded table (src/tables/append.ts):
//   - a date split flags no overlap, and rows at the same hours keep the
//     loaded value and TOU
//   - a blank in a held row stays blank; a table with no presence falls back
//     to "not NaN"
//   - years extend in both directions at their year offsets; a gap and too
//     many years are refused
//   - nothing is written in place, so a rank memo keyed on the old cube
//     cannot answer for the merged one
//
// Run:  node test_append.mjs

import assert from 'node:assert/strict';
import './test_loader.mjs';

const { mergePlanes, unionSpan, appendEntityTable, appendEntitySize, appendNotes } =
  await import('../src/tables/append.ts');
const { rankedStats, rankedRow, createRankMemo } = await import('../src/kernels.ts');
const { YEAR_SLOT_HOURS: H } = await import('../src/model/calendar.ts');
const { fewNames, MAX_CASE_YEARS } = await import('../src/ingest.ts');

let checks = 0;
function ok(label) {
  checks++;
  console.log(`  ok  ${label}`);
}

/** A source: `value(plane, hour)` NaN for none; rows by `rowAt(hour)`. */
function make(firstYear, numYears, planes, value, rowAt = () => true, opts = {}) {
  const hours = numYears * H;
  const cube = new Float32Array(planes * hours);
  for (let p = 0; p < planes; p++)
    for (let h = 0; h < hours; h++) cube[p * hours + h] = rowAt(h) ? value(p, h) : NaN;
  const tou = new Uint8Array(hours);
  const hoursPresent = new Uint8Array(hours);
  for (let h = 0; h < hours; h++) {
    const r = rowAt(h);
    hoursPresent[h] = r ? 1 : 0;
    tou[h] = r ? (opts.tou ?? 1) : 0xff;
  }
  const src = { firstYear, numYears, cube, tou, hoursPresent };
  if (opts.presence !== false) src.presence = new Uint8Array(planes).fill(1);
  if (opts.noHours) delete src.hoursPresent;
  return src;
}
const view = (src, keys) => ({ ...src, keys });
const ident = (n) => Int32Array.from({ length: n }, (_, i) => i);
const snap = (s) => ({
  cube: s.cube.slice(),
  tou: s.tou.slice(),
  hp: s.hoursPresent?.slice(),
  presence: s.presence?.slice(),
});
function same(s, before) {
  assert.deepEqual(Array.from(s.cube), Array.from(before.cube));
  assert.deepEqual(Array.from(s.tou), Array.from(before.tou));
  if (before.hp) assert.deepEqual(Array.from(s.hoursPresent), Array.from(before.hp));
  if (before.presence) assert.deepEqual(Array.from(s.presence), Array.from(before.presence));
}

// A date split: old holds the first half, fresh the second.
{
  const old = make(
    2030,
    1,
    1,
    () => 1,
    (h) => h < 4000,
  );
  const fresh = make(
    2030,
    1,
    1,
    () => 2,
    (h) => h >= 4000,
  );
  const m = mergePlanes(old, fresh, 1, ident(1), ident(1));
  assert.equal(m.overlapped[0], 0);
  assert.equal(m.cube[0], 1);
  assert.equal(m.cube[5000], 2);
  assert.equal(m.wrote, H - 4000);
  assert.equal(m.hoursPresent[3999], 1);
  assert.equal(m.hoursPresent[4000], 1);
  ok('a date split flags no overlap and takes fresh where old has no row');
}

// A blank in a held row stays blank.
{
  const old = make(2030, 1, 1, (_, h) => (h === 10 ? NaN : 1));
  const fresh = make(2030, 1, 1, () => 2);
  const m = mergePlanes(old, fresh, 1, ident(1), ident(1));
  assert.ok(Number.isNaN(m.cube[10]));
  assert.equal(m.cube[11], 1);
  assert.equal(m.overlapped[0], 1);
  ok('a blank in a held row stays blank');
}

// Same hours: old value and old TOU win.
{
  const old = make(
    2030,
    1,
    2,
    (p) => 10 + p,
    () => true,
    { tou: 3 },
  );
  const fresh = make(
    2030,
    1,
    2,
    (p) => 20 + p,
    () => true,
    { tou: 7 },
  );
  const m = mergePlanes(old, fresh, 2, ident(2), ident(2));
  assert.equal(m.cube[0], 10);
  assert.equal(m.cube[H], 11);
  assert.equal(m.tou[0], 3);
  assert.deepEqual(Array.from(m.overlapped), [1, 1]);
  assert.equal(m.wrote, 0);
  ok('rows at the same hours keep the old value and TOU');
}

// Extension in both directions, at year offsets.
{
  const old = make(2031, 1, 2, (p, h) => 100 * (p + 1) + (h % 7));
  const later = make(2032, 1, 2, (p) => 500 + p);
  const earlier = make(2030, 1, 2, (p) => 900 + p);
  let m = mergePlanes(old, later, 2, ident(2), ident(2));
  assert.equal(m.firstYear, 2031);
  assert.equal(m.numYears, 2);
  assert.equal(m.cube[0], 100);
  assert.equal(m.cube[H], 500);
  assert.equal(m.cube[2 * H], 200);
  assert.equal(m.cube[3 * H + 5], 501);
  assert.equal(m.tou.length, 2 * H);
  m = mergePlanes(old, earlier, 2, ident(2), ident(2));
  assert.equal(m.firstYear, 2030);
  assert.equal(m.cube[0], 900);
  assert.equal(m.cube[H], 100);
  assert.equal(m.cube[2 * H], 901);
  assert.equal(m.cube[3 * H + 3], 200 + 3);
  // A plane only fresh carries sits at its year offset, old's span NaN.
  m = mergePlanes(old, earlier, 3, Int32Array.of(0, 1, -1), Int32Array.of(0, 1, 1));
  assert.ok(Number.isNaN(m.cube[4 * H + H]));
  assert.equal(m.cube[4 * H], 901);
  // A plane only old carries keeps its years at offset, fresh's span NaN.
  m = mergePlanes(old, earlier, 3, Int32Array.of(0, 1, 1), Int32Array.of(0, 1, -1));
  assert.equal(m.cube[4 * H + H], 200);
  assert.ok(Number.isNaN(m.cube[4 * H]));
  ok('extension in both directions lands at the year offsets');
}

// Gap and too-long refusals.
{
  const a = make(2030, 1, 1, () => 1);
  const b = make(2033, 1, 1, () => 1);
  const u = unionSpan(a, b);
  assert.deepEqual(u.missing, [2031, 2032]);
  assert.throws(() => mergePlanes(a, b, 1, ident(1), ident(1)), /2031-2032/);
  const far = { firstYear: 2030 + MAX_CASE_YEARS, numYears: 1 };
  assert.equal(unionSpan(a, { firstYear: 2031, numYears: MAX_CASE_YEARS - 1 }).tooLong, false);
  assert.equal(unionSpan(a, { firstYear: 2031, numYears: MAX_CASE_YEARS }).tooLong, true);
  assert.equal(unionSpan(a, far).tooLong, true);
  assert.throws(
    () =>
      mergePlanes(
        {
          ...a,
          numYears: MAX_CASE_YEARS,
          cube: new Float32Array(0),
          tou: new Uint8Array(0),
          hoursPresent: new Uint8Array(0),
        },
        { ...b, firstYear: 2030 + MAX_CASE_YEARS },
        0,
        new Int32Array(0),
        new Int32Array(0),
      ),
    /at most 256 years/,
  );
  ok('a gap and too many years are refused');
}

// No presence: fall back to not-NaN.
{
  const old = make(
    2030,
    1,
    1,
    (_, h) => (h < 10 ? NaN : 1),
    () => true,
    { presence: false },
  );
  const fresh = make(
    2030,
    1,
    1,
    () => 2,
    () => true,
    { presence: false },
  );
  const m = mergePlanes(old, fresh, 1, ident(1), ident(1));
  assert.equal(m.cube[5], 2);
  assert.equal(m.cube[50], 1);
  assert.equal(m.overlapped[0], 1);
  assert.equal(m.presence[0], 1);
  // TOU alone says a row when there is no hoursPresent.
  const o2 = make(
    2030,
    1,
    1,
    () => 1,
    (h) => h < 100,
    { noHours: true },
  );
  const f2 = make(
    2030,
    1,
    1,
    () => 2,
    (h) => h >= 100,
    { noHours: true },
  );
  const m2 = mergePlanes(o2, f2, 1, ident(1), ident(1));
  assert.equal(m2.cube[99], 1);
  assert.equal(m2.cube[100], 2);
  assert.equal(m2.overlapped[0], 0);
  ok('with no presence a cell is held when it is not NaN');
}

// Never in place; old arrays byte-identical.
{
  const old = make(
    2030,
    1,
    2,
    () => 1,
    (h) => h < 5000,
  );
  const fresh = make(2031, 1, 2, () => 2);
  const before = snap(old);
  const fb = snap(fresh);
  const m = mergePlanes(old, fresh, 2, ident(2), ident(2));
  assert.notEqual(m.cube, old.cube);
  assert.notEqual(m.tou, old.tou);
  assert.notEqual(m.hoursPresent, old.hoursPresent);
  assert.notEqual(m.presence, old.presence);
  same(old, before);
  same(fresh, fb);
  const same1 = mergePlanes(old, old, 2, ident(2), ident(2));
  assert.notEqual(same1.cube, old.cube);
  same(old, before);
  ok('a merge builds new arrays and leaves its inputs byte-identical');
}

// Ranked stats through one memo.
{
  const old = make(
    2030,
    1,
    1,
    () => 1,
    (h) => h < 4000,
  );
  const fresh = make(
    2030,
    1,
    1,
    () => 5,
    (h) => h >= 4000,
  );
  const memo = createRankMemo();
  const mask = new Uint8Array(H).fill(1);
  const starts = Int32Array.of(0);
  const before = rankedRow(rankedStats(old.cube, starts, H, mask, undefined, undefined, memo), 0);
  assert.equal(before.n, 4000);
  const m = mergePlanes(old, fresh, 1, ident(1), ident(1));
  const after = rankedRow(rankedStats(m.cube, starts, H, mask, undefined, undefined, memo), 0);
  assert.equal(after.n, H);
  assert.equal(after.max, 5);
  assert.equal(after.sum, 4000 + 5 * (H - 4000));
  ok('ranked stats on the merged cube reflect the new values through one memo');
}

// Entity append: keys, columns, overlap, size.
{
  const old = view(
    make(2030, 1, 2, (p) => p + 1),
    ['A', 'B'],
  );
  const fresh = view(
    make(2031, 1, 2, (p) => 7 + p),
    ['B', 'C'],
  );
  const size = appendEntitySize(old, fresh);
  assert.deepEqual(size, { planes: 3, numYears: 2 });
  const r = appendEntityTable(old, fresh);
  assert.deepEqual(r.keys, ['A', 'B', 'C']);
  assert.deepEqual(r.added, ['C']);
  assert.deepEqual(r.overlapping, []);
  assert.deepEqual(r.from, { firstYear: 2030, numYears: 1 });
  assert.deepEqual(r.to, { firstYear: 2030, numYears: 2 });
  assert.equal(r.merged.cube[1 * 2 * H + H], 7);
  assert.equal(r.merged.cube[2 * 2 * H + H], 8);
  assert.ok(Number.isNaN(r.merged.cube[2 * 2 * H]));
  const same = appendEntityTable(
    old,
    view(
      make(2030, 1, 1, () => 9),
      ['B'],
    ),
  );
  assert.deepEqual(same.overlapping, ['B']);
  ok('an entity append joins keys at the end and names the overlap');
}

// Notes.
{
  const span1 = { firstYear: 2030, numYears: 1 };
  const span2 = { firstYear: 2030, numYears: 2 };
  const base = { table: null, noun: 'generator', added: [], overlapping: [], wrote: 0 };
  assert.deepEqual(
    appendNotes('a.csv', 'Gen', {
      ...base,
      added: ['A', 'B', 'C', 'D'],
      overlapping: ['E'],
      wrote: 5,
      from: span1,
      to: span2,
    }),
    [
      'a.csv joined Gen: 4 new generator(s) (A, B, C, …), and the table now spans 2030-2031 (it spanned 2030).',
      'a.csv: 1 generator(s) were already in Gen for the same hours (E); the loaded values were kept.',
    ],
  );
  assert.deepEqual(
    appendNotes('a.csv', 'Gen', { ...base, added: ['A'], wrote: 1, from: span1, to: span1 }),
    ['a.csv joined Gen: 1 new generator(s) (A).'],
  );
  assert.deepEqual(appendNotes('a.csv', 'Gen', { ...base, from: span1, to: span1 }), [
    'a.csv added nothing new to Gen: every generator and hour it carries was already loaded, and the loaded values were kept.',
  ]);
  assert.equal(fewNames(['a', 'b', 'c', 'd']), 'a, b, c, …');
  assert.equal(fewNames(['a', 'b']), 'a, b');
  ok('notes word what joined, what overlapped and what added nothing');
}

{
  const one = (key, hour, value) =>
    view(
      make(
        2035,
        1,
        1,
        () => value,
        (h) => h === hour,
      ),
      [key],
    );
  const first = appendEntityTable(one('A', 0, NaN), one('B', 1, 20));
  const old = { ...first.merged, keys: first.keys };
  const next = appendEntityTable(old, one('A', 1, 30));
  assert.equal(next.merged.cube[1], 30);
  assert.equal(next.merged.wrote, 1);
  assert.deepEqual(next.overlapping, []);
  assert.ok(Number.isNaN(old.cube[1]), 'append leaves the prior cube alone');
  const blank = appendEntityTable({ ...next.merged, keys: next.keys }, one('A', 0, 99));
  assert.ok(Number.isNaN(blank.merged.cube[0]), 'an explicitly offered blank keeps priority');
  assert.equal(blank.merged.wrote, 0);
  assert.deepEqual(blank.overlapping, ['A']);
  ok('repeated row-and-column additions keep ownership per cell, including explicit blanks');
}

console.log(`\n${checks} append checks passed`);
