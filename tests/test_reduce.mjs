// tests/test_reduce.mjs — the lookup join / bucketed reduce kernel.
//
// Invariants tested:
//   * Enum dictionaries are sorted, so bucket order is deterministic.
//   * Entities absent from the list get their own '(unlisted)' bucket (never dropped).
//   * Entities with missing/empty column values get '(blank)'.
//   * presence === 0 planes are skipped.
//   * Arithmetic is exact across hours.

import assert from 'node:assert/strict';
import './test_loader.mjs';

const { HOURS_PER_YEAR } = await import('../src/model/calendar.ts');
const { buildLookup, parseLookupCsv } = await import('../src/lookups/parse.ts');
const { bucketLabelFor, bucketedReduce, reduceSingleBucket } =
  await import('../src/lookups/reduce.ts');

const HOURS = HOURS_PER_YEAR;
let checks = 0;
function ok(label) {
  checks++;
  console.log(`ok - ${label}`);
}

const GEN_COLUMNS = ['Name', 'Bus ID', 'Area Name', 'FuelType', 'PSSEMaxCap(MW)'];
function makeLookup(rows) {
  const csv = [
    `GENERATORLIST${','.repeat(GEN_COLUMNS.length - 1)}`,
    GEN_COLUMNS.join(','),
    ...rows,
  ].join('\n');
  return buildLookup(parseLookupCsv(csv, 'GeneratorList.csv').rows);
}

{
  const lookup = makeLookup([
    'ALDER,101,AREA_AV,Gas,200',
    'BIRCH,102,AREA_NV,Wind,100',
    'CEDAR,103,AREA_AV,,50',
  ]);

  assert.equal(bucketLabelFor('ALDER', lookup, 'FuelType'), 'Gas');
  assert.equal(bucketLabelFor('BIRCH', lookup, 'FuelType'), 'Wind');
  assert.equal(bucketLabelFor('CEDAR', lookup, 'FuelType'), '(blank)');
  assert.equal(bucketLabelFor('UNKNOWN', lookup, 'FuelType'), '(unlisted)');
  assert.equal(bucketLabelFor('ALDER', undefined, 'FuelType'), '(unlisted)');
  ok('bucketLabelFor resolves enum labels, (blank) for empty, and (unlisted) for absent');
}

{
  const lookup = makeLookup([
    'G1,101,AREA_AV,Solar,100',
    'G2,102,AREA_AV,Solar,100',
    'G3,103,AREA_AV,Gas,200',
    'G4,104,AREA_AV,,50',
  ]);
  // G5 is in the export but not in the list (unlisted)
  // G6 is in the export but has presence 0 (absent plane)
  const generators = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6'];
  const cube = new Float32Array(generators.length * HOURS);
  const presence = new Uint8Array([1, 1, 1, 1, 1, 0]);

  // Fill G1 with 1, G2 with 2, G3 with 10, G4 with 100, G5 with 1000, G6 with 99999
  for (let i = 0; i < generators.length; i++) {
    const fillVal =
      i === 0 ? 1 : i === 1 ? 2 : i === 2 ? 10 : i === 3 ? 100 : i === 4 ? 1000 : 99999;
    for (let h = 0; h < HOURS; h++) cube[i * HOURS + h] = fillVal;
  }

  const result = bucketedReduce(cube, presence, generators, lookup, 'FuelType');
  const labels = result.buckets.map((b) => b.label);

  // Gas, Solar are dictionary sorted enum labels, followed by (blank) and (unlisted)
  assert.deepEqual(labels, ['Gas', 'Solar', '(blank)', '(unlisted)']);
  ok('buckets are ordered in sorted dictionary order, with blank and unlisted preserved');

  const gasBucket = result.buckets.find((b) => b.label === 'Gas');
  assert.equal(gasBucket.count, 1);
  assert.equal(gasBucket.series[0], 10);
  assert.equal(gasBucket.series[HOURS - 1], 10);

  const solarBucket = result.buckets.find((b) => b.label === 'Solar');
  assert.equal(solarBucket.count, 2);
  // G1 (1) + G2 (2) = 3
  assert.equal(solarBucket.series[0], 3);

  const blankBucket = result.buckets.find((b) => b.label === '(blank)');
  assert.equal(blankBucket.count, 1);
  assert.equal(blankBucket.series[0], 100);

  const unlistedBucket = result.buckets.find((b) => b.label === '(unlisted)');
  assert.equal(unlistedBucket.count, 1);
  assert.equal(unlistedBucket.series[0], 1000);

  ok('bucketedReduce sums member planes accurately across all hours');
}

