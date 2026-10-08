// tests/test_hourly_csv.mjs — the hourly CSV writer (src/ui/hourly-csv.ts),
// from synthetic values only. The contracts:
//
//   * Every formatted cell reads back to the float32 it came from, integers
//     print bare, and a non-finite value is a blank field.
//   * A percent becomes its ratio by a string shift, exponent form included,
//     never by a division that brings back float noise.
//   * A field carrying a delimiter is quoted, so a label never shifts columns.
//   * The chart pane's download writes through the writer.
//   * A drawer file has 8,784 hour rows per layout unit with masked hours
//     blank, a key line per series whose name is unique, warnings once each
//     with a count, refusals grouped with at most five names, and a size
//     bound no smaller than the bytes it writes. Wide is withheld past
//     Excel's column limit.
//   * Long writes 8,784 rows per series under a `Series` value that is the
//     wide header and a key line, holds no series copies, and says past
//     Excel's rows that it is for pandas or R.
//   * The download layout is wire format: wide is the 8,784-hour slot with a
//     non-leap series blank on Feb 29, long writes no Feb 29 rows for a
//     non-leap series, and HourOfYear is the slot hour (Mar 1 HE 1 is 1440
//     in every year).
//   * A file holding more than one year (a Case spanning several, or Cases
//     of different years) writes each series' years: wide one column per
//     series and year, named with its year, on the one 8,784-hour slot;
//     long a `Year` column after `Series`, a non-leap year without Feb 29.
//     A file of one year keeps the one-year layout byte for byte, and every
//     size bound holds.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import './test_loader.mjs';

const {
  CELL_MAX_CHARS,
  HOUR_COLUMNS,
  WIDE_MAX_COLUMNS,
  csvField,
  formatCell,
  formatRatioCell,
  hourFields,
  LONG_EXCEL_SERIES,
  hourlyFileBound,
  hourlyNames,
  hourlyPeakBytes,
  longNote,
  percentTextAsRatio,
  wideWithheld,
} = await import('../src/ui/hourly-csv.ts');
const { exportHourly } = await import('../src/app/hourly-export.ts');
const { YEAR_SLOT_HOURS: H } = await import('../src/model/calendar.ts');

let checks = 0;
function ok(label) {
  checks++;
  console.log(`ok - ${label}`);
}

{
  // A spread of float32 values: tiny, huge, negative, fractional, random.
  const values = new Float32Array(20000);
  let seed = 12345;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < values.length; i++) {
    const scale = 10 ** Math.floor(next() * 24 - 12);
    values[i] = (next() - 0.5) * scale;
  }
  values.set([0.1, 1 / 3, 2 / 3, 1e-7, 123456.789, -0.000123, 3.4e38, 1.4e-45], 0);
  for (const value of values) {
    const text = formatCell(value);
    assert.equal(Math.fround(Number(text)), value, `${value} printed as ${text}`);
    const mantissa = text.split('e')[0];
    assert.ok(!mantissa.includes('.') || !/[0.]$/.test(mantissa), `${text} has trailing zeros`);
  }
  ok('every formatted float32 cell reads back to the same float32, with no trailing zeros');

  const extremes = [
    ...values,
    -1.2345679e-7,
    -0.0000012345679,
    -999999999,
    -1.2345679e9,
    -3.4028235e38,
    -1.4e-45,
  ].map(Math.fround);
  const widest = Math.max(
    ...extremes.map((value) => Math.max(formatCell(value).length, formatRatioCell(value).length)),
  );
  assert.ok(widest <= CELL_MAX_CHARS, `a cell printed ${widest} characters`);
  ok('no cell, plain or ratio, prints wider than the size bound counts');

  assert.equal(formatCell(Math.fround(0.1)), '0.1');
  assert.equal(formatCell(Math.fround(1 / 3)), '0.33333334');
  assert.equal(formatCell(Math.fround(0.25)), '0.25');
  ok('float noise never reaches a cell: float32 0.1 prints 0.1, not 0.10000000149011612');

  assert.equal(formatCell(42), '42');
  assert.equal(formatCell(-7), '-7');
  assert.equal(formatCell(0), '0');
  assert.equal(formatCell(16777216), '16777216');
  ok('an integer prints bare');

  assert.equal(formatCell(NaN), '');
  assert.equal(formatCell(Infinity), '');
  ok('NaN and infinities are blank fields');
}

