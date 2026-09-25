// scripts/make-perf-data.mjs
//
// Writes full-size synthetic GridView exports, so parse cost at bus and
// generator width is MEASURED. Separate from scripts/make-sample-data.mjs
// because this one must STREAM (a rung is half a gigabyte). Output goes to
// sample-data/ (gitignored); tests/test_perf_data.mjs checks the manifest.
//
// Usage:
//   node scripts/make-perf-data.mjs                  # the control rung only
//   node scripts/make-perf-data.mjs --rung wide-512  # one named rung
//   node scripts/make-perf-data.mjs --ladder --yes   # the whole ladder, ~2 GB
//   node scripts/make-perf-data.mjs --drop --yes     # the worst-drop fixture, ~3 GB
//   node scripts/make-perf-data.mjs --seed 7 --out /tmp/x
//
// --ladder WIPES the output directory, so write the drop after it. The
// projected size is printed first, and runs above CONFIRM_ABOVE_BYTES need
// --yes.

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Default output directory, under the already-ignored sample-data/ tree. */
export const DEFAULT_OUT = join(REPO, 'sample-data', 'perf');

/** Fixed default seed. A timing comparison across a parser change is only
 * valid if the input bytes are identical, so non-determinism here is a defect
 * and not a nuisance. */
export const DEFAULT_SEED = 20260904;

/** Every generated name carries this, so a generated file is never mistaken
 * for an export and an export is never mistaken for a generated one and
 * deleted. */
const NAME_PREFIX = 'SAMPLE';

/** Non-leap. Every rung is exactly 8,760 hours, so no rung's cost is inflated
 * by Feb 29 rows the parsers drop anyway. */
const YEAR = 2034;
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const HOURS_PER_YEAR = 8760;

/** Formatting buffer. Rows are written into this and flushed; it is never
 * grown per row and no row set is ever accumulated. Must exceed the longest
 * single row -- at 5,900 entities a row runs about 60 KB. */
const CHUNK_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------- the ladder

/**
 * The width ladder: one shape with one parameter changed per rung, so a cost
 * curve can be fitted and extrapolated. `kind` only sets the title word.
 * `proves` says what the rung is for; a rung without one should not exist.
 */
const wide = (entities, kind, proves, extra = {}) => ({
  name: `wide-${entities}`,
  shape: 'wide',
  entities,
  metrics: 1,
  kind,
  quantity: 'Power Flow (MW)',
  hashed: false,
  proves,
  ...extra,
});

export const RUNGS = [
  wide(215, 'Interface', "control: the interface kind's real width, known to parse today", {
    hashed: true,
  }),
  wide(
    512,
    'Interface',
    "the interface slab's old column ceiling (block.c NUM = 512, gone in ABI v3)",
  ),
  wide(513, 'Interface', 'one column past that ceiling -- the rung that proved it was gone'),
  wide(2048, 'Interface', 'midpoint, so the cost curve has a point between the two ceilings'),
  wide(4096, 'Interface', "the area parser's exact name-table ceiling (block.c MAX_NAMES = 4096)"),
  wide(4097, 'Interface', 'one past the area name-table ceiling'),
  wide(4900, 'Generator', 'the real generator width'),
  wide(5900, 'Bus', 'the real bus width -- the widest file the app will ever be handed'),
  // Above bus width, titled Interface: they stand for WIDTH, and a Bus title
  // would need an id row this generator does not write here.
  wide(
    8028,
    'Interface',
    'the widest wide export that loads: one below the head-probe wall, as a full file',
  ),
  wide(
    10000,
    'Interface',
    'a full-size file above the head-probe wall -- the refusal without reading the file',
  ),
  // The row-dominated shape: a few hundred entities, several metrics, one row
  // per entity-hour, so row limits and block boundaries carry the cost.
  {
    name: 'long-200',
    shape: 'long',
    entities: 200,
    metrics: 6,
    kind: 'Area',
    quantity: null,
    hashed: false,
    proves: 'the row-dominated shape, through the area seam: ~1.75M rows, no preamble',
  },
  // Wide AND many metrics, which only shape L allows: `long-200` scaled up,
  // bracketing the long parser's name table from a real file.
  {
    name: 'long-4096',
    shape: 'long',
    entities: 4096,
    metrics: 6,
    kind: 'Area',
    quantity: null,
    hashed: false,
    proves:
      'wide AND many metrics at once, at the area name ' +
      "table's exact capacity: 4,096 entities x 6 metrics, ~35.9M rows",
  },
  {
    name: 'long-4097',
    shape: 'long',
    entities: 4097,
    metrics: 6,
    kind: 'Area',
    quantity: null,
    hashed: false,
    proves: 'one entity past the area name table, reached by a real file rather than an axis probe',
  },
];

