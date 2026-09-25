// scripts/make-sample-data.mjs
//
// Writes a tiny, synthetic GridView export set covering every (kind, shape)
// src/detect.ts routes, every split style the Import Dialog merges, and every
// awkward property the real exports carry, so ingest is tested on files built
// here.
//
// The CORRECTNESS generator: each file is built whole in memory so an anomaly
// (a duplicate row, a disagreeing TOU, a BOM) can be spliced in at an exact
// position, which the streaming perf generator cannot do. Their shared ~30
// lines (seeded PRNG, name formatter) are duplicated on purpose until a third
// script needs them.
//
// Every awkward property is a fixed, NAMED file, never random, and
// tests/test_sample_data.mjs asserts each is still present: clean-only data
// would pass every test and fail on the first real export.
//
// Usage:
//   node scripts/make-sample-data.mjs                  # writes the whole set
//   node scripts/make-sample-data.mjs --seed 7 --out /tmp/x

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A sibling of sample-data/perf/: one gitignore rule already covers the
 * whole sample-data/ tree, so this generator needs no ignore rule of its own. */
export const DEFAULT_OUT = join(REPO, 'sample-data', 'correctness');

/** Fixed default seed: a test that regenerates its own input must get
 * byte-identical output, or "regenerate and compare" proves nothing. */
export const DEFAULT_SEED = 20260915;

/** Every generated name carries this, so a synthetic file can never be
 * mistaken for a real export and a real export can never be mistaken for
 * synthetic and deleted. */
const NAME_PREFIX = 'SAMPLE';

/** Non-leap, matching scripts/make-perf-data.mjs's ladder, so a human
 * comparing the two output sets is not asking "why do these differ" about a
 * fact that has nothing to do with either generator. */
const YEAR = 2034;
/** Leap, for the one file that needs Feb 29 to exist at all. */
const LEAP_YEAR = 2036;