{
  assert.equal(percentTextAsRatio('42.5'), '0.425');
  assert.equal(percentTextAsRatio('42'), '0.42');
  assert.equal(percentTextAsRatio('100'), '1');
  assert.equal(percentTextAsRatio('12345.6'), '123.456');
  assert.equal(percentTextAsRatio('5'), '0.05');
  assert.equal(percentTextAsRatio('0.5'), '0.005');
  assert.equal(percentTextAsRatio('-0.5'), '-0.005');
  assert.equal(percentTextAsRatio('-250'), '-2.5');
  assert.equal(percentTextAsRatio('0'), '0');
  assert.equal(percentTextAsRatio(''), '');
  ok('a percent becomes its ratio by moving the decimal point two places');

  assert.equal(percentTextAsRatio('1.5e-7'), '1.5e-9');
  assert.equal(percentTextAsRatio('-3.25e+21'), '-3.25e+19');
  assert.equal(percentTextAsRatio('1e+1'), '1e-1');
  ok('exponent notation shifts its exponent, not its digits');

  // The division would print noise the string shift never has.
  const percent = Math.fround(42.1);
  assert.equal(formatRatioCell(percent), '0.421');
  assert.notEqual(String(percent / 100), '0.421');
  ok('a drawn % value leaves as its ratio text with no division noise');
}

{
  assert.deepEqual([...HOUR_COLUMNS], ['Month', 'Day', 'HE', 'HourOfYear']);
  assert.equal(hourFields(0), 'Jan,1,1,0');
  assert.equal(hourFields(23), 'Jan,1,24,23');
  assert.equal(hourFields(24 * 31), 'Feb,1,1,744');
  assert.equal(hourFields(1416), 'Feb,29,1,1416');
  assert.equal(hourFields(1440), 'Mar,1,1,1440');
  assert.equal(hourFields(8783), 'Dec,31,24,8783');
  ok('the hour columns are Month, Day, HE (1-24) and HourOfYear (0-8783 on the leap slot)');

  assert.equal(csvField('Case 1 · A, B'), '"Case 1 · A, B"');
  assert.equal(csvField('x; y'), '"x; y"');
  assert.equal(csvField('Say "hi"'), '"Say ""hi"""');
  assert.equal(csvField('plain'), 'plain');
  ok('a field carrying a comma, semicolon or quote is quoted; a plain one stays bare');
}

// ------------------------------------------------ the drawer's hourly files

/** A synthetic resolved series, as `resolveDraw` returns one. */
function series(subject, values, extra = {}) {
  const facets = {
    caseLabel: 'Case 1',
    kind: 'generator',
    variable: 'Generation (MW)',
    unit: 'MW',
    subject,
    ...(extra.facets ?? {}),
  };
  return {
    name: subject,
    unit: 'MW',
    values,
    warnings: extra.warnings ?? [],
    ...(extra.refusal ? { refusal: extra.refusal, values: null } : {}),
    facets,
    // The ref the fake host hands out for it.
    ref: extra.ref ?? {},
  };
}

/** The fake host's Case years: `c1` is a leap year unless a test says. */
const YEARS = { c1: 2024, c2: 2025, c4: 2025, c5: 2036 };
/** Cases spanning several years. */
const SPANS = { c3: { firstYear: 2035, numYears: 3 } };

const refOf = (subject, extra = {}) => ({
  id: subject,
  kind: 'generator',
  caseId: 'c1',
  slotKey: 'generator',
  entity: subject,
  variable: 'Generation (MW)',
  unit: 'MW',
  axisIndex: 0,
  ...extra,
});

/** A plane: `level` every hour, NaN where `masked` says. */
function plane(level, masked = () => false) {
  const values = new Float32Array(H);
  for (let hour = 0; hour < H; hour++) values[hour] = masked(hour) ? NaN : level + hour / 8;
  return values;
}

/** Run the export over resolved series, and return the file and the host's
 * account. */
