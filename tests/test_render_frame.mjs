// tests/test_render_frame.mjs — one render, as the value `main.ts` paints.
//
// `src/app/render-frame.ts` decides what a render shows and in what order its
// steps run. The orders asserted here are the ones a reordering would break
// silently:
//
//   * **Notes follow the series.** A series raises its warnings while it
//     resolves, so notes read before the resolve carry only the previous
//     render's.
//   * **The whole year is resolved only when a pane asks**, once, and the
//     overview pool is swept at `settle` when nothing asked. A capped render
//     resolves nothing and sweeps the drawn pool.
//   * **Boxes are cut only when a pane asks**, once per dimension.
//   * **The browse signature moves with every input a rebuild reads.** A term
//     it misses leaves a stale ranking with nothing to say so.
//
// Line pools are faked through `LineSource`, so what is resolved, and when,
// is observable without a table.
//
// Run:  node tests/test_render_frame.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './test_loader.mjs';

const { YEAR_SLOT_HOURS: H } = await import('../src/model/calendar.ts');
const { computeFrame, datesClearedOf, drawContextOf } = await import('../src/app/render-frame.ts');

let checks = 0;
function ok(label) {
  checks++;
  console.log(`ok - ${label}`);
}

const FILTERS = Object.freeze({
  years: null,
  dates: null,
  hoursOfDay: null,
  daysOfWeek: null,
  seasons: null,
  tou: null,
});
const QUERY = Object.freeze({
  cases: ['c1'],
  filters: FILTERS,
  boxDims: ['month', 'month', 'case', 'hourOfDay'],
});

/** A resolved line: one value per hour, `n` of them kept. */
function line(rowId, { warnings = [], n = H, caseId = 'c1' } = {}) {
  const values = new Float32Array(H).fill(Number.NaN);
  values.fill(1, 0, n);
  const q = { min: 1, p25: 1, p50: 1, p75: 1, max: 1 };
  return {
    name: rowId,
    color: '#123456',
    unit: 'MW',
    values,
    warnings,
    sorted: new Float32Array(n).fill(1),
    n,
    stats: { n, mean: 1, min: 1, max: 1, sd: 0 },
    quantiles: q,
    allZero: false,
    rowId,
    spec: { caseId },
  };
}

/** A pool that logs what it was asked, into the shared `log`. */
function source(name, log, lines) {
  return {
    resolves: [],
    sweeps: 0,
    resolve(draws) {
      log.push(`${name}.resolve`);
      this.resolves.push(draws);
      return lines(draws);
    },
    sweep() {
      log.push(`${name}.sweep`);
      this.sweeps++;
    },
  };
}

const draw = (id) => ({ ref: { id }, color: '#000000', dashed: false });

/** The most lines the fake charts draw. */
const CAP = 3;

/** A frame over fakes; `over` replaces any input. */
function frameOf(over = {}) {
  const log = [];
  const drawn = source('drawn', log, (draws) =>
    draws.map((one) => line(one.ref.id, { warnings: [`warned by ${one.ref.id}`], n: 100 })),
  );
  const overview = source('overview', log, (draws) => draws.map((one) => line(one.ref.id)));
  const years = [];
  const declared = [];
  const input = {
    query: QUERY,
    cap: (count) => (count > CAP ? `${count} is too many lines` : null),
    draws: [draw('p1')],
    pinnedIds: ['p1'],
    notes: ['from the ledger'],
    hasCases: true,
    drawn,
    overview,
    limitLines: (series) => series.map((entry) => ({ label: `limit of ${entry.rowId}` })),
    spanOfCase: (caseId) => {
      years.push(caseId);
      return { firstYear: 2031, numYears: 1 };
    },
    boxScratch: (hours) => new Float32Array(hours),
    declareTabs: () => {
      log.push('declareTabs');
      return declared;
    },
    freshness: {
      lookups: new Map(),
      groupingsRev: 0,
      generatorGroupsRev: 0,
      busGroupsRev: 0,
      interfaceGroupsRev: 0,
      limits: { shared: undefined, cases: new Map() },
    },
    activeTabId: '',
    ...over,
  };
  const frame = computeFrame(input);
  return { frame, log, drawn: input.drawn, overview: input.overview, years, input };
}

