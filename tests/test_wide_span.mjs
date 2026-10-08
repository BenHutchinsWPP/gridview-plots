// tests/test_wide_span.mjs — a wide-shape Case spanning several years, read
// from the generated sample exports through the wide reader's own ingest
// (`ingestWithWorkers`) with the parser run in-process, because the pool's
// Workers do not run under Node:
//
//   1. the date line's endpoint years size the Case; with no date line the
//      first row's year is the one year;
//   2. a 2034-2036 area file is one three-year table, every cell at its year
//      offset, Feb 29 2036 kept and 2034's and 2035's empty, coverage counted
//      in real hours, and its rows in another order load identically;
//   3. a year of the date line with no rows is refused, naming it;
//   4. two files of abutting years merge into the table one whole-span file
//      makes, and two with a year between them are refused, naming it;
//   5. a row outside the date line's years is refused.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import './test_loader.mjs';

const { generate } = await import('../scripts/make-sample-data.mjs');
const { parseDateLine } = await import('../src/tables/wide/header.ts');
const { instantiateParser, parseBytes } = await import('../src/tables/wide/block.ts');
const { readWholeRows } = await import('../src/tables/wide/worker.ts');
const { ingestWithWorkers } = await import('../src/tables/wide/pool.ts');
const { checkMergeGroup } = await import('../src/tables/wide/merge.ts');
const areaWide = await import('../src/tables/area/wide.ts');
const { YEAR_SLOT_HOURS, SLOT_MONTH_STARTS, realHours } = await import('../src/model/calendar.ts');

let checks = 0;
function ok(label) {
  checks++;
  console.log(`ok - ${label}`);
}

const parser = await instantiateParser(
  new WebAssembly.Module(readFileSync(new URL('../parser/wide/block.wasm', import.meta.url))),
);

/** The wide reader's worker, run in this process. */
function inProcessWorker() {
  const listeners = new Set();
  const reply = (data) => setImmediate(() => [...listeners].forEach((fn) => fn({ data })));
  return {
    addEventListener: (type, fn) => type === 'message' && listeners.add(fn),
    removeEventListener: (type, fn) => listeners.delete(fn),
    async postMessage(message) {
      try {
        const { bytes, from, to } = await readWholeRows(message);
        const payload = parseBytes(
          parser,
          message.layout,
          bytes,
          from,
          to,
          message.activePlanes,
          message.firstYear,
          message.numYears,
        );
        reply({ kind: 'done', blockId: message.blockId, caseIndex: message.caseIndex, ...payload });
      } catch (error) {
        reply({ kind: 'error', blockId: message.blockId, message: String(error?.message) });
      }
    },
  };
}

/** Files read as a drop would read them into Area tables; `groupOf` as the
 * Import Dialog's study names would give it. */
async function load(files, groupOf) {
  const plans = [];
  for (const file of files) plans.push(await areaWide.readCasePlan(file));
  return ingestWithWorkers(
    [inProcessWorker()],
    parser.budget,
    plans,
    areaWide.unionOf(plans),
    areaWide.AREA_WIDE_SPEC,
    areaWide.finalizeArea,
    undefined,
    groupOf,
  );
}

/** Every data row of a wide text below its four preamble lines and header. */
function rowsOf(text) {
  return text
    .trim()
    .split('\r\n')
    .slice(5)
    .map((line) => {
      const cells = line.split(',');
      const [month, day, year] = cells[0].split('/').map(Number);
      const slotHour = (SLOT_MONTH_STARTS[month - 1] + day - 1) * 24 + Number(cells[1]) - 1;
      return { year, slotHour, values: cells.slice(3) };
    });
}

const cell = (text) => (text.trim() === '' ? NaN : Math.fround(Number(text)));
const bytesOf = (array) => new Uint8Array(array.buffer, array.byteOffset, array.byteLength);

/** The table's planes as bytes, so two loads compare NaN for NaN. */
function assertSameTable(a, b, what) {
  assert.deepEqual([a.firstYear, a.numYears], [b.firstYear, b.numYears], what);
  assert.deepEqual(a.areas, b.areas, what);
  assert.ok(Buffer.from(bytesOf(a.cube)).equals(Buffer.from(bytesOf(b.cube))), `${what}: cube`);
  assert.deepEqual(a.hoursPresent, b.hoursPresent, `${what}: hours present`);
  assert.deepEqual(a.tou, b.tou, `${what}: TOU`);
}

