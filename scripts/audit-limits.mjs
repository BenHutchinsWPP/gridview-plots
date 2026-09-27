// scripts/audit-limits.mjs
//
// Checks the interface-limit parsing assumptions against a limits export and
// its Power Flow export, printing COUNTS AND VERDICTS ONLY, so the output stays
// short enough to read at a glance. It never prints a name, row, cell, header
// or value (tests/test_limits_audit.mjs searches for its fixtures' ones).
// It reads both files through the app's own parsers (the limits rows a drop
// keeps, the flow cube the wide reader builds), so a "match" is what a drop
// would draw, and adds why a name missed and whether units look like MW.
//
// Usage:
//   node scripts/audit-limits.mjs <limits.csv> <flow.csv>

import '../tests/test_loader.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { parseLimitsCsv, readLimitRows, NO_LIMIT_BEYOND } = await import('../src/limits/parse.ts');
const { readCasePlan, ingestWithWorkers } = await import('../src/tables/interface/pool.ts');
const { instantiateParser, parseBytes } = await import('../src/tables/wide/block.ts');
const { readWholeRows } = await import('../src/tables/wide/worker.ts');
const { normalizeCell, parseNumber } = await import('../src/lookups/parse.ts');
const { HOURS_PER_YEAR, buildCalendar, getMonth } = await import('../src/model/calendar.ts');
const { fileBlob } = await import('./file-blob.mjs');

/** A limit this far past the flow's own extreme, on its own side, counts as
 * exceeded rather than as rounding. */
const EXCEED_TOLERANCE = 0.01;

/** Unit words a preamble might carry. Only whether each appears is reported. */
const UNIT_TOKENS = {
  MW: /\bMW\b/,
  MVA: /\bMVA\b/i,
  percent: /%|\bpercent\b/i,
  amps: /\bamps?\b|\bkA\b/i,
};

/** Header words that would mean the file carries a finer schedule than a month. */
const FINER_THAN_MONTH = /^(week|day|date|hour|he|period|season|start|end)\b/i;

const collapse = (name) => name.replace(/\s+/g, ' ');

/** Where a refusal happened, which is all a refusal may say. */
let stage = 'starting';

/** The limits file's structure, counted over the rows parse.ts keeps. */
function auditLimitsLayout(text) {
  // parseLimitsCsv has already refused a file with no header.
  const { layout, rows } = readLimitRows(text);
  const { header } = layout;
  const markerColumns = new Set();
  const years = new Set();
  const yearIndex = header.indexOf('year');
  let rowsWithSecondMarker = 0;
  let blankMonthCells = 0;
  let noLimitCells = 0;
  let noLimitNot99999 = 0;
  let justInsideThreshold = 0;
  for (const { cells, sideIndex } of rows) {
    const markers = cells.filter((cell) => /^(min|max)$/i.test(cell.trim())).length;
    if (markers > 1) rowsWithSecondMarker++;
    markerColumns.add(sideIndex);
    if (yearIndex >= 0) years.add((cells[yearIndex] ?? '').trim());
    for (const index of layout.monthIndexes) {
      const cell = normalizeCell(cells[index] ?? '');
      const value = cell === null ? null : parseNumber(cell);
      if (value === null) {
        blankMonthCells++;
        continue;
      }
      const magnitude = Math.abs(value);
      if (magnitude > NO_LIMIT_BEYOND) {
        noLimitCells++;
        if (magnitude !== 99999) noLimitNot99999++;
      } else if (magnitude >= NO_LIMIT_BEYOND * 0.9) justInsideThreshold++;
    }
  }
  const preamble = text.split(/\r?\n/).slice(0, layout.headerIndex).join('\n');
  return {
    headerFound: true,
    finerThanMonthColumns: header.filter((cell) => FINER_THAN_MONTH.test(cell)).length,
    distinctYears: years.size,
    markerColumnCount: markerColumns.size,
    markerHeaderBlank:
      markerColumns.size === 1 ? (header[[...markerColumns][0]] ?? '') === '' : null,
    rowsWithSecondMarker,
    blankMonthCells,
    noLimitCells,
    noLimitNot99999,
    justInsideThreshold,
    preambleUnits: Object.fromEntries(
      Object.entries(UNIT_TOKENS).map(([unit, pattern]) => [unit, pattern.test(preamble)]),
    ),
  };
}