// ------------------------------------------------------ notes follow series
{
  const { frame, log } = frameOf();
  assert.deepEqual(
    frame.notes,
    ['from the ledger', 'warned by p1'],
    "the ledger's notes, then the warnings the resolve raised",
  );
  assert.equal(log[0], 'drawn.resolve', 'the series resolve first');
  assert.ok(
    log.indexOf('declareTabs') > log.indexOf('drawn.resolve'),
    'the browse tabs are declared after the series',
  );
  assert.equal(log.filter((step) => step === 'declareTabs').length, 1, 'and once');
  ok("a render's notes carry the warnings its own series raised");
}

// ------------------------------------------------- only the draws are drawn
{
  const draws = [draw('p1'), { ref: { id: 'preview' }, color: '#999', dashed: true }];
  const { frame, drawn, overview } = frameOf({ draws, pinnedIds: ['p1'] });
  assert.deepEqual(drawn.resolves, [draws], 'the drawn pool resolves exactly the draws');
  frame.charts.overview();
  assert.deepEqual(overview.resolves, [draws], 'and the whole year resolves the same draws');
  assert.deepEqual(
    frame.series.map((entry) => entry.rowId),
    ['p1', 'preview'],
  );
  assert.equal(frame.pinLines.get('p1').drawn, true);
  assert.equal(frame.pinLines.has('preview'), false, 'the preview is no pin');
  ok('only the pins and the preview are drawn, and only pins get a pin line');
}

// --------------------------------------------------------- a capped render
{
  const many = CAP + 1;
  const ids = Array.from({ length: many }, (_, i) => `p${i}`);
  const { frame, log, drawn, overview } = frameOf({ draws: ids.map(draw), pinnedIds: ids });
  assert.deepEqual(drawn.resolves, [], 'a capped render resolves nothing');
  assert.equal(drawn.sweeps, 1, 'and frees every drawn line');
  assert.deepEqual(frame.series, []);
  assert.equal(frame.charts.overview, undefined, 'no pane can ask for the whole year');
  assert.equal(frame.charts.overviewLimits, undefined);
  assert.ok(frame.charts.refusal, 'every pane says why');
  assert.equal(frame.notes[0], frame.charts.refusal, 'the refusal leads the notes');
  assert.deepEqual(frame.notes.slice(1), ['from the ledger']);
  assert.match(frame.pinLines.get('p0').reason, /more series are pinned/);
  frame.settle();
  assert.equal(overview.sweeps, 1, 'settle frees the overview pool');
  assert.ok(!log.includes('overview.resolve'));
  assert.equal(
    frame.status.split(' · ')[0],
    '8,760 of 8,760 h',
    "nothing drawn counts every real hour of the loaded Case's year",
  );
  ok('a capped render resolves nothing and sweeps the drawn and overview pools');

  // The pins alone fit; the preview is what took the set past the cap.
  const pins = ids.slice(0, -1);
  const withPreview = frameOf({ draws: ids.map(draw), pinnedIds: pins }).frame;
  assert.match(withPreview.pinLines.get('p0').reason, /previewed row/);
  ok('a cap the preview caused says so on each pin');
}

