// tests/test_long_span.mjs — a long-shape Case spanning several years, read
// from the generated sample exports through the pool's own steps (header,
// per-block scan, year span, merge check, span cube, blit, finalize), driven
// in-process because the pool's Workers do not run under Node:
//
//   1. a shuffled 2034-2036 bus file is one three-year Case, every value at
//      its year's offset, Feb 29 2036 kept and 2034's and 2035's empty, and
//      it loads identically from its rows in another order;
//   2. a nine-year area file puts its last year's values at year offset 8;
//   3. a year with no rows, a duplicate (entity, hour) in year 2 and a Feb 29
//      in a non-leap year are each refused by what is wrong;
//   4. coverage counts the span's real hours, never its slot hours.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import './test_loader.mjs';

const { generate } = await import('../scripts/make-sample-data.mjs');
const { entityHashes, buildColumnPlan } = await import('../src/tables/long/header.ts');
const { afterNextNewline, instantiateParser, loadEntityAxis, parseBytes, scanAxis, setKeyLayout } =
  await import('../src/tables/long/block.ts');
const pool = await import('../src/tables/long/pool.ts');
const { addYearRows, checkMergeGroup, unionMetricNames } =
  await import('../src/tables/long/merge.ts');
const { yearSpanOf } = await import('../src/ingest.ts');
const { AREA_KIND, unionOf: areaUnionOf } = await import('../src/tables/area/long.ts');
const { BUS_LONG_KIND } = await import('../src/tables/bus/long.ts');
const { YEAR_SLOT_HOURS, SLOT_MONTH_STARTS, realHours } = await import('../src/model/calendar.ts');

let checks = 0;
function ok(label) {
  checks++;
  console.log(`ok - ${label}`);
}

const wasmModule = new WebAssembly.Module(
  readFileSync(new URL('../parser/long/block.wasm', import.meta.url)),
);
const encoder = new TextEncoder();

/** Small blocks, so one file's years arrive over several scans. */
const BLOCK_BYTES = 8 * 1024;

function wholeRowRanges(bytes, dataStart) {
  const ranges = [];
  for (let start = dataStart; start < bytes.length; start += BLOCK_BYTES) {
    const from = start === dataStart ? dataStart : afterNextNewline(bytes, start);
    if (from < 0) continue;
    const end = Math.min(start + BLOCK_BYTES, bytes.length);
    let to = afterNextNewline(bytes, end);
    if (to < 0) to = bytes.length;
    if (to > from) ranges.push([from, to]);
  }
  return ranges;
}

/**
 * One merge group of long files as `discoverEntities` and `ingest` read it:
 * scan every block for names and years, refuse a file whose years are not one
 * run, check the group, allocate the group's span, parse every member against
 * that span and blit. Throws each refusal's message.
 */
async function load(files, kind, retainedOf) {
  const parser = await instantiateParser(wasmModule);
  const members = [];
  for (const { name, bytes } of files) {
    const plan = await pool.readCasePlan(new File([bytes], name), kind.sig);
    members.push({ plan, bytes, ranges: wholeRowRanges(bytes, plan.dataStart) });
  }
  const layout = pool.layoutOf(members.map((m) => m.plan));
  setKeyLayout(parser, layout);

  for (const { plan, bytes, ranges } of members) {
    const names = new Set();
    plan.rowsPerBlock = [];
    for (const [from, to] of ranges) {
      const scan = scanAxis(parser, bytes, from, to);
      for (const n of scan.names) names.add(n);
      plan.rowsPerBlock.push(scan.rows);
      addYearRows(plan.rowsByYear, scan);
    }
    const years = yearSpanOf(`${plan.file.name} has`, plan.rowsByYear);
    if (years.refusal) throw new Error(years.refusal);
    Object.assign(plan, years.span);
    plan.entities = [...names];
  }

  const plans = members.map((m) => m.plan);
  const check = checkMergeGroup(plans);
  if (check.refusal) throw new Error(check.refusal);
  const span = check.span;

  const axis = pool.unionEntities(plans);
  loadEntityAxis(parser, entityHashes(axis));
  const retained = retainedOf(plans);
  const header =
    plans.length === 1
      ? plans[0].header
      : { ...plans[0].header, metricNames: unionMetricNames(plans) };
  const accumulator = pool.createAccumulator(buildColumnPlan(header, retained), axis.length, span);
  for (const { plan, bytes, ranges } of members) {
    const columnPlan = buildColumnPlan(plan.header, retained);
    ranges.forEach(([from, to], i) => {
      const payload = parseBytes(
        parser,
        bytes,
        from,
        to,
        columnPlan.activePlanes,
        axis.length,
        columnPlan.sourceMetricCount,
        plan.rowsPerBlock[i],
        span.firstYear,
        span.numYears,
      );
      pool.blitBlock(accumulator, payload, columnPlan);
    });
  }
  const repPlan = {
    ...plans[0],
    label: plans.map((p) => p.file.name).join(' + '),
    header,
    ...span,
  };
  return { span, axis, accumulator, ...kind.finalize(accumulator, repPlan, axis) };
}

