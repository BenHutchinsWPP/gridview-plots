// tests/test_series_label.mjs — what a drawn line is CALLED. A name missing a
// facet cannot say which run a line came from, silently.
//
//   * A full label names every facet that can vary, for entities, authored
//     groups and buckets.
//   * A bucket names its column (`SOUTH` by Zone is not `SOUTH` by Owner).
//   * A shorthand keeps only what varies across the drawn set.
//   * A shorthand is never ambiguous: colliding lines get full labels.

import assert from 'node:assert/strict';
import './test_loader.mjs';

const { fullLabel, contextLabel, subjectLabel, shortLabels, kindNoun, variableLabel } =
  await import('../src/series/label.ts');

const checks = [];
const ok = (name, fn) => checks.push([name, fn]);

/** A facet set in the shape `src/app/draw.ts` builds one. */
const facets = (over) => ({
  caseLabel: 'Winter 2035',
  kind: 'bus',
  variable: 'LMP ($/MWh)',
  unit: '$/MWh',
  subject: 'WILLOWBEND (10002)',
  ...over,
});

// ------------------------------------------------------------------ 1. full

ok('a full label names the Case, the kind, the quantity and the subject', () => {
  const label = fullLabel(facets());
  for (const part of ['Winter 2035', 'Bus', 'LMP ($/MWh)', 'WILLOWBEND (10002)']) {
    assert.ok(label.includes(part), `"${label}" does not name ${part}`);
  }
});

ok('the kind noun is derived from the token, so no list of kinds lives here', () => {
  assert.equal(kindNoun('area'), 'Area');
  assert.equal(kindNoun('interface'), 'Interface');
  assert.equal(kindNoun(''), '');
});

ok('a quantity that already carries its unit is not given a second one', () => {
  // GridView names most quantities with the unit inside them. Appending
  // unconditionally produced "Generation (MWh) (MWh)".
  assert.equal(variableLabel('Generation (MWh)', 'MWh'), 'Generation (MWh)');
  // And an Area metric named without one still has to state it: a number with
  // no unit beside it is what this whole module exists to prevent.
  assert.equal(variableLabel('LMP', '$/MWh'), 'LMP ($/MWh)');
  assert.equal(variableLabel('LMP', ''), 'LMP');
});

ok('a bucket names the column that bucketed it, not just its value', () => {
  const zone = fullLabel(facets({ groupBy: 'Zone', subject: 'SOUTH (12 buses)' }));
  assert.ok(zone.includes('Zone = SOUTH (12 buses)'), zone);
  // The same value under another column is another series, and the labels
  // have to differ or the legend claims they are one.
  const owner = fullLabel(facets({ groupBy: 'Owner', subject: 'SOUTH (12 buses)' }));
  assert.notEqual(zone, owner);
});

ok('an authored group reads the same way, under the axis its kind named', () => {
  const label = fullLabel(
    facets({
      kind: 'interface',
      groupBy: 'Interface Group',
      subject: 'WEST (4 paths)',
    }),
  );
  assert.ok(label.includes('Interface Group = WEST (4 paths)'), label);
});

ok('% of range is part of the name, divisor and all, because it is part of the numbers', () => {
  const plain = fullLabel(facets({ kind: 'generator', subject: 'PV_1' }));
  const ofLimit = fullLabel(facets({ kind: 'generator', subject: 'PV_1', range: '% of limit' }));
  const ofPeak = fullLabel(facets({ kind: 'generator', subject: 'PV_1', range: '% of peak' }));
  assert.ok(ofLimit.endsWith('% of limit'), ofLimit);
  assert.notEqual(plain, ofLimit);
  assert.notEqual(ofLimit, ofPeak);
});

ok('the filters a bucket was built under are named, or two fleets share a name', () => {
  const unfiltered = facets({ kind: 'generator', groupBy: 'Fuel Type', subject: 'Gas (30 units)' });
  const filtered = {
    ...unfiltered,
    subject: 'Gas (11 units)',
    filters: [{ label: 'Nameplate (MW)', constraint: '≥ 200' }],
  };
  const label = fullLabel(filtered);
  assert.ok(label.includes('filtered: Nameplate (MW) ≥ 200'), label);
  assert.notEqual(fullLabel(unfiltered), label);
});

ok('the context line is the full label without the subject', () => {
  const entry = facets({ groupBy: 'Zone', subject: 'SOUTH (12 buses)' });
  assert.equal(subjectLabel(entry), 'Zone = SOUTH (12 buses)');
  assert.ok(!contextLabel(entry).includes('SOUTH'), contextLabel(entry));
  assert.equal(fullLabel(entry), `${contextLabel(entry)} · ${subjectLabel(entry)}`);
});