// ------------------------------------------------- the whole year, on demand
{
  const { frame, overview } = frameOf();
  frame.settle();
  assert.deepEqual(overview.resolves, [], 'no pane asked, so nothing resolved');
  assert.equal(overview.sweeps, 1, 'and the overview pool is freed');
  ok('the overview pool is swept when no pane asked for the whole year');
}
{
  const { frame, overview } = frameOf();
  const first = frame.charts.overview();
  assert.equal(frame.charts.overview(), first, 'asked twice, resolved once');
  assert.deepEqual(frame.charts.overviewLimits(), [{ label: 'limit of p1' }]);
  assert.equal(overview.resolves.length, 1, 'its limits reuse the same lines');
  frame.settle();
  assert.equal(overview.sweeps, 0, 'a pane asked, so its lines are kept');
  assert.deepEqual(frame.charts.limits, [{ label: 'limit of p1' }], 'the drawn limits');
  ok('the whole year resolves once, only when a pane asks, and is then kept');
}

// ------------------------------------------------------ boxes, on demand
{
  const { frame, years } = frameOf();
  // The status sentence reads the Case years too, so count from here.
  const unasked = years.length;
  const month = frame.charts.boxes(0);
  assert.ok(month.length > 0 && years.length > unasked, 'a month cut reads the Case year');
  const read = years.length;
  assert.equal(frame.charts.boxes(1), month, 'a second pane on the same dimension reuses it');
  assert.equal(years.length, read);
  assert.notEqual(frame.charts.boxes(3), month, 'another dimension is its own cut');
  ok('boxes are cut only when asked, once per dimension');
}

// ------------------------------------------------- charts and status facts
{
  const { frame } = frameOf({ hasCases: false });
  assert.equal(frame.charts.hasCases, false, 'the charts are told whether any Case is loaded');
  assert.equal(frame.charts.dates, null);
  assert.deepEqual(frame.charts.boxDims, QUERY.boxDims);
  assert.deepEqual(frame.charts.spanOf(frame.series[0]), { firstYear: 2031, numYears: 1 });
  assert.equal(frame.status.split(' ')[0], '100', 'the status counts the hours kept');
  assert.equal(frameOf({ draws: [], pinnedIds: [] }).frame.status.split(' ')[0], '8,760');
  ok('the charts input and status sentence state the render as drawn');
}
{
  // The count is out of real hours, never the slot's 8,784: a non-leap Case
  // reads 8,760, a leap one 8,784, and a frame mixing them the most any has.
  const status = (over) => frameOf(over).frame.status.split(' · ')[0];
  const spanOfCase = (caseId) => ({ firstYear: caseId === 'leap' ? 2032 : 2031, numYears: 1 });
  assert.equal(status({}), '100 of 8,760 h');
  assert.equal(status({ spanOfCase: () => ({ firstYear: 2032, numYears: 1 }) }), '100 of 8,784 h');
  assert.equal(
    status({ spanOfCase: () => ({ firstYear: 2031, numYears: 2 }) }),
    '100 of 17,544 h',
    'a Case spanning 2031-2032 counts both years',
  );
  const full = (caseIds) =>
    source('drawn', [], (draws) =>
      draws.map((one, i) =>
        line(one.ref.id, { caseId: caseIds[i], n: caseIds[i] === 'leap' ? 8784 : 8760 }),
      ),
    );
  assert.equal(
    status({ drawn: full(['c1']), spanOfCase }),
    '8,760 of 8,760 h',
    'an unfiltered non-leap Case shows every hour it has',
  );
  assert.equal(
    status({
      drawn: full(['c1', 'leap']),
      draws: [draw('p1'), draw('p2')],
      pinnedIds: ['p1', 'p2'],
      spanOfCase,
    }),
    '8,784 of 8,784 h',
  );
  assert.equal(
    status({ draws: [], pinnedIds: [], query: { ...QUERY, cases: [] } }),
    '8,760 of 8,760 h',
    'no Case loaded: the non-leap year a yearless series takes',
  );
  ok('the status counts hours out of the real hours of the Cases drawn');
}

