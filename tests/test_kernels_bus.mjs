// tests/test_kernels_bus.mjs — bus kernels and unit rules. Invented names and
// ids.
//
//   * The axis is the BusNumber id; two buses sharing a name stay distinct.
//   * A single bus is one stored plane (group sums are in test_series.mjs).
//   * NaN is absent and never reaches a statistic.
//   * A total exists only for units summable over hours, per
//     data/bus/quantity-rules.json.

import assert from 'node:assert/strict';
import './test_loader.mjs';

const {
  applyMask,
  buildSeries,
  busIndex,
  createScratch,
  hasData,
  isAllZero,
  planeStart,
  quantiles,
  sortAsc,
  stats,
} = await import('../src/tables/bus/kernels.ts');
const { HOURS_PER_YEAR } = await import('../src/model/calendar.ts');
const {
  busLabel,
  combinesAcrossBuses,
  ruleForUnit,
  scaleOf,
  scalesOf,
  spatialOf,
  spatialRefusal,
  temporalOf,
  totalIsMeaningful,
  unitOf,
} = await import('../src/tables/bus/rules.ts');
// The rules file read as data; see the record check further down.
const rulesData = (await import('../data/bus/quantity-rules.json', { with: { type: 'json' } }))
  .default;

const HOURS = HOURS_PER_YEAR;
let checks = 0;
function ok(label) {
  checks++;
  console.log(`ok - ${label}`);
}

/** A BusTable, one plane per id; `absent` ids stay NaN with presence 0. */
function makeCase({
  buses,
  names = buses.map((id) => `BUS_${id}`),
  fill = (i, h) => i * 1000 + h,
  absent = [],
  sourceColumns = buses,
  quantity = 'LMP ($/MWh)',
  year = 2035,
} = {}) {
  const cube = new Float32Array(buses.length * HOURS).fill(NaN);
  const presence = new Uint8Array(buses.length);
  buses.forEach((id, index) => {
    if (absent.includes(id)) return;
    presence[index] = 1;
    for (let hour = 0; hour < HOURS; hour++) cube[index * HOURS + hour] = fill(index, hour);
  });
  return {
    cube,
    buses: Int32Array.from(buses),
    names,
    presence,
    tou: new Uint8Array(HOURS),
    sourceColumns,
    year,
    quantity,
  };
}

// ---------------------------------------------------------------- buildSeries

{
  const data = makeCase({ buses: [10001, 10002, 10003], absent: [10003] });
  const index = busIndex(data);
  const out = createScratch();

  const built = buildSeries(data, 10002, index, out);
  assert.ok(built.values, 'a carried bus builds');
  assert.equal(built.values[0], 1000, 'the stored plane IS the series');
  assert.equal(built.values[HOURS - 1], 1000 + HOURS - 1);
  assert.equal(built.values, out, 'the caller-owned buffer is written, not a fresh one');
  assert.equal(planeStart(2), 2 * HOURS);
  ok('a retained bus builds straight out of its cube plane, resolved by id');

  // Presence before the cube: an absent plane is NaN, and NaN must never
  // reach a statistic.
  assert.equal(hasData(data, 2), false, 'presence says 10003 is absent');
  const missingPlane = buildSeries(data, 10003, index, out);
  assert.equal(missingPlane.values, null, 'an absent plane refuses');
  assert.match(missingPlane.refusal, /has no data for BUS_10003 \(10003\)/);
  assert.ok(!Number.isNaN(missingPlane.values), 'a refusal is null, never a NaN series');
  ok('an absent plane refuses by name and id rather than returning NaN');

  // Carried but not retained, versus never carried: different problems,
  // different fixes, so they must not share a message.
  const narrow = makeCase({ buses: [10001], sourceColumns: [10001, 10002] });
  const narrowIndex = busIndex(narrow);
  const notRetained = buildSeries(narrow, 10002, narrowIndex, out);
  assert.equal(notRetained.values, null);
  assert.match(notRetained.refusal, /Bus 10002 is in this case but was not retained at load\./);
  const neverSeen = buildSeries(narrow, 99999, narrowIndex, out);
  assert.match(neverSeen.refusal, /does not carry bus 99999\./);
  ok('"not retained" and "not carried" refuse with different messages');

  const labelled = buildSeries(narrow, 99999, narrowIndex, out, 'Winter Peak');
  assert.ok(labelled.refusal.includes('Winter Peak'), labelled.refusal);
  ok('a refusal names the case from the label the caller passes, not from the table');
}