async function run(
  layout,
  resolved,
  { notes = [], confirm = true, descriptor = ['# Cases: Case 1', '# Hours: Jan'] } = {},
) {
  const refs = resolved.map((entry, i) =>
    refOf(entry.facets.subject, { id: `${entry.facets.subject}#${i}`, ...entry.ref }),
  );
  const byId = new Map(refs.map((ref, i) => [ref.id, resolved[i]]));
  const log = [];
  let asked;
  const parts = await exportHourly(
    {
      resolve: (ref) => {
        log.push('resolve');
        return byId.get(ref.id) ?? null;
      },
      spanOfCase: (caseId) => SPANS[caseId] ?? { firstYear: YEARS[caseId], numYears: 1 },
      progress: (message) => log.push(`busy:${message}`),
      nextFrame: async () => log.push('frame'),
      confirm: async (bytes) => {
        asked = bytes;
        return confirm;
      },
    },
    { layout, refs, descriptor, notes },
  );
  return { text: parts?.join(''), parts, log, asked };
}

const header = (text) => text.split('\n').filter((line) => line.startsWith('#'));
const body = (text) => {
  const lines = text.split('\n');
  return lines.slice(lines.indexOf('') + 1, -1);
};

{
  const masked = (hour) => hour >= 24 && hour < 48;
  const resolved = [
    series('ALDER', plane(10, masked)),
    series('BIRCH', plane(20, masked)),
    series('CEDAR', null, { refusal: 'No hours for this unit.' }),
  ];
  const { text, asked } = await run('wide', resolved);
  const rows = body(text);
  assert.equal(rows[0], 'Month,Day,HE,HourOfYear,ALDER [MW],BIRCH [MW],CEDAR [MW]');
  assert.equal(rows.length - 1, H);
  assert.equal(rows[1], 'Jan,1,1,0,10,20,');
  assert.equal(rows[25], 'Jan,2,1,24,,,');
  assert.equal(rows[H], 'Dec,31,24,8783,1107.875,1117.875,');
  ok('wide: 8,784 hour rows, masked hours and a refused series blank');

  assert.ok(asked >= new TextEncoder().encode(text).length, `${asked} bytes bound`);
  ok('the wide size bound is at least the bytes written');
}

{
  const pct = plane(42.1);
  const resolved = [
    series('ALDER', pct, {
      ref: { perUnit: true },
      facets: { range: '% of limit' },
      warnings: ['ALDER has no max cap.', 'Plain mean used.'],
    }),
    series('BIRCH', plane(5), { warnings: ['Plain mean used.'] }),
  ];
  const { text } = await run('wide', resolved, { notes: ['2 units have no hours.'] });
  const lines = header(text);
  assert.ok(lines.includes('# Warnings: Plain mean used. (2 series)'), lines.join('\n'));
  assert.ok(lines.includes('# Warnings: ALDER has no max cap. (1 series)'));
  assert.ok(lines.includes('# Notes: 2 units have no hours.'));
  assert.equal(lines.filter((line) => line.includes('Plain mean used.')).length, 1);
  ok(
    'warnings are stated once each with the count of series that raised them, and the tab notes after',
  );

  const rows = body(text);
  assert.ok(rows[0].includes('[ratio of range]'), rows[0]);
  assert.equal(rows[1].split(',')[4], '0.421');
  const key = lines.find((line) => line.startsWith('# Series: ALDER'));
  assert.match(key, /Unit: ratio of range/);
  assert.match(key, /Divisor: limit/);
  ok('a % of range series leaves as ratios, and its unit and divisor say so');
}

{
  // Two series the legend would name alike: the name takes its position.
  const twin = { facets: { caseLabel: 'Case 1' } };
  const resolved = [series('ALDER', plane(1), twin), series('ALDER', plane(2), twin)];
  const names = hourlyNames(
    resolved.map((entry) => ({ facets: entry.facets, refusal: '', warnings: [], ratio: false })),
  );
  // The legend falls back to the full label for a shared shorthand; the
  // export then separates the two by position.
  assert.deepEqual(names, [
    'Case 1 · Generator · Generation (MW) · ALDER [MW] (1)',
    'Case 1 · Generator · Generation (MW) · ALDER [MW] (2)',
  ]);
  const { text } = await run('wide', resolved);
  const keys = header(text).filter((line) => line.startsWith('# Series: '));
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(keys.length, 2);
  ok('a name collision is suffixed with its position, and the key lines stay unique');

  const varied = [
    series('ALDER', plane(1)),
    series('ALDER', plane(2), { facets: { caseLabel: 'Case 2' } }),
  ];
  const variedText = (await run('wide', varied)).text;
  assert.ok(
    body(variedText)[0].endsWith('Case 1 · ALDER [MW],Case 2 · ALDER [MW]'),
    body(variedText)[0],
  );
  assert.ok(header(variedText).some((line) => line.startsWith('# Every series: Kind: Generator')));
  assert.ok(
    !header(variedText).some(
      (line) => line.startsWith('# Every series:') && line.includes('Case 1'),
    ),
  );
  ok('names carry only the facets that vary; the shared ones are stated once');
}

