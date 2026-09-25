// tests/test_hourly_csv.mjs — the hourly CSV writer (src/ui/hourly-csv.ts),
// from synthetic values only. The contracts:
//
//   * Every formatted cell reads back to the float32 it came from, integers
//     print bare, and a non-finite value is a blank field.
//   * A percent becomes its ratio by a string shift, exponent form included,
//     never by a division that brings back float noise.
//   * A field carrying a delimiter is quoted, so a label never shifts columns.
//   * The chart pane's download writes through the writer.
//   * A drawer file has 8,760 hour rows per layout unit with masked hours
//     blank, a key line per series whose name is unique, warnings once each
//     with a count, refusals grouped with at most five names, and a size
//     bound no smaller than the bytes it writes. Wide is withheld past
//     Excel's column limit.
//   * Long writes 8,760 rows per series under a `Series` value that is the
//     wide header and a key line, holds no series copies, and says past
//     Excel's rows that it is for pandas or R.

import assert from 'node:assert/strict';
import './test_loader.mjs';

const {
  CELL_MAX_CHARS,
  HOUR_COLUMNS,
  WIDE_MAX_SERIES,
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
const { HOURS_PER_YEAR: H } = await import('../src/model/calendar.ts');

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
  assert.equal(hourFields(8759), 'Dec,31,24,8759');
  ok('the hour columns are Month, Day, HE (1-24) and HourOfYear (0-8759)');

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
async function run(layout, resolved, { notes = [], confirm = true } = {}) {
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
      progress: (message) => log.push(`busy:${message}`),
      nextFrame: async () => log.push('frame'),
      confirm: async (bytes) => {
        asked = bytes;
        return confirm;
      },
    },
    { layout, refs, descriptor: ['# Cases: Case 1', '# Hours: Jan'], notes },
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
  assert.equal(rows[H], 'Dec,31,24,8759,1104.875,1114.875,');
  ok('wide: 8,760 hour rows, masked hours and a refused series blank');

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
  assert.equal(wideWithheld(WIDE_MAX_SERIES), '');
  assert.match(wideWithheld(WIDE_MAX_SERIES + 1), /Withheld: 16,381 series/);
  const refs = Array.from({ length: WIDE_MAX_SERIES + 1 }, () => series('X', plane(1)));
  await assert.rejects(run('wide', refs), /at most 16,380/);
  ok('wide is withheld above 16,380 series, with the reason');

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
  ok('long: 8,760 rows per series, masked hours and a refused series blank, % as ratios');

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
    3 * hourlyFileBound('long', new TextEncoder().encode(headerText).length, keys),
    'the confirm is asked on long’s own bound',
  );
  ok('the long size bound is at least three times the bytes written, and holds no copies');

  assert.equal(longNote(LONG_EXCEL_SERIES), '');
  assert.match(longNote(LONG_EXCEL_SERIES + 1), /^For pandas or R: 1,051,200 rows/);
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

console.log(`\n${checks} checks passed.`);
