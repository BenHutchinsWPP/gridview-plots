// tests/test_range.mjs — "% of range", the one normalizer every kind calls.
//
//   * A value ≥ 0 divides by the upper side, a negative one by a lower side
//     < 0; a lower side ≥ 0 sends negatives to the upper side.
//   * A missing side is the series' own peak or trough over every hour, not
//     the hours a filter keeps.
//   * A per-hour limit falls back to the peak only for the hours it lacks.
//   * The label names which divisor each side used, over the shown hours.

import assert from 'node:assert/strict';
import './test_loader.mjs';

const { normalizeToRange, rangeLabel, PERCENT } = await import('../src/series/range.ts');
const { HOURS_PER_YEAR } = await import('../src/model/calendar.ts');

const checks = [];
const ok = (name, fn) => checks.push([name, fn]);

/** A year of hours, `fill(hour)` each. */
const year = (fill) => Float32Array.from({ length: HOURS_PER_YEAR }, (_, hour) => fill(hour));

ok('a battery at −25/+50 against −50/+100 is −50% and +50%', () => {
  const series = year((hour) => (hour % 2 === 0 ? 50 : -25));
  const use = normalizeToRange(series, { upper: 100, lower: -50 }, PERCENT);
  assert.equal(series[0], 50);
  assert.equal(series[1], -50);
  assert.deepEqual(use, { upper: 'limit', lower: 'limit' });
  assert.equal(rangeLabel(use), '% of limit');
});

ok('the label names only the divisors the shown hours used', () => {
  // No limit in hour 0; the mask hides it, so every shown hour used the limit.
  const upper = Float32Array.from({ length: HOURS_PER_YEAR }, (_, hour) =>
    hour === 0 ? NaN : 100,
  );
  const shown = Uint8Array.from({ length: HOURS_PER_YEAR }, (_, hour) => (hour === 0 ? 0 : 1));
  const all = normalizeToRange(
    year(() => 50),
    { upper },
    PERCENT,
  );
  assert.equal(rangeLabel(all), '% of limit, else peak');
  const series = year(() => 50);
  const use = normalizeToRange(series, { upper }, PERCENT, shown);
  assert.equal(rangeLabel(use), '% of limit');
  assert.equal(series[0], 100, 'the hidden hour still divides by the peak');
});

ok('a 60/100 thermal unit at 60 is 60%, and at −2 is −2% of its max', () => {
  const series = year((hour) => (hour === 0 ? -2 : 60));
  const use = normalizeToRange(series, { upper: 100, lower: 60 }, PERCENT);
  assert.equal(series[1], 60);
  assert.ok(Math.abs(series[0] - -2) < 1e-6, String(series[0]));
  assert.equal(rangeLabel(use), '% of limit', 'the negative hour used the max: one divisor');
});

ok('a missing side is the peak over every hour, not the filtered ones', () => {
  // The peak (80) sits in hour 0; a filter that dropped hour 0 must not move
  // the divisor to 40.
  const series = year((hour) => (hour === 0 ? 80 : 40));
  const use = normalizeToRange(series, {}, PERCENT);
  assert.equal(series[0], 100);
  assert.equal(series[1], 50);
  assert.equal(rangeLabel(use), '% of peak');
});

ok('a side stated on one sign only names both divisors', () => {
  const series = year((hour) => (hour % 2 === 0 ? 50 : -20));
  const use = normalizeToRange(series, { upper: 100 }, PERCENT);
  assert.equal(series[0], 50);
  assert.equal(series[1], -100, 'the trough (−20) is the lower divisor');
  assert.equal(rangeLabel(use), '% of limit (+) / peak (−)');
});

ok('a divisor that is not one published limit is named as what it is', () => {
  const summed = 'summed limits';
  assert.equal(rangeLabel({ upper: 'limit', lower: 'limit' }, summed), '% of summed limits');
  assert.equal(
    rangeLabel({ upper: 'mixed', lower: null }, summed),
    '% of summed limits, else peak',
  );
  assert.equal(
    rangeLabel({ upper: 'limit', lower: 'peak' }, summed),
    '% of summed limits (+) / peak (−)',
  );
  assert.equal(rangeLabel({ upper: 'peak', lower: null }, summed), '% of peak');
});

ok('a per-hour limit with NaN hours falls back to the peak for those hours only', () => {
  const series = year(() => 50);
  series[0] = 200;
  const upper = year((hour) => (hour < 10 ? NaN : 100));
  const use = normalizeToRange(series, { upper }, PERCENT);
  assert.equal(series[0], 100, 'hour 0 has no limit: 200 over the peak 200');
  assert.equal(series[5], 25, 'nor hour 5: 50 over the peak 200');
  assert.equal(series[10], 50, 'hour 10 has one: 50 over 100');
  assert.equal(use.upper, 'mixed');
  assert.equal(rangeLabel(use), '% of limit, else peak');
});

ok('a max cap of 0 is no limit, and NaN hours stay NaN', () => {
  const series = year(() => 25);
  series[3] = NaN;
  const use = normalizeToRange(series, { upper: 0 });
  assert.equal(series[0], 1, 'a ratio when no scale is given');
  assert.ok(Number.isNaN(series[3]));
  assert.equal(rangeLabel(use), '% of peak');
});

let failed = 0;
for (const [name, fn] of checks) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL - ${name}`);
    console.error(error);
  }
}
if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log(`\n${checks.length} checks passed`);