/** Bus-width cases in the worst-drop fixture: three 207 MB cubes plus the
 * static pools exceed the 1,024 MiB peak-tab budget; two would not. */
export const DROP_CASES = 3;

/**
 * The worst-drop fixture: separate files (a person must be able to drop them
 * together), same width, names and quantity, different seeds, so memory
 * depends on case COUNT only. Written by `--drop`, not `--ladder`, and
 * measured as composite rungs.
 */
const FIRST_QUANTITY_RUNGS = Array.from({ length: DROP_CASES }, (_, i) => ({
  name: `drop-5900-${i + 1}`,
  shape: 'wide',
  entities: 5900,
  metrics: 1,
  kind: 'Bus',
  quantity: 'Power Flow (MW)',
  hashed: false,
  // Offsets, not the base seed: case 1 must not be byte-identical to
  // `wide-5900`, or a drop of the two would be one file under two names.
  seedOffset: i + 1,
  proves: `case ${i + 1} of ${DROP_CASES} in the bus-width worst drop`,
}));

/** The same cases' second quantity: each quantity is its own cube and slot,
 * so this is the heavier half of a real drop. */
const SECOND_QUANTITY_RUNGS = FIRST_QUANTITY_RUNGS.map((rung, i) => ({
  ...rung,
  name: `${rung.name}-load`,
  quantity: 'Load (MW)',
  seedOffset: DROP_CASES + i + 1,
  proves: `case ${i + 1} of ${DROP_CASES}'s second quantity in the bus-width worst drop`,
}));

export const DROP_RUNGS = [...FIRST_QUANTITY_RUNGS, ...SECOND_QUANTITY_RUNGS];

/** Drops: files loaded as separate Cases in one session, measured as one
 * composite rung (what HOLDING several cases costs). */
export const DROPS = [
  {
    name: `drop-${DROP_CASES}x5900`,
    entities: 5900,
    quantitiesPerCase: 1,
    cases: FIRST_QUANTITY_RUNGS.map((rung) => rung.name),
    proves:
      `${DROP_CASES} bus-width cases held at once, one quantity each, which is the ` +
      `cube floor rather than any parser cost`,
  },
  {
    // `cases` lists FILES, case-major: each Case's quantities are adjacent.
    name: `drop-${DROP_CASES}x5900x2`,
    entities: 5900,
    quantitiesPerCase: 2,
    cases: FIRST_QUANTITY_RUNGS.flatMap((rung, i) => [rung.name, SECOND_QUANTITY_RUNGS[i].name]),
    proves:
      `the realistic worst drop: ${DROP_CASES} bus-width cases of two quantities each, ` +
      `so ${DROP_CASES * 2} cubes held at once`,
  },
];

/** Every rung this script can write, ladder and drop alike. */
export const ALL_RUNGS = [...RUNGS, ...DROP_RUNGS];

export const CONTROL_RUNG = 'wide-215';

/** Mean bytes per formatted value, comma included (measured on the control
 * rung). Used only to project sizes; the manifest records actual bytes. */
const MEAN_VALUE_BYTES = 9.62;

/** `M/D/YYYY,HH,OffPeak,` plus the CRLF. */
const KEY_COLUMN_BYTES = 21;

