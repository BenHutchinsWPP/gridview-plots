// tests/test_lookups.mjs — reference lists: detect shape R, parse, and merge.
//
// Ranked by how badly each one fails when it is wrong:
//
//   * **Enum dictionaries remap, they do not concatenate.** An appended file's
//     codes are meaningless against the loaded dictionary; splicing two code
//     arrays mislabels every appended row and does it silently. This is the
//     likeliest bug in the merge and gets the most direct test below.
//   * **Merge order must not matter** for the stored bytes. Only the
//     WINNER of a first-wins conflict may depend on drop order, and the ingest
//     note is what records that one happened.
//   * A duplicate key keeps the FIRST row, and the discards are counted.
//   * A banner word no list claims refuses BY NAME, naming the word it read.
//
// Run:  node test_lookups.mjs

import assert from 'node:assert/strict';
import './test_loader.mjs';

const { classify } = await import('../src/detect.ts');
const { buildLookup, parseLookupCsv, normalizeCell, parseNumber, splitCsvLine } =
  await import('../src/lookups/parse.ts');
const { cellText, mergeLookup, toRows } = await import('../src/lookups/merge.ts');
const { attachLookup, clearLookups, lookupFor, lookupSources, mergeNote } =
  await import('../src/lookups/store.ts');

let checks = 0;
function ok(label) {
  checks++;
  console.log(`ok - ${label}`);
}

const encoder = new TextEncoder();
const probe = (text) => encoder.encode(text);

/** A BusList with one banner line. Columns are the declared twelve. */
function busList(rows, { columns = BUS_COLUMNS } = {}) {
  return [`BUS_GENERAL${','.repeat(columns.length - 1)}`, columns.join(','), ...rows].join('\n');
}
const BUS_COLUMNS = [
  'BusID',
  'Name',
  'BaseKV',
  'Type',
  'VM',
  'VA',
  'Latitude',
  'Longitude',
  'Monitored',
  'LoadArea',
  'PSSEArea',
  'PSSEZone',
];
const busRow = (id, name, area, { kv = '230', lat = '44.5', lon = '-121.5', zone = 'Z1' } = {}) =>
  `${id},${name},${kv},1,1.02,0,${lat},${lon},TRUE,${area},A1,${zone}`;

/** A GeneratorList: two banner lines, the second being the "add ' to the
 * generator id" note the real file carries. */
function generatorList(rows, { columns = GEN_COLUMNS } = {}) {
  return [
    `GENERATORLIST${','.repeat(columns.length - 1)}`,
    `Note!!! Please add ' at the beginning of generator ID as a special indicator of text type.${','.repeat(columns.length - 1)}`,
    columns.join(','),
    ...rows,
  ].join('\n');
}
const GEN_COLUMNS = [
  'Name',
  'Bus ID',
  'Unit ID',
  'FuelType',
  'Long Name',
  'Commission Date',
  'ServiceStatus',
  'EconomicPMax',
];
const genRow = (name, busId, fuel, longName = `"${name}, unit 1"`) =>
  `${name},${busId},'G1,${fuel},${longName},#2031-04-05#,#TRUE#,"1,234.5"`;

// ------------------------------------------------------------------ detect

{
  const bus = classify(probe(busList([busRow(101, 'ALDER', 'NORTH')])), 'BusList.csv');
  assert.equal(bus.kind, 'bus');
  assert.equal(bus.shape, 'R', 'a reference list is shape R, not a table shape');
  assert.equal(bus.confidence, 'high');

  const gen = classify(
    probe(generatorList([genRow('G-ALDER-1', 101, 'HYDRO')])),
    'GeneratorList.csv',
  );
  assert.equal(gen.kind, 'generator');
  assert.equal(gen.shape, 'R', 'two banner lines detect as well as one');
  ok('BusList and GeneratorList are recognised as shape R, one banner line or two');

  // The detector's rule, in the other shape: name the word, do not fall through to
  // "matches nothing known".
  const strange = classify(probe(['TRANSFORMERLIST,,,', 'A,B,C,D', '1,2,3,4'].join('\n')), 'x.csv');
  assert.equal(strange.kind, 'unrecognized');
  assert.match(strange.reason, /"TRANSFORMERLIST"/, strange.reason);
  assert.match(strange.reason, /BUS_GENERAL/);
  ok('a banner word no list claims refuses by name, naming the word it read');

  // The branch must not claim an hourly export: a wide title line is also
  // "text in cell 1, nothing after it".
  const wide = [
    "Bus Hourly 'LMP ($/MWh)' Data for Year 2035,,,,",
    '',
    '',
    '',
    ',,BusNumber,101,102',
    'Date,Hour,TOU,ALDER,BIRCH',
  ].join('\n');
  const hourly = classify(probe(wide), 'hourly.csv');
  assert.equal(hourly.kind, 'bus');
  assert.equal(hourly.shape, 'W', 'a wide bus export is still shape W, not swallowed by shape R');
  ok('a wide export whose title line looks banner-shaped is still detected as wide');
}