/** The wide reader's worker, run in this process: Node has no Worker. */
function inProcessWorker(parser) {
  const listeners = new Set();
  const reply = (data) => setImmediate(() => [...listeners].forEach((fn) => fn({ data })));
  return {
    addEventListener: (type, fn) => type === 'message' && listeners.add(fn),
    removeEventListener: (type, fn) => listeners.delete(fn),
    async postMessage(message) {
      if (message.kind === 'init') return reply({ kind: 'ready', budget: parser.budget });
      try {
        const { bytes, from, to } = await readWholeRows(message);
        const payload = parseBytes(
          parser,
          message.layout,
          bytes,
          from,
          to,
          message.activePlanes,
          message.year,
        );
        reply({ kind: 'done', blockId: message.blockId, caseIndex: message.caseIndex, ...payload });
      } catch (error) {
        reply({ kind: 'error', blockId: message.blockId, message: String(error?.message) });
      }
    },
  };
}

/** The flow file as a drop would load it: Feb 29 dropped, a repeated hour
 * refused, a blank cell absent. Then per interface and month, its extremes. */
async function flowExtremes(file, plan) {
  const wasm = readFileSync(new URL('../parser/wide/block.wasm', import.meta.url));
  const parser = await instantiateParser(new WebAssembly.Module(wasm));
  const result = await ingestWithWorkers(
    [inProcessWorker(parser)],
    parser.budget,
    [plan],
    plan.header.entityNames,
  );
  // The failure's text names the file and quotes cells; the refusal names the stage.
  if (result.failures.length > 0 || result.cases.length === 0) throw new Error('flow refused');
  const table = result.cases[0];
  const calendar = buildCalendar(table.year);
  const extremes = new Map();
  table.interfaces.forEach((name, i) => {
    if (!table.presence[i]) return;
    const entry = {
      max: new Float64Array(12).fill(-Infinity),
      min: new Float64Array(12).fill(Infinity),
    };
    const plane = table.cube.subarray(i * HOURS_PER_YEAR, (i + 1) * HOURS_PER_YEAR);
    for (let hour = 0; hour < HOURS_PER_YEAR; hour++) {
      const value = plane[hour];
      if (Number.isNaN(value)) continue;
      const month = getMonth(calendar[hour]) - 1;
      if (value > entry.max[month]) entry.max[month] = value;
      if (value < entry.min[month]) entry.min[month] = value;
    }
    extremes.set(name, entry);
  });
  const hours = table.hoursPresent.reduce((sum, seen) => sum + seen, 0);
  return { extremes, hours, unit: table.unit };
}

