// tests/test_sample_data.mjs — the correctness-fixture generator, checked by
// running the REAL classifier, case-plan readers and list parser over its
// bytes (never trusting its own manifest):
//
//   1. DETERMINISM: one seed, byte-identical output.
//   2. ROUTING: every file classifies as the (kind, shape) it was written as.
//   3. THE READERS ACCEPT IT: each export passes its kind's `readCasePlan`.
//   4. THE AWKWARD PROPERTIES are present in the bytes, each by name.
//
// Generated into a temp dir each run (small and fast), so the suite can never
// silently skip.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import './test_loader.mjs';

const { generate, DEFAULT_SEED } = await import('../scripts/make-sample-data.mjs');
const { classify } = await import('../src/detect.ts');
const { normalizeCell, parseLookupCsv, parseNumber, splitCsvLine } =
  await import('../src/lookups/parse.ts');
const areaWide = await import('../src/tables/area/wide.ts');
const busWide = await import('../src/tables/bus/wide.ts');
const generatorWide = await import('../src/tables/generator/wide.ts');
const wideHeader = await import('../src/tables/wide/header.ts');
const widePool = await import('../src/tables/wide/pool.ts');
const longPool = await import('../src/tables/long/pool.ts');
const areaLong = await import('../src/tables/area/long.ts');
const busLong = await import('../src/tables/bus/long.ts');
const generatorLong = await import('../src/tables/generator/long.ts');

let checks = 0;
function ok(label) {
  checks++;
  console.log(`ok - ${label}`);
}

const scratch = mkdtempSync(join(tmpdir(), 'gvp-sample-'));
const dirA = join(scratch, 'a');
const dirB = join(scratch, 'b');

