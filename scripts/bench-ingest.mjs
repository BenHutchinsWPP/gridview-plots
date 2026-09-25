// scripts/bench-ingest.mjs
//
// Drives the real ingest code over the files scripts/make-perf-data.mjs wrote,
// and reports what it cost. Not a test: a wall-clock gate passes on one
// machine and fails on another, and would block unrelated changes.
//
// Node cannot construct the app's Workers, so this drives the case-plan
// reader and the accumulator loop directly; per-Worker wasm memory in the
// browser is confirmed by hand. Each rung runs in its own child process, so
// an OOM costs one row, and a failure's text is kept verbatim (an axis
// refusal, a column-count refusal and an OOM are different answers).
//
// Usage:
//   node scripts/bench-ingest.mjs                    # the control rung
//   node scripts/bench-ingest.mjs --rung wide-512
//   node scripts/bench-ingest.mjs --ladder           # every rung, one child each
//   node scripts/bench-ingest.mjs --measure wide-512 # child mode: JSON on stdout

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The module-loader shim every existing suite uses: node's ESM resolver
// rejects the extensionless relative imports (`./header`) that are normal
// TypeScript and normal Vite. Must come before any src/ import.
import '../tests/test_loader.mjs';

import { fileBlob } from './file-blob.mjs';
import { CONTROL_RUNG, DEFAULT_OUT, wideRung, writeHead } from './make-perf-data.mjs';
import { cell, mb, renderReport } from './bench-report.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Which binary each shape is measured against: the committed one, or a
 * variant built by `parser/<shape>/build.sh` via `--wasm-<key> PATH`. The
 * path is recorded on every result, since an unnamed binary's number is not
 * a measurement. Keys are the flag names: `area` is the long reader,
 * `interface` the wide one.
 */
const wasmPaths = {
  area: join(REPO, 'parser', 'area', 'block.wasm'),
  interface: join(REPO, 'parser', 'wide', 'block.wasm'),
};

/** A copy taken before any --wasm-<kind> flag is parsed, so a child process is
 * only told about a binary that was actually overridden. */
const defaultWasmPaths = { ...wasmPaths };

/** The module for one kind, from whichever binary this run is measuring. */
function wasmModule(kind) {
  return new WebAssembly.Module(readFileSync(wasmPaths[kind]));
}

const interfaceHeader = await import('../src/tables/interface/header.ts');
const interfaceBlock = await import('../src/tables/interface/block.ts');
const interfacePool = await import('../src/tables/interface/pool.ts');
const interfaceWorker = await import('../src/tables/wide/worker.ts');
const busWide = await import('../src/tables/bus/wide.ts');
const areaHeader = await import('../src/tables/long/header.ts');
const areaBlock = await import('../src/tables/long/block.ts');
const areaPool = await import('../src/tables/long/pool.ts');
const areaLong = await import('../src/tables/area/long.ts');
const detect = await import('../src/detect.ts');
const ingestShared = await import('../src/ingest.ts');
const areaWorker = await import('../src/tables/long/worker.ts');

// ---------------------------------------------------------------- instruments

/** Peak RSS from the kernel (VmHWM), not polling, which misses the single
 * burst that allocates a cube. Per-process, hence one process per rung. */
function peakRssBytes() {
  try {
    const status = readFileSync('/proc/self/status', 'utf8');
    const match = /^VmHWM:\s+(\d+)\s+kB$/m.exec(status);
    if (match) return Number(match[1]) * 1024;
  } catch {
    // Not Linux, or /proc not mounted. Fall through to the sampled figure,
    // which under-reports rather than lying about being exact.
  }
  return process.memoryUsage().rss;
}

const now = () => Number(process.hrtime.bigint()) / 1e6;

/** Run one named stage, recording its time, and name it as `failedStage` if it
 * is the FIRST to throw (later stages run on purpose, e.g. the cube after a
 * refused plan). */
async function stage(result, name, fn) {
  const started = now();
  try {
    return await fn();
  } catch (error) {
    result.failedStage ??= name;
    throw error;
  } finally {
    result.stages[name] = Number((now() - started).toFixed(2));
  }
}

// ---------------------------------------------------------------- static cost

/**
 * What the pools cost an idle tab: instances × `memory.buffer.byteLength`,
 * judged against the 256 MiB static budget at `POOL_CAP`. Measured on the
 * instance, since `--initial-memory` is only a request. Instantiated RAW, so
 * a variant can be measured before the TypeScript accepts its ABI.
 */
async function staticCostOf(kind) {
  const instance = await WebAssembly.instantiate(wasmModule(kind), {});
  const exports = instance.exports;
  const bytes = exports.memory.buffer.byteLength;

  // Each module reports its byte budgets; width is runtime (0 until a block
  // configures it). The long parser's table capacities have no export and
  // are probed below.
  const dimensions =
    kind === 'interface'
      ? {
          inbufBytes: exports.inbuf_size(),
          arenaBytes: exports.arena_bytes(),
        }
      : {
          inbufBytes: exports.inbuf_size(),
          arenaBytes: exports.arena_bytes(),
          areaTable: probeAreaTable(exports),
        };

  return { kind, wasm: wasmPaths[kind].replace(REPO, '.'), bytes, dimensions };
}

