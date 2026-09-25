// tests/test_kernels_generator.mjs — generator kernels and rules. Invented
// names.
//
//   * A single unit is one plane (group sums are in test_series.mjs).
//   * NaN is absent; presence is checked before the cube.
//   * Totals only for units summable over hours, per
//     data/generator/quantity-rules.json.
//   * The three polysemous headers are a stated list.

import assert from 'node:assert/strict';
import './test_loader.mjs';

const {
  applyMask,
  buildSeries,
  createScratch,
  hasData,
  isAllZero,
  planeStart,
  quantiles,
  sortAsc,
  stats,
} = await import('../src/tables/generator/kernels.ts');
const { HOURS_PER_YEAR } = await import('../src/model/calendar.ts');
const {
  isPolysemous,
  quantityNote,
  ruleForUnit,
  scaleOf,
  scalesOf,
  temporalOf,
  totalIsMeaningful,
  unitOf,
} = await import('../src/tables/generator/rules.ts');
// The rules file read as data; see the record check further down.
const rulesData = (
  await import('../data/generator/quantity-rules.json', { with: { type: 'json' } })
).default;

const HOURS = HOURS_PER_YEAR;
let checks = 0;
function ok(label) {
  checks++;
  console.log(`ok - ${label}`);
}

/** A GeneratorTable, one plane per unit; `absent` units stay NaN with
 * presence 0. */
function makeCase({
  generators,
  fill = (i, h) => i * 1000 + h,
  absent = [],
  sourceColumns = generators,
  quantity = 'Generation (MWh)',
  year = 2035,
} = {}) {
  const cube = new Float32Array(generators.length * HOURS).fill(NaN);
  const presence = new Uint8Array(generators.length);
  generators.forEach((name, index) => {
    if (absent.includes(name)) return;
    presence[index] = 1;
    for (let hour = 0; hour < HOURS; hour++) cube[index * HOURS + hour] = fill(index, hour);
  });
  return {
    cube,
    generators,
    presence,
    tou: new Uint8Array(HOURS),
    sourceColumns,
    year,
    quantity,
  };
}

// ---------------------------------------------------------------- buildSeries

{
  const data = makeCase({ generators: ['G1 PV', 'G2 WT', 'G3 BA'], absent: ['G3 BA'] });
  const out = createScratch();

  const built = buildSeries(data, 'G2 WT', out);
  assert.ok(built.values, 'a carried generator builds');
  assert.equal(built.values[0], 1000, 'the stored plane IS the series');
  assert.equal(built.values[HOURS - 1], 1000 + HOURS - 1);
  assert.equal(built.values, out, 'the caller-owned buffer is written, not a fresh one');
  assert.equal(planeStart(2), 2 * HOURS);
  ok('a retained generator builds straight out of its cube plane');

  assert.equal(hasData(data, 2), false, 'presence says G3 BA is absent');
  const missingPlane = buildSeries(data, 'G3 BA', out);
  assert.equal(missingPlane.values, null, 'an absent plane refuses, never a NaN series');
  assert.match(missingPlane.refusal, /has no data for "G3 BA"/);
  ok('an absent plane refuses rather than returning NaN');

  // "Not retained" and "not carried" refuse with different messages -- see
  // test_kernels_bus.mjs for why they must not share one.
  const narrow = makeCase({ generators: ['G1 PV'], sourceColumns: ['G1 PV', 'G2 WT'] });
  const notRetained = buildSeries(narrow, 'G2 WT', out);
  assert.equal(notRetained.values, null);
  assert.match(notRetained.refusal, /"G2 WT" is in this case but was not retained at load\./);
  const neverSeen = buildSeries(narrow, 'G9 XX', out);
  assert.match(neverSeen.refusal, /does not carry "G9 XX"\./);
  ok('"not retained" and "not carried" refuse with different messages');

  const labelled = buildSeries(narrow, 'G9 XX', out, 'Winter Peak');
  assert.ok(labelled.refusal.includes('Winter Peak'), labelled.refusal);
  ok('a refusal names the case from the label the caller passes, not from the table');
}

// ------------------------------------------------------- masking and stats

{
  const series = createScratch();
  const mask = new Uint8Array(HOURS);
  for (let hour = 0; hour < HOURS; hour++) {
    series[hour] = hour % 5 === 0 ? NaN : hour;
    mask[hour] = hour % 2 === 0 ? 1 : 0;
  }
  const gathered = createScratch();
  const kept = applyMask(series, mask, gathered);
  assert.ok(kept > 0);
  for (let i = 0; i < kept; i++) assert.ok(!Number.isNaN(gathered[i]), 'no NaN survives the mask');

  const summary = stats(gathered, kept);
  assert.equal(summary.n, kept);
  assert.ok(Number.isFinite(summary.mean) && Number.isFinite(summary.sd));
  const spread = quantiles(sortAsc(gathered, kept), kept);
  assert.ok(spread.min <= spread.median && spread.median <= spread.max);
  assert.equal(isAllZero(new Float32Array(10), 10), true);
  ok(
    'the shared kernels reach callers through generator/kernels.ts, and NaN never reaches a statistic',
  );
}

// ---------------------------------------------------------------- unit rules