/** Above this total, the run refuses to start without --yes: a laptop disk
 * is the thing being protected, and the full ladder is ~2 GB. */
const CONFIRM_ABOVE_BYTES = 512 * 1024 * 1024;

/** What a rung will cost on disk, before anything is written. */
export function projectBytes(rung) {
  if (rung.shape === 'long') {
    // One row per (entity, hour), and each row repeats the entity name.
    const row = KEY_COLUMN_BYTES + NAME_WIDTH + 1 + rung.metrics * MEAN_VALUE_BYTES;
    return Math.round(200 + rung.entities * HOURS_PER_YEAR * row);
  }
  const header = rung.entities * (NAME_WIDTH + 1) + 20;
  const row = KEY_COLUMN_BYTES + rung.entities * MEAN_VALUE_BYTES;
  return Math.round(300 + header + HOURS_PER_YEAR * row);
}

// ---------------------------------------------------------------- primitives

/** Mulberry32. Seeded, so two runs at one seed are byte-identical. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Every generated entity name is this long. Realistic length matters: at bus
 * width the header is ~100 KB of the head probe's 256 KB. Constant across
 * kinds so every rung differs in one parameter only.
 */
const NAME_WIDTH = 22;

/** One entity name: obviously synthetic, padded with underscores to
 * NAME_WIDTH so it can never pass for a real name. */
export function entityName(kind, index) {
  const head = `${NAME_PREFIX}_${kind.toUpperCase()}_`;
  const tail = String(index).padStart(5, '0');
  return head + '_'.repeat(Math.max(0, NAME_WIDTH - head.length - tail.length)) + tail;
}

/** The title word of a rung written in the Bus export's own layout. */
export const BUS_KIND = 'Bus';

/** One synthetic bus number: six digits, unique within a rung. */
export function busNumber(index) {
  return 100000 + index;
}

export function metricName(index) {
  return `${NAME_PREFIX}_METRIC_${String(index).padStart(2, '0')}`;
}

/** One value, formatted like real exports: digit width drives size and parse
 * cost, so the mix includes negatives, values near 1e8, and exponent
 * notation. */
function formatValue(next) {
  const roll = next();
  if (roll < 0.7) return (next() * 5000).toFixed(3);
  if (roll < 0.85) return (-next() * 90000).toFixed(3);
  if (roll < 0.95) return (next() * 1e8).toFixed(2);
  return `${(next() * 9).toFixed(6)}E-0${1 + Math.floor(next() * 3)}`;
}

/** Walk the 8,760 hours of a non-leap year as (month, day, hour-ending). */
function* calendar() {
  for (let month = 1; month <= 12; month++) {
    for (let day = 1; day <= MONTH_LENGTHS[month - 1]; day++) {
      for (let hour = 1; hour <= 24; hour++) yield [month, day, hour];
    }
  }
}

// ---------------------------------------------------------------- the writer

/** Thrown by HeadSink to stop a writer mid-file, keeping the writers free of
 * a limit check on the hot path. */
const ENOUGH = Symbol('enough');

/**
 * A sink that keeps the first bytes and stops the writer, so a rung's head can
 * be produced at any width without writing the rung. It shares the real
 * writers ON PURPOSE: preamble length is part of what the head probe
 * measures.
 */
class HeadSink {
  constructor(limit) {
    this.limit = limit;
    this.chunks = [];
    this.bytes = 0;
  }

  async push(text) {
    const buf = Buffer.from(text, 'latin1');
    this.chunks.push(buf);
    this.bytes += buf.length;
    if (this.bytes >= this.limit) throw ENOUGH;
  }

  async flush() {}

  async end() {
    return this.bytes;
  }
}

/** The first `limit` bytes of a rung, without writing it. Build `rung` as the
 * ladder does: its name is written into the preamble and moves the wall. */