// ------------------------------------------------ the browse signature
{
  const tab = (signature, tables = [{}]) => ({
    id: 'bus',
    label: 'Bus',
    scope: { tables, variables: ['Load (MW)'], variable: 'Load (MW)', signature },
    build: () => null,
  });
  const base = {
    lookups: new Map([['generatorlist', {}]]),
    groupingsRev: 0,
    generatorGroupsRev: 0,
    busGroupsRev: 0,
    interfaceGroupsRev: 0,
    limits: { shared: {}, cases: new Map([['c1', {}]]) },
  };
  const signatureOf = (freshness, declared = [tab('s')]) =>
    frameOf({ freshness, declareTabs: () => declared }).frame.browse.signature;
  const was = signatureOf(base);
  assert.equal(signatureOf(base), was, 'the same inputs are the same signature');
  const moved = {
    'a tab scope': signatureOf(base, [tab('t')]),
    // A second list merged under the same variant is a new object.
    'a list merged into': signatureOf({ ...base, lookups: new Map([['generatorlist', {}]]) }),
    'the area groupings': signatureOf({ ...base, groupingsRev: 1 }),
    'the generator groups': signatureOf({ ...base, generatorGroupsRev: 1 }),
    'the bus groups': signatureOf({ ...base, busGroupsRev: 1 }),
    'the interface groups': signatureOf({ ...base, interfaceGroupsRev: 1 }),
    'the shared limits': signatureOf({ ...base, limits: { ...base.limits, shared: {} } }),
    "a Case's limits": signatureOf({
      ...base,
      limits: { ...base.limits, cases: new Map([['c1', {}]]) },
    }),
  };
  for (const [input, signature] of Object.entries(moved)) {
    assert.notEqual(signature, was, `${input} moves the browse signature`);
  }
  const empty = frameOf({ declareTabs: () => [tab('s', [])] }).frame.browse;
  assert.deepEqual(empty.tabs, [], 'a declared tab with nothing loaded is not on the bar');
  assert.equal(empty.variable, '');
  const shown = frameOf({ declareTabs: () => [tab('s')], activeTabId: 'bus' }).frame.browse;
  assert.deepEqual(shown.variables, ['Load (MW)']);
  assert.equal(shown.hourFilter, 'all hours');
  ok(`the browse signature moves with each of its ${Object.keys(moved).length} inputs`);
}

// ------------------------------------------------------------ draw contexts
{
  let filters = FILTERS;
  const source = { caseLabel: () => 'Case' };
  const lines = {};
  const drawn = drawContextOf(source, () => filters, lines);
  const overview = drawContextOf(
    source,
    datesClearedOf(() => filters),
    lines,
  );
  assert.equal(drawn.lines, lines);
  assert.equal(drawn.caseLabel('c1'), 'Case');
  filters = { ...FILTERS, years: new Set([2036]), dates: [{ start: 0, end: 23 }] };
  assert.equal(drawn.filters, filters, 'a context reads the filters at every draw');
  assert.equal(overview.filters.dates, null, 'an overview clears the dates');
  assert.equal(
    overview.filters.years,
    filters.years,
    'and keeps the years: it draws every year the Years filter keeps',
  );
  assert.equal(overview.filters, overview.filters, 'one cleared object per filter state');
  const held = overview.filters;
  filters = { ...filters, hoursOfDay: new Set([1]) };
  assert.notEqual(overview.filters, held, 'and a new one when the filters move');
  assert.deepEqual(overview.filters.hoursOfDay, new Set([1]));
  ok('one factory makes every draw context, reading its filters live');
}

// ------------------------------------------------------ holds no app state
{
  const code = readFileSync(new URL('../src/app/render-frame.ts', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
    .join('\n');
  const imports = [...code.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(
    imports.filter((path) => /store|case-model|main|storage|limits|lookups/.test(path)),
    [],
    'the frame imports no store',
  );
  assert.doesNotMatch(code, /caseStore|listCases|document\.|getElementById/);
  assert.doesNotMatch(code, /^let /m, 'and keeps no module-level state');
  ok('the frame reaches no store and no DOM');
}

console.log(`\n${checks} checks passed.`);