// ------------------------------------------------- the id is not the name

{
  // Two buses, one name. This is legal in an export and is the whole reason
  // the id row exists: by name these are indistinguishable, by id they are
  // two different planes.
  const data = makeCase({
    buses: [20001, 20002],
    names: ['WILLOWBEND', 'WILLOWBEND'],
    fill: (i) => (i === 0 ? 7 : 42),
  });
  const index = busIndex(data);
  const out = createScratch();

  assert.equal(index.get(20001), 0);
  assert.equal(index.get(20002), 1);
  const first = buildSeries(data, 20001, index, out);
  assert.equal(first.values[0], 7);
  const second = buildSeries(data, 20002, index, createScratch());
  assert.equal(second.values[0], 42);
  assert.notEqual(first.values[0], second.values[0]);
  ok('two same-named buses resolve to two different planes through the id');

  assert.equal(busLabel('WILLOWBEND', 20002), 'WILLOWBEND (20002)');
  assert.equal(busLabel('  ', 20002), 'bus 20002', 'an unnamed bus is still identifiable');
  ok('a bus is labelled name (id) everywhere a human reads it');
}

// ------------------------------------------------------- masking and stats

{
  // The shared kernels reach callers through this module (they are the same
  // functions Interface uses); this checks the re-export, and that NaN is
  // dropped rather than counted.
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
  ok('the shared kernels reach callers through bus/kernels.ts, and NaN never reaches a statistic');
}

// ---------------------------------------------------------------- unit rules

{
  assert.equal(unitOf('LMP ($/MWh)'), '$/MWh');
  assert.equal(unitOf('Load (MW)'), 'MW');
  assert.equal(unitOf('Unserved Load Cost ($)'), '$');
  assert.equal(unitOf('Bus Utilisation'), '', 'no parentheses, no guessed unit');
  ok('unitOf reads the unit out of the title-line quantity');

  assert.equal(temporalOf('$/MWh'), 'MEAN', 'a price is not summed over hours');
  assert.equal(temporalOf('MW'), 'MEAN');
  assert.equal(temporalOf('MWh'), 'SUM');
  assert.equal(temporalOf('$'), 'SUM');
  assert.equal(temporalOf('bananas'), 'MEAN', 'an unknown unit gets a mean, never a total');
  assert.equal(totalIsMeaningful('$/MWh'), false);
  assert.equal(totalIsMeaningful('MWh'), true);
  ok('a period total is offered only where summing over hours is meaningful');

  assert.equal(scaleOf('MW'), 'MWh', 'MW and MWh are the same number for one hour');
  assert.equal(scaleOf('$/MWh'), '$/MWh');
  assert.deepEqual(scalesOf([{ unit: 'MW' }, { unit: 'MWh' }, { unit: '$/MWh' }]), [
    { scale: 'MWh', label: 'MW · MWh' },
    { scale: '$/MWh', label: '$/MWh' },
  ]);
  assert.deepEqual(scalesOf([{ unit: '' }]), [{ scale: '', label: '(no unit)' }]);
  ok('scalesOf merges MW with MWh and keeps everything else on its own axis');

  // The spatial rule is the unit's `class` only; no second field may appear.
  for (const unit of ['$/MWh', 'MW', 'MWh', '$']) {
    const rule = ruleForUnit(unit);
    assert.ok(rule, `${unit} has a rule`);
    assert.equal(rule.series, undefined, `${unit} carries no series rule`);
    assert.equal(rule.weight, undefined, `${unit} carries no weight column`);
  }
  ok('the bus rules carry no series or weight key: the spatial rule is the class');

  // EXTENSIVE and RATE sum across buses; INTENSIVE refuses, and so does a
  // unit no rule claims -- a total of an unknown unit is the plausible wrong
  // answer, not a missing feature.
  assert.equal(spatialOf('MWh'), 'SUM', 'extensive');
  assert.equal(spatialOf('$'), 'SUM', 'extensive');
  assert.equal(spatialOf('MW'), 'SUM', 'a rate sums across buses in one hour');
  assert.equal(spatialOf('$/MWh'), 'REFUSE', 'intensive');
  assert.equal(spatialOf('kV'), 'REFUSE', 'intensive');
  assert.equal(spatialOf('bananas'), 'REFUSE', 'an unknown unit is not guessed at');
  assert.equal(spatialRefusal('Load Payment ($)', '$'), undefined, 'no reason where it may sum');
  // Plain English, naming the UNIT and the arithmetic rather than this
  // file's own word for the rule. See `spatialRefusal` in
  // src/tables/bus/rules.ts.
  assert.match(spatialRefusal('LMP ($/MWh)', '$/MWh'), /\$\/MWh/);
  assert.ok(!/intensive/i.test(spatialRefusal('LMP ($/MWh)', '$/MWh')));
  assert.match(spatialRefusal('LMP ($/MWh)', '$/MWh'), /weighting column/);
  ok('spatialOf reads the class, and its refusal names the class and the missing weight');

  // The question the Bus Groups tab asks BEFORE a variable is picked, so a
  // quantity it could only refuse is never in its dropdown.
  assert.equal(combinesAcrossBuses('Unserved Load (MWh)'), true);
  assert.equal(combinesAcrossBuses('Load (MW)'), true);
  assert.equal(combinesAcrossBuses('Load Payment ($)'), true);
  assert.equal(combinesAcrossBuses('LMP ($/MWh)'), false);
  assert.equal(combinesAcrossBuses('LMP - Congestion ($/MWh)'), false);
  ok('combinesAcrossBuses answers for a whole quantity, before one is picked');
}