{
  const refused = Array.from({ length: 8 }, (_, i) =>
    series(`U${i}`, null, { refusal: 'No max cap in the GeneratorList.' }),
  );
  refused.push(series('OTHER', null, { refusal: 'Not in this Case.' }));
  const lines = header((await run('wide', refused)).text);
  const grouped = lines.filter((line) => line.startsWith('# Refused: '));
  assert.equal(grouped.length, 2);
  assert.equal(
    grouped[0],
    '# Refused: No max cap in the GeneratorList. (8 series, blank: U0 [MW]; U1 [MW]; U2 [MW]; U3 [MW]; U4 [MW] and 3 more)',
  );
  assert.match(grouped[1], /Not in this Case\. \(1 series, blank: OTHER \[MW\]\)/);
  ok('refusals are grouped by reason with a count and at most five names');
}

{
  assert.equal(wideWithheld(WIDE_MAX_COLUMNS), '');
  assert.match(
    wideWithheld(WIDE_MAX_COLUMNS + 1),
    /^Withheld: 16,381 columns is more than Excel holds \(16,380 beside the hour columns\)/,
  );
  const refs = Array.from({ length: WIDE_MAX_COLUMNS + 1 }, () => series('X', plane(1)));
  await assert.rejects(run('wide', refs), /at most 16,380/);
  ok('wide is withheld above 16,380 columns, with the reason');

  const declined = await run('wide', [series('ALDER', plane(1))], { confirm: false });
  assert.equal(declined.parts, null);
  ok('a declined size guard writes nothing');

  // Busy is set and a frame yielded before the first resolve.
  const { log } = await run('wide', [series('ALDER', plane(1))]);
  assert.ok(log[0].startsWith('busy:'));
  assert.equal(log[1], 'frame');
  assert.ok(log.indexOf('resolve') > 1);
  ok('the export sets busy and yields a frame before it resolves anything');
}