{
  assert.equal(unitOf('Generation (MWh)'), 'MWh');
  assert.equal(unitOf('LMP ($/MWh)'), '$/MWh');
  assert.equal(unitOf('Fuel Cost ($) /ES Storage'), '$', 'the last parenthesis is the unit');
  assert.equal(
    unitOf('Startup Fuel Consumpt./ Spillage/ PumpLine'),
    '',
    'no parentheses, no guessed unit',
  );
  ok('unitOf reads the unit out of the title-line quantity');

  assert.equal(temporalOf('MWh'), 'SUM', 'generation over the kept hours is a real number');
  assert.equal(temporalOf('$'), 'SUM');
  assert.equal(temporalOf('MMBtu'), 'SUM');
  assert.equal(temporalOf('MW'), 'MEAN');
  assert.equal(temporalOf('$/MWh'), 'MEAN');
  assert.equal(temporalOf('bananas'), 'MEAN', 'an unknown unit gets a mean, never a total');
  assert.equal(totalIsMeaningful('MWh'), true);
  assert.equal(totalIsMeaningful('$/MWh'), false);
  ok('a period total is offered only where summing over hours is meaningful');

  // `class` is what a fleet sum reads (`spatialOf`).
  assert.equal(ruleForUnit('MWh').class, 'EXTENSIVE');
  assert.equal(ruleForUnit('$/MWh').class, 'INTENSIVE');
  assert.equal(ruleForUnit('MW').class, 'RATE');
  ok('every unit carries the EXTENSIVE/INTENSIVE class the later fleet sum needs');

  assert.equal(scaleOf('MW'), 'MWh', 'MW and MWh are the same number for one hour');
  assert.deepEqual(scalesOf([{ unit: 'MWh' }, { unit: 'MW' }, { unit: '$' }]), [
    { scale: 'MWh', label: 'MWh · MW' },
    { scale: '$', label: '$' },
  ]);
  assert.deepEqual(scalesOf([{ unit: '' }]), [{ scale: '', label: '(no unit)' }]);
  ok('scalesOf merges MW with MWh and keeps everything else on its own axis');
}

// -------------------------------------------------------- polysemous columns

{
  for (const quantity of [
    'Fuel Cost ($) /ES Storage',
    'Startup Fuel Consumpt./ Spillage/ PumpLine',
    'Sec. Fuel Consmpt. / Pumping Cost',
  ]) {
    assert.equal(isPolysemous(quantity), true, quantity);
    assert.ok(quantityNote(quantity), `${quantity} says what its meanings are`);
  }
  assert.equal(isPolysemous('Generation (MWh)'), false);
  assert.equal(isPolysemous('Something / With / Slashes'), false, 'a slash is not the test');
  assert.equal(quantityNote('Generation (MWh)'), undefined, 'no note is invented');
  ok('the three polysemous headers are a stated list, and nothing else is polysemous');
}

// ------------------------------- recorded columns, polysemous or ruled
//
// Every recorded column needs a ruled unit OR the polysemous flag (a
// polysemous header may still carry a unit, e.g. `Fuel Cost ($) /ES Storage`).
{
  const listed = rulesData.quantities;
  assert.ok(Array.isArray(listed) && listed.length > 0, 'the record is a non-empty list');
  const names = listed.map((entry) => entry.quantity);
  assert.equal(new Set(names).size, names.length, 'each column is recorded once');

  const unruled = [];
  for (const entry of listed) {
    assert.equal(typeof entry.quantity, 'string', `${JSON.stringify(entry)} names its column`);
    assert.equal(entry.quantity.trim(), entry.quantity, `"${entry.quantity}" has no stray space`);
    const unit = unitOf(entry.quantity);
    const ruled = unit !== '' && ruleForUnit(unit) !== undefined;
    if (!ruled && entry.polysemous !== true) unruled.push(`${entry.quantity} -> "${unit}"`);
  }
  assert.deepEqual(
    unruled,
    [],
    'a recorded column whose unit this file has no rule for, and which is not flagged ' +
      '`polysemous`, gets MEAN, no total and no place in the Generator Groups dropdown. Add ' +
      'the unit to data/generator/quantity-rules.json, or flag the entry if it means several ' +
      'things:\n  ' +
      unruled.join('\n  '),
  );
  ok('every column the rules file records has a ruled unit or is flagged polysemous');
}

// ------------------------------------------------------- import discipline

// AGENTS.md's "Kind is not shape" rule -- see test_kernels_bus.mjs for why
// it is checked as text here rather than left to the type system.
{
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = 'src/tables/generator';
  const files = readdirSync(dir, { recursive: true }).filter((name) =>
    String(name).endsWith('.ts'),
  );
  assert.ok(files.length > 0, `${dir} has sources to check`);
  for (const file of files) {
    const source = readFileSync(`${dir}/${file}`, 'utf8');
    for (const match of source.matchAll(/from '([^']+)'/g)) {
      assert.ok(
        !/\.\.\/(area|interface|bus|generator)\//.test(match[1]) ||
          match[1].includes('/generator/'),
        `${dir}/${file} imports another kind: ${match[1]}`,
      );
    }
  }
  ok('nothing under src/tables/generator/ imports another kind');

  // …and never reciprocal: the shape reader stays free of every kind.
  for (const file of readdirSync('src/tables/wide').filter((name) => name.endsWith('.ts'))) {
    const source = readFileSync(`src/tables/wide/${file}`, 'utf8');
    assert.ok(
      !/from '\.\.\/(area|interface|bus|generator)/.test(source),
      `src/tables/wide/${file} imports a kind`,
    );
  }
  ok('nothing under src/tables/wide/ imports a kind');
}

console.log(`\n${checks} checks passed.`);