// ------------------------------------------- the quantities record
//
// As in tests/test_kernels_interface.mjs: every recorded column resolves to a
// ruled unit.
{
  const listed = rulesData.quantities;
  assert.ok(Array.isArray(listed) && listed.length > 0, 'the record is a non-empty list');
  assert.equal(new Set(listed).size, listed.length, 'each column is recorded once');

  const unruled = [];
  for (const quantity of listed) {
    assert.equal(typeof quantity, 'string', `${quantity} is recorded as text`);
    assert.equal(quantity.trim(), quantity, `"${quantity}" carries no stray whitespace`);
    const unit = unitOf(quantity);
    if (unit === '' || ruleForUnit(unit) === undefined) unruled.push(`${quantity} -> "${unit}"`);
  }
  assert.deepEqual(
    unruled,
    [],
    'a recorded column whose unit this file has no rule for gets MEAN, no total and no place ' +
      'in a groups dropdown. Add the unit to data/bus/quantity-rules.json:\n  ' +
      unruled.join('\n  '),
  );
  ok('every column the rules file records resolves to a unit it carries a rule for');
}

// ------------------------------------------------------- import discipline

// AGENTS.md's "Kind is not shape" rule, checked as text -- a runtime import
// graph cannot see a violation that typechecks fine.
{
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = 'src/tables/bus';
  const files = readdirSync(dir, { recursive: true }).filter((name) =>
    String(name).endsWith('.ts'),
  );
  assert.ok(files.length > 0, `${dir} has sources to check`);
  for (const file of files) {
    const source = readFileSync(`${dir}/${file}`, 'utf8');
    for (const match of source.matchAll(/from '([^']+)'/g)) {
      assert.ok(
        !/\.\.\/(area|interface|bus|generator)\//.test(match[1]) || match[1].includes('/bus/'),
        `${dir}/${file} imports another kind: ${match[1]}`,
      );
    }
  }
  ok('nothing under src/tables/bus/ imports another kind');

  // …and never reciprocal: the shape reader stays free of every kind.
  for (const file of readdirSync('src/tables/wide').filter((name) => name.endsWith('.ts'))) {
    const source = readFileSync(`src/tables/wide/${file}`, 'utf8');
    assert.ok(
      !/from '\.\.\/(area|interface|bus|generator)/.test(source),
      `src/tables/wide/${file} imports a kind`,
    );
  }
  ok('nothing under src/tables/wide/ imports a kind');

  // The LONG shape reader's vocabulary is held to the same rule, and it is the
  // rule that put `src/tables/long/kind.ts` there: a kind describes its own
  // long-shape ingest against the shape, never against Area's directory.
  for (const file of readdirSync('src/tables/long').filter((name) => name.endsWith('.ts'))) {
    const source = readFileSync(`src/tables/long/${file}`, 'utf8');
    assert.ok(
      !/from '\.\.\/(area|interface|bus|generator)/.test(source),
      `src/tables/long/${file} imports a kind`,
    );
  }
  ok('nothing under src/tables/long/ imports a kind either');
}

console.log(`\n${checks} checks passed.`);