// ----------------------------------------------------------------- 2. short

ok('one line is named by its subject alone: nothing else distinguishes it', () => {
  assert.deepEqual(shortLabels([facets()]), ['WILLOWBEND (10002)']);
});

ok('a facet every line agrees on is dropped, and one they differ on is kept', () => {
  const drawn = [facets(), facets({ subject: 'EASTGATE (10044)' })];
  assert.deepEqual(shortLabels(drawn), ['WILLOWBEND (10002)', 'EASTGATE (10044)']);

  const twoCases = [facets(), facets({ caseLabel: 'Summer 2035' })];
  assert.deepEqual(shortLabels(twoCases), [
    'Winter 2035 · WILLOWBEND (10002)',
    'Summer 2035 · WILLOWBEND (10002)',
  ]);
});

ok('two kinds drawn together are told apart by kind, and two quantities by quantity', () => {
  const kinds = shortLabels([facets(), facets({ kind: 'generator', subject: 'PV_1' })]);
  assert.deepEqual(kinds, ['Bus · WILLOWBEND (10002)', 'Generator · PV_1']);

  const quantities = shortLabels([
    facets({ kind: 'generator', variable: 'Generation (MWh)', unit: 'MWh', subject: 'PV_1' }),
    facets({ kind: 'generator', variable: 'Commitment (MW)', unit: 'MW', subject: 'PV_1' }),
  ]);
  assert.deepEqual(quantities, ['Generation (MWh) · PV_1', 'Commitment (MW) · PV_1']);
});

ok('an entity beside a bucket gets the bucket column back, since the set disagrees', () => {
  const drawn = [facets(), facets({ groupBy: 'Zone', subject: 'SOUTH (12 buses)' })];
  assert.deepEqual(shortLabels(drawn), ['WILLOWBEND (10002)', 'Zone = SOUTH (12 buses)']);
});

ok('the same unit in MW and as % of range is two lines, and the shorthand says which', () => {
  const drawn = [
    facets({ kind: 'generator', subject: 'PV_1' }),
    facets({ kind: 'generator', subject: 'PV_1', range: '% of limit' }),
  ];
  const [mw, pct] = shortLabels(drawn);
  assert.equal(mw.split(' · ').at(-1), 'PV_1');
  assert.ok(pct.endsWith('PV_1 · % of limit'), pct);
});

ok('a shorthand that would name two lines is replaced by both full labels', () => {
  // Only the filters differ, and shorthands omit filters, so they collide and
  // must fall back to full labels.
  const base = facets({ kind: 'generator', groupBy: 'Fuel Type', subject: 'Gas (30 units)' });
  const drawn = [
    { ...base, filters: [{ label: 'Nameplate (MW)', constraint: '≥ 200' }] },
    { ...base, filters: [{ label: 'Nameplate (MW)', constraint: '≤ 50' }] },
  ];
  const short = shortLabels(drawn);
  assert.deepEqual(short, [fullLabel(drawn[0]), fullLabel(drawn[1])]);
  assert.notEqual(short[0], short[1]);
});

ok('a collision replaces only the lines that collide, not the whole set', () => {
  const base = facets({ groupBy: 'Zone', subject: 'SOUTH (12 buses)' });
  const drawn = [
    { ...base, filters: [{ label: 'kV', constraint: '≥ 200' }] },
    { ...base, filters: [{ label: 'kV', constraint: '≤ 50' }] },
    facets({ subject: 'EASTGATE (10044)' }),
  ];
  const short = shortLabels(drawn);
  assert.equal(short[2], 'EASTGATE (10044)');
  assert.equal(new Set(short).size, 3, `shorthands must stay distinct: ${short.join(' | ')}`);
});

// -------------------------------------------------------------- 3. the wire
//
// `src/app/draw.ts` is the only place a row becomes a name; no kind writes
// its own.

ok('draw.ts names every kind through the one label module', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/app/draw.ts', import.meta.url), 'utf8');
  assert.match(source, /from '\.\.\/series\/label'/);
  // One facet builder for four kinds, and every resolver goes through it.
  assert.equal(
    source.match(/facetsOf\(\s*context,\s*spec\.ref,/g)?.length,
    4,
    'each kind builds its facets with the shared builder',
  );
  assert.ok(!/name: `\$\{/.test(source), 'no resolver hand-writes a legend name');
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