{
  const lookup = makeLookup(['G1,101,AREA_AV,Solar,100', 'G2,102,AREA_AV,Solar,100']);
  const generators = ['G1', 'G2'];
  const cube = new Float32Array(generators.length * HOURS);
  const presence = new Uint8Array([1, 1]);
  for (let h = 0; h < HOURS; h++) {
    cube[0 * HOURS + h] = 5;
    cube[1 * HOURS + h] = 15;
  }

  const out = new Float32Array(HOURS);
  const count = reduceSingleBucket(cube, presence, generators, lookup, 'FuelType', 'Solar', out);
  assert.equal(count, 2);
  assert.equal(out[0], 20);
  assert.equal(out[HOURS - 1], 20);
  ok('reduceSingleBucket accumulates matching planes into caller output buffer');

  const countZero = reduceSingleBucket(cube, presence, generators, lookup, 'FuelType', 'Wind', out);
  assert.equal(countZero, 0);
  assert.equal(out[0], 0);
  ok('reduceSingleBucket returns 0 when no entity matches the target label');
}

{
  const lookup = makeLookup(['G1,101,AREA_AV,Solar,100', 'G2,102,AREA_AV,Solar,100']);
  const generators = ['G1', 'G2'];
  const cube = new Float32Array(generators.length * HOURS);
  const presence = new Uint8Array([1, 1]);
  cube.fill(NaN);
  // G1 has 10 at h=0, NaN at h=1, NaN at h=2
  cube[0 * HOURS + 0] = 10;
  // G2 has NaN at h=0, 20 at h=1, NaN at h=2
  cube[1 * HOURS + 1] = 20;

  const out = new Float32Array(HOURS);
  reduceSingleBucket(cube, presence, generators, lookup, 'FuelType', 'Solar', out);
  // At h=0: G1 is 10, G2 is NaN -> 10 (not NaN)
  assert.equal(out[0], 10);
  // At h=1: G1 is NaN, G2 is 20 -> 20 (not NaN)
  assert.equal(out[1], 20);
  // At h=2: both are NaN -> remains NaN
  assert.ok(Number.isNaN(out[2]));
  ok('reduceSingleBucket avoids NaN poisoning while keeping hours with no data as NaN');

  const result = bucketedReduce(cube, presence, generators, lookup, 'FuelType');
  const solar = result.buckets.find((b) => b.label === 'Solar');
  assert.equal(solar.series[0], 10);
  assert.equal(solar.series[1], 20);
  assert.ok(Number.isNaN(solar.series[2]));
  ok('bucketedReduce avoids NaN poisoning while keeping hours with no data as NaN');
}