// ------------------------------------------------------------------- CSV

{
  assert.deepEqual(splitCsvLine('a,"b, still b",c'), ['a', 'b, still b', 'c']);
  assert.deepEqual(splitCsvLine('a,"say ""hi""",c'), ['a', 'say "hi"', 'c']);
  assert.equal(normalizeCell('#TRUE#'), 'TRUE', 'the # wrapper comes off');
  assert.equal(normalizeCell("'G1"), 'G1', 'a leading apostrophe is a text-type marker, not data');
  assert.equal(normalizeCell('N/A'), null);
  assert.equal(normalizeCell('NA'), null);
  assert.equal(normalizeCell('   '), null);
  assert.equal(
    parseNumber('1,234'),
    1234,
    'thousands separators are stripped, as the profiler does',
  );
  assert.equal(parseNumber('12 kV'), null, 'a prefix match is not a number');
  ok('the CSV reader honours quotes, and the blank spellings all normalize to null');
}

// ------------------------------------------------------------------ parse

{
  const text = busList([
    busRow(101, 'ALDER', 'NORTH'),
    busRow(102, 'BIRCH', 'SOUTH', { lat: '0', lon: '0' }),
    busRow(103, 'CEDAR', 'NORTH', { kv: '0' }),
  ]);
  const { rows } = parseLookupCsv(text, 'BusList.csv');
  const table = buildLookup(rows);
  assert.equal(table.entity, 'bus');
  assert.equal(table.rowCount, 3);
  assert.deepEqual(table.keyColumns, ['BusID']);

  const baseKv = table.columns[table.byName.get('BaseKV')];
  assert.equal(baseKv.kind, 'float');
  assert.equal(baseKv.nulls[table.index.get(103)], 0, 'BaseKV 0 is a real value: fictitious buses');
  assert.equal(baseKv.values[table.index.get(103)], 0);

  const lat = table.columns[table.byName.get('Latitude')];
  assert.equal(lat.nulls[table.index.get(102)], 1, '0,0 is "unknown", not the Gulf of Guinea');
  assert.equal(lat.nulls[table.index.get(101)], 0);

  const area = table.columns[table.byName.get('LoadArea')];
  assert.equal(area.kind, 'enum');
  assert.deepEqual(area.labels, ['NORTH', 'SOUTH'], 'the dictionary is sorted, not first-seen');

  const monitored = table.columns[table.byName.get('Monitored')];
  assert.equal(monitored.kind, 'bool');
  assert.equal(monitored.values[0], 1);
  ok('a BusList parses into declared column types, with 0-is-null only where the file means it');

  const gen = buildLookup(
    parseLookupCsv(generatorList([genRow('G-ALDER-1', 101, 'HYDRO')]), 'g.csv').rows,
  );
  const longName = gen.columns[gen.byName.get('Long Name')];
  assert.equal(longName.values[0], 'G-ALDER-1, unit 1', 'a quoted field keeps its comma');
  const unit = gen.columns[gen.byName.get('Unit ID')];
  assert.equal(unit.values[0], 'G1', "the id's leading apostrophe is stripped");
  const commissioned = gen.columns[gen.byName.get('Commission Date')];
  assert.equal(cellText(commissioned, 0), '2031-04-05', 'a #-wrapped date round-trips');
  const service = gen.columns[gen.byName.get('ServiceStatus')];
  assert.equal(service.values[0], 1, '#TRUE# is a boolean, not the text "#TRUE#"');
  const busId = gen.columns[gen.byName.get('Bus ID')];
  assert.equal(busId.kind, 'int', 'GeneratorList."Bus ID" and BusList.BusID must normalize alike');
  assert.equal(busId.values[0], 101);
  const pmax = gen.columns[gen.byName.get('EconomicPMax')];
  assert.equal(pmax.values[0], 1234.5, 'a quoted, comma-grouped number is one number');
  ok('a GeneratorList parses: quoted commas, apostrophe ids, wrapped dates and booleans');
}