try {
  const manifest = await generate({ out: dirA });
  await generate({ out: dirB });

  const bytesOf = (dir, name) => readFileSync(join(dir, name));
  const textOf = (dir, name) => readFileSync(join(dir, name), 'utf8');
  const fileOf = (name) => new File([bytesOf(dirA, name)], name);

  // --- 1. determinism ------------------------------------------------------

  {
    const namesA = readdirSync(dirA).sort();
    const namesB = readdirSync(dirB).sort();
    assert.deepEqual(namesA, namesB, 'the same seed writes the same file names');
    const differing = namesA.filter((name) => !bytesOf(dirA, name).equals(bytesOf(dirB, name)));
    assert.deepEqual(
      differing,
      [],
      'two runs at one seed must be byte-identical; these differ: ' + differing.join(', '),
    );
    assert.equal(manifest.seed, DEFAULT_SEED);
    ok(`two runs at seed ${DEFAULT_SEED} are byte-identical across all ${namesA.length} files`);
  }

  // --- 2. routing ----------------------------------------------------------
  //
  // Stated here, not read from the manifest, so a mislabelling generator
  // cannot agree with itself.

  const ROUTES = {
    'area-wide.csv': ['area', 'W'],
    'area-long.csv': ['area', 'L'],
    'interface-wide-power-flow.csv': ['interface', 'W'],
    'interface-wide-congestion-cost.csv': ['interface', 'W'],
    'bus-wide.csv': ['bus', 'W'],
    'bus-wide-no-id.csv': ['bus', 'W'],
    'bus-long.csv': ['bus', 'L'],
    'generator-wide.csv': ['generator', 'W'],
    'generator-long.csv': ['generator', 'L'],
    'bus-list.csv': ['bus', 'R'],
    'generator-list.csv': ['generator', 'R'],
    'groupings.csv': ['groupings', undefined],
  };

  for (const [name, [kind, shape]] of Object.entries(ROUTES)) {
    const result = classify(new Uint8Array(bytesOf(dirA, name)), name);
    assert.equal(result.kind, kind, `${name} must classify as ${kind}, got ${result.kind}`);
    assert.equal(result.shape, shape, `${name} must classify as shape ${shape}`);
    assert.equal(
      result.confidence,
      'high',
      `${name} must classify with high confidence, or a drop of it stops to ask`,
    );
  }
  ok(`every file in the shape table routes to its own (kind, shape), at high confidence`);

  // Every variant (split halves, conflict pairs, anomaly carriers) must still
  // route, including files that exist to be refused.
  {
    const unrouted = readdirSync(dirA)
      .filter((name) => name.endsWith('.csv') && !(name in ROUTES))
      .filter(
        (name) => classify(new Uint8Array(bytesOf(dirA, name)), name).kind === 'unrecognized',
      );
    assert.deepEqual(
      unrouted,
      [],
      'these classify as unrecognized, so nothing would ever read them: ' + unrouted.join(', '),
    );
    ok('every split, conflict pair and anomaly carrier still routes to a reader');
  }

  // --- 3. the real case-plan readers accept them ---------------------------

  {
    const plan = await areaWide.readCasePlan(fileOf('area-wide.csv'));
    assert.equal(plan.year, 2034);
    assert.deepEqual(
      plan.header.entityNames.map((name) => name.trim()),
      [
        'SAMPLE_AREA_0001',
        'SAMPLE_AREA_0002',
        'SAMPLE_AREA_0003',
        'SAMPLE_AREA_0004',
        'SAMPLE_AREA_0005',
      ],
      "the wide Area axis is the header's own columns",
    );
    assert.equal(plan.title.quantity, 'Load (MWh)');
    assert.equal(plan.title.entity, 'Area', 'the entity noun is what routes a wide file');
  }
  {
    // A wide bus file without an id row is refused by name (ids are the key),
    // never read with its first data row as the header.
    const keyed = await busWide.readCasePlan(fileOf('bus-wide.csv'));
    assert.ok(keyed.header.entityNames.length > 0);
    assert.equal(keyed.year, 2034);
    await assert.rejects(
      () => busWide.readCasePlan(fileOf('bus-wide-no-id.csv')),
      /id row/,
      'the keyless case is refused by a message that names the row whose absence moved ' +
        'everything up by one, never read as though line 6 were a header',
    );
  }
  {
    const plan = await generatorWide.readCasePlan(fileOf('generator-wide.csv'));
    assert.ok(plan.header.entityNames.length > 0);
    assert.equal(plan.year, 2034);
  }
  for (const [name, sig] of [
    ['area-long.csv', areaLong.AREA_LONG],
    ['bus-long.csv', busLong.BUS_LONG],
    ['generator-long.csv', generatorLong.GENERATOR_LONG],
  ]) {
    const plan = await longPool.readCasePlan(fileOf(name), sig);
    assert.equal(plan.year, 2034, `${name}: the year comes off the first data row`);
    assert.ok(
      plan.header.metricNames.length > 0,
      `${name}: a long export's metrics start after its key columns`,
    );
  }
  ok('every hourly export is read by its own kind‘s case-plan reader: year, axis and metrics');

  // --- 4. the awkward properties, asserted in the bytes --------------------

  /** Every property the manifest claims, so a silently dropped one fails
   *  here rather than in whatever suite was relying on it. */
  const CLAIMED = Object.keys(manifest.properties);

  /** Every property this suite has actually checked, so the closing
   *  assertion can catch one that is claimed and never looked at. */
  const ASSERTED = new Set();

  function property(name, fn) {
    ASSERTED.add(name);
    assert.ok(
      CLAIMED.includes(name),
      `the generator no longer claims "${name}". Claimed: ${CLAIMED.join(' | ')}`,
    );
    fn();
    ok(`property: ${name}`);
  }

  const busWideText = textOf(dirA, 'bus-wide.csv');
  const busIdRow = splitCsvLine(busWideText.split('\r\n')[4]);
  const busNameRow = splitCsvLine(busWideText.split('\r\n')[5]);

  property('duplicate bus names across columns, distinct BusNumbers', () => {
    const duplicated = busNameRow.filter((cell) => cell.trim() === 'SAMPLE_BUS_DUPNAME');
    assert.equal(duplicated.length, 2, 'two columns share one bus NAME');
    const ids = busNameRow
      .map((cell, i) => (cell.trim() === 'SAMPLE_BUS_DUPNAME' ? busIdRow[i] : null))
      .filter((id) => id !== null);
    assert.equal(new Set(ids).size, 2, 'and they are told apart by BusNumber, which is the key');
  });

  property('entity names ending in #2 and #3', () => {
    assert.ok(busNameRow.some((cell) => cell.trim().endsWith('#2')));
    assert.ok(busNameRow.some((cell) => cell.trim().endsWith('#3')));
  });

  property('values near 1e8, and negative values in the tens of thousands', () => {
    const firstRow = splitCsvLine(textOf(dirA, 'area-wide.csv').split('\r\n')[5]);
    assert.ok(Number(firstRow[3]) > 1e7, `first value is ${firstRow[3]}, not near 1e8`);
    assert.ok(Number(firstRow[4]) < -10000, `second value is ${firstRow[4]}, not a big negative`);
  });

  property('a leap year, so Feb 29 is present', () => {
    const text = textOf(dirA, 'area-wide-leapyear.csv');
    assert.match(text, /^2\/29\/\d{4},1,/m, 'the file carries a 2/29 row for ingest to drop');
  });

  property('the same (entity, metric, hour) written twice', () => {
    const rows = textOf(dirA, 'area-wide-duplicate-row.csv').trim().split('\r\n').slice(5);
    assert.equal(rows[0], rows[rows.length - 1], 'the first data row is repeated verbatim');
  });

  property("two files disagreeing about one hour's TOU", () => {
    const [a, b] = ['area-wide-conflict-tou-a.csv', 'area-wide-conflict-tou-b.csv'].map((name) =>
      textOf(dirA, name).split('\r\n').slice(5),
    );
    const differing = a.filter((row, i) => row.split(',')[2] !== b[i]?.split(',')[2]);
    assert.equal(differing.length, 1, 'exactly one hour disagrees, so the refusal names it');
  });

  property('two files whose dates are in different calendar years', () => {
    const yearOf = (name) => textOf(dirA, name).split('\r\n')[5].split(',')[0].split('/')[2];
    assert.notEqual(
      yearOf('area-wide-conflict-year-a.csv'),
      yearOf('area-wide-conflict-year-b.csv'),
    );
  });

  property('a BOM on line 1, header padding, trailing comma padding', () => {
    const raw = bytesOf(dirA, 'area-wide-bom-padded.csv');
    assert.deepEqual(
      [...raw.subarray(0, 3)],
      [0xef, 0xbb, 0xbf],
      'a UTF-8 BOM is three bytes; written under a single-byte encoding it is one 0xFF and ' +
        'the file is unreadable rather than awkward',
    );
    const lines = raw.toString('utf8').split('\r\n');
    assert.match(lines[4], /,\s\S/, 'a header cell carries a leading space');
    assert.ok(lines[4].endsWith(','), 'the header is comma-padded');
    assert.ok(lines[5].endsWith(','), 'and so is every data row');
  });

  // The two reference lists, through the real parser.
  const busList = parseLookupCsv(textOf(dirA, 'bus-list.csv'), 'bus-list.csv');
  const generatorList = parseLookupCsv(textOf(dirA, 'generator-list.csv'), 'generator-list.csv');
  const cellOf = (parsed, key, column) =>
    parsed.rows.rows.get(key)?.[parsed.rows.columns.indexOf(column)];

  property('every blank spelling normalizeCell recognises', () => {
    // Asserted through `normalizeCell` rather than counted: the canonical set
    // lives in src/lookups/parse.ts, and a spelling added there is one this
    // file has to start carrying.
    for (const spelling of ['', 'NA', 'N/A', 'n/a', 'NULL', '#N/A']) {
      assert.equal(normalizeCell(spelling), null, `"${spelling}" must read as blank`);
    }
    const text = textOf(dirA, 'bus-list.csv');
    for (const spelling of ['NA', 'N/A', 'n/a', 'NULL', '#N/A']) {
      assert.ok(
        text.includes(`,${spelling},`) || text.includes(`,${spelling}\r`),
        `"${spelling}" is not in the file`,
      );
    }
    assert.ok(text.includes(',,'), 'and an empty cell too');
    assert.equal(cellOf(busList, 10005, 'LoadArea'), null, 'the parser hands them back as blanks');
  });

  property('True/False title case, #TRUE#/#FALSE#, YES/NO', () => {
    const monitored = busList.rows.columns.indexOf('Monitored');
    const spellings = new Set(
      [...busList.rows.rows.values()].map((cells) => cells[monitored]).filter((v) => v !== null),
    );
    assert.ok(spellings.size >= 3, `the Monitored column spells its booleans ${[...spellings]}`);
    const text = textOf(dirA, 'bus-list.csv');
    for (const spelling of ['True', 'False', '#TRUE#', '#FALSE#', 'YES', 'NO']) {
      assert.ok(text.includes(spelling), `the file must carry the spelling ${spelling}`);
    }
  });

  property('lat/long of exactly 0,0 and a BaseKV of 0', () => {
    assert.equal(cellOf(busList, 10003, 'Latitude'), '0');
    assert.equal(cellOf(busList, 10003, 'Longitude'), '0');
    assert.equal(cellOf(busList, 10002, 'BaseKV'), '0');
  });

  property('numbers written with thousands separators', () => {
    const va = cellOf(busList, 10004, 'VA');
    assert.equal(va, '12,345.678', 'the comma is INSIDE one quoted field, not a column break');
    assert.equal(
      busList.rows.columns.length,
      splitCsvLine(textOf(dirA, 'bus-list.csv').split('\r\n')[1]).length,
      'and the row still has as many cells as the header',
    );
    // What the app does with it is pinned here rather than left to be
    // discovered: `parseNumber` strips the separators, so a comma-grouped
    // number is a number. That is the fact this fixture exists to hold still.
    assert.equal(parseNumber(va), 12345.678);
  });

  property('a leading apostrophe on a Unit ID', () => {
    const text = textOf(dirA, 'generator-list.csv');
    assert.match(text, /,'PV,/, "the list carries a Unit ID written 'PV");
    assert.equal(
      cellOf(generatorList, 'SAMPLE_GENERATOR_0001', 'Unit ID'),
      'PV',
      'and the parser strips the apostrophe rather than carrying it into the id',
    );
  });

  property('UnitID values that are text and others that look numeric', () => {
    const ids = [...generatorList.rows.rows.values()].map(
      (cells) => cells[generatorList.rows.columns.indexOf('Unit ID')],
    );
    assert.ok(ids.includes('PV') && ids.includes('A'), 'text-typed ids');
    assert.ok(ids.includes('1') && ids.includes('01'), 'and ids that look numeric, one padded');
  });

  property('a quoted field containing a comma', () => {
    assert.equal(
      cellOf(generatorList, 'SAMPLE_GENERATOR_0001', 'Long Name'),
      'Sample Plant, Unit 1',
      'a split(",") reader would have cut this in two, which is the point of carrying it',
    );
  });

  property('a wide Bus export with no id row', () => {
    const lines = textOf(dirA, 'bus-wide-no-id.csv').split('\r\n');
    assert.ok(
      !lines.some((line) => line.startsWith(',,BusNumber')),
      'the keyless case carries no id row at all',
    );
    assert.match(
      lines[wideHeader.PREAMBLE_LINES],
      /^Date,/,
      'its header is where a 4-line preamble puts it',
    );
  });

  property('reference list and hourly export disagree on membership, both directions', () => {
    const listed = new Set([...busList.rows.rows.keys()].map(String));
    const hourly = new Set(
      busIdRow
        .slice(3)
        .map((cell) => cell.trim())
        .filter(Boolean),
    );
    assert.ok(
      [...hourly].some((id) => !listed.has(id)),
      'an hourly bus absent from the list',
    );
    assert.ok(
      [...listed].some((id) => !hourly.has(id)),
      'and a listed bus absent from the hourly',
    );
  });

  property('two interface quantities, one Case', () => {
    const quantities = ['interface-wide-power-flow.csv', 'interface-wide-congestion-cost.csv'].map(
      (name) => classify(new Uint8Array(bytesOf(dirA, name)), name).variant,
    );
    assert.equal(new Set(quantities).size, 2, 'two slots, so they do not replace each other');
    assert.ok(quantities.every(Boolean), 'and each quantity is read off its own title line');
  });

  for (const name of [
    'metric zero for some entities, dense for others',
    'metric all-zero everywhere',
  ]) {
    property(name, () => {
      const lines = textOf(dirA, 'area-long.csv').trim().split('\r\n');
      const header = splitCsvLine(lines[0]);
      const column = header.indexOf(
        name.startsWith('metric all-zero') ? 'SAMPLE_METRIC_04' : 'SAMPLE_METRIC_03',
      );
      assert.ok(column > 0, 'the metric column is named in the header');
      const values = lines.slice(1).map((line) => Number(splitCsvLine(line)[column]));
      const zeros = values.filter((value) => value === 0).length;
      if (name.startsWith('metric all-zero')) {
        assert.equal(zeros, values.length, 'every value in the constant plane is zero');
      } else {
        assert.ok(zeros > 0 && zeros < values.length, 'zero for some entities, dense for others');
      }
    });
  }

  for (const [name, a, b] of [
    [
      'date-split covering the whole year',
      'area-wide-split-fullyear-h1.csv',
      'area-wide-split-fullyear-h2.csv',
    ],
    [
      'date-split covering only part of the year',
      'area-wide-split-partial-a.csv',
      'area-wide-split-partial-b.csv',
    ],
    [
      'entity-subset split, same range, disjoint entity sets',
      'area-wide-split-entities-a.csv',
      'area-wide-split-entities-b.csv',
    ],
    [
      'a pair split by date and entity subset at once',
      'area-wide-split-both-a.csv',
      'area-wide-split-both-b.csv',
    ],
  ]) {
    property(name, () => {
      const plans = [a, b].map((file) => textOf(dirA, file).split('\r\n'));
      const headers = plans.map((lines) =>
        splitCsvLine(lines[4])
          .slice(3)
          .map((c) => c.trim()),
      );
      const firstDates = plans.map((lines) => lines[5].split(',')[0]);
      const sameEntities = headers[0].join('|') === headers[1].join('|');
      const sameStart = firstDates[0] === firstDates[1];
      assert.ok(
        !sameEntities || !sameStart,
        `${a} and ${b} differ in neither entities nor dates, so they are not a split`,
      );
    });
  }

  property('reference list and hourly export disagree on membership, generator side', () => {
    const header = splitCsvLine(textOf(dirA, 'generator-wide.csv').split('\r\n')[4]).slice(3);
    const listed = new Set([...generatorList.rows.rows.keys()].map(String));
    assert.ok(
      header.some((name) => !listed.has(name.trim())),
      'an hourly generator that the list has never heard of',
    );
  });

  // Nothing claimed and unasserted: the manifest is a promise the suite keeps.
  {
    const unchecked = CLAIMED.filter((name) => !ASSERTED.has(name));
    assert.deepEqual(
      unchecked,
      [],
      'the generator claims these properties and nothing here checks them: ' +
        unchecked.join(' | '),
    );
    ok(`all ${CLAIMED.length} claimed properties are asserted in the generated bytes`);
  }

  console.log(`\n${checks} checks passed.`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
