// scripts/audit-limits.mjs
//
// Checks the interface-limit parsing assumptions against a limits export and
// its Power Flow export, printing COUNTS AND VERDICTS ONLY, so the output stays
// short enough to read at a glance. It never prints a name, row, cell, header
// or value (tests/test_limits_audit.mjs searches for its fixtures' ones).
// It uses the app's own parsers, so a "match" is what a drop would draw, and
// adds why a name missed and whether units look like MW.
//
// Usage:
//   node scripts/audit-limits.mjs <limits.csv> <flow.csv>

import '../tests/test_loader.mjs';
import { createReadStream, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const { parseLimitsCsv, NO_LIMIT_BEYOND } = await import('../src/limits/parse.ts');
const { readCasePlan } = await import('../src/tables/interface/pool.ts');
const { splitCsvLine, normalizeCell, parseNumber } = await import('../src/lookups/parse.ts');
const { MONTH_NAMES } = await import('../src/model/calendar.ts');
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

/** The limits file's structure, read the way parse.ts reads it and counted. */
function auditLimitsLayout(text) {
  const lines = text.split(/\r?\n/);
  const wanted = MONTH_NAMES.map((month) => month.toLowerCase());
  let headerIndex = -1;
  let cells = [];
  for (let i = 0; i < Math.min(lines.length, 20); i++) {
    cells = splitCsvLine(lines[i]).map((cell) => cell.trim().toLowerCase());
    if (wanted.every((month) => cells.includes(month))) {
      headerIndex = i;
      break;
    }
  }
  const preamble = headerIndex < 0 ? '' : lines.slice(0, headerIndex).join('\n');
  const monthIndexes = wanted.map((month) => cells.indexOf(month));
  const markerColumns = new Set();
  const years = new Set();
  const yearIndex = cells.indexOf('year');
  let rowsWithSecondMarker = 0;
  let markerHeaderBlank = null;
  let blankMonthCells = 0;
  let noLimitCells = 0;
  let noLimitNot99999 = 0;
  let justInsideThreshold = 0;
  for (let i = headerIndex + 1; headerIndex >= 0 && i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const row = splitCsvLine(lines[i]);
    const markers = row
      .map((cell, index) => [cell.trim().toLowerCase(), index])
      .filter(([cell]) => cell === 'min' || cell === 'max');
    if (markers.length === 0) continue;
    if (markers.length > 1) rowsWithSecondMarker++;
    markerColumns.add(markers[0][1]);
    if (yearIndex >= 0) years.add((row[yearIndex] ?? '').trim());
    for (const index of monthIndexes) {
      const cell = normalizeCell(row[index] ?? '');
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
  if (markerColumns.size === 1) {
    const [index] = markerColumns;
    markerHeaderBlank = (cells[index] ?? '') === '';
  }
  return {
    headerFound: headerIndex >= 0,
    finerThanMonthColumns: cells.filter((cell) => FINER_THAN_MONTH.test(cell)).length,
    distinctYears: years.size,
    markerColumnCount: markerColumns.size,
    markerHeaderBlank,
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

/** Per interface and month, the flow's extremes, by streaming the export. */
async function flowExtremes(flowPath, plan) {
  const columns = [];
  plan.header.canonical.forEach((name, index) => {
    if (index > plan.header.touCol && name !== '') columns.push([index, name]);
  });
  const extremes = new Map(
    columns.map(([, name]) => [
      name,
      { max: new Float64Array(12).fill(-Infinity), min: new Float64Array(12).fill(Infinity) },
    ]),
  );
  let hours = 0;
  const input = createReadStream(flowPath, { start: plan.dataStart });
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (line.trim() === '') continue;
    const cells = line.split(',');
    const month = Number((cells[plan.header.dateCol] ?? '').trim().split('/')[0]) - 1;
    if (!(month >= 0 && month < 12)) continue;
    hours++;
    for (const [index, name] of columns) {
      const value = Number(cells[index]);
      if (!Number.isFinite(value)) continue;
      const entry = extremes.get(name);
      if (value > entry.max[month]) entry.max[month] = value;
      if (value < entry.min[month]) entry.min[month] = value;
    }
  }
  return { extremes, hours };
}

/** The whole audit as numbers and booleans (exported for the test). */
export async function auditLimits(limitsPath, flowPath) {
  stage = 'reading the limits file';
  const text = readFileSync(limitsPath, 'utf8');
  const layout = auditLimitsLayout(text);
  const { table, warnings } = parseLimitsCsv(text, 'limits');
  const countIn = (pattern) => {
    const hit = warnings.find((warning) => pattern.test(warning));
    // The count is `toLocaleString()` text: any locale's digit grouping.
    return hit ? Number(hit.match(/: (\d[\d.,'\u00a0\u202f]*) /)[1].replace(/\D/g, '')) : 0;
  };

  stage = 'reading the flow file';
  const plan = await readCasePlan(fileBlob(flowPath));
  const { extremes, hours } = await flowExtremes(flowPath, plan);
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
        if (bound !== 0 && Math.sign(reach) !== 0 && Math.sign(bound) !== Math.sign(reach)) {
          magnitude.oppositeSign++;
          continue;
        }
        const ratio = Math.abs(reach) / Math.abs(bound);
        if (ratio > 1 + EXCEED_TOLERANCE) magnitude.exceeded++;
        else if (ratio >= 0.5) magnitude.within50to100++;
        else magnitude.below50++;
        if (ratio < 0.01) magnitude.belowOnePercent++;
      }
    }
  }
  names.flowInterfacesWithNoLimit = [...flowNames].filter(
    (name) => !table.byInterface.has(name),
  ).length;

  const flowIsMW = /\(MW\)/.test(plan.title.quantity);
  const otherUnitStated =
    layout.preambleUnits.MVA || layout.preambleUnits.percent || layout.preambleUnits.amps;
  const exceedShare = magnitude.monthSides === 0 ? null : magnitude.exceeded / magnitude.monthSides;
  return {
    limits: {
      ...layout,
      interfaces: table.byInterface.size,
      duplicateRowsDropped: countIn(/duplicate/),
      rowsWithNoMarker: countIn(/no MIN or MAX/),
      rowsWithBlankName: countIn(/blank path name/),
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
          : exceedShare > 0.05 || magnitude.belowOnePercent > magnitude.monthSides / 2
            ? 'no'
            : magnitude.within50to100 > 0
              ? 'yes'
              : 'undetermined',
      '2 names match exactly after trimming': names.unmatched === 0 ? 'yes' : 'no',
      '3 one value per month, nothing finer':
        layout.headerFound &&
        layout.finerThanMonthColumns === 0 &&
        layout.distinctYears <= 1 &&
        countIn(/duplicate/) === 0
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