export async function writeHead(rung, { seed = DEFAULT_SEED, limit } = {}) {
  const sink = new HeadSink(limit);
  const write = rung.shape === 'long' ? writeLong : writeWide;
  try {
    await write(sink, rung, seed + (rung.seedOffset ?? 0));
  } catch (error) {
    if (error !== ENOUGH) throw error;
  }
  return Buffer.concat(sink.chunks).subarray(0, limit);
}

/** A wide rung at any width, shaped exactly like a ladder rung. */
export function wideRung(entities, kind = 'Interface') {
  return wide(entities, kind, `ad-hoc width, not a ladder rung`);
}

/** A streaming sink over one reused buffer. Each flush awaits the write
 * callback, since `write(buf)` queues by reference and the buffer must not be
 * overwritten before it is consumed. */
class ChunkSink {
  constructor(stream, hash) {
    this.stream = stream;
    this.hash = hash;
    this.buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    this.length = 0;
    this.bytes = 0;
  }

  async push(text) {
    const need = Buffer.byteLength(text, 'latin1');
    if (need > this.buffer.length) {
      throw new Error(
        `A single row of ${need} B exceeds the ${this.buffer.length} B format buffer. ` +
          `Raise CHUNK_BYTES.`,
      );
    }
    if (this.length + need > this.buffer.length) await this.flush();
    this.length += this.buffer.write(text, this.length, 'latin1');
  }

  async flush() {
    if (this.length === 0) return;
    const view = this.buffer.subarray(0, this.length);
    if (this.hash) this.hash.update(view);
    this.bytes += this.length;
    await new Promise((resolve, reject) => {
      this.stream.write(view, (error) => (error ? reject(error) : resolve()));
    });
    this.length = 0;
  }

  async end() {
    await this.flush();
    await new Promise((resolve, reject) => {
      this.stream.end((error) => (error ? reject(error) : resolve()));
    });
    return this.bytes;
  }
}

/**
 * Shape W: one metric, entity per column, 8,760 rows, header on line 5. Key
 * columns carry the real exports' stray leading spaces, CRLF throughout. The
 * generated-file marker sits on preamble line 2, which nothing reads.
 */
async function writeWide(sink, rung, seed) {
  const names = Array.from({ length: rung.entities }, (_, i) => entityName(rung.kind, i + 1));
  const headerLine = `Date, Hour, TOU,${names.join(',')}\r\n`;
  await sink.push(`${rung.kind} Hourly '${rung.quantity}' Data for Year ${YEAR}\r\n`);
  await sink.push(
    `SYNTHETIC DATA -- generated by scripts/make-perf-data.mjs, rung ${rung.name}, ` +
      `seed ${seed}. Not a real export.\r\n`,
  );
  await sink.push(
    `(From the first hour of 1/1/${YEAR} to the last hour of 12/31/${YEAR}. ` +
      `Column identifier -- ${rung.kind} Name)\r\n`,
  );
  await sink.push('\r\n');
  // A wide Bus export carries the bus-number row above the header, or the
  // Bus adapter refuses it.
  if (rung.kind === BUS_KIND) {
    const ids = Array.from({ length: rung.entities }, (_, i) => busNumber(i + 1));
    await sink.push(`,,BusNumber,${ids.join(',')}\r\n`);
  }
  await sink.push(headerLine);

  const next = rng(seed);
  let rows = 0;
  for (const [month, day, hour] of calendar()) {
    const fields = new Array(rung.entities);
    for (let e = 0; e < rung.entities; e++) fields[e] = formatValue(next);
    await sink.push(
      `${month}/${day}/${YEAR},${hour},${hour % 2 === 0 ? 'OnPeak' : 'OffPeak'},` +
        `${fields.join(',')}\r\n`,
    );
    rows++;
  }
  return { rows, headerBytes: headerLine.length };
}

/**
 * Shape L: many metrics, entity per ROW, header on line 1, no preamble (kind
 * is inferred from key columns). The SAMPLE_ prefix in every Name marks the
 * file as generated. Key columns carry real exports' stray spaces.
 */