// ------------------------------------------------------- explicit members
//
// The third arm of the family: sum the planes of a NAMED member set, the
// reduce a user-authored group needs. Same presence rule, same NaN
// behaviour -- a second copy of either is how two reduces come to disagree
// about whether an absent plane counts.
{
  const { reduceMembers } = await import('../src/lookups/reduce.ts');

  const generators = ['G1', 'G2', 'G3'];
  const presence = Uint8Array.from([1, 1, 0]); // G3 carried by the axis, no data
  const cube = new Float32Array(generators.length * HOURS);
  for (let h = 0; h < HOURS; h++) {
    cube[0 * HOURS + h] = 10;
    cube[1 * HOURS + h] = h === 0 ? Number.NaN : 5;
    cube[2 * HOURS + h] = 1e9; // poison: presence 0 must keep it out
  }

  const out = new Float32Array(HOURS);
  // A member the axis never heard of (SYN-BIGGER-STUDY) is a no-op, not an
  // error: a grouping written for a bigger study loads, and the units it
  // names that this study lacks contribute nothing.
  const count = reduceMembers(
    cube,
    presence,
    generators,
    new Set(['G1', 'G2', 'G3', 'SYN-BIGGER-STUDY']),
    out,
  );
  assert.equal(count, 2, 'presence 0 and unknown names contribute nothing');
  assert.equal(out[0], 10, 'G2\u2019s NaN at h=0 does not poison G1\u2019s 10');
  assert.equal(out[1], 15);
  ok('reduceMembers sums an explicit member set, skipping absent planes and unknown names');

  const none = reduceMembers(
    cube,
    presence,
    generators,
    new Set(['NOPE']),
    new Float32Array(HOURS),
  );
  assert.equal(none, 0);
  ok('an empty contribution is a count of zero, not an error');
}

// ------------------------------------------------- the signed member reduce
//
// The arm interface groups need: a coefficient per member, so a boundary can
// hold a path measured the opposite way round. `reduceMembers` is this with
// every coefficient 1, and they are separate functions so a caller that
// forgets the map gets a compile error rather than a silent plain sum.
{
  const { reduceSignedMembers } = await import('../src/lookups/reduce.ts');

  const paths = ['P01', 'P02', 'P03'];
  const presence = Uint8Array.from([1, 1, 0]); // P03 on the axis, no data
  const cube = new Float32Array(paths.length * HOURS);
  for (let h = 0; h < HOURS; h++) {
    cube[h] = 10; // P01
    cube[HOURS + h] = 40; // P02
    cube[2 * HOURS + h] = 999; // P03, and presence 0 must keep it out
  }

  const out = new Float32Array(HOURS);
  const count = reduceSignedMembers(
    cube,
    presence,
    paths,
    new Map([
      ['P01', 1],
      ['P02', -1],
      ['P03', 1],
      ['SYN-BIGGER-STUDY', 1],
    ]),
    out,
  );
  assert.equal(count, 2, 'the absent plane and the off-axis name contribute nothing');
  assert.equal(out[0], -30, '10 + (-1 x 40)');
  ok('a coefficient of -1 subtracts a member, and presence still gates the cube');

  // A coefficient of 0 is a member counted zero times, which a caller may
  // mean. It is NOT the same as absent: it counts toward the contribution.
  const zeroed = new Float32Array(HOURS);
  const zeroCount = reduceSignedMembers(
    cube,
    presence,
    paths,
    new Map([
      ['P01', 1],
      ['P02', 0],
    ]),
    zeroed,
  );
  assert.equal(zeroCount, 2, 'a zero coefficient is a member, not an absence');
  assert.equal(zeroed[0], 10);
  ok('a zero coefficient is honoured as written rather than read as a missing member');

  // NaN is absent, not a small number -- the rule every reduce in this file
  // shares. A member whose plane is NaN for an hour leaves that hour to the
  // others rather than poisoning it.
  const holed = new Float32Array(cube);
  holed[0] = Number.NaN;
  const partial = new Float32Array(HOURS);
  reduceSignedMembers(
    holed,
    presence,
    paths,
    new Map([
      ['P01', 1],
      ['P02', -1],
    ]),
    partial,
  );
  assert.equal(partial[0], -40, 'hour 0 is P02 alone');
  assert.equal(partial[1], -30, 'and the rest is both');
  ok('a NaN hour is skipped rather than poisoning the signed sum');

  const none = reduceSignedMembers(cube, presence, paths, new Map(), new Float32Array(HOURS));
  assert.equal(none, 0);
  ok('an empty coefficient map is a count of zero, not an error');
}

console.log(`\n${checks} checks passed.`);