/** The long parser's routing-table capacity, observed: `area_table_put`
 * returns 0 when the power-of-two table is full, so fill it with distinct
 * hashes (an export would need an ABI change). */
function probeAreaTable(exports) {
  exports.area_table_reset();
  for (let i = 0; i < 1 << 20; i++) {
    if (!exports.area_table_put((i * 2654435761) >>> 0, i)) return i;
  }
  return null; // Past a million entries something else is wrong; do not guess.
}

/** Both pools at two sizes: `poolSize()` (this host) and `POOL_CAP` (what the
 * budget is judged at, comparable across hosts), both read from
 * src/ingest.ts. */
export async function measureStaticCost() {
  const kinds = await Promise.all([staticCostOf('area'), staticCostOf('interface')]);
  const local = ingestShared.poolSize();
  const cap = ingestShared.POOL_CAP;
  const perInstance = kinds.reduce((sum, k) => sum + k.bytes, 0);
  return {
    kinds,
    localPoolSize: local,
    capPoolSize: cap,
    perInstanceBytes: perInstance,
    localPoolBytes: perInstance * local,
    // The static pool budget is stated against a full pool, so this is the
    // figure it is judged against.
    capPoolBytes: perInstance * cap,
  };
}

/**
 * Split a rung's block loop as the app does: a worker runs `readWholeRows` and
 * `parseBytes`; the main thread runs blit, cube allocation and finalize for
 * every block. The main-thread share is the SERIAL FRACTION, the price of
 * the pool-size cap, and Node's only view of worker count.
 */
function splitTimer() {
  const totals = { worker: 0, blit: 0 };
  return {
    totals,
    async worker(fn) {
      const at = now();
      try {
        return await fn();
      } finally {
        totals.worker += now() - at;
      }
    },
    blit(fn) {
      const at = now();
      try {
        return fn();
      } finally {
        totals.blit += now() - at;
      }
    },
  };
}

// ---------------------------------------------------------------- detection

/** The classifier's verdict per rung, and whether line 5 fit in
 * DETECT_PROBE_BYTES: from about 4,000 entities it does not. */
async function measureDetect(entry, file, result) {
  const probe = new Uint8Array(await file.slice(0, detect.DETECT_PROBE_BYTES).arrayBuffer());
  const verdict = await stage(result, 'detect', () => detect.classify(probe, entry.file));
  result.detected = verdict.kind;
  result.detectedConfidence = verdict.confidence;
  result.detectedVariant = verdict.variant ?? null;

  // Is the line the classifier's verdict rests on entirely inside the probe?
  // For the wide shape that is line 5; for the long shape, line 1.
  const linesNeeded = entry.shape === 'wide' ? 5 : 1;
  let at = 0;
  let complete = true;
  for (let i = 0; i < linesNeeded; i++) {
    const next = probe.indexOf(10, at);
    if (next < 0) {
      complete = false;
      break;
    }
    at = next + 1;
  }
  result.detectLineComplete = complete;
  result.detectProbeBytes = detect.DETECT_PROBE_BYTES;
}

// ---------------------------------------------------------------- wide / interface

/** Block size as src/tables/wide/pool.ts cuts it, through the same helper and
 * layout, so blocks match the app's (variant binaries included). */
function wideBlockBytes(plan, layout) {
  return Math.max(
    plan.bytesPerRow,
    Math.min(
      interfacePool.BLOCK_TARGET_BYTES,
      interfacePool.safeBlockRows(layout) * plan.bytesPerRow,
    ),
  );
}

/**
 * A ColumnPlan shaped only as far as `createAccumulator` reads it, so the
 * cube allocation can be measured at a width whose real plan is refused.
 *
 * Ceiling 3 -- one contiguous Float32Array of entities x 8,760 -- is a
 * property of the WIDTH, not of whether the parser will accept the file. This
 * probe measures the allocation even when a rung fails before reaching it.
 */
function cubeProbePlan(entities) {
  return {
    // `entities`, not `interfaces`: the wide seam is not only the interface
    // kind's.
    entities: new Array(entities).fill(''),
    plan: new Int32Array(0),
    slabPlan: new Int32Array(0),
    activePlanes: new Int32Array(0),
    presence: new Uint8Array(entities),
  };
}

/** One wide file, start to finish. `parser` and `retain` serve the multi-case
 * drop: one parser per session, and tables held so residency is measured,
 * not just the parse. */