/** Every data row of a long text as its key fields and metric cells. */
function rowsOf(text, keyCols) {
  return text
    .trim()
    .split('\r\n')
    .slice(1)
    .map((line) => {
      const cells = line.split(',');
      const [month, day, year] = cells[0].split('/').map(Number);
      const slotHour = (SLOT_MONTH_STARTS[month - 1] + day - 1) * 24 + Number(cells[1]) - 1;
      return { year, slotHour, entity: cells[3].trim(), values: cells.slice(keyCols) };
    });
}

/** One entity's whole span of one quantity, as bytes. The entity axis is in
 * first-seen order, so two loads are compared per entity, not per index. */
function spanBytes(loaded, quantity, entity) {
  const table = loaded.data.find((t) => t.quantity === quantity);
  const plane = table.numYears * YEAR_SLOT_HOURS;
  const at = loaded.axis.indexOf(entity);
  return new Uint8Array(table.cube.slice(at * plane, (at + 1) * plane).buffer);
}

/** Two loads hold the same numbers for every entity and quantity. */
function assertSameCubes(a, b) {
  assert.deepEqual([...a.axis].sort(), [...b.axis].sort());
  for (const table of a.data) {
    for (const entity of a.axis) {
      assert.deepEqual(
        spanBytes(b, table.quantity, entity),
        spanBytes(a, table.quantity, entity),
        `${entity} ${table.quantity}`,
      );
    }
  }
}

const cell = (text) => (text.trim() === '' ? NaN : Math.fround(Number(text)));
const reorder = (text) => {
  const [header, ...rows] = text.trim().split('\r\n');
  // Every other row moved to the end, reversed: a different order, same rows.
  const odd = rows.filter((_, i) => i % 2).reverse();
  return [header, ...rows.filter((_, i) => i % 2 === 0), ...odd].join('\r\n') + '\r\n';
};