/** The whole audit as numbers and booleans (exported for the test). */
export async function auditLimits(limitsPath, flowPath) {
  stage = 'reading the limits file';
  const text = readFileSync(limitsPath, 'utf8');
  const { table, dropped } = parseLimitsCsv(text, 'limits');
  const layout = auditLimitsLayout(text);

  stage = 'reading the flow file';
  const file = fileBlob(flowPath);
  let flow;
  try {
    flow = await flowExtremes(file, await readCasePlan(file));
  } finally {
    file.close();
  }
  const { extremes, hours, unit } = flow;
  stage = 'comparing';

  const flowNames = new Set(extremes.keys());
  const byCase = new Map([...flowNames].map((name) => [name.toLowerCase(), name]));
  const byCollapsed = new Map([...flowNames].map((name) => [collapse(name), name]));
  const names = {
    limitInterfaces: table.byInterface.size,
    flowInterfaces: flowNames.size,
    matched: 0,
    unmatched: 0,
    unmatchedThatMatchIgnoringCase: 0,
    unmatchedThatMatchCollapsingSpaces: 0,
    flowInterfacesWithNoLimit: 0,
  };
  const magnitude = {
    monthSides: 0,
    exceeded: 0,
    floorOrCeiling: 0,
    within50to100: 0,
    below50: 0,
    belowOnePercent: 0,
    oppositeSign: 0,
  };
  let varyingWithinYear = 0;
  for (const [name, limit] of table.byInterface) {
    for (const side of ['min', 'max']) {
      const values = limit[side];
      if (!values) continue;
      const finite = [...values].filter(Number.isFinite);
      if (new Set(finite).size > 1) varyingWithinYear++;
    }
    if (!flowNames.has(name)) {
      names.unmatched++;
      if (byCase.has(name.toLowerCase())) names.unmatchedThatMatchIgnoringCase++;
      if (byCollapsed.has(collapse(name))) names.unmatchedThatMatchCollapsingSpaces++;
      continue;
    }
    names.matched++;
    const flow = extremes.get(name);
    for (const side of ['min', 'max']) {
      const values = limit[side];
      if (!values) continue;
      for (let m = 0; m < 12; m++) {
        const bound = values[m];
        const reach = side === 'max' ? flow.max[m] : flow.min[m];
        if (!Number.isFinite(bound) || !Number.isFinite(reach)) continue;
        magnitude.monthSides++;
        // How far the flow went past the limit, on the limit's own side.
        const past = side === 'max' ? reach - bound : bound - reach;
        if (past > EXCEED_TOLERANCE * Math.abs(bound)) {
          magnitude.exceeded++;
          continue;
        }
        // A MIN at or above zero is a floor and a MAX at or below zero a
        // ceiling: the flow's distance from zero says nothing of their scale.
        if (side === 'max' ? bound <= 0 : bound >= 0) {
          magnitude.floorOrCeiling++;
          continue;
        }
        if (Math.sign(reach) === -Math.sign(bound)) {
          magnitude.oppositeSign++;
          continue;
        }
        const ratio = Math.abs(reach) / Math.abs(bound);
        if (ratio >= 0.5) magnitude.within50to100++;
        else magnitude.below50++;
        if (ratio < 0.01) magnitude.belowOnePercent++;
      }
    }
  }
  names.flowInterfacesWithNoLimit = [...flowNames].filter(
    (name) => !table.byInterface.has(name),
  ).length;

  const flowIsMW = unit === 'MW';
  const otherUnitStated =
    layout.preambleUnits.MVA || layout.preambleUnits.percent || layout.preambleUnits.amps;
  const exceedShare = magnitude.monthSides === 0 ? null : magnitude.exceeded / magnitude.monthSides;
  const scaled = magnitude.within50to100 + magnitude.below50;
  return {
    limits: {
      ...layout,
      interfaces: table.byInterface.size,
      duplicateRowsDropped: dropped.duplicates,
      rowsWithNoMarker: dropped.untyped,
      rowsWithBlankName: dropped.unnamed,
      sidesVaryingWithinYear: varyingWithinYear,
    },
    flow: { quantityIsMW: flowIsMW, hours },
    names,
    magnitude,
    verdicts: {
      // A limit below its flow suggests a smaller unit; far above, a larger.
      // MW is affirmed only when some flows approach a limit.
      '1 unit is MW':
        !flowIsMW || otherUnitStated || magnitude.monthSides === 0
          ? 'undetermined'
          : exceedShare > 0.05 || magnitude.belowOnePercent > scaled / 2
            ? 'no'
            : magnitude.within50to100 > 0
              ? 'yes'
              : 'undetermined',
      '2 names match exactly after trimming': names.unmatched === 0 ? 'yes' : 'no',
      '3 one value per month, nothing finer':
        layout.headerFound &&
        layout.finerThanMonthColumns === 0 &&
        layout.distinctYears <= 1 &&
        dropped.duplicates === 0
          ? 'yes'
          : 'no',
      '4 MIN/MAX found by value, unambiguously':
        layout.markerColumnCount === 1 && layout.rowsWithSecondMarker === 0 ? 'yes' : 'no',
      // A limit just inside the threshold would draw off the top of most
      // charts, which is what the threshold exists to stop the sentinel doing.
      'no-limit cells sit clear of the threshold': layout.justInsideThreshold === 0 ? 'yes' : 'no',
    },
  };
}

/** One line per number, `section.key: value`, and nothing else. */
export function formatAudit(report) {
  const lines = [];
  for (const [section, entries] of Object.entries(report)) {
    for (const [key, value] of Object.entries(entries)) {
      if (value !== null && typeof value === 'object') {
        for (const [inner, v] of Object.entries(value))
          lines.push(`${section}.${key}.${inner}: ${v}`);
      } else {
        lines.push(`${section}.${key}: ${value}`);
      }
    }
  }
  return lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [limitsPath, flowPath] = process.argv.slice(2);
  if (!limitsPath || !flowPath) {
    console.error('Usage: node scripts/audit-limits.mjs <limits.csv> <flow.csv>');
    process.exit(2);
  }
  try {
    console.log(formatAudit(await auditLimits(limitsPath, flowPath)));
  } catch (error) {
    // The app's own messages name the file and quote cells; this one must not.
    console.error(`audit refused while ${stage}.`);
    process.exit(1);
  }
}