async function measureWide(entry, dir, result, { parser: provided = null, retain = null } = {}) {
  const parser = provided ?? (await interfaceBlock.instantiateParser(wasmModule('interface')));
  const file = fileBlob(join(dir, entry.file));

  try {
    await measureDetect(entry, file, result);
    // A Bus rung carries the bus-number row a real Bus export has, one line
    // deeper than every other wide kind, so only the Bus reader finds its
    // header. The parse after the plan is the same shape reader either way.
    const readPlan = entry.kind === 'bus' ? busWide.readCasePlan : interfacePool.readCasePlan;
    const plan = await stage(result, 'casePlan', () => readPlan(file));
    result.axisSize = plan.header.entityNames.length;
    result.bytesPerRow = plan.bytesPerRow;
    result.quantity = plan.title.quantity;
    // The budgets this rung was actually driven at, from the binary itself.
    result.budget = parser.budget;

    const retained = plan.header.entityNames;
    let columnPlan = null;
    let layout = null;
    try {
      columnPlan = await stage(result, 'columnPlan', () =>
        interfaceHeader.buildColumnPlan(plan.header, retained),
      );
      // The shape the app would configure the parser at for THIS file: as wide
      // as its header, as tall as the arena then allows.
      layout = interfacePool.layoutFor(parser.budget, columnPlan);
      result.layout = layout;
    } catch (error) {
      // Measure the cube allocation anyway: it is what the width costs, and
      // the plan refusal is a different ceiling from the allocation one.
      const probe = await stage(result, 'cubeAlloc', () =>
        interfacePool.createAccumulator(cubeProbePlan(entry.entities)),
      );
      result.cubeBytes = probe.cube.byteLength;
      result.cubeProbed = true;
      throw error;
    }

    const accumulator = await stage(result, 'cubeAlloc', () =>
      interfacePool.createAccumulator(columnPlan),
    );
    result.cubeBytes = accumulator.cube.byteLength;

    const blockBytes = wideBlockBytes(plan, layout);
    result.blockBytes = blockBytes;

    let rows = 0;
    let parsedBytes = 0;
    let blocks = 0;
    const split = splitTimer();
    await stage(result, 'parse', async () => {
      for (let start = plan.dataStart; start < file.size; start += blockBytes) {
        const message = {
          kind: 'block',
          blockId: blocks,
          caseIndex: 0,
          file,
          start,
          end: Math.min(start + blockBytes, file.size),
          skipPartialFirstRow: start !== plan.dataStart,
          activePlanes: columnPlan.activePlanes,
          layout,
          year: plan.year,
        };
        // The two calls worker.ts makes, timed as one: this is what a worker
        // does, and it is the only part more workers can shorten.
        const payload = await split.worker(async () => {
          const { bytes, from, to } = await interfaceWorker.readWholeRows(message);
          parsedBytes += to - from;
          return interfaceBlock.parseBytes(
            parser,
            layout,
            bytes,
            from,
            to,
            columnPlan.activePlanes,
            plan.year,
          );
        });
        split.blit(() => interfacePool.blitBlock(accumulator, payload));
        rows += payload.rows;
        blocks++;
      }
    });
    result.blocks = blocks;
    result.rows = rows;
    result.parsedBytes = parsedBytes;
    result.workerMs = Number(split.totals.worker.toFixed(2));
    result.blitMs = Number(split.totals.blit.toFixed(2));

    const finalized = await stage(result, 'finalize', () =>
      interfacePool.finalizeCase(accumulator, entry.name, retained, plan.year, plan.title),
    );
    result.warnings = finalized.warnings;
    retain?.push(finalized.data);
    result.outcome = 'ok';
  } finally {
    file.close();
  }
}

// ---------------------------------------------------------------- multi-case drop

/** Retained tables at module scope, read after sampling, so V8 cannot
 * collect the cubes before the peak is taken. */
let retainedTables = null;

/**
 * A drop: several bus-width files as separate Cases in one session, with one
 * parser (pools have no lifecycle). N cases cost N cubes whatever the parser
 * does; this measures what a case RETAINS, the peak while case k parses over
 * k-1 held, and whether the marginal cost is flat.
 */