const scratch = mkdtempSync(join(tmpdir(), 'gvp-wide-span-'));
try {
  await generate({ out: scratch });
  const textOf = (name) => readFileSync(join(scratch, name), 'utf8');
  const fileOf = (name, text = textOf(name)) => new File([text], name);

  // ------------------------------------------------------ 1. the date line
  {
    assert.deepEqual(
      parseDateLine(
        '(From the first hour of 1/1/2035 to the last hour of 12/31/2035. ' +
          'Column identifier -- BusName)\r',
      ),
      { firstYear: 2035, lastYear: 2035 },
    );
    const multi = textOf('area-wide-multiyear.csv').split('\r\n')[2];
    assert.deepEqual(parseDateLine(multi), { firstYear: 2034, lastYear: 2036 });
    assert.equal(parseDateLine('Date Range: whatever'), null);
    assert.equal(parseDateLine(''), null);

    const plan = await areaWide.readCasePlan(fileOf('area-wide-multiyear.csv'));
    assert.deepEqual([plan.firstYear, plan.numYears], [2034, 3]);
    assert.equal(plan.title.year, 2034, 'the title names the first year only');

    const lines = textOf('area-wide.csv').split('\r\n');
    lines[2] = '';
    const undated = await areaWide.readCasePlan(fileOf('undated.csv', lines.join('\r\n')));
    assert.deepEqual([undated.firstYear, undated.numYears], [2034, 1]);
    ok('the date line states the years; without one, the first row is the one year');
  }

  // ------------------------------------------------- 2. three years, one file
  {
    const name = 'area-wide-multiyear.csv';
    const text = textOf(name);
    const result = await load([fileOf(name)]);
    assert.deepEqual(result.failures, []);
    const [table] = result.cases;
    assert.deepEqual([table.firstYear, table.numYears], [2034, 3]);
    const span = 3 * YEAR_SLOT_HOURS;
    assert.equal(table.cube.length, table.areas.length * span);
    assert.equal(table.hoursPresent.length, span);
    assert.equal(table.tou.length, span);

    // Every cell at `(area * numYears + yearOffset) * 8784 + slotHour`.
    const rows = rowsOf(text);
    let compared = 0;
    for (const row of rows) {
      row.values.forEach((value, area) => {
        const at = area * span + (row.year - 2034) * YEAR_SLOT_HOURS + row.slotHour;
        assert.ok(
          Object.is(table.cube[at], cell(value)),
          `area ${area} ${row.year} ${row.slotHour}`,
        );
        compared++;
      });
    }
    assert.ok(compared > 500, `${compared} cells compared`);

    // Slot hours 1416-1439 are Feb 29 in every year; only 2036's is real.
    const feb29 = (yearOffset) => yearOffset * YEAR_SLOT_HOURS + 1416;
    for (let area = 0; area < table.areas.length; area++) {
      for (let h = 0; h < 24; h++) {
        assert.ok(Number.isNaN(table.cube[area * span + feb29(0) + h]), '2034 has no Feb 29');
        assert.ok(Number.isNaN(table.cube[area * span + feb29(1) + h]), '2035 has no Feb 29');
        assert.ok(!Number.isNaN(table.cube[area * span + feb29(2) + h]), '2036 has Feb 29');
      }
    }
    assert.equal(table.hoursPresent[feb29(2)], 1);
    assert.equal(table.hoursPresent[feb29(1)], 0);

    // Coverage counts the span's real hours: 8,760 + 8,760 + 8,784.
    assert.equal(realHours(2034, 3), 26304);
    const seen = new Set(rows.map((r) => `${r.year}:${r.slotHour}`)).size;
    const messages = result.warnings.map((w) => w.message);
    assert.ok(
      messages.includes(
        `area-wide-multiyear: covers ${seen.toLocaleString()} of 26,304 hours; the rest read as ` +
          `no-data.`,
      ),
      messages.join('\n'),
    );
    assert.ok(!messages.some((m) => m.includes('title line says')), 'the title names 2034');
    ok('a 2034-2036 wide area file is one three-year table, every cell at its year offset');

    const [preamble, body] = [text.split('\r\n').slice(0, 5), text.trim().split('\r\n').slice(5)];
    const reversed = [...preamble, ...body.reverse()].join('\r\n') + '\r\n';
    const again = await load([fileOf(name, reversed)]);
    assertSameTable(again.cases[0], table, 'reversed rows');
    ok('the same file with its rows reversed loads byte-identically');
  }

  // ------------------------------------------------------ 3. a year of no rows
  {
    const name = 'area-wide-multiyear-gap.csv';
    const plan = await areaWide.readCasePlan(fileOf(name));
    assert.deepEqual([plan.firstYear, plan.numYears], [2034, 3], 'the date line spans the run');
    const result = await load([fileOf(name)]);
    assert.deepEqual(result.cases, []);
    assert.deepEqual(
      result.failures.map((f) => f.message),
      [
        'area-wide-multiyear-gap has rows for 2034 and 2036 but none for 2035. A Case is a ' +
          'contiguous run of years, so the load is refused rather than reading 2035 as no data. ' +
          "Add the missing year's rows, or load each run of years as its own Case.",
      ],
    );
    ok('a year of the date line with no rows is refused, naming it');
  }

  // --------------------------------------------- 4. merges across years
  {
    const [a, b] = ['area-wide-split-years-a.csv', 'area-wide-split-years-b.csv'];
    const merged = await load([fileOf(a), fileOf(b)], [0, 0]);
    assert.deepEqual(merged.failures, []);
    assert.equal(merged.cases.length, 1);
    assert.deepEqual([merged.cases[0].firstYear, merged.cases[0].numYears], [2030, 3]);

    // One file holding both runs, its date line over the whole span.
    const aLines = textOf(a).trim().split('\r\n');
    aLines[2] = aLines[2].replace(/last hour of (\d+)\/(\d+)\/2031/, 'last hour of $1/$2/2032');
    const whole = [...aLines, ...textOf(b).trim().split('\r\n').slice(5)].join('\r\n') + '\r\n';
    const one = await load([fileOf('whole.csv', whole)]);
    assert.deepEqual(one.failures, []);
    assertSameTable(merged.cases[0], one.cases[0], 'split vs whole');

    const backward = await load([fileOf(b), fileOf(a)], [0, 0]);
    assertSameTable(backward.cases[0], one.cases[0], 'split, dropped backward');
    ok('2030-2031 and 2032 in two files merge into the table one 2030-2032 file makes');

    const [x, y] = ['area-wide-conflict-year-a.csv', 'area-wide-conflict-year-b.csv'];
    const refusal =
      `"${x}", "${y}" were assigned to one study and together have rows for 2034 and 2036 but ` +
      'none for 2035. A Case is a contiguous run of years, so the load is refused rather than ' +
      "reading 2035 as no data. Add the missing year's rows, or load each run of years as its " +
      'own Case. Give them different study names to load them separately.';
    const plans = [await areaWide.readCasePlan(fileOf(x)), await areaWide.readCasePlan(fileOf(y))];
    assert.equal(checkMergeGroup(plans).refusal, refusal);
    const gapped = await load([fileOf(x), fileOf(y)], [0, 0]);
    assert.deepEqual(gapped.cases, []);
    assert.deepEqual(
      gapped.failures.map((f) => [f.file, f.message]),
      [
        [x, refusal],
        [y, refusal],
      ],
    );
    ok('a same-study pair with a year between them is refused, naming the year');
  }

  // ----------------------------------------- 5. rows outside the date line
  {
    const lines = textOf('area-wide.csv').trim().split('\r\n');
    const last = lines.length - 1;
    lines[last] = lines[last].replace(/^(\d+\/\d+)\/2034,/, '$1/2035,');
    assert.match(lines[last], /^\d+\/\d+\/2035,/);
    const result = await load([fileOf('late.csv', lines.join('\r\n') + '\r\n')]);
    assert.deepEqual(result.cases, []);
    assert.match(result.failures[0].message, /1 row\(s\) are dated outside 2034/);

    const early = textOf('area-wide.csv').trim().split('\r\n');
    early[5] = early[5].replace(/^(\d+\/\d+)\/2034,/, '$1/2033,');
    await assert.rejects(areaWide.readCasePlan(fileOf('early.csv', early.join('\r\n'))), {
      message:
        'early.csv: the first data row is dated 2033, outside 2034, the years the date line ' +
        'states. The date line sizes the table, so the load is refused rather than guessing ' +
        'which of the two is right.',
    });
    ok("a row outside the date line's years is refused");
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${checks} checks passed.`);