{
  const masked = (hour) => hour % 24 === 0;
  const resolved = [
    series('ALDER', plane(10, masked)),
    series('BIRCH', plane(42.5), { ref: { perUnit: true }, facets: { range: '% of peak' } }),
    series('CEDAR', null, { refusal: 'No hours for this unit.' }),
  ];
  const long = await run('long', resolved);
  const wide = await run('wide', resolved);
  const rows = body(long.text);
  assert.equal(rows[0], 'Series,Month,Day,HE,HourOfYear,Value');
  // Names here carry no comma, so the five fields after the name split plainly.
  const data = rows.slice(1).map((line) => {
    const fields = line.split(',');
    return { series: fields.slice(0, -5).join(','), value: fields.at(-1) };
  });
  assert.equal(data.length, 3 * H);
  const perSeries = new Map();
  for (const row of data) perSeries.set(row.series, (perSeries.get(row.series) ?? 0) + 1);
  assert.deepEqual([...perSeries.values()], [H, H, H]);
  assert.equal(data[0].value, '');
  assert.equal(data[1].value, '10.125');
  assert.ok(
    data.slice(2 * H).every((row) => row.value === ''),
    'a refused series is blank',
  );
  assert.equal(data[H + 1].value, '0.42625');
  ok('long: 8,784 rows per series, masked hours and a refused series blank, % as ratios');

  const keys = header(long.text)
    .filter((line) => line.startsWith('# Series: '))
    .map((line) => line.slice('# Series: '.length, line.indexOf(' | Kind: ')));
  const wideHeader = body(wide.text)[0].split(',').slice(4);
  assert.deepEqual([...perSeries.keys()], keys);
  assert.deepEqual(keys, wideHeader);
  ok('every Series value is a key line and a wide column header, one to one');

  // Same values in both layouts, hour for hour.
  const wideRowsOf = body(wide.text)
    .slice(1)
    .map((line) => line.split(','));
  data.forEach((row, i) => {
    const column = Math.floor(i / H);
    assert.equal(row.value, wideRowsOf[i % H][4 + column]);
  });
  ok('long and wide carry the same cell for every series and hour');

  assert.ok(long.asked >= 3 * new TextEncoder().encode(long.text).length);
  assert.equal(hourlyPeakBytes('long', 1000, 50), 3000, 'long counts no series copies');
  assert.equal(hourlyPeakBytes('wide', 1000, 50), 3000 + 50 * H * 4);
  const headerText = long.parts[0];
  assert.equal(
    long.asked,
    3 *
      hourlyFileBound(
        'long',
        new TextEncoder().encode(headerText).length,
        keys,
        keys.map(() => ({ span: { firstYear: 2024, numYears: 1 } })),
      ),
    'the confirm is asked on long’s own bound',
  );
  ok('the long size bound is at least three times the bytes written, and holds no copies');

  assert.equal(longNote(LONG_EXCEL_SERIES), '');
  // The rows long writes: 8,784 per series, the slot, with a header row.
  assert.ok(LONG_EXCEL_SERIES * 8784 + 1 <= 1_048_576, '119 series fit Excel');
  assert.ok((LONG_EXCEL_SERIES + 1) * 8784 + 1 > 1_048_576, '120 do not');
  assert.match(longNote(LONG_EXCEL_SERIES + 1), /^For pandas or R: at least 1,051,200 rows/);
  ok('long says it is for pandas or R above 119 series');

  // The export's buffer is reused between resolves, so a copy is the only
  // way a series outlives the next one. Long takes none; wide takes one each.
  let copies = 0;
  class Scratch extends Float32Array {
    slice(...args) {
      copies++;
      return super.slice(...args);
    }
  }
  const scratch = (entry) => ({ ...entry, values: Scratch.from(entry.values) });
  await run('long', [scratch(series('ALDER', plane(1))), scratch(series('BIRCH', plane(2)))]);
  assert.equal(copies, 0, 'long');
  await run('wide', [scratch(series('ALDER', plane(1))), scratch(series('BIRCH', plane(2)))]);
  assert.equal(copies, 2, 'wide');
  ok('long writes each series as it resolves and copies none');
}