function isLeap(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year, month) {
  const ML = [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return ML[month - 1];
}

// ---------------------------------------------------------------- primitives

/** Mulberry32, seeded. Duplicated from scripts/make-perf-data.mjs on purpose
 * -- see the header comment for why the two scripts do not share a module. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function entityName(kind, index) {
  return `${NAME_PREFIX}_${kind.toUpperCase()}_${String(index).padStart(4, '0')}`;
}

function metricName(index) {
  return `${NAME_PREFIX}_METRIC_${String(index).padStart(2, '0')}`;
}

/** Two magnitudes a float32 cube and a naive parser get wrong (near 1e8, and
 * tens of thousands negative), pinned so tests can ask for them. */
const LARGE_VALUE = '98765432.10';
const NEGATIVE_VALUE = '-54321.098';

/** One value, in the mix block.c must survive (as make-perf-data.mjs):
 * moderate positives, large negatives, near 1e8, exponent notation. */
function formatValue(next) {
  const roll = next();
  if (roll < 0.7) return (next() * 5000).toFixed(3);
  if (roll < 0.85) return (-next() * 90000).toFixed(3);
  if (roll < 0.95) return (next() * 1e8).toFixed(2);
  return `${(next() * 9).toFixed(6)}E-0${1 + Math.floor(next() * 3)}`;
}

function touOf(hour) {
  return hour % 2 === 0 ? 'OnPeak' : 'OffPeak';
}

/** Walk hour-ending 1..24 over a date range. Feb 29 is not special-cased:
 * ingest drops it at read time. */
function* calendarRange(year, fromMonth, fromDay, toMonth, toDay) {
  let month = fromMonth;
  let day = fromDay;
  while (month < toMonth || (month === toMonth && day <= toDay)) {
    for (let hour = 1; hour <= 24; hour++) yield [month, day, hour];
    day++;
    if (day > daysInMonth(year, month)) {
      day = 1;
      month++;
    }
  }
}

/** A CSV cell, quoted (RFC 4180) only when it needs to be -- the one field
 * this generator ever quotes is GeneratorList's Long Name, which carries a
 * real comma, proving a real CSV reader is required. */
function csvField(value) {
  return /,/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// ---------------------------------------------------------------- shape W

/** One wide (shape W) export as text. Every awkward wide property is an
 * option here, so every wide file goes through this one writer. */
function buildWideText({
  entity,
  quantity,
  year,
  range,
  names,
  seed,
  ids, // bus id row values, aligned to `names`, or undefined for no id row
  bom = false,
  headerPadding = false,
  trailingComma = false,
  duplicateFirstDataRow = false,
  touOverride, // { month, day, hour, tou }
  // Pin the first row's first two cells to the awkward magnitudes, so a test
  // can ask for them.
  extremesFirstRow = false,
}) {
  const [[fromMonth, fromDay], [toMonth, toDay]] = range;
  const lines = [];
  lines.push(`${entity} Hourly '${quantity}' Data for Year ${year}`);
  lines.push('');
  lines.push(
    `(From the first hour of ${fromMonth}/${fromDay}/${year} to the last hour of ` +
      `${toMonth}/${toDay}/${year}. Column identifier -- ${entity}Name)`,
  );
  lines.push('');
  if (ids) lines.push(`,,BusNumber,${ids.join(',')}`);

  const headerNames = names.map((n, i) => (headerPadding && i === 0 ? ` ${n}` : n));
  let headerLine = `Date, Hour, TOU,${headerNames.join(',')}`;
  if (trailingComma) headerLine += ',';
  lines.push(headerLine);

  const next = rng(seed);
  const dataLines = [];
  for (const [month, day, hour] of calendarRange(year, fromMonth, fromDay, toMonth, toDay)) {
    const tou =
      touOverride &&
      touOverride.month === month &&
      touOverride.day === day &&
      touOverride.hour === hour
        ? touOverride.tou
        : touOf(hour);
    const fields = names.map(() => formatValue(next));
    if (extremesFirstRow && dataLines.length === 0) {
      fields[0] = LARGE_VALUE;
      if (fields.length > 1) fields[1] = NEGATIVE_VALUE;
    }
    let row = `${month}/${day}/${year},${hour},${tou},${fields.join(',')}`;
    if (trailingComma) row += ',';
    dataLines.push(row);
  }
  if (duplicateFirstDataRow) dataLines.push(dataLines[0]);
  lines.push(...dataLines);

  let text = lines.join('\r\n') + '\r\n';
  if (bom) text = '﻿' + text;
  return text;
}

// ---------------------------------------------------------------- shape L

/** One long (shape L) export as text. `keyValuesFor(index)` gives an entity's
 * key values; `valueFor(entity, metric, next)` lets a caller shape per-entity
 * metrics (e.g. zero for some entities). */
function buildLongText({
  keys,
  entities, // count
  keyValuesFor,
  metrics,
  year,
  range,
  seed,
  valueFor = (_entityIndex, _metricIndex, next) => formatValue(next),
}) {
  const [[fromMonth, fromDay], [toMonth, toDay]] = range;
  const header = ['Date', ' Hour', ' TOU', ...keys.map((k) => ` ${k}`), ...metrics].join(',');
  const lines = [header];
  const next = rng(seed);
  for (const [month, day, hour] of calendarRange(year, fromMonth, fromDay, toMonth, toDay)) {
    const tou = touOf(hour);
    for (let e = 0; e < entities; e++) {
      const fields = metrics.map((_, m) => valueFor(e, m, next));
      lines.push(
        `${month}/${day}/${year},${hour},${tou},${keyValuesFor(e).join(',')},${fields.join(',')}`,
      );
    }
  }
  return lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- shape R

/** One reference list as text: one or two banner lines, a header, then rows.
 * `rows` are plain objects keyed by declared column name; a column a row
 * does not set is written blank. */
function buildRefListText(columnNames, bannerLines, rows) {
  const lines = [...bannerLines, columnNames.map(csvField).join(',')];
  for (const row of rows) lines.push(columnNames.map((c) => csvField(row[c] ?? '')).join(','));
  return lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- Groupings

function buildGroupingsText(pairs) {
  const lines = ['Name,Grouping', ...pairs.map(([name, group]) => `${name},${group}`)];
  return lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- the set

/** BusList and GeneratorList column names, duplicated from
 * src/lookups/schema.ts so this script runs in Node with no build step. */
const BUS_LIST_COLUMNS = [
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
const GENERATOR_LIST_COLUMNS = [
  'GeneratorKey',
  'Name',
  'Bus ID',
  'Bus Name',
  'Bus KV',
  'Unit ID',
  'Generator TypeID',
  'SubType',
  'Long ID',
  'Long Name',
  'ServiceStatus',
  'Commission Date',
  'Retirement Date',
  'DevStatus',
  'Area Name',
  'Region Name',
  'PSSEMinCap(MW)',
  'PSSEMaxCap(MW)',
  'InitialDispatch(MW)',
  'Save To Binary',
  'State',
  'County',
  'City',
  'Zipcode',
  'FuelType',
  'Technology',
  'BTM',
  'InternalID',
  'EconomicPMin',
  'EconomicPMax',
];

/** Build the file set plus a `properties` map from each awkward property to
 * the files carrying it (what tests/test_sample_data.mjs checks). */
export function buildFiles(seed = DEFAULT_SEED) {
  const files = [];
  const properties = {};
  const add = (name, text, notes) => files.push({ name, text, notes });
  const mark = (key, description, ...fileNames) => {
    properties[key] = { description, files: fileNames };
  };

  // --- Area, shape W: areas full year, one characteristic -----------------
  const AREA_NAMES = Array.from({ length: 5 }, (_, i) => entityName('area', i + 1));
  add(
    'area-wide.csv',
    buildWideText({
      entity: 'Area',
      quantity: 'Load (MWh)',
      year: YEAR,
      range: [
        [1, 1],
        [1, 3],
      ],
      names: AREA_NAMES,
      seed: seed + 1,
      extremesFirstRow: true,
    }),
    'shape W, area, one characteristic -- the baseline wide Area export.',
  );
  mark(
    'values near 1e8, and negative values in the tens of thousands',
    `area-wide.csv's first data row carries ${LARGE_VALUE} in its first entity column and ` +
      `${NEGATIVE_VALUE} in its second.`,
    'area-wide.csv',
  );

  // --- Area, shape L: areas full year, many characteristics ----------------
  const AREA_METRICS = Array.from({ length: 4 }, (_, i) => metricName(i + 1));
  add(
    'area-long.csv',
    buildLongText({
      keys: ['Name'],
      entities: AREA_NAMES.length,
      keyValuesFor: (e) => [AREA_NAMES[e]],
      metrics: AREA_METRICS,
      year: YEAR,
      range: [
        [1, 1],
        [1, 2],
      ],
      seed: seed + 2,
      valueFor: (e, m, next) => {
        // Metric index 2: zero for entities 0-1, dense for the rest.
        if (m === 2) return e < 2 ? '0' : formatValue(next);
        // Metric index 3: zero everywhere -- the constant-plane case.
        if (m === 3) return '0';
        return formatValue(next);
      },
    }),
    'shape L, area, many characteristics -- carries the zero-plane properties.',
  );
  mark(
    'metric zero for some entities, dense for others',
    'area-long.csv metric column 3 (SAMPLE_METRIC_03) is zero for the first two areas and dense for the rest.',
    'area-long.csv',
  );
  mark(
    'metric all-zero everywhere',
    'area-long.csv metric column 4 (SAMPLE_METRIC_04) is zero for every area and every hour.',
    'area-long.csv',
  );

  // --- Interface, shape W: two quantities, one Case -------------------------
  const INTERFACE_NAMES = Array.from({ length: 4 }, (_, i) => entityName('interface', i + 1));
  const interfaceRange = [
    [1, 1],
    [1, 2],
  ];
  add(
    'interface-wide-power-flow.csv',
    buildWideText({
      entity: 'Interface',
      quantity: 'Power Flow (MW)',
      year: YEAR,
      range: interfaceRange,
      names: INTERFACE_NAMES,
      seed: seed + 3,
    }),
    'shape W, interface, quantity 1 of 2 sharing a Case with interface-wide-congestion-cost.csv.',
  );
  add(
    'interface-wide-congestion-cost.csv',
    buildWideText({
      entity: 'Interface',
      quantity: 'Congestion Cost ($)',
      year: YEAR,
      range: interfaceRange,
      names: INTERFACE_NAMES,
      seed: seed + 4,
    }),
    'shape W, interface, quantity 2 of 2 -- same year and axis as interface-wide-power-flow.csv, different measurement, one Case.',
  );
  mark(
    'two interface quantities, one Case',
    'interface-wide-power-flow.csv and interface-wide-congestion-cost.csv share a year and entity axis; different quantities.',
    'interface-wide-power-flow.csv',
    'interface-wide-congestion-cost.csv',
  );

  // --- Bus, shape W, with id row --------------------------------------------
  // Two columns share a NAME with distinct BusNumbers (ids are the key); two
  // names end in "#2"/"#3"; id 10007 is absent from bus-list.csv, which has
  // an id absent here: both directions of the join.
  const BUS_IDS = [10001, 10002, 10003, 10004, 10005, 10006, 10007];
  const BUS_NAMES = [
    entityName('bus', 1),
    'SAMPLE_BUS_DUPNAME',
    'SAMPLE_BUS_DUPNAME',
    'SAMPLE_BUS_ALPHA#2',
    'SAMPLE_BUS_ALPHA#3',
    entityName('bus', 6),
    entityName('bus', 7),
  ];
  add(
    'bus-wide.csv',
    buildWideText({
      entity: 'Bus',
      quantity: 'LMP ($/MWh)',
      year: YEAR,
      range: [
        [1, 1],
        [1, 2],
      ],
      names: BUS_NAMES,
      seed: seed + 5,
      ids: BUS_IDS,
    }),
    'shape W, bus, with the ,,BusNumber,... id row -- the bus key argument.',
  );
  mark(
    'duplicate bus names across columns, distinct BusNumbers',
    'bus-wide.csv columns 2 and 3 both carry the name "SAMPLE_BUS_DUPNAME" under BusNumbers 10002 and 10003.',
    'bus-wide.csv',
  );
  mark(
    'entity names ending in #2 and #3',
    'bus-wide.csv carries "SAMPLE_BUS_ALPHA#2" (BusNumber 10004) and "SAMPLE_BUS_ALPHA#3" (BusNumber 10005).',
    'bus-wide.csv',
  );
  mark(
    'reference list and hourly export disagree on membership, both directions',
    'bus-wide.csv carries BusNumber 10007, absent from bus-list.csv; bus-list.csv carries BusID 10099, absent from bus-wide.csv.',
    'bus-wide.csv',
    'bus-list.csv',
  );

  // --- Bus, shape W, keyless: a wide bus export with no id row ------------
  add(
    'bus-wide-no-id.csv',
    buildWideText({
      entity: 'Bus',
      quantity: 'LMP ($/MWh)',
      year: YEAR,
      range: [
        [1, 1],
        [1, 1],
      ],
      names: [entityName('bus', 1), entityName('bus', 2)],
      seed: seed + 6,
      // No `ids`: the id row that BUS_WIDE_SPEC (preambleLines: 5) requires
      // is simply absent, which is the property this file is FOR.
    }),
    'shape W, bus, with no id row -- a wide Bus export that classifies but must be refused at ingest for lacking the BusNumber row.',
  );
  mark(
    'a wide Bus export with no id row',
    'bus-wide-no-id.csv has a Bus title line and a Date,Hour,TOU header but no ,,BusNumber,... row above it.',
    'bus-wide-no-id.csv',
  );

  // --- Bus, shape L: many characteristics -----------------------------------
  const BUS_LONG_METRICS = Array.from({ length: 2 }, (_, i) => metricName(i + 1));
  const BUS_LONG_ROWS = [
    { id: 20001, name: entityName('bus', 1), area: 'SAMPLE_AREA_0001' },
    { id: 20002, name: entityName('bus', 2), area: 'SAMPLE_AREA_0002' },
    { id: 20003, name: entityName('bus', 3), area: 'SAMPLE_AREA_0001' },
  ];
  add(
    'bus-long.csv',
    buildLongText({
      keys: ['BusID', 'BusName', 'Area'],
      entities: BUS_LONG_ROWS.length,
      keyValuesFor: (e) => [BUS_LONG_ROWS[e].id, BUS_LONG_ROWS[e].name, BUS_LONG_ROWS[e].area],
      metrics: BUS_LONG_METRICS,
      year: YEAR,
      range: [
        [1, 1],
        [1, 1],
      ],
      seed: seed + 7,
    }),
    'shape L, bus, many characteristics -- key columns BusID, BusName, Area.',
  );

  // --- Generator, shape W: no id row, names only ----------------------------
  const GENERATOR_NAMES = Array.from({ length: 6 }, (_, i) => entityName('generator', i + 1));
  add(
    'generator-wide.csv',
    buildWideText({
      entity: 'Generator',
      quantity: 'Energy (MWh)',
      year: YEAR,
      range: [
        [1, 1],
        [1, 2],
      ],
      names: GENERATOR_NAMES,
      seed: seed + 8,
    }),
    'shape W, generator, no id row -- names key the axis directly, unlike Bus.',
  );
  mark(
    'reference list and hourly export disagree on membership, generator side',
    'generator-wide.csv carries SAMPLE_GENERATOR_0006, absent from generator-list.csv.',
    'generator-wide.csv',
    'generator-list.csv',
  );

  // --- Generator, shape L: many characteristics -----------------------------
  const GENERATOR_LONG_METRICS = Array.from({ length: 2 }, (_, i) => metricName(i + 1));
  const GENERATOR_LONG_UNITS = [
    { unitName: entityName('generator', 1), busId: 10001, unitId: 'PV' },
    { unitName: entityName('generator', 2), busId: 10002, unitId: 'A' },
    { unitName: entityName('generator', 3), busId: 10003, unitId: '1' },
    { unitName: entityName('generator', 4), busId: 10004, unitId: '01' },
  ];
  add(
    'generator-long.csv',
    buildLongText({
      keys: ['UnitName', 'BusID', 'UnitID'],
      entities: GENERATOR_LONG_UNITS.length,
      keyValuesFor: (e) => [
        GENERATOR_LONG_UNITS[e].unitName,
        GENERATOR_LONG_UNITS[e].busId,
        GENERATOR_LONG_UNITS[e].unitId,
      ],
      metrics: GENERATOR_LONG_METRICS,
      year: YEAR,
      range: [
        [1, 1],
        [1, 1],
      ],
      seed: seed + 9,
    }),
    'shape L, generator, many characteristics -- UnitID mixes text ("PV", "A") and numeric-looking ("1", "01") values.',
  );
  mark(
    'UnitID values that are text and others that look numeric',
    'generator-long.csv UnitID column carries "PV", "A", "1" and "01" -- the last two must not collide or be read as the same key.',
    'generator-long.csv',
  );

  // --- BusList (shape R) -----------------------------------------------------
  const busListRows = [
    {
      BusID: 10001,
      Name: 'Sample Substation Alpha',
      BaseKV: '230',
      Type: '1',
      VM: '1.02',
      VA: '-3.5',
      Latitude: '41.5',
      Longitude: '-87.6',
      Monitored: 'True',
      LoadArea: 'SAMPLE_ZONE_A',
      PSSEArea: 'SAMPLE_PA_1',
      PSSEZone: 'SAMPLE_PZ_1',
    },
    {
      BusID: 10002,
      Name: 'Sample Substation Beta',
      BaseKV: '0', // legitimate: a fictitious/aggregation bus
      Type: '2',
      VM: '1.00',
      VA: '0',
      Latitude: '39.1',
      Longitude: '-94.6',
      Monitored: 'False',
      LoadArea: 'SAMPLE_ZONE_B',
      PSSEArea: 'SAMPLE_PA_1',
      PSSEZone: 'SAMPLE_PZ_2',
    },
    {
      BusID: 10003,
      Name: 'Sample Substation Gamma',
      BaseKV: '138',
      Type: '1',
      VM: '0.99',
      VA: '2.1',
      Latitude: '0', // unknown, not the equator
      Longitude: '0',
      Monitored: '#TRUE#',
      LoadArea: 'SAMPLE_ZONE_A',
      PSSEArea: 'SAMPLE_PA_2',
      PSSEZone: 'SAMPLE_PZ_1',
    },
    {
      BusID: 10004,
      Name: 'Sample Substation Delta',
      BaseKV: '69',
      Type: '3',
      VM: '1.01',
      // Unquoted here: `csvField` quotes cells with commas, and pre-quoting
      // would produce the literal text `"12,345.678"`.
      VA: '12,345.678',
      Latitude: '33.4',
      Longitude: '-112.1',
      Monitored: '#FALSE#',
      LoadArea: 'SAMPLE_ZONE_C',
      PSSEArea: 'SAMPLE_PA_2',
      PSSEZone: 'SAMPLE_PZ_2',
    },
    {
      BusID: 10005,
      Name: 'Sample Substation Epsilon',
      BaseKV: '345',
      Type: '1',
      VM: '1.00',
      VA: '1.0',
      Latitude: '',
      Longitude: 'NA',
      Monitored: 'YES',
      LoadArea: 'na',
      PSSEArea: 'N/A',
      PSSEZone: 'n/a',
    },
    {
      BusID: 10006,
      Name: 'Sample Substation Zeta',
      BaseKV: '115',
      Type: '2',
      VM: '0.98',
      VA: '-1.2',
      Latitude: '45.0',
      Longitude: '-93.1',
      Monitored: 'NO',
      LoadArea: 'NULL',
      PSSEArea: '#N/A',
      PSSEZone: 'SAMPLE_PZ_3',
    },
    {
      // Present in the list, absent from bus-wide.csv (the other
      // direction from BusNumber 10007 above).
      BusID: 10099,
      Name: 'Sample Substation Omega',
      BaseKV: '230',
      Type: '1',
      VM: '1.00',
      VA: '0.0',
      Latitude: '29.7',
      Longitude: '-95.4',
      Monitored: 'True',
      LoadArea: 'SAMPLE_ZONE_A',
      PSSEArea: 'SAMPLE_PA_1',
      PSSEZone: 'SAMPLE_PZ_1',
    },
  ];
  // BusID 10004's VA is the quoted "12,345.678" (a thousands separator); the
  // comma must not split the field.
  add(
    'bus-list.csv',
    buildRefListText(BUS_LIST_COLUMNS, ['BUS_GENERAL'], busListRows),
    "shape R, bus -- banner BUS_GENERAL, superset (plus one extra, minus one) of bus-wide.csv's axis.",
  );
  mark(
    'every blank spelling normalizeCell recognises',
    'bus-list.csv BusID 10005 spells its LoadArea/PSSEArea/PSSEZone/Longitude blanks as "", ' +
      '"NA", "N/A" and "n/a"; BusID 10006 adds "NULL" and "#N/A". The set is asserted against ' +
      "src/lookups/parse.ts's own BLANKS rather than counted here, so a spelling added there " +
      'fails until this file carries it.',
    'bus-list.csv',
  );
  mark(
    'True/False title case, #TRUE#/#FALSE#, YES/NO',
    'bus-list.csv Monitored column carries "True", "False", "#TRUE#", "#FALSE#", "YES" and "NO" across its rows.',
    'bus-list.csv',
  );
  mark(
    'lat/long of exactly 0,0 and a BaseKV of 0',
    'bus-list.csv BusID 10002 has BaseKV 0 (a real fictitious bus); BusID 10003 has Latitude/Longitude both 0 (unknown location).',
    'bus-list.csv',
  );
  mark(
    'numbers written with thousands separators',
    'bus-list.csv BusID 10004\'s VA column is the quoted field "12,345.678".',
    'bus-list.csv',
  );

  // --- GeneratorList (shape R) -----------------------------------------------
  const generatorListRows = [
    {
      GeneratorKey: '1',
      Name: entityName('generator', 1),
      'Bus ID': '10001',
      'Bus Name': 'Sample Substation Alpha',
      'Bus KV': '230',
      'Unit ID': "'PV", // leading apostrophe, the Note!!! case
      'Generator TypeID': 'SAMPLE_TYPE_1',
      SubType: 'SAMPLE_SUBTYPE_1',
      'Long ID': 'LID-0001',
      'Long Name': 'Sample Plant, Unit 1', // real comma -- must be quoted
      ServiceStatus: 'YES',
      'Commission Date': '#2020-01-15#',
      'Retirement Date': '',
      DevStatus: 'SAMPLE_DEV_1',
      'Area Name': 'SAMPLE_ZONE_A',
      'Region Name': 'SAMPLE_REGION_1',
      'PSSEMinCap(MW)': '10',
      'PSSEMaxCap(MW)': '150',
      'InitialDispatch(MW)': '80',
      'Save To Binary': 'TRUE',
      State: 'SAMPLE_STATE_1',
      County: 'SAMPLE_COUNTY_1',
      City: 'SAMPLE_CITY_1',
      Zipcode: '00001',
      FuelType: 'SAMPLE_FUEL_GAS',
      Technology: 'SAMPLE_TECH_CC',
      BTM: 'FALSE',
      InternalID: '1001',
      EconomicPMin: '10',
      EconomicPMax: '150',
    },
    {
      GeneratorKey: '2',
      Name: entityName('generator', 2),
      'Bus ID': '10002',
      'Bus Name': 'Sample Substation Beta',
      'Bus KV': '138',
      'Unit ID': 'A',
      'Generator TypeID': 'SAMPLE_TYPE_2',
      SubType: 'SAMPLE_SUBTYPE_2',
      'Long ID': 'LID-0002',
      'Long Name': 'Sample Plant Unit 2',
      ServiceStatus: 'NO',
      'Commission Date': '#2015-06-01#',
      'Retirement Date': '#2040-06-01#',
      DevStatus: 'SAMPLE_DEV_2',
      'Area Name': 'SAMPLE_ZONE_B',
      'Region Name': 'SAMPLE_REGION_1',
      'PSSEMinCap(MW)': '5',
      'PSSEMaxCap(MW)': '75',
      'InitialDispatch(MW)': '0',
      'Save To Binary': 'FALSE',
      State: '', // blank
      County: 'NA',
      City: 'N/A',
      Zipcode: 'n/a',
      FuelType: 'NULL',
      Technology: '#N/A',
      BTM: 'TRUE',
      InternalID: '1002',
      EconomicPMin: '5',
      EconomicPMax: '75',
    },
    {
      GeneratorKey: '3',
      Name: entityName('generator', 3),
      'Bus ID': '10003',
      'Bus Name': 'Sample Substation Gamma',
      'Bus KV': '69',
      'Unit ID': '1',
      'Generator TypeID': 'SAMPLE_TYPE_1',
      SubType: 'SAMPLE_SUBTYPE_1',
      'Long ID': 'LID-0003',
      'Long Name': 'Sample Plant Unit 3',
      ServiceStatus: 'YES',
      'Commission Date': '#2022-11-30#',
      'Retirement Date': '',
      DevStatus: 'SAMPLE_DEV_1',
      'Area Name': 'SAMPLE_ZONE_A',
      'Region Name': 'SAMPLE_REGION_2',
      'PSSEMinCap(MW)': '2',
      'PSSEMaxCap(MW)': '40',
      'InitialDispatch(MW)': '20',
      'Save To Binary': 'TRUE',
      State: 'SAMPLE_STATE_2',
      County: 'SAMPLE_COUNTY_2',
      City: 'SAMPLE_CITY_2',
      Zipcode: '00003',
      FuelType: 'SAMPLE_FUEL_SOLAR',
      Technology: 'SAMPLE_TECH_PV',
      BTM: 'FALSE',
      InternalID: '1003',
      EconomicPMin: '2',
      EconomicPMax: '40',
    },
    {
      // Present in the list, absent from generator-wide.csv -- the other
      // direction of the reference-list join.
      GeneratorKey: '4',
      Name: 'SAMPLE_GENERATOR_EXTRA',
      'Bus ID': '10099',
      'Bus Name': 'Sample Substation Omega',
      'Bus KV': '230',
      'Unit ID': '01',
      'Generator TypeID': 'SAMPLE_TYPE_2',
      SubType: 'SAMPLE_SUBTYPE_2',
      'Long ID': 'LID-0004',
      'Long Name': 'Sample Plant Unit 4',
      ServiceStatus: 'YES',
      'Commission Date': '#2018-03-09#',
      'Retirement Date': '',
      DevStatus: 'SAMPLE_DEV_1',
      'Area Name': 'SAMPLE_ZONE_A',
      'Region Name': 'SAMPLE_REGION_1',
      'PSSEMinCap(MW)': '1',
      'PSSEMaxCap(MW)': '20',
      'InitialDispatch(MW)': '5',
      'Save To Binary': 'TRUE',
      State: 'SAMPLE_STATE_1',
      County: 'SAMPLE_COUNTY_1',
      City: 'SAMPLE_CITY_1',
      Zipcode: '00099',
      FuelType: 'SAMPLE_FUEL_WIND',
      Technology: 'SAMPLE_TECH_WIND',
      BTM: 'FALSE',
      InternalID: '1099',
      EconomicPMin: '1',
      EconomicPMax: '20',
    },
  ];
  add(
    'generator-list.csv',
    buildRefListText(
      GENERATOR_LIST_COLUMNS,
      [
        'GENERATORLIST',
        'Note!!! prepend an apostrophe to a Unit ID that looks numeric to keep it text',
      ],
      generatorListRows,
    ),
    'shape R, generator -- two banners, the second the Note!!! apostrophe warning.',
  );
  mark(
    'a leading apostrophe on a Unit ID',
    "generator-list.csv row 1's Unit ID is written \"'PV\", following its own Note!!! banner's instruction.",
    'generator-list.csv',
  );
  mark(
    'a quoted field containing a comma',
    'generator-list.csv row 1\'s Long Name is "Sample Plant, Unit 1" -- a real comma inside a quoted field.',
    'generator-list.csv',
  );

  // --- Groupings.csv -----------------------------------------------------
  add(
    'groupings.csv',
    buildGroupingsText(
      AREA_NAMES.map((name, i) => [name, i < 2 ? 'SAMPLE_GROUP_NORTH' : 'SAMPLE_GROUP_SOUTH']),
    ),
    "Name -> Grouping over area-wide.csv / area-long.csv's area axis.",
  );

  // --- Splits, from the Import Dialog's "same study name" merge ------------
  const SPLIT_AREAS_3 = AREA_NAMES.slice(0, 3);

  // Date-split covering the whole year: two halves, same axis.
  add(
    'area-wide-split-fullyear-h1.csv',
    buildWideText({
      entity: 'Area',
      quantity: 'Load (MWh)',
      year: YEAR,
      range: [
        [1, 1],
        [6, 30],
      ],
      names: SPLIT_AREAS_3,
      seed: seed + 10,
    }),
    'date-split half 1 of 2 (Jan 1 - Jun 30): with h2, covers the whole year.',
  );
  add(
    'area-wide-split-fullyear-h2.csv',
    buildWideText({
      entity: 'Area',
      quantity: 'Load (MWh)',
      year: YEAR,
      range: [
        [7, 1],
        [12, 31],
      ],
      names: SPLIT_AREAS_3,
      seed: seed + 11,
    }),
    'date-split half 2 of 2 (Jul 1 - Dec 31): with h1, covers the whole year.',
  );
  mark(
    'date-split covering the whole year',
    'area-wide-split-fullyear-h1.csv (Jan-Jun) plus -h2.csv (Jul-Dec), same axis, cover 2034 exactly once each.',
    'area-wide-split-fullyear-h1.csv',
    'area-wide-split-fullyear-h2.csv',
  );

  // Date-split covering only part of the year.
  add(
    'area-wide-split-partial-a.csv',
    buildWideText({
      entity: 'Area',
      quantity: 'Load (MWh)',
      year: YEAR,
      range: [
        [1, 1],
        [2, 28],
      ],
      names: SPLIT_AREAS_3,
      seed: seed + 12,
    }),
    'date-split part 1 of 2 (Jan 1 - Feb 28): with -b, covers ~120 days, not the whole year.',
  );
  add(
    'area-wide-split-partial-b.csv',
    buildWideText({
      entity: 'Area',
      quantity: 'Load (MWh)',
      year: YEAR,
      range: [
        [3, 1],
        [4, 29],
      ],
      names: SPLIT_AREAS_3,
      seed: seed + 13,
    }),
    'date-split part 2 of 2 (Mar 1 - Apr 29): with -a, covers ~120 days, not the whole year.',
  );
  mark(
    'date-split covering only part of the year',
    'area-wide-split-partial-a.csv (Jan-Feb) plus -b.csv (Mar-Apr): together, about 120 of 365 days.',
    'area-wide-split-partial-a.csv',
    'area-wide-split-partial-b.csv',
  );

  // Entity-subset split: same date range, disjoint entity sets.
  const entitySplitRange = [
    [1, 1],
    [1, 2],
  ];
  add(
    'area-wide-split-entities-a.csv',
    buildWideText({
      entity: 'Area',
      quantity: 'Load (MWh)',
      year: YEAR,
      range: entitySplitRange,
      names: AREA_NAMES.slice(0, 2),
      seed: seed + 14,
    }),
    'entity-subset split half 1 of 2: same date range as -b, disjoint area columns.',
  );
  add(
    'area-wide-split-entities-b.csv',
    buildWideText({
      entity: 'Area',
      quantity: 'Load (MWh)',
      year: YEAR,
      range: entitySplitRange,
      names: AREA_NAMES.slice(2, 4),
      seed: seed + 15,
    }),
    'entity-subset split half 2 of 2: same date range as -a, disjoint area columns.',
  );
  mark(
    'entity-subset split, same range, disjoint entity sets',
    'area-wide-split-entities-a.csv and -b.csv share Jan 1-2, 2034 but carry disjoint area columns.',
    'area-wide-split-entities-a.csv',
    'area-wide-split-entities-b.csv',
  );

  // A pair split by date AND entity subset at once.
  add(
    'area-wide-split-both-a.csv',
    buildWideText({
      entity: 'Area',
      quantity: 'Load (MWh)',
      year: YEAR,
      range: [
        [1, 1],
        [1, 2],
      ],
      names: AREA_NAMES.slice(0, 2),
      seed: seed + 16,
    }),
    'split by date AND entity subset, half 1 of 2.',
  );
  add(
    'area-wide-split-both-b.csv',
    buildWideText({
      entity: 'Area',
      quantity: 'Load (MWh)',
      year: YEAR,
      range: [
        [1, 3],
        [1, 4],
      ],
      names: AREA_NAMES.slice(2, 4),
      seed: seed + 17,
    }),
    'split by date AND entity subset, half 2 of 2.',
  );
  mark(
    'a pair split by date and entity subset at once',
    'area-wide-split-both-a.csv (Jan 1-2, areas 1-2) and -b.csv (Jan 3-4, areas 3-4): both axes differ.',
    'area-wide-split-both-a.csv',
    'area-wide-split-both-b.csv',
  );

  // Two files disagreeing about one hour's TOU -- must be refused.
  const conflictRange = [
    [1, 1],
    [1, 2],
  ];
  const conflictAreas = AREA_NAMES.slice(0, 3);
  add(
    'area-wide-conflict-tou-a.csv',
    buildWideText({
      entity: 'Area',
      quantity: 'Load (MWh)',
      year: YEAR,
      range: conflictRange,
      names: conflictAreas,
      seed: seed + 18,
    }),
    'TOU-conflict half 1 of 2: hour 5 of day 1 is OffPeak, the ordinary parity rule.',
  );
  add(
    'area-wide-conflict-tou-b.csv',
    buildWideText({
      entity: 'Area',
      quantity: 'Load (MWh)',
      year: YEAR,
      range: conflictRange,
      names: conflictAreas,
      seed: seed + 19,
      touOverride: { month: 1, day: 1, hour: 5, tou: 'OnPeak' },
    }),
    "TOU-conflict half 2 of 2: hour 5 of day 1 is forced to OnPeak, disagreeing with -a.csv's OffPeak.",
  );
  mark(
    "two files disagreeing about one hour's TOU",
    'area-wide-conflict-tou-a.csv and -b.csv agree on every cell except hour 5 of Jan 1, 2034, where TOU is OffPeak in -a and OnPeak in -b.',
    'area-wide-conflict-tou-a.csv',
    'area-wide-conflict-tou-b.csv',
  );

  // Two files whose dates are in different calendar years.
  add(
    'area-wide-conflict-year-a.csv',
    buildWideText({
      entity: 'Area',
      quantity: 'Load (MWh)',
      year: YEAR,
      range: conflictRange,
      names: conflictAreas,
      seed: seed + 20,
    }),
    `year-conflict half 1 of 2: dated ${YEAR}.`,
  );
  add(
    'area-wide-conflict-year-b.csv',
    buildWideText({
      entity: 'Area',
      quantity: 'Load (MWh)',
      year: YEAR + 1,
      range: conflictRange,
      names: conflictAreas,
      seed: seed + 21,
    }),
    `year-conflict half 2 of 2: dated ${YEAR + 1}, otherwise identical in shape to -a.csv.`,
  );
  mark(
    'two files whose dates are in different calendar years',
    `area-wide-conflict-year-a.csv is dated ${YEAR}; area-wide-conflict-year-b.csv is dated ${YEAR + 1}.`,
    'area-wide-conflict-year-a.csv',
    'area-wide-conflict-year-b.csv',
  );

  // The same (entity, metric, hour) written twice, within one file.
  add(
    'area-wide-duplicate-row.csv',
    buildWideText({
      entity: 'Area',
      quantity: 'Load (MWh)',
      year: YEAR,
      range: [
        [1, 1],
        [1, 1],
      ],
      names: AREA_NAMES.slice(0, 3),
      seed: seed + 22,
      duplicateFirstDataRow: true,
    }),
    'one file whose first data row (Jan 1, hour 1) is written a second time verbatim -- the duplicate area-hour refusal.',
  );
  mark(
    'the same (entity, metric, hour) written twice',
    'area-wide-duplicate-row.csv repeats its first data row (Jan 1, hour 1, 2034) once more, unchanged.',
    'area-wide-duplicate-row.csv',
  );

  // A leap year, so Feb 29 is present and has something to drop.
  add(
    'area-wide-leapyear.csv',
    buildWideText({
      entity: 'Area',
      quantity: 'Load (MWh)',
      year: LEAP_YEAR,
      range: [
        [2, 27],
        [3, 2],
      ],
      names: AREA_NAMES.slice(0, 2),
      seed: seed + 23,
    }),
    `shape W, area, ${LEAP_YEAR} -- Feb 27 through Mar 2, so Feb 29 is present in the file.`,
  );
  mark(
    'a leap year, so Feb 29 is present',
    `area-wide-leapyear.csv is dated ${LEAP_YEAR} and spans Feb 27 - Mar 2, so it carries a Feb 29 row ingest must drop.`,
    'area-wide-leapyear.csv',
  );

  // BOM on line 1, headers with leading/trailing spaces, trailing comma
  // padding -- three csv-hygiene properties on one otherwise-ordinary file.
  add(
    'area-wide-bom-padded.csv',
    buildWideText({
      entity: 'Area',
      quantity: 'Load (MWh)',
      year: YEAR,
      range: [
        [1, 1],
        [1, 1],
      ],
      names: AREA_NAMES.slice(0, 2),
      seed: seed + 24,
      bom: true,
      headerPadding: true,
      trailingComma: true,
    }),
    'shape W, area -- a leading UTF-8 BOM, a leading space on the first entity column, and trailing comma padding on every row.',
  );
  mark(
    'a BOM on line 1, header padding, trailing comma padding',
    "area-wide-bom-padded.csv opens with a UTF-8 BOM, pads its first entity column's header with a leading space, and every row ends with a trailing comma.",
    'area-wide-bom-padded.csv',
  );

  return { files, properties };
}

// ---------------------------------------------------------------- entry point

function parseArgs(argv) {
  const args = { out: DEFAULT_OUT, seed: DEFAULT_SEED };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--out') args.out = argv[++i];
    else if (flag === '--seed') args.seed = Number(argv[++i]);
    else throw new Error(`Unknown argument ${flag}`);
  }
  if (!Number.isInteger(args.seed)) throw new Error('--seed must be an integer');
  return args;
}

/** Write the set to `out` (wiped first) with a manifest.json of every file
 * and property. Exported for tests. */
export async function generate({ out = DEFAULT_OUT, seed = DEFAULT_SEED } = {}) {
  const { files, properties } = buildFiles(seed);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  for (const file of files) {
    // UTF-8 matters for the BOM file only (EF BB BF); the rest is ASCII.
    await writeFile(join(out, file.name), file.text, 'utf8');
  }
  const manifest = {
    generator: 'scripts/make-sample-data.mjs',
    synthetic: true,
    seed,
    namePrefix: NAME_PREFIX,
    files: files.map((f) => ({
      name: f.name,
      bytes: Buffer.byteLength(f.text, 'utf8'),
      notes: f.notes,
    })),
    properties,
  };
  await writeFile(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const manifest = await generate(args);
  const totalBytes = manifest.files.reduce((sum, f) => sum + f.bytes, 0);
  console.log(`${manifest.files.length} file(s) -> ${args.out}, seed ${args.seed}`);
  for (const f of manifest.files) console.log(`  wrote ${f.name.padEnd(36)} ${f.bytes} B`);
  console.log(
    `wrote ${manifest.files.length} file(s), ${totalBytes} B total, ` +
      `${Object.keys(manifest.properties).length} awkward properties, ` +
      `in ${((Date.now() - started) / 1000).toFixed(3)} s`,
  );
}
