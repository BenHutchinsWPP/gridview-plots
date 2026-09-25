// tests/test_fixtures_interface.mjs — synthetic wide exports in memory
// (invented names and values, GridView's format). Beyond test_fixtures.mjs's
// properties: four preamble lines with the header on line 5, a title with a
// quoted quantity and year, names with spaces, hyphens, plus signs and double
// underscores that must survive exact matching, and optional Feb 29.

/** Interface names in the shapes the real exports use. Invented; the shapes
 * are what matters -- a name with a comma would be a different problem and
 * GridView does not emit one. */
const NAME_SHAPES = [
  (i) => `P${String(i).padStart(2, '0')} Alpha Beta ${i % 2 ? 'N-S' : 'E-W'}`,
  (i) => `W${String(i).padStart(2, '0')}_AA_ONE__BB_TWO_1`,
  (i) => `Pth ${String(i).padStart(2, '0')} Gamma - Delta`,
  (i) => `AA${String(i).padStart(2, '0')}_Epsilon+`,
];

/** `count` distinct interface names. Distinctness matters: columns map by
 * trimmed name, and a duplicate would double-write one cube plane. */
export function interfaceNames(count = 12) {
  return Array.from({ length: count }, (_, i) => NAME_SHAPES[i % NAME_SHAPES.length](i + 1));
}

/** Mulberry32 -- see test_fixtures.mjs. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Non-leap month lengths. Feb 29 is emitted only when asked for, and then
 * only to prove ingest drops it. */
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** `entity` is the FIRST WORD of the title line -- the only thing in a wide
 * export that says which KIND it is, and what routes it to a kind's adapter.
 * Default `Interface`; pass `Area` for a wide Area export. */
function preamble(quantity, year, entity) {
  return [
    `${entity} Hourly '${quantity}' Data for Year ${year}`,
    '',
    `(From the first hour of 1/1/${year} to the last hour of 12/31/${year}. Column identifier -- ${entity}Name)`,
    '',
  ];
}

function headerLine(names) {
  // The real header carries a stray leading space on Hour and TOU, and some
  // interface names arrive padded. Columns map by trimmed name precisely so
  // this is harmless -- keep it, or the test stops proving that.
  return ['Date', ' Hour', ' TOU', ...names.map((n, i) => (i % 5 === 2 ? ` ${n}` : n))].join(',');
}

/** Emit rows, advancing day and hour as test_fixtures.mjs's `rows` does. */
function* rows({ year, days, hours, seed, names, quantity, feb29, entity = 'Interface' }) {
  const next = rng(seed);
  for (const line of preamble(quantity, year, entity)) yield line;
  yield headerLine(names);

  let month = 1;
  let day = 1;
  for (let d = 0; d < days; d++) {
    for (let hour = 1; hour <= hours; hour++) {
      const tou = hour % 2 === 0 ? 'OnPeak' : 'OffPeak';
      const fields = [`${month}/${day}/${year}`, String(hour), tou];
      for (let m = 0; m < names.length; m++) fields.push(value(next, m));
      yield fields.join(',');
    }
    // Feb 29, when asked for: the rows exist in the file and must not exist
    // in the cube.
    if (feb29 && month === 2 && day === 28) {
      for (let hour = 1; hour <= hours; hour++) {
        const fields = [`2/29/${year}`, String(hour), 'OffPeak'];
        for (let m = 0; m < names.length; m++) fields.push(value(next, m));
        yield fields.join(',');
      }
    }
    if (++day > MONTH_LENGTHS[month - 1]) {
      day = 1;
      month++;
    }
  }
}

/** One synthetic export as bytes; a couple of days by default. */
export function exportCsv({
  year = 2036,
  days = 1,
  hours = 2,
  seed = 12345,
  names = interfaceNames(),
  quantity = 'Power Flow (MW)',
  feb29 = false,
  entity = 'Interface',
} = {}) {
  // CRLF throughout, including a terminator on the final row.
  return new TextEncoder().encode(
    [...rows({ year, days, hours, seed, names, quantity, feb29, entity })].join('\r\n') + '\r\n',
  );
}

/** Stream a full-size export to `path`. */
export async function writeExportCsv(path, options = {}) {
  const { createWriteStream } = await import('node:fs');
  const { once } = await import('node:events');
  const settings = {
    year: 2036,
    days: 365,
    hours: 24,
    seed: 12345,
    names: interfaceNames(),
    quantity: 'Power Flow (MW)',
    feb29: false,
    entity: 'Interface',
    ...options,
  };
  const out = createWriteStream(path);
  let chunk = '';
  for (const row of rows(settings)) {
    chunk += row + '\r\n';
    if (chunk.length > 1 << 20) {
      if (!out.write(chunk)) await once(out, 'drain');
      chunk = '';
    }
  }
  if (chunk) out.write(chunk);
  out.end();
  await once(out, 'finish');
  return path;
}

/** One field -- see test_fixtures.mjs for why these shapes and not others. */
function value(next, index) {
  const r = next();
  if (index % 17 === 5) return '0';
  // Exponent notation -- real exports carry `2.568664E-03` for near-zero
  // flows, and it parsed to NaN for a whole build.
  if (index % 23 === 7) return `${(r * 9 + 1).toFixed(6)}E-03`;
  // Flows are signed: a path runs both ways and the sign is the direction.
  if (index % 3 === 2) return (-r * 2000).toFixed(6);
  // Eight significant digits -- same one-ulp rounding case as test_fixtures.mjs.
  if (index % 13 === 4) return (r * 100000).toFixed(8);
  return (r * 500).toFixed(6);
}