// -------------------------------------------------- duplicates and refusals

{
  const { rows, warnings } = parseLookupCsv(
    busList([
      busRow(101, 'ALDER', 'NORTH'),
      busRow(101, 'ALDER-2', 'SOUTH'),
      busRow(102, 'BIRCH', 'SOUTH'),
    ]),
    'BusList.csv',
  );
  const table = buildLookup(rows);
  assert.equal(table.rowCount, 2, 'the duplicate key did not add a row');
  const name = table.columns[table.byName.get('Name')];
  assert.equal(name.values[table.index.get(101)], 'ALDER', 'the FIRST copy of a key wins');
  assert.ok(
    warnings.some((warning) => /1 row\(s\) repeat a "BusID"/.test(warning)),
    `the discard is counted: ${warnings.join(' | ')}`,
  );
  ok('a duplicate key keeps the first row and the discard reaches the notes');

  assert.throws(
    () =>
      parseLookupCsv(
        busList([busRow(101, 'ALDER', 'NORTH')], { columns: BUS_COLUMNS.slice(1) }),
        'b.csv',
      ),
    /key column "BusID" is missing/,
    'a missing KEY column is the one refusal',
  );
  const extra = parseLookupCsv(
    busList([`${busRow(101, 'ALDER', 'NORTH')},SUBSTATION-A`], {
      columns: [...BUS_COLUMNS, 'Substation'],
    }),
    'b.csv',
  );
  assert.ok(extra.warnings.some((warning) => /Substation/.test(warning)));
  const widened = buildLookup(extra.rows);
  assert.ok(widened.byName.has('Substation'), 'a 13th column is carried, not refused');
  ok('a missing key column refuses; an undeclared column is carried and named');
}

// ------------------------------------------------------------------ merge

/** Columns as comparable plain data, for the byte-identity assertions. */
function snapshot(table) {
  return JSON.stringify(
    table.columns.map((column) => ({
      ...column,
      values: column.values === undefined ? undefined : Array.from(column.values),
      codes: column.codes === undefined ? undefined : Array.from(column.codes),
      nulls: column.nulls === undefined ? undefined : Array.from(column.nulls),
    })),
  );
}