async function measureDrop(entry, dir, result) {
  const parser = await interfaceBlock.instantiateParser(wasmModule('interface'));
  const retained = (retainedTables = []);
  const cases = [];
  const stages = {};
  let rows = 0;
  let parsedBytes = 0;
  let blocks = 0;
  let workerMs = 0;
  let blitMs = 0;

  // Before the first case: what the process costs with the parser standing but
  // nothing loaded. Every per-case figure below is a rise over this.
  const baselineRss = process.memoryUsage().rss;
  result.baselineRssMb = Number((baselineRss / 1e6).toFixed(1));

  for (const caseEntry of entry.caseEntries) {
    const sub = { stages: {}, outcome: 'failed', failedStage: null, error: null };
    try {
      await measureWide(caseEntry, dir, sub, { parser, retain: retained });
    } catch (error) {
      // A drop that dies on case k is the measurement: k-1 cases fit and k did
      // not. Record how far it got and stop, rather than losing the cases that
      // did load.
      result.cases = cases;
      result.casesLoaded = retained.length;
      result.failedStage ??= sub.failedStage ?? 'drop';
      throw error;
    }

    const heldCubeBytes = retained.reduce((total, table) => total + table.cube.byteLength, 0);
    cases.push({
      name: caseEntry.name,
      cubeMb: Number((sub.cubeBytes / 1e6).toFixed(1)),
      parseMs: sub.stages.parse ?? null,
      heldCubeMb: Number((heldCubeBytes / 1e6).toFixed(1)),
      // Sampled with this case and every case before it still held.
      rssMb: Number((process.memoryUsage().rss / 1e6).toFixed(1)),
      peakRssMb: Number((peakRssBytes() / 1e6).toFixed(1)),
    });
    rows += sub.rows;
    parsedBytes += sub.parsedBytes;
    blocks += sub.blocks;
    workerMs += sub.workerMs;
    blitMs += sub.blitMs;
    for (const [name, ms] of Object.entries(sub.stages)) {
      stages[name] = Number(((stages[name] ?? 0) + ms).toFixed(2));
    }
  }

  // Retained after a collection (`--expose-gc`, drop children only), to tell a
  // held cube from uncollected block buffers.
  if (typeof global.gc === 'function') {
    global.gc();
    result.settledRssMb = Number((process.memoryUsage().rss / 1e6).toFixed(1));
  }

  result.cases = cases;
  result.casesLoaded = retained.length;
  result.stages = stages;
  result.rows = rows;
  result.parsedBytes = parsedBytes;
  result.blocks = blocks;
  result.workerMs = Number(workerMs.toFixed(2));
  result.blitMs = Number(blitMs.toFixed(2));
  result.cubeBytes = retained.reduce((total, table) => total + table.cube.byteLength, 0);
  result.outcome = 'ok';

  // The read that keeps every cube alive past the sampling above. Do not
  // remove: without it the retention this function measures is collectable.
  result.axisSize = retained.at(-1)?.interfaces.length ?? 0;
}

// ---------------------------------------------------------------- long / area

/**
 * The long-shape rung. The long path scans every row's identity before any
 * value is parsed; `scan` is reported separately. Blocks are cut as
 * src/tables/long/pool.ts rangesFor() cuts them, and the scan's row counts
 * bound the parser, so the scan cannot be skipped.
 */
async function measureLong(entry, dir, result) {
  const wasm = wasmModule('area');
  const parser = await areaBlock.instantiateParser(wasm);
  const file = fileBlob(join(dir, entry.file));

  try {
    await measureDetect(entry, file, result);
    const plan = await stage(result, 'casePlan', () =>
      areaPool.readCasePlan(file, areaLong.AREA_LONG),
    );

    const ranges = [];
    for (let start = plan.dataStart; start < file.size; start += areaPool.BLOCK_TARGET_BYTES) {
      ranges.push({
        start,
        end: Math.min(start + areaPool.BLOCK_TARGET_BYTES, file.size),
        skipPartialFirstRow: start !== plan.dataStart,
      });
    }

    // Axis discovery. discoverEntities() itself dispatches to Workers and cannot
    // run here, so its per-block body is driven directly: the same scanAxis
    // over the same ranges, collecting the same names and row counts.
    const seen = new Set();
    const rowsPerBlock = new Array(ranges.length).fill(0);
    let scannedBytes = 0;
    await stage(result, 'scan', async () => {
      for (let i = 0; i < ranges.length; i++) {
        const { bytes, from, to } = await areaWorker.readWholeRows({ file, ...ranges[i] });
        const scan = areaBlock.scanAxis(parser, bytes, from, to);
        for (const name of scan.names) seen.add(name);
        rowsPerBlock[i] = scan.rows;
        scannedBytes += to - from;
      }
    });
    const areas = [...seen];
    result.axisSize = areas.length;
    result.blocks = ranges.length;

    await stage(result, 'loadAxis', () =>
      areaBlock.loadEntityAxis(parser, areaHeader.entityHashes(areas)),
    );

    const retained = plan.header.metricNames;
    const columnPlan = await stage(result, 'columnPlan', () =>
      areaHeader.buildColumnPlan(plan.header, retained),
    );
    const accumulator = await stage(result, 'cubeAlloc', () =>
      areaPool.createAccumulator(columnPlan, areas.length),
    );
    result.cubeBytes = accumulator.cube.byteLength;

    let rows = 0;
    let parsedBytes = 0;
    const split = splitTimer();
    await stage(result, 'parse', async () => {
      for (let i = 0; i < ranges.length; i++) {
        const payload = await split.worker(async () => {
          const { bytes, from, to } = await areaWorker.readWholeRows({ file, ...ranges[i] });
          parsedBytes += to - from;
          return areaBlock.parseBytes(
            parser,
            bytes,
            from,
            to,
            columnPlan.activePlanes,
            areas.length,
            plan.header.metricNames.length,
            rowsPerBlock[i],
          );
        });
        split.blit(() => areaPool.blitBlock(accumulator, payload));
        rows += payload.rows;
      }
    });
    result.rows = rows;
    result.parsedBytes = parsedBytes;
    result.scannedBytes = scannedBytes;
    result.workerMs = Number(split.totals.worker.toFixed(2));
    result.blitMs = Number(split.totals.blit.toFixed(2));

    const finalized = await stage(result, 'finalize', () =>
      areaLong.finalizeCase(accumulator, entry.name, retained, plan.year, areas),
    );
    result.warnings = finalized.warnings;
    result.outcome = 'ok';
  } finally {
    file.close();
  }
}