{
  // A leap Case (c1, 2024) and a non-leap one (c2, 2025), whose Feb 29 the
  // draw leaves NaN: the download layout every reader of these files relies on.
  const feb29 = (hour) => hour >= 1416 && hour < 1440;
  const resolved = [
    series('ALDER', plane(10)),
    series('BIRCH', plane(20, feb29), { ref: { caseId: 'c2' }, facets: { caseLabel: 'Case 2' } }),
  ];
  const wide = await run('wide', resolved);
  const rows = body(wide.text);
  assert.equal(rows.length - 1, H);
  assert.equal(rows[1 + 1415], 'Feb,28,24,1415,186.875,196.875');
  assert.equal(rows[1 + 1416], 'Feb,29,1,1416,187,');
  assert.equal(rows[1 + 1439], 'Feb,29,24,1439,189.875,');
  assert.equal(rows[1 + 1440], 'Mar,1,1,1440,190,200');
  ok('wide: 8,784 rows on the slot, Feb 29 a value in a leap year and blank in a non-leap one');

  const long = await run('long', resolved);
  const data = body(long.text).slice(1);
  const leapRows = data.filter((line) => line.startsWith('Case 1'));
  const plainRows = data.filter((line) => line.startsWith('Case 2'));
  assert.equal(leapRows.length, 8784);
  assert.equal(plainRows.length, 8760);
  assert.equal(data.length, 8784 + 8760);
  assert.ok(leapRows.includes('Case 1 · ALDER [MW],2024,Feb,29,1,1416,187'));
  assert.ok(!plainRows.some((line) => line.includes(',Feb,29,')));
  assert.equal(plainRows[1416], 'Case 2 · BIRCH [MW],2025,Mar,1,1,1440,200');
  ok(
    'long: a non-leap series writes no Feb 29 rows, a leap one does, and Mar 1 HE 1 is 1440 in both',
  );

  const bytes = new TextEncoder().encode(long.text).length;
  assert.ok(long.asked >= 3 * bytes);
  assert.ok(
    hourlyFileBound('long', 0, ['x'], [{ span: { firstYear: 2025, numYears: 1 } }]) <
      hourlyFileBound('long', 0, ['x'], [{ span: { firstYear: 2024, numYears: 1 } }]),
  );
  ok("long's size bound counts a non-leap series' rows, not the slot's");
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const bytesOf = (text) => new TextEncoder().encode(text).length;

{
  // The one-year layout, pinned byte for byte: these are the files a
  // one-year Case's reader already parses, so years must not reach them.
  const feb29 = (hour) => hour >= 1416 && hour < 1440;
  const options = { descriptor: ['# Cases: Case 1'], notes: ['n1'] };
  const same = () => [
    series('ALDER', plane(10)),
    series('BIRCH', plane(42.5), {
      ref: { perUnit: true },
      facets: { range: '% of peak' },
      warnings: ['w'],
    }),
    series('CEDAR', null, { refusal: 'No hours.' }),
  ];
  const nonleap = () => [
    series('ALDER', plane(10, feb29), { ref: { caseId: 'c2' } }),
    series('BIRCH', plane(3, feb29), { ref: { caseId: 'c4' }, facets: { caseLabel: 'Case 4' } }),
  ];
  const golden = {
    'same wide': [same, 'wide', '7a694268aed7ecd3c8f7289fcc9eb9dabc95af1db4fc80121c8117334549935f'],
    'same long': [same, 'long', '9a0012e25bfa2d10fa2cec9d020f9d20cbe8869d8be3ef26dcd3798d4f276cdc'],
    'non-leap wide': [
      nonleap,
      'wide',
      '96906f62e1f7bf34acd4377f02aeb4af9ff68bf1a468d5d26bfb45b86c2f3bb4',
    ],
    'non-leap long': [
      nonleap,
      'long',
      'fa3ca2e9270bb9c099cf0e2efd36bc1aec3b2780056cff73289f20cc45bfc979',
    ],
  };
  for (const [label, [make, layout, hash]] of Object.entries(golden)) {
    const { text } = await run(layout, make(), options);
    assert.equal(sha256(text), hash, label);
    assert.ok(!/Years: |,Year,/.test(text), `${label} names no year`);
  }
  ok('a file of one year is the one-year layout byte for byte, naming no year');
}

/** A three-year series of Case 3 (2035–2037): `level + year` every hour of
 * year slot `year`, Feb 29 NaN in 2035 and 2037 as a load leaves it. */
function threeYears(level) {
  const values = new Float32Array(3 * H);
  for (let i = 0; i < values.length; i++) {
    const year = Math.floor(i / H);
    const slot = i % H;
    values[i] = year !== 1 && slot >= 1416 && slot < 1440 ? NaN : level + year;
  }
  return values;
}

{
  const resolved = [
    series('ALDER', threeYears(10), { ref: { caseId: 'c3' }, facets: { caseLabel: 'Case 3' } }),
    series('BIRCH', threeYears(20), { ref: { caseId: 'c3' }, facets: { caseLabel: 'Case 3' } }),
  ];
  const wide = await run('wide', resolved);
  const rows = body(wide.text);
  assert.equal(
    rows[0],
    'Month,Day,HE,HourOfYear,ALDER [MW] 2035,ALDER [MW] 2036,ALDER [MW] 2037,' +
      'BIRCH [MW] 2035,BIRCH [MW] 2036,BIRCH [MW] 2037',
  );
  assert.equal(rows.length - 1, H);
  assert.equal(rows[1], 'Jan,1,1,0,10,11,12,20,21,22');
  assert.equal(rows[1 + 1416], 'Feb,29,1,1416,,11,,,21,');
  assert.equal(rows[1 + 1439], 'Feb,29,24,1439,,11,,,21,');
  assert.equal(rows[1 + 1440], 'Mar,1,1,1440,10,11,12,20,21,22');
  assert.equal(rows[H], 'Dec,31,24,8783,10,11,12,20,21,22');
  assert.ok(
    header(wide.text).includes(
      '# Every series: Kind: Generator | Case: Case 3 | Group-by: none | Filters: none | Variable: Generation (MW) | Unit: MW | Divisor: none | Years: 2035–2037',
    ),
    header(wide.text).join('\n'),
  );
  assert.ok(!header(wide.text).some((line) => line.startsWith('# Refused')));
  ok(
    'wide: a three-year series is a column per year on the 8,784-hour slot, Feb 29 filled only in 2036',
  );

  assert.ok(wide.asked >= 3 * bytesOf(wide.text), `${wide.asked} bound`);
  assert.equal(
    wide.asked -
      3 *
        hourlyFileBound(
          'wide',
          bytesOf(wide.parts[0]),
          ['ALDER', 'BIRCH'],
          [{ span: SPANS.c3 }, { span: SPANS.c3 }],
        ),
    6 * H * 4,
    'wide copies six columns, not two',
  );
  ok('the wide size bound counts every series-year column and holds');

  const long = await run('long', resolved);
  const longRows = body(long.text);
  assert.equal(longRows[0], 'Series,Year,Month,Day,HE,HourOfYear,Value');
  const data = longRows.slice(1);
  assert.equal(data.length, 2 * 26_304);
  const alder = data.filter((row) => row.startsWith('ALDER'));
  assert.equal(alder.length, 26_304, '8,760 + 8,784 + 8,760');
  for (const year of [2035, 2036, 2037]) {
    const ofYear = alder.filter((row) => row.startsWith(`ALDER [MW],${year},`));
    assert.equal(ofYear.length, year === 2036 ? 8784 : 8760, String(year));
    assert.equal(
      ofYear.some((row) => row.includes(',Feb,29,')),
      year === 2036,
      String(year),
    );
  }
  assert.equal(alder[0], 'ALDER [MW],2035,Jan,1,1,0,10');
  assert.equal(alder[8760], 'ALDER [MW],2036,Jan,1,1,0,11');
  assert.ok(alder.includes('ALDER [MW],2036,Feb,29,1,1416,11'));
  assert.ok(alder.includes('ALDER [MW],2037,Mar,1,1,1440,12'));
  ok('long: a Year column, 26,304 rows per three-year series, no Feb 29 rows in 2035 or 2037');

  assert.ok(long.asked >= 3 * bytesOf(long.text), `${long.asked} bound`);
  ok('the long size bound counts each year’s real rows and holds');
}

{
  // One-year Cases of different years: the file holds two years, so it says
  // which each column and row is.
  const resolved = [
    series('ALDER', plane(10)),
    series('BIRCH', plane(20), { ref: { caseId: 'c5' }, facets: { caseLabel: 'Case 5' } }),
  ];
  const wide = await run('wide', resolved);
  const rows = body(wide.text);
  assert.equal(
    rows[0],
    'Month,Day,HE,HourOfYear,Case 1 · ALDER [MW] 2024,Case 5 · BIRCH [MW] 2036',
  );
  assert.equal(rows.length - 1, H);
  assert.ok(
    header(wide.text).some((line) => /^# Series: Case 1 · ALDER.*\| Years: 2024$/.test(line)),
  );
  assert.ok(wide.asked >= 3 * bytesOf(wide.text));
  const long = await run('long', resolved);
  const data = body(long.text);
  assert.equal(data[0], 'Series,Year,Month,Day,HE,HourOfYear,Value');
  assert.equal(data[1], 'Case 1 · ALDER [MW],2024,Jan,1,1,0,10');
  assert.ok(data.includes('Case 5 · BIRCH [MW],2036,Jan,1,1,0,20'));
  assert.equal(data.length - 1, 2 * H);
  assert.ok(long.asked >= 3 * bytesOf(long.text));
  ok('one-year Cases of different years name their year in every column and row');
}

{
  // Wide's column limit counts a series' years, once they are known.
  const many = Array.from({ length: Math.ceil(WIDE_MAX_COLUMNS / 3) + 1 }, () =>
    series('X', threeYears(1), { ref: { caseId: 'c3' } }),
  );
  await assert.rejects(run('wide', many), /at most 16,380 columns.*take the long layout/);
  ok('wide refuses more series-year columns than Excel holds');
}

console.log(`\n${checks} checks passed.`);