const scratch = mkdtempSync(join(tmpdir(), 'gvp-long-span-'));
try {
  await generate({ out: scratch });
  const textOf = (name) => readFileSync(join(scratch, name), 'utf8');
  const fileOf = (name, text = textOf(name)) => ({ name, bytes: encoder.encode(text) });
  const busUnion = (plans) => pool.unionMetricsOf(plans);

  // --------------------------------------------- 1. three shuffled years
  {
    const name = 'bus-long-multiyear.csv';
    const text = textOf(name);
    const busLoad = await load([fileOf(name)], BUS_LONG_KIND, busUnion);
    assert.deepEqual(busLoad.span, { firstYear: 2034, numYears: 3 });
    const span = 3 * YEAR_SLOT_HOURS;
    const tables = busLoad.data;
    assert.ok(tables.length > 0);
    for (const table of tables) {
      assert.deepEqual([table.firstYear, table.numYears], [2034, 3]);
      assert.equal(table.cube.length, table.buses.length * span);
      assert.equal(table.hoursPresent.length, span);
    }

    // Every row's every cell, at `(entity * numYears + yearOffset) * 8784 + slotHour`.
    const rows = rowsOf(text, 6);
    const metricNames = text.split('\r\n')[0].split(',').slice(6);
    let compared = 0;
    for (const row of rows) {
      const entity = busLoad.axis.indexOf(row.entity);
      const at = entity * span + (row.year - 2034) * YEAR_SLOT_HOURS + row.slotHour;
      metricNames.forEach((metric, m) => {
        const table = tables.find((t) => t.quantity === metric.trim());
        assert.ok(
          Object.is(table.cube[at], cell(row.values[m])),
          `${row.entity} ${row.year} slot hour ${row.slotHour} ${metric}`,
        );
        compared++;
      });
    }
    assert.ok(compared > 1000, `${compared} cells compared`);

    // Feb 29 is slot hours 1416-1439 in every year: 2036's has rows, 2034's
    // and 2035's are phantom and read NaN.
    const feb29 = (yearOffset) => yearOffset * YEAR_SLOT_HOURS + 1416;
    assert.ok(rows.some((r) => r.year === 2036 && r.slotHour >= 1416 && r.slotHour < 1440));
    for (const table of tables) {
      for (let entity = 0; entity < busLoad.axis.length; entity++) {
        for (let h = 0; h < 24; h++) {
          assert.ok(Number.isNaN(table.cube[entity * span + feb29(0) + h]), '2034 has no Feb 29');
          assert.ok(Number.isNaN(table.cube[entity * span + feb29(1) + h]), '2035 has no Feb 29');
        }
      }
    }
    assert.equal(busLoad.accumulator.hourSeen[feb29(2)], 1, 'Feb 29 2036 is present');
    assert.equal(busLoad.accumulator.hourSeen[feb29(0)], 0);

    // The coverage note counts real hours over the span: 8,760 + 8,760 + 8,784.
    const seen = new Set(rows.map((r) => `${r.year}:${r.slotHour}`)).size;
    assert.equal(realHours(2034, 3), 26304);
    assert.ok(
      busLoad.warnings.includes(
        `${name}: covers ${seen.toLocaleString()} of 26,304 hours; the rest read as no-data.`,
      ),
      busLoad.warnings.join('\n'),
    );
    ok('a shuffled 2034-2036 bus file is one three-year Case, every cell at its year offset');

    // The same rows in another order load to the same cubes, cell for cell.
    const again = await load([fileOf(name, reorder(text))], BUS_LONG_KIND, busUnion);
    assert.deepEqual(again.span, busLoad.span);
    assertSameCubes(busLoad, again);
    assert.deepEqual(again.data[0].hoursPresent, tables[0].hoursPresent);
    assert.deepEqual(again.data[0].tou, tables[0].tou);
    ok('the same file with its rows reordered loads byte-identically, entity for entity');
  }

  // ------------------------------------------------- 2. nine years, no wrap
  {
    const name = 'area-long-nineyear.csv';
    const text = textOf(name);
    const nine = await load([fileOf(name)], AREA_KIND, areaUnionOf);
    assert.deepEqual(nine.span, { firstYear: 2030, numYears: 9 });
    const table = nine.data;
    assert.deepEqual([table.firstYear, table.numYears], [2030, 9]);
    const span = 9 * YEAR_SLOT_HOURS;
    const metrics = table.metrics.length;
    const metricNames = text.split('\r\n')[0].split(',').slice(4);
    const rows = rowsOf(text, 4);
    const last = rows.filter((r) => r.year === 2038);
    assert.ok(last.length > 0);
    // Every row of every year, so 2038's cannot have been folded onto 2030's.
    for (const row of rows) {
      const entity = table.areas.indexOf(row.entity);
      metricNames.forEach((metric, m) => {
        const plane = table.metrics.indexOf(metric.trim());
        const at =
          (entity * metrics + plane) * span + (row.year - 2030) * YEAR_SLOT_HOURS + row.slotHour;
        assert.ok(Object.is(table.cube[at], cell(row.values[m])), `${row.entity} ${metric}`);
      });
    }
    assert.ok(span - 1 > 65535, 'the last slot hour is past a u16');
    ok(`a nine-year area file puts 2038's ${last.length} rows at year offset 8`);
  }

  // ------------------------------------------------------------ 3. refusals
  {
    const name = 'bus-long-multiyear.csv';
    const [header, ...rows] = textOf(name).trim().split('\r\n');
    const gapped = [header, ...rows.filter((r) => !r.split(',')[0].endsWith('/2035'))];
    await assert.rejects(
      load([fileOf('gap.csv', gapped.join('\r\n') + '\r\n')], BUS_LONG_KIND, busUnion),
      {
        message:
          'gap.csv has rows for 2034 and 2036 but none for 2035. A Case is a contiguous run of ' +
          'years, so the load is refused rather than reading 2035 as no data. Add the missing ' +
          "year's rows, or load each run of years as its own Case.",
      },
    );
    ok('a year with no rows inside a file is refused, naming it');

    await assert.rejects(
      load([fileOf('bus-long-multiyear-duplicate.csv')], BUS_LONG_KIND, busUnion),
      /Two rows both describe area index \d+ at hour 1440 of 2035 \(Mar 1, hour ending 1\)/,
    );
    ok('a duplicate (entity, hour) in year 2 is refused, naming its year and date');

    await assert.rejects(
      load([fileOf('area-long-multiyear-feb29-nonleap.csv')], AREA_KIND, areaUnionOf),
      /1 row\(s\) carry a Date or Hour this parser could not read/,
    );
    ok('a Feb 29 in a non-leap year is refused as a bad date');
  }

  // ------------------------------------- 4. a merge across files and years
  {
    const name = 'bus-long-multiyear.csv';
    const [header, ...rows] = textOf(name).trim().split('\r\n');
    const part = (keep) =>
      [header, ...rows.filter((r) => keep(Number(r.split(',')[0].split('/')[2])))].join('\r\n') +
      '\r\n';
    const whole = await load([fileOf(name)], BUS_LONG_KIND, busUnion);
    const merged = await load(
      [
        fileOf(
          'late.csv',
          part((y) => y === 2036),
        ),
        fileOf(
          'early.csv',
          part((y) => y < 2036),
        ),
      ],
      BUS_LONG_KIND,
      busUnion,
    );
    assert.deepEqual(merged.span, { firstYear: 2034, numYears: 3 });
    assertSameCubes(whole, merged);
    ok('2034-2035 and 2036 in two files merge into the same three-year table as one file');

    await assert.rejects(
      load(
        [
          fileOf(
            'a.csv',
            part((y) => y === 2034),
          ),
          fileOf(
            'c.csv',
            part((y) => y === 2036),
          ),
        ],
        BUS_LONG_KIND,
        busUnion,
      ),
      /"a\.csv", "c\.csv" were assigned to one study and together have rows for 2034 and 2036 but none for 2035\./,
    );
    ok('a merge whose union skips a year is refused, naming it');
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${checks} checks passed.`);