// ---------------------------------------------------------------- area axis probe

/**
 * The long parser's name-table ceiling, measured directly through
 * `loadEntityAxis`: a file big enough to hit it (4,096 entities × 8,760 hours)
 * would be gigabytes. Same seam and refusal text the user would see.
 */
const AREA_AXIS_PROBES = [4096, 4097].map((entities) => ({
  name: `area-axis-${entities}`,
  file: null,
  shape: 'area-axis',
  kind: 'area',
  entities,
  metrics: 0,
  bytes: 0,
  headerBytes: 0,
  proves:
    entities === 4096
      ? "the area name table's exact capacity (block.c AREA_TABLE = 4096)"
      : 'one name past the area table -- the refusal, attributably',
}));

async function measureAreaAxis(entry, _dir, result) {
  const wasm = wasmModule('area');
  const parser = await areaBlock.instantiateParser(wasm);

  const names = await stage(result, 'axisNames', () =>
    Array.from(
      { length: entry.entities },
      (_, i) => `SAMPLE_AREA_${String(i + 1).padStart(5, '0')}`,
    ),
  );
  const hashes = await stage(result, 'axisHashes', () => areaHeader.entityHashes(names));
  await stage(result, 'loadAxis', () => areaBlock.loadEntityAxis(parser, hashes));
  result.axisSize = entry.entities;
  result.outcome = 'ok';
}

// ------------------------------------------------- head probe / cube ceiling

/**
 * The wide reader's head-probe walls, BISECTED: `readCasePlan` must find the
 * preamble, header and one data row in a fixed 256 KiB slice, and three of
 * those grow with width. A hardcoded bracket would go stale silently; this
 * walks the real reader over heads the real generator (`writeHead`) writes.
 */
const HEAD_PROBE_SEARCH = { lo: 5900, hi: 40000 };

/** The two walls, in the order a widening file meets them: below `header+row`
 * the header fits but no row after it; above `header` the header itself does
 * not. The LOWER one binds. */
const HEAD_PROBE_WALLS = [
  {
    id: 'header+row',
    // The probe held the header line but not a whole data row after it.
    matches: (message) => message.includes('header but no data rows'),
    means: 'the header fits the probe but the first data row does not',
  },
  {
    id: 'header',
    matches: (message) => message.includes('no column header within'),
    means: 'the header line itself does not end inside the probe',
  },
];

/** Does `readCasePlan` accept a file of this width? Returns null on success,
 * or the refusal message. Head bytes only: no rung, no file on disk. */