async function writeLong(sink, rung, seed) {
  const names = Array.from({ length: rung.entities }, (_, i) => entityName(rung.kind, i + 1));
  const metrics = Array.from({ length: rung.metrics }, (_, i) => metricName(i + 1));
  const headerLine = `Date, Hour, TOU, Name,${metrics.join(',')}\r\n`;
  await sink.push(headerLine);

  const next = rng(seed);
  let rows = 0;
  for (const [month, day, hour] of calendar()) {
    // Entity-inner, hour-outer: one hour's rows are adjacent, which is the
    // order a real export arrives in. Row order carries no meaning to the
    // parser, but a benchmark should measure the ordinary case.
    const prefix = `${month}/${day}/${YEAR},${hour},${hour % 2 === 0 ? 'OnPeak' : 'OffPeak'},`;
    for (let e = 0; e < rung.entities; e++) {
      const fields = new Array(rung.metrics);
      for (let m = 0; m < rung.metrics; m++) fields[m] = formatValue(next);
      await sink.push(`${prefix}${names[e]},${fields.join(',')}\r\n`);
      rows++;
    }
  }
  return { rows, headerBytes: headerLine.length };
}

// ---------------------------------------------------------------- generation

/** Manifest entries already on disk, for a subset run. Entries at another
 * seed describe other bytes and are not carried forward. */
async function readExistingFiles(out, seed) {
  try {
    const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
    return manifest.seed === seed ? manifest.files : [];
  } catch {
    return [];
  }
}

/** The drop a rung belongs to, or null. */
function dropOf(rungName) {
  return DROPS.find((drop) => drop.cases.includes(rungName))?.name ?? null;
}

/** Write one rung and return its manifest entry. */
export async function generateRung(rung, { out, seed }) {
  const path = join(out, `${rung.name}.csv`);
  const hash = rung.hashed ? createHash('sha256') : null;
  const sink = new ChunkSink(createWriteStream(path), hash);

  // A rung's seed is DERIVED from the run's, so drop cases differ yet still
  // move with --seed.
  const rungSeed = seed + (rung.seedOffset ?? 0);
  const write = rung.shape === 'long' ? writeLong : writeWide;
  const { rows, headerBytes } = await write(sink, rung, rungSeed);
  const bytes = await sink.end();

  return {
    name: rung.name,
    file: `${rung.name}.csv`,
    shape: rung.shape,
    kind: rung.kind.toLowerCase(),
    entities: rung.entities,
    metrics: rung.metrics,
    rows,
    bytes,
    headerBytes,
    proves: rung.proves,
    seed: rungSeed,
    // Which drop this file is a case of, or absent. The bench uses it to keep
    // a drop's members out of the per-file results: they are measured together
    // or not at all.
    ...(dropOf(rung.name) ? { partOfDrop: dropOf(rung.name) } : {}),
    // Only the smallest rung is hashed, so the test suite stays fast and no
    // half-gigabyte file has to be read to prove determinism.
    sha256: hash ? hash.digest('hex') : null,
  };
}