{
  // Two files of one pair. B repeats 101 with a DIFFERENT LoadArea (a
  // first-wins conflict), adds 103, and its enum values sort differently from
  // A's — which is what makes a spliced code array visibly wrong.
  const a = parseLookupCsv(
    busList([busRow(101, 'ALDER', 'NORTH'), busRow(102, 'BIRCH', 'SOUTH')]),
    'BusList-A.csv',
  ).rows;
  const b = parseLookupCsv(
    busList([busRow(101, 'ALDER', 'WEST'), busRow(103, 'CEDAR', 'ALPHA')]),
    'BusList-B.csv',
  ).rows;

  const ab = mergeLookup(mergeLookup(undefined, a).table, b);
  assert.equal(ab.added, 1, 'only 103 is new');
  assert.equal(ab.alreadyKnown, 1);
  assert.equal(ab.differing, 1, 'and 101 disagreed, which is counted rather than refused');
  assert.equal(ab.table.rowCount, 3);

  const area = ab.table.columns[ab.table.byName.get('LoadArea')];
  assert.deepEqual(area.labels, ['ALPHA', 'NORTH', 'SOUTH'], 'the union dictionary is sorted');
  assert.equal(
    area.labels[area.codes[ab.table.index.get(101)]],
    'NORTH',
    "first key wins: 101 keeps A's LoadArea",
  );
  assert.equal(
    area.labels[area.codes[ab.table.index.get(103)]],
    'ALPHA',
    "the APPENDED row's code is remapped through the union dictionary, not spliced from B",
  );
  ok('a merge unions keys, first key wins, and the discard is counted');

  // B's own dictionary was ['ALPHA', 'WEST']: code 0 = ALPHA. In the union
  // ALPHA is still 0 by luck, so make the point where luck cannot help — a
  // label that sorts after everything in A.
  const c = parseLookupCsv(busList([busRow(104, 'DOGWOOD', 'ZETA')]), 'BusList-C.csv').rows;
  const abc = mergeLookup(ab.table, c);
  const areaC = abc.table.columns[abc.table.byName.get('LoadArea')];
  assert.equal(areaC.labels.indexOf('ZETA'), areaC.labels.length - 1);
  assert.equal(
    areaC.labels[areaC.codes[abc.table.index.get(104)]],
    'ZETA',
    "C's only label had code 0 in C and is not code 0 here",
  );
  assert.equal(
    areaC.labels[areaC.codes[abc.table.index.get(101)]],
    'NORTH',
    "and A's rows still read right",
  );
  ok('enum dictionaries remap on append rather than concatenating');

  // Two drop orders, byte-identical columns. The pair below has no
  // conflicting values, because the WINNER of a conflict is allowed to depend
  // on drop order — nothing else is.
  const d = parseLookupCsv(busList([busRow(201, 'ELM', 'NORTH')]), 'd.csv').rows;
  const e = parseLookupCsv(busList([busRow(200, 'FIR', 'ZETA')]), 'e.csv').rows;
  const de = mergeLookup(mergeLookup(undefined, d).table, e).table;
  const ed = mergeLookup(mergeLookup(undefined, e).table, d).table;
  assert.equal(snapshot(de), snapshot(ed), 'two drop orders produce byte-identical columns');
  assert.deepEqual([...de.index.keys()], [200, 201], 'the union is sorted by key, not by arrival');
  ok('merge order does not reach the stored bytes: sorted rows, derived codes');

  // A column present in one file of a pair and absent from the other.
  const wide = parseLookupCsv(
    busList([`${busRow(300, 'GUM', 'NORTH')},SUB-1`], { columns: [...BUS_COLUMNS, 'Substation'] }),
    'wide.csv',
  ).rows;
  const narrow = parseLookupCsv(busList([busRow(301, 'HOLLY', 'SOUTH')]), 'narrow.csv').rows;
  const merged = mergeLookup(mergeLookup(undefined, wide).table, narrow).table;
  const substation = merged.columns[merged.byName.get('Substation')];
  assert.equal(cellText(substation, merged.index.get(300)), 'SUB-1');
  assert.equal(
    cellText(substation, merged.index.get(301)),
    null,
    'a row from a file lacking the column is null in it',
  );
  assert.equal(
    mergeLookup(mergeLookup(undefined, narrow).table, wide).differing,
    0,
    'a new column is not a conflict',
  );
  ok('the merge unions columns, and a row from a file lacking one is null there');

  // Round trip: decode and rebuild changes nothing.
  assert.equal(snapshot(buildLookup(toRows(ab.table))), snapshot(ab.table));
  ok('a table decodes to rows and rebuilds byte-identically');
}

// ------------------------------------------------------------------ store

{
  clearLookups();
  const first = attachLookup(
    parseLookupCsv(busList([busRow(101, 'ALDER', 'NORTH')]), 'BusList-A.csv').rows,
  );
  const second = attachLookup(
    parseLookupCsv(
      busList([busRow(101, 'ALDER', 'WEST'), busRow(102, 'BIRCH', 'SOUTH')]),
      'BusList-B.csv',
    ).rows,
  );
  assert.equal(
    lookupFor('buslist').rowCount,
    2,
    'the second file grew the list, it did not replace it',
  );
  assert.equal(lookupFor('generatorlist'), undefined, 'and it did not open a generator list');
  assert.deepEqual(
    lookupSources(),
    ['BusList-A.csv', 'BusList-B.csv'],
    'both files are named as provenance',
  );

  const note = mergeNote('BusList-B.csv', second);
  assert.match(note, /1 row\(s\) added/);
  assert.match(note, /1 key\(s\) already known, 1 with differing values \(kept first\)/, note);
  assert.match(note, /2 row\(s\) in the bus list/);
  assert.equal(first.alreadyKnown, 0, 'the first file of a variant merges with nothing');
  ok('the session store grows one list per variant, and the discard count reaches the note');

  attachLookup(
    parseLookupCsv(generatorList([genRow('G1', 101, 'HYDRO')]), 'GeneratorList.csv').rows,
  );
  assert.equal(lookupFor('generatorlist').entity, 'generator');
  assert.equal(lookupFor('buslist').rowCount, 2, 'a generator list does not disturb the bus list');
  clearLookups();
  ok('the two variants are independent');
}

console.log(`\n${checks} checks passed.`);