async function headPlanAt(entities) {
  const rung = wideRung(entities);
  // A little past the probe, so the plan fails on the CONSTANT and never
  // because the bytes ran out -- which would pin the wall at whatever this
  // limit happened to be.
  const head = await writeHead(rung, { limit: 320 * 1024 });
  try {
    await interfacePool.readCasePlan(new File([head], `${rung.name}.csv`));
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Largest `e` in (lo, hi] for which `below(e)` holds, and the first for which
 * it does not. Both ends are returned: a ceiling is only attributable with the
 * rung either side of it. */
async function bisect(lo, hi, below) {
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (await below(mid)) lo = mid;
    else hi = mid;
  }
  return [lo, hi];
}

async function measureHeadProbe(_entry, _dir, result) {
  const walls = [];
  let lo = HEAD_PROBE_SEARCH.lo;

  await stage(result, 'bisect', async () => {
    // Wall 1: the last width that PLANS at all.
    const [lastOk, firstRefused] = await bisect(
      lo,
      HEAD_PROBE_SEARCH.hi,
      async (e) => (await headPlanAt(e)) === null,
    );
    const firstMessage = await headPlanAt(firstRefused);
    walls.push({
      ...(HEAD_PROBE_WALLS.find((w) => w.matches(firstMessage)) ?? {
        id: 'unclassified',
        means: 'a refusal this probe does not recognise',
      }),
      lastOk,
      firstRefused,
      message: firstMessage,
    });
    lo = firstRefused;

    // Wall 2: above it the refusal CHANGES, because a different part of the
    // head stops fitting. Bisect on the message rather than on success, since
    // everything above wall 1 is a refusal of one kind or another.
    const still = walls[0].matches;
    if (still) {
      const [lastSame, firstOther] = await bisect(lo, HEAD_PROBE_SEARCH.hi, async (e) =>
        still(await headPlanAt(e)),
      );
      if (firstOther < HEAD_PROBE_SEARCH.hi) {
        const message = await headPlanAt(firstOther);
        walls.push({
          ...(HEAD_PROBE_WALLS.find((w) => w.matches(message)) ?? {
            id: 'unclassified',
            means: 'a refusal this probe does not recognise',
          }),
          lastOk: lastSame,
          firstRefused: firstOther,
          message,
        });
      }
    }
  });

  // `matches` is a function and does not survive JSON; the child returns this
  // over a pipe, so drop it rather than shipping `undefined` into the report.
  result.walls = walls.map(({ matches, ...wall }) => wall);
  // The binding wall is the FIRST one a widening file meets, and it is the
  // number that answers "how wide can an export be".
  result.axisSize = walls[0]?.lastOk ?? null;
  result.entities = walls[0]?.firstRefused ?? null;
  result.outcome = 'ok';
}

const HEAD_PROBE_ENTRY = {
  name: 'head-probe-wall',
  file: null,
  shape: 'head-probe',
  kind: 'interface',
  entities: null,
  metrics: 1,
  bytes: 0,
  headerBytes: 0,
  proves: "the wide reader's fixed 256 KiB head probe, bisected to the exact entity count",
};

/** The contiguous cube's cost at widths no file reaches (above the head-probe
 * wall), measured by allocation: "would a 30,000-bus export load?" needs both
 * which wall stops it and what it would have cost. */
const CUBE_PROBES = [10000, 20000, 30000].map((entities) => ({
  name: `cube-${entities}`,
  file: null,
  shape: 'cube',
  kind: 'interface',
  entities,
  metrics: 1,
  bytes: 0,
  headerBytes: 0,
  proves: `the contiguous cube at ${entities.toLocaleString()} entities, which no file reaches`,
}));

async function measureCube(entry, _dir, result) {
  const accumulator = await stage(result, 'cubeAlloc', () =>
    interfacePool.createAccumulator(cubeProbePlan(entry.entities)),
  );
  result.cubeBytes = accumulator.cube.byteLength;
  result.cubeProbed = true;
  result.axisSize = entry.entities;
  result.outcome = 'ok';
}

// ---------------------------------------------------------------- the run

/** Measure one rung. Never throws: a failure's text is the result. */
export async function measure(entry, dir) {
  const result = {
    rung: entry.name,
    shape: entry.shape,
    kind: entry.kind,
    entities: entry.entities,
    metrics: entry.metrics,
    fileBytes: entry.bytes,
    headerBytes: entry.headerBytes,
    stages: {},
    outcome: 'failed',
    failedStage: null,
    error: null,
  };

  const started = now();
  try {
    if (entry.shape === 'area-axis') await measureAreaAxis(entry, dir, result);
    else if (entry.shape === 'head-probe') await measureHeadProbe(entry, dir, result);
    else if (entry.shape === 'cube') await measureCube(entry, dir, result);
    else if (entry.shape === 'long') await measureLong(entry, dir, result);
    else if (entry.shape === 'drop') await measureDrop(entry, dir, result);
    else await measureWide(entry, dir, result);
  } catch (error) {
    // Verbatim. The message is the measurement: it says WHICH ceiling was hit.
    result.error = error instanceof Error ? error.message : String(error);
    result.failedStage ??= 'startup';
    result.outcome = 'refused';
  }
  result.totalMs = Number((now() - started).toFixed(2));
  result.peakRssMb = Number((peakRssBytes() / 1e6).toFixed(1));

  const parseMs = result.stages.parse;
  if (parseMs > 0 && result.parsedBytes) {
    result.mbPerSec = Number((result.parsedBytes / 1e6 / (parseMs / 1000)).toFixed(1));
    result.rowsPerSec = Math.round(result.rows / (parseMs / 1000));
  }
  return result;
}

export function readManifest(dir) {
  return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
}

// ---------------------------------------------------------------- isolation

const SELF = fileURLToPath(import.meta.url);

/** The hand-filled Browser confirmation section of an existing report, or
 * null while it still carries the generator's "not yet performed" line. */
export function priorBrowserSection(reportPath) {
  let text;
  try {
    text = readFileSync(reportPath, 'utf8');
  } catch {
    return null; // No report yet. Nothing to preserve.
  }
  const start = text.indexOf('## Browser confirmation');
  if (start < 0) return null;
  const section = text.slice(start);
  if (section.includes('**Status: not yet performed.**')) return null;
  return section.split('\n');
}

/** Where the report lands by default: beside the data it measured, untracked.
 * Copy it aside before a parser change to compare before and after. */
export const DEFAULT_REPORT = join(REPO, 'sample-data', 'perf-ladder-report.md');

/** Measure one rung in its own child process, never throwing: an OOM kill or
 * V8 abort becomes a row (exit code, signal, stderr). */
function measureIsolated(entry, dir) {
  // Forward variant flags, or the child and parent describe different builds.
  // Only drop children get `--expose-gc`, so ladder rows stay comparable.
  const execArgv = entry.shape === 'drop' ? ['--expose-gc'] : [];
  const argv = [...execArgv, SELF, '--measure', entry.name, '--in', dir];
  for (const kind of ['area', 'interface']) {
    if (wasmPaths[kind] !== defaultWasmPaths[kind]) argv.push(`--wasm-${kind}`, wasmPaths[kind]);
  }
  const child = spawnSync(process.execPath, argv, {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  // The child prints exactly one JSON line on stdout when it completed a
  // measurement -- including a measurement whose outcome is a refusal.
  const line = child.stdout.trim().split('\n').pop();
  if (child.status === 0 && line) {
    try {
      return JSON.parse(line);
    } catch {
      // Fall through: unparseable stdout is a crashed child, not a result.
    }
  }

  const how = child.signal ? `killed by ${child.signal}` : `exit code ${child.status}`;
  return {
    rung: entry.name,
    shape: entry.shape,
    kind: entry.kind,
    entities: entry.entities,
    metrics: entry.metrics,
    fileBytes: entry.bytes,
    headerBytes: entry.headerBytes,
    stages: {},
    outcome: 'crashed',
    failedStage: 'child process',
    // Verbatim, and untruncated at the front: an OOM kill's useful text
    // ("JavaScript heap out of memory", "Array buffer allocation failed") is
    // in the first lines, and the stack that follows is not.
    error: `${how}. stderr:\n${(child.stderr || '(empty)').trim()}`,
    totalMs: null,
    peakRssMb: null,
  };
}

// ---------------------------------------------------------------- reporting

export function describe(result) {
  const lines = [];
  const stages = Object.entries(result.stages)
    .map(([name, ms]) => `${name} ${ms.toFixed(1)} ms`)
    .join(', ');
  lines.push(
    `${result.rung}  ${result.entities.toLocaleString()} entities  ` +
      (result.fileBytes
        ? `${mb(result.fileBytes)} MB  header ${result.headerBytes.toLocaleString()} B`
        : '(no file — probe)'),
  );
  lines.push(`  stages:   ${stages || '(none reached)'}`);
  if (result.totalMs !== null) lines.push(`  total:    ${result.totalMs.toFixed(1)} ms`);
  if (result.peakRssMb !== null) lines.push(`  peak RSS: ${result.peakRssMb.toFixed(1)} MB`);
  if (result.cubeBytes) {
    lines.push(`  cube:     ${mb(result.cubeBytes)} MB${result.cubeProbed ? ' (probed)' : ''}`);
  }
  if (result.outcome === 'ok') {
    if (result.rows !== undefined) {
      lines.push(
        `  parsed:   ${result.rows.toLocaleString()} rows in ${result.blocks} block(s) — ` +
          `${result.mbPerSec} MB/s, ${result.rowsPerSec.toLocaleString()} rows/s`,
      );
    }
    if (result.workerMs !== undefined) {
      const serial = result.blitMs + (result.stages.cubeAlloc ?? 0) + (result.stages.finalize ?? 0);
      lines.push(
        `  split:    worker ${result.workerMs.toFixed(1)} ms (parallel), ` +
          `blit ${result.blitMs.toFixed(1)} ms + cube ${cell(result.stages.cubeAlloc)} ms + ` +
          `final ${cell(result.stages.finalize)} ms = ${serial.toFixed(1)} ms serial`,
      );
    }
    for (const c of result.cases ?? []) {
      lines.push(
        `  case:     ${c.name}  cube ${c.cubeMb} MB  held ${c.heldCubeMb} MB  ` +
          `RSS ${c.rssMb} MB (peak ${c.peakRssMb})`,
      );
    }
    if (result.settledRssMb !== undefined) {
      lines.push(
        `  settled:  ${result.settledRssMb} MB after gc, from a ${result.baselineRssMb} MB baseline`,
      );
    }
    for (const warning of result.warnings ?? []) lines.push(`  warning:  ${warning}`);
  } else {
    lines.push(`  ${result.outcome.toUpperCase()} at stage "${result.failedStage}":`);
    for (const line of result.error.split('\n')) lines.push(`    ${line}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- entry point

function parseArgs(argv) {
  const args = {
    in: DEFAULT_OUT,
    rung: null,
    measure: null,
    ladder: false,
    report: DEFAULT_REPORT,
    static: false,
    // Names this configuration in the report. A sweep runs the same rungs over
    // the same seed and the same bytes against several binaries, and the label
    // is what tells two otherwise identical reports apart.
    label: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--in') args.in = argv[++i];
    else if (flag === '--rung') args.rung = argv[++i];
    else if (flag === '--measure') args.measure = argv[++i];
    else if (flag === '--ladder') args.ladder = true;
    else if (flag === '--report') args.report = argv[++i];
    else if (flag === '--static') args.static = true;
    else if (flag === '--label') args.label = argv[++i];
    else if (flag === '--wasm-area') wasmPaths.area = argv[++i];
    else if (flag === '--wasm-interface') wasmPaths.interface = argv[++i];
    else throw new Error(`Unknown argument ${flag}`);
  }
  return args;
}

/** Everything measurable: the generated files, plus the probes that need no
 * file. Probe entries are indistinguishable from rungs downstream, which is
 * the point -- they are rows in the same report with the same columns. */
function entriesFor(manifest) {
  // Drop member files are not standalone rows: each is shaped like
  // `wide-5900`. findEntry() still reaches them by name.
  const standalone = manifest.files.filter((file) => !file.partOfDrop);
  const drops = (manifest.drops ?? [])
    .map((drop) => {
      const caseEntries = drop.cases.map((name) =>
        manifest.files.find((file) => file.name === name),
      );
      return {
        ...drop,
        shape: 'drop',
        kind: 'interface',
        metrics: 1,
        caseEntries,
        // The drop's total bytes and its widest header, so the results table's
        // file and header columns mean the same thing for a drop as for a rung.
        bytes: caseEntries.reduce((total, file) => total + (file?.bytes ?? 0), 0),
        headerBytes: Math.max(...caseEntries.map((file) => file?.headerBytes ?? 0)),
      };
      // A drop whose files are not all on disk is not measurable, and a partial
      // drop measured as a smaller one would be a quietly wrong answer.
    })
    .filter((drop) => drop.caseEntries.every(Boolean));
  return [...standalone, ...drops, ...AREA_AXIS_PROBES, HEAD_PROBE_ENTRY, ...CUBE_PROBES];
}

function findEntry(manifest, name) {
  // Members first: `--rung drop-5900-2` measures that one file on its own,
  // which is how a drop's case is investigated when the drop itself fails.
  const entry =
    entriesFor(manifest).find((candidate) => candidate.name === name) ??
    manifest.files.find((file) => file.name === name);
  if (!entry) {
    throw new Error(
      `No rung "${name}" in ${manifest.files.length} generated file(s) or the probes. ` +
        // Drop members included: they are not measured by --ladder, but --rung
        // reaches them, so a typo of one should be answered rather than hidden.
        `Known: ${[...new Set([...entriesFor(manifest), ...manifest.files].map((e) => e.name))].join(', ')}`,
    );
  }
  return entry;
}

if (process.argv[1] && SELF === process.argv[1]) {
  const args = parseArgs(process.argv.slice(2));

  // Before the manifest is read: the static cost is a property of the BINARY
  // and needs no generated data at all, so `--static` works on a fresh clone
  // where `make-perf-data.mjs` has never been run.
  if (args.static) {
    const cost = await measureStaticCost();
    for (const k of cost.kinds) {
      console.log(`${k.kind.padEnd(9)} ${mb(k.bytes).padStart(6)} MB per instance  ${k.wasm}`);
      console.log(`          ${JSON.stringify(k.dimensions)}`);
    }
    console.log(`total     ${mb(cost.perInstanceBytes).padStart(6)} MB per worker`);
    console.log(
      `pool ${String(cost.localPoolSize).padStart(2)}   ${mb(cost.localPoolBytes).padStart(6)} MB (this host)`,
    );
    console.log(
      `pool ${String(cost.capPoolSize).padStart(2)}   ${mb(cost.capPoolBytes).padStart(6)} MB ` +
        `(POOL_CAP; static budget: 268.4 MB / 256 MiB)`,
    );
    process.exit(0);
  }

  const manifest = readManifest(args.in);

  if (args.measure) {
    // Child mode. Exactly one JSON line on stdout, so the parent can tell a
    // completed measurement from a dead process.
    const result = await measure(findEntry(manifest, args.measure), args.in);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (args.ladder) {
    const entries = entriesFor(manifest);
    const results = [];
    for (const entry of entries) {
      process.stderr.write(`measuring ${entry.name} …\n`);
      const result = measureIsolated(entry, args.in);
      result.proves = entry.proves;
      results.push(result);
      console.log(`${describe(result)}\n`);
    }
    const os = await import('node:os');
    writeFileSync(
      args.report,
      renderReport(results, {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        cpus: os.cpus().length,
        totalMemGb: Math.round(os.totalmem() / 1e9),
        seed: manifest.seed,
        dir: args.in.replace(REPO, '.'),
        when: new Date().toISOString().slice(0, 10),
        // Measured in the PARENT, against the same binaries the children were
        // told to use. It needs no file, so it costs nothing to include and a
        // report without it cannot be compared against another candidate's.
        staticCost: await measureStaticCost(),
        label: args.label,
        // Read BEFORE the file is overwritten, so a hand-filled browser
        // confirmation survives a re-run of the ladder.
        priorBrowserSection: priorBrowserSection(args.report),
      }),
    );
    console.log(`report written to ${args.report}`);
  } else {
    const entry = findEntry(manifest, args.rung ?? CONTROL_RUNG);
    const result = measureIsolated(entry, args.in);
    result.proves = entry.proves;
    console.log(describe(result));
  }
}