/** Generate `rungs` into `out` and write the manifest (exported for tests). */
export async function generate({
  out = DEFAULT_OUT,
  seed = DEFAULT_SEED,
  rungs = RUNGS,
  wipe = true,
  onRung,
} = {}) {
  // A full run wipes; a SUBSET merges into the existing manifest so one rung
  // can be regenerated without rewriting the rest.
  const existing = wipe ? [] : await readExistingFiles(out, seed);
  if (wipe) await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  const files = existing.filter((file) => !rungs.some((rung) => rung.name === file.name));
  for (const rung of rungs) {
    const entry = await generateRung(rung, { out, seed });
    files.push(entry);
    onRung?.(entry, rung);
  }
  files.sort(
    (a, b) =>
      ALL_RUNGS.findIndex((r) => r.name === a.name) - ALL_RUNGS.findIndex((r) => r.name === b.name),
  );

  // A drop is announced only when every one of its cases is on disk. A
  // half-written drop measured as a two-case drop would be a quietly wrong
  // answer to the one question it exists to ask.
  const written = new Set(files.map((file) => file.name));
  const drops = DROPS.filter((drop) => drop.cases.every((name) => written.has(name)));

  const manifest = {
    generator: 'scripts/make-perf-data.mjs',
    synthetic: true,
    seed,
    year: YEAR,
    hoursPerYear: HOURS_PER_YEAR,
    namePrefix: NAME_PREFIX,
    files,
    drops,
  };
  await writeFile(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

// ---------------------------------------------------------------- entry point

function parseArgs(argv) {
  const args = {
    out: DEFAULT_OUT,
    seed: DEFAULT_SEED,
    rungs: null,
    ladder: false,
    drop: false,
    yes: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--out') args.out = argv[++i];
    else if (flag === '--seed') args.seed = Number(argv[++i]);
    else if (flag === '--rung') args.rungs = (args.rungs ?? []).concat(argv[++i].split(','));
    else if (flag === '--ladder') args.ladder = true;
    else if (flag === '--drop') args.drop = true;
    else if (flag === '--yes') args.yes = true;
    else throw new Error(`Unknown argument ${flag}`);
  }
  if (!Number.isInteger(args.seed)) throw new Error('--seed must be an integer');
  const chosen = [args.ladder && '--ladder', args.drop && '--drop', args.rungs && '--rung'].filter(
    Boolean,
  );
  if (chosen.length > 1) throw new Error(`${chosen.join(' and ')} are mutually exclusive`);
  return args;
}

/** Which rungs this invocation writes. Default is the control rung alone:
 * every other choice writes hundreds of megabytes, and a default that does
 * that is a default nobody can run by accident. */
function selectRungs(args) {
  if (args.ladder) return RUNGS;
  if (args.drop) return DROP_RUNGS;
  const names = args.rungs ?? [CONTROL_RUNG];
  return names.map((name) => {
    const rung = ALL_RUNGS.find((candidate) => candidate.name === name);
    if (!rung) {
      throw new Error(`No rung "${name}". Known: ${ALL_RUNGS.map((r) => r.name).join(', ')}`);
    }
    return rung;
  });
}

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = parseArgs(process.argv.slice(2));
  const rungs = selectRungs(args);

  // Projected BEFORE anything is written. Nobody should ever be surprised by a
  // multi-gigabyte write, and a projection printed afterwards is not a guard.
  const projected = rungs.reduce((total, rung) => total + projectBytes(rung), 0);
  console.log(`${rungs.length} rung(s) -> ${args.out}, seed ${args.seed}`);
  for (const rung of rungs) {
    console.log(
      `  ${rung.name.padEnd(11)} ${String(rung.entities).padStart(5)} entities  ` +
        `~${mb(projectBytes(rung)).padStart(8)}   ${rung.proves}`,
    );
  }
  console.log(`  projected total: ${mb(projected)}`);

  if (projected > CONFIRM_ABOVE_BYTES && !args.yes) {
    console.error(
      `\nRefusing to write ${mb(projected)} without --yes ` +
        `(threshold ${mb(CONFIRM_ABOVE_BYTES)}). Re-run with --yes to proceed.`,
    );
    process.exit(1);
  }

  const started = Date.now();
  const manifest = await generate({
    out: args.out,
    seed: args.seed,
    rungs,
    // Only a full-ladder run wipes; a subset merges, so re-measuring one width
    // does not cost the other seven.
    wipe: args.ladder,
    onRung: (entry) =>
      console.log(
        `  wrote ${entry.name.padEnd(11)} ${String(entry.rows).padStart(8)} rows  ` +
          `${mb(entry.bytes).padStart(8)}`,
      ),
  });
  const written = manifest.files
    .filter((file) => rungs.some((rung) => rung.name === file.name))
    .reduce((total, file) => total + file.bytes, 0);
  console.log(
    `wrote ${rungs.length} file(s), ${mb(written)} actual against ${mb(projected)} projected, ` +
      `in ${((Date.now() - started) / 1000).toFixed(1)} s`,
  );
}
