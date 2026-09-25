// tests/test_browse.mjs — the browse drawer's model, its plane-start
// contract, and every kind's tab built on both. The DOM half is scanned as
// text by test_dom_contract.mjs (there is no jsdom here). The contracts:
//
//   * Stats are computed for scoped rows only (an out-of-scope plane is
//     poisoned and must never reach a column).
//   * Blanks are blanks, and sort last in both directions.
//   * A pin keeps its colour; unpinning never recolours the others.
//   * A click previews, the checkbox pins, and the preview ends when the
//     pinned set changes.
//   * The join never drops the unexpected; units with no hours are dropped
//     from the Generator tab with a counted note.
//   * A filter carries into a group once: as a keep-set over ungrouped rows,
//     restated as context columns, never re-applied to the aggregate.
//   * Numbers render whole (ratios as percent), a text filter matches the
//     rendered text, and the value keeps full precision.
//   * A hidden column leaves the table and the file, and its filter clears.
//   * Column order is one list over hidden and shown columns, reconciled
//     (not reset) when columns change; the CSV follows it.
//   * The CSV is not the paint: full precision, and `#` lines stating only
//     what was applied.
//   * A drag cannot shrink past the bar or cover the charts.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './test_loader.mjs';

const { HOURS_PER_YEAR } = await import('../src/model/calendar.ts');
const { RANKED, RANKED_FIELDS } = await import('../src/kernels.ts');
const { planeStartsFor, rankScopedRows } = await import('../src/ui/browse-planes.ts');
const {
  STAT_COLUMNS,
  browseJoinKey,
  builtView,
  headerSignature,
  carryFilterContext,
  declinedGroupBy,
  restorePins,
  rowIdOf,
  rowSubject,
  pinnedConstraint,
  savePins,
  withRowId,
  cellClassOf,
  createSelection,
  displayCell,
  filterConstraint,
  filteringColumnLabels,
  keptRowKeys,
  moveColumnTo,
  orderedColumns,
  setColumnVisible,
  clearFilters,
  dropRescaledBounds,
  setGroupBy,
  viewChips,
  statColumns,
  statColumnsFrom,
  visibleColumns,
  visibleRows,
} = await import('../src/ui/browse-model.ts');
const { buildGeneratorTab } = await import('../src/tables/generator/ui/browse.ts');
const { browseDescriptor, browseTableCsv } = await import('../src/ui/browse-csv.ts');
const { filtersLabel } = await import('../src/app/browse-scope.ts');
const { buildBusTab } = await import('../src/tables/bus/ui/browse.ts');
const { buildAreaTab } = await import('../src/tables/area/ui/browse.ts');
const { areaAnswers } = await import('../src/tables/area/ui/retarget.ts');
/** A kind's answers over `rows`, as main.ts assembles them. */
const retargetOf = (answers, rows, combines) => ({ ...answers, rows, combines });
const areaRetarget = (rows, combines) => retargetOf(areaAnswers, rows, combines);
const { retargetVariable, variableSwitch, targetOf, percentSwitch, retargetPercent } =
  await import('../src/ui/browse-retarget.ts');
const { buildInterfaceTab } = await import('../src/tables/interface/ui/browse.ts');
const { RATIO_METRICS, combinesAcrossAreas } = await import('../src/tables/area/rules.ts');
const { buildLookup, parseLookupCsv } = await import('../src/lookups/parse.ts');
const { attachLookup, clearLookups } = await import('../src/lookups/store.ts');
const { resolveGeneratorSeries } = await import('../src/tables/generator/series.ts');
const { resolveAreaSeries } = await import('../src/tables/area/series.ts');
const { CASE_GROUP_BY, createSeriesBuffers, specFromRow } = await import('../src/series/model.ts');
const { setGroupings } = await import('../src/lookups/groupings.ts');
const {
  BAR_HEIGHT_PX,
  PANE_HEADER_PX,
  SNAP_PX,
  DETENT_SHARE,
  clampHeight,
  nearestDetent,
  settleHeight,
} = await import('../src/ui/drawer-height.ts');

/** The Case labels a drawer export resolves rows' Case ids through. */
const CASE_LABELS = (caseId) => ({ c1: 'Case 1', c2: 'Case 2' })[caseId] ?? caseId;

const HOURS = HOURS_PER_YEAR;
let checks = 0;
function ok(label) {
  checks++;
  console.log(`ok - ${label}`);
}

const allHours = () => new Uint8Array(HOURS).fill(1);

// -------------------------------------------------------- plane starts

{
  const presence = Uint8Array.from([1, 0, 1, 1]);
  const starts = planeStartsFor([2, 1, 0], presence, (index) => index * HOURS);
  assert.deepEqual([...starts], [2 * HOURS, -1, 0]);
  ok('plane starts follow the SCOPE order, not the axis order');
  assert.equal(starts[1], -1, 'presence 0 is -1');
  ok('a row the case does not carry is -1, which the kernel reads as blank');

  const missing = planeStartsFor([-1], presence, (index) => index * HOURS);
  assert.equal(missing[0], -1);
  ok('a row that is not on this table’s axis at all is -1 too');

  const reused = new Int32Array(3);
  assert.equal(
    planeStartsFor([0, 1, 2], presence, (i) => i * HOURS, reused),
    reused,
  );
  ok('a caller’s buffer of the right length is written in place');
  const wrongSize = new Int32Array(2);
  assert.notEqual(
    planeStartsFor([0, 1, 2], presence, (i) => i * HOURS, wrongSize),
    wrongSize,
  );
  ok('a buffer of the wrong length is replaced, never partly overwritten');
}

// ------------------------------------------------------------ the model

/** A tab of plain rows, for the sort and filter tests. `cells` is one array
 * per row, in column order. */
function fakeTab(columns, cells) {
  return {
    id: 'fake',
    label: 'Fake',
    rows: cells.map((_, index) => ({
      id: `row${index}`,
      kind: 'generator',
      caseId: 'c1',
      slotKey: 'generator Generation (MWh)',
      entity: `row${index}`,
      variable: 'Generation (MWh)',
      unit: 'MWh',
      axisIndex: index,
    })),
    columns: columns.map((column, at) => ({
      ...column,
      computed: column.computed ?? false,
      value: (row) => cells[row][at],
    })),
    notes: [],
  };
}

const NO_VIEW = { sort: null, filters: new Map() };
// The stats files the golden check below writes, byte for byte, from the
// invented generators there.
const GOLDEN_STATS_CSV = [
  '# Cases: Case 1',
  '# Variable: Generation (MWh)',
  '# Hours: Jan; HE 1-6',
  '',
  'Case,Generator,Fuel Type (Cleaned),Area Name,PSSEMaxCap(MW),FuelType,Min,Max,Average,StdDev,p25,p75,Cap factor (%)',
  'Case 1,ALDER,Coal,AREA_AE,200,Coal,10,10,10,0,10,10,0.05',
  'Case 1,BIRCH,Coal,AREA_NV,120,Coal,20,20,20,0,20,20,0.16666666666666666',
  'Case 1,CEDAR,Natural Gas,AREA_AE,80,Gas,30,30,30,0,30,30,0.375',
  '',
  '=====',
  '# Cases: Case 1',
  '# Variable: Generation (MWh)',
  '# Hours: Jan; HE 1-6',
  '# Column filters: Area Name: contains AREA_AE',
  '',
  'Case,Generator,Fuel Type (Cleaned),Area Name,PSSEMaxCap(MW),FuelType,Min,Max,Average,StdDev,p25,p75,Cap factor (%)',
  'Case 1,CEDAR,Natural Gas,AREA_AE,80,Gas,30,30,30,0,30,30,0.375',
  'Case 1,ALDER,Coal,AREA_AE,200,Coal,10,10,10,0,10,10,0.05',
  '',
  '=====',
  '# Cases: Case 1',
  '# Variable: Generation (MWh)',
  '# Hours: Jan; HE 1-6',
  '# Column filters: Area Name: contains AREA_AE',
  '# Grouped by: FuelType',
  '',
  'Case,FuelType,Units,Min,Max,Average,StdDev,p25,p75,Area Name (filter)',
  'Case 1,Coal,1,10,10,10,0,10,10,contains AREA_AE',
  'Case 1,Gas,1,30,30,30,0,30,30,contains AREA_AE',
  '',
  '=====',
  '# Cases: Case 1',
  '# Variable: Generation (MWh)',
  '# Hours: Jan; HE 1-6',
  '# % of range: values are ratios of range (0.42 = 42%); every series of its limit (summed, for a group), else of its own peak',
  '',
  'Case,Generator,Fuel Type (Cleaned),Area Name,PSSEMaxCap(MW),FuelType,Min (%),Max (%),Average (%),StdDev (%),p25 (%),p75 (%),Cap factor (%)',
  'Case 1,ALDER,Coal,AREA_AE,200,Coal,0.05000000074505806,0.05000000074505806,0.05000000074505806,0,0.05000000074505806,0.05000000074505806,0.0002500000037252903',
  'Case 1,BIRCH,Coal,AREA_NV,120,Coal,0.1666666716337204,0.1666666716337204,0.1666666716337204,0,0.1666666716337204,0.1666666716337204,0.0013888889302810033',
  'Case 1,CEDAR,Natural Gas,AREA_AE,80,Gas,0.375,0.375,0.375,0,0.375,0.375,0.0046875',
  '',
  '=====',
  '# Cases: Case 1',
  '# Variable: Generation (MWh)',
  '# Hours: Jan; HE 1-6',
  '# % of range: values are ratios of range (0.42 = 42%); 2 of 3 series of their limit (summed, for a group), else of their own peak',
  '',
  'Case,Generator,Fuel Type (Cleaned),Area Name,PSSEMaxCap(MW),FuelType,Min,Max,Average,StdDev,p25,p75,Cap factor (%)',
  'Case 1,ALDER,Coal,AREA_AE,200,Coal,10,10,10,0,10,10,0.05',
  'Case 1,BIRCH,Coal,AREA_NV,120,Coal,20,20,20,0,20,20,0.16666666666666666',
  'Case 1,CEDAR,Natural Gas,AREA_AE,80,Gas,30,30,30,0,30,30,0.375',
  '',
].join('\n');

{
  const tab = fakeTab(
    [
      { key: 'name', label: 'Name', kind: 'text' },
      { key: 'max', label: 'Max', kind: 'number', computed: true },
    ],
    [
      ['ALDER', 30],
      ['BIRCH', 10],
      ['CEDAR', null],
      ['DOGWOOD', 30],
    ],
  );

  const desc = [...visibleRows(tab, { ...NO_VIEW, sort: { key: 'max', direction: 'desc' } })];
  assert.deepEqual(desc, [0, 3, 1, 2]);
  ok('descending by a stat column ranks the biggest first, blanks last');

  const asc = [...visibleRows(tab, { ...NO_VIEW, sort: { key: 'max', direction: 'asc' } })];
  assert.deepEqual(asc, [1, 0, 3, 2]);
  ok('ascending puts blanks LAST too — a blank row is not a small one');
  assert.deepEqual([desc[0], desc[1]], [0, 3]);
  ok('equal rows keep axis order in both directions, so a re-sort never reshuffles them');

  const contains = new Map([['name', { kind: 'text', text: 'Wood' }]]);
  assert.deepEqual([...visibleRows(tab, { ...NO_VIEW, filters: contains })], [3]);
  ok('a text filter is a case-insensitive substring over the cell as displayed');

  const range = new Map([['max', { kind: 'range', min: 20, max: null }]]);
  assert.deepEqual([...visibleRows(tab, { ...NO_VIEW, filters: range })], [0, 3]);
  ok('a numeric filter is two bounds on one column, and a blank cell fails them');

  const both = new Map([
    ['name', { kind: 'text', text: 'a' }],
    ['max', { kind: 'range', min: null, max: 20 }],
  ]);
  assert.deepEqual([...visibleRows(tab, { ...NO_VIEW, filters: both })], []);
  ok('two column filters are an AND — multi-attribute filtering with no query language');

  const stale = new Map([['gone', { kind: 'text', text: 'x' }]]);
  assert.equal(visibleRows(tab, { ...NO_VIEW, filters: stale }).length, 4);
  ok(
    'a filter on a column the SOURCE never emitted is ignored — not applied to nothing, so a re-scope cannot empty the table',
  );
}

{
  // "% of range": a bound is typed in the units shown, and a bound typed in
  // the other units is dropped when the toggle rescales its column.
  const tab = fakeTab(
    [
      { key: 'name', label: 'Name', kind: 'text' },
      { key: 'stat.max', label: 'Max (%)', kind: 'number', computed: true, cellClass: 'ratio' },
    ],
    [
      ['ALDER', 0.95],
      ['BIRCH', 0.5],
    ],
  );
  const atLeast80 = new Map([['stat.max', { kind: 'range', min: 80, max: null }]]);
  assert.deepEqual([...visibleRows(tab, { ...NO_VIEW, filters: atLeast80 })], [0]);
  ok('a bound on a ratio column is in percent, as the cell reads');

  const view = {
    ...NO_VIEW,
    filters: new Map([
      ['stat.max', { kind: 'range', min: 500, max: null }],
      ['stat.n', { kind: 'range', min: 10, max: null }],
      ['name', { kind: 'text', text: 'a' }],
      ['cap', { kind: 'range', min: 100, max: null }],
    ]),
  };
  assert.deepEqual([...dropRescaledBounds(view).filters.keys()], ['stat.n', 'name', 'cap']);
  const untouched = { ...NO_VIEW, filters: new Map([['name', { kind: 'text', text: 'a' }]]) };
  assert.equal(dropRescaledBounds(untouched), untouched, 'nothing dropped, same view');
  ok(
    'the toggle drops bounds on rescaled stat columns and keeps the hours count, text and other columns',
  );
}

{
  // The filter matches the rendered text (separators included), never the
  // raw double. Asserted on a number column, which the model supports.
  const big = fakeTab(
    [{ key: 'mwh', label: 'MWh', kind: 'number', computed: true }],
    [[1234567.4], [42]],
  );
  const grouped = new Map([['mwh', { kind: 'text', text: '1,234' }]]);
  assert.deepEqual([...visibleRows(big, { ...NO_VIEW, filters: grouped })], [0]);
  const fraction = new Map([['mwh', { kind: 'text', text: '567.4' }]]);
  assert.deepEqual([...visibleRows(big, { ...NO_VIEW, filters: fraction })], []);
  ok('a text filter matches the ROUNDED text: grouping separators included, raw doubles never');
}

{
  assert.equal(displayCell(null), '');
  assert.equal(displayCell(Number.NaN), '');
  assert.equal(displayCell(0), '0');
  assert.equal(displayCell(1234.4), '1,234');
  assert.equal(displayCell(1200000), '1,200,000');
  assert.equal(displayCell(0.5), '1');
  assert.equal(displayCell(0.4), '<1');
  assert.equal(displayCell(0.0004), '<1');
  assert.equal(displayCell(-0.4), '>-1');
  ok('a blank cell renders empty, and a NaN one renders empty rather than "NaN"');
  ok('a quantity renders whole with separators — 1.2 GWh reads 1,200,000, not 1.20e+6');
  ok('a non-zero quantity that rounds to zero says <1 (or >-1), never 0');
  assert.equal(displayCell(0.4312, 'ratio'), '43%');
  assert.equal(displayCell(1.2, 'ratio'), '120%');
  assert.equal(displayCell(0.004, 'ratio'), '<1%');
  assert.equal(displayCell(-0.004, 'ratio'), '>-1%');
  ok('a ratio renders whole percent, with the same honesty at the bottom of its range');
  assert.equal(displayCell(8760, 'count'), '8760');
  assert.equal(displayCell(10001, 'count'), '10001');
  ok('a count is a bare whole number — an id that grew a separator would be a different id');
}

// -------------------------------------------------------- the selection

{
  const palette = ['red', 'green', 'blue'];
  const selection = createSelection(palette);
  const ref = (id) => ({
    id,
    kind: 'generator',
    caseId: 'c1',
    slotKey: 'slot',
    entity: id,
    variable: 'Generation (MWh)',
    unit: 'MWh',
    axisIndex: 0,
  });

  selection.pin(ref('a'));
  selection.pin(ref('b'));
  selection.pin(ref('c'));
  assert.deepEqual(
    selection.list().map((entry) => entry.color),
    ['red', 'green', 'blue'],
  );
  ok('colours are taken from the palette in order as rows are pinned');

  selection.unpin('b');
  assert.deepEqual(
    selection.list().map((entry) => entry.color),
    ['red', 'blue'],
  );
  ok('deselecting one series does NOT recolour the others');

  selection.pin(ref('d'));
  assert.equal(selection.colorOf('d'), 'green');
  assert.equal(selection.colorOf('c'), 'blue');
  ok('the freed colour is reused by the next pin, and the survivors keep theirs');

  selection.preview(ref('e'));
  assert.equal(selection.previewed().id, 'e');
  assert.equal(selection.isPinned('e'), false);
  selection.preview(ref('f'));
  assert.equal(selection.previewed().id, 'f');
  ok('a click previews one row at a time, replaced by the next click');

  selection.preview(ref('a'));
  assert.equal(selection.previewed(), null);
  ok('previewing an already pinned row clears the preview instead of drawing it twice');

  selection.pin(ref('g'));
  selection.preview(ref('g'));
  assert.equal(selection.previewed(), null);
  selection.toggle(ref('g'));
  assert.equal(selection.isPinned('g'), false);
  ok('the checkbox pins and unpins the same row');

  // A change to the pinned set ends the preview: an invisible preview left
  // in the drawn set would keep a pane refusing over a series no control can
  // remove.
  selection.preview(ref('h'));
  selection.toggle(ref('i'));
  assert.equal(selection.previewed(), null, 'a tick drops the preview');
  selection.preview(ref('h'));
  selection.toggle(ref('i'));
  assert.equal(selection.isPinned('i'), false);
  assert.equal(selection.previewed(), null, 'an UNtick drops it too');
  selection.preview(ref('h'));
  selection.unpin('nothing-is-pinned-under-this-id');
  assert.equal(selection.previewed()?.id, 'h', 'an unpin that removed nothing changes nothing');
  ok('unticking everything leaves nothing drawn: the preview does not outlive the pins');

  selection.restore([
    { ref: ref('restored-1'), color: 'blue' },
    { ref: ref('restored-2'), color: 'red' },
  ]);
  assert.equal(selection.isPinned('restored-1'), true);
  assert.equal(selection.colorOf('restored-1'), 'blue');
  assert.equal(selection.colorOf('restored-2'), 'red');
  assert.equal(selection.isPinned('a'), false);
  assert.equal(selection.list().length, 2);
  ok('restore populates the SelectionStore with pinned rows and their held colors');
}

// ------------------------------------------------------- the Generator tab

const GEN_COLUMNS = ['Name', 'Bus ID', 'Area Name', 'FuelType', 'PSSEMaxCap(MW)'];
function generatorList(rows) {
  return [
    `GENERATORLIST${','.repeat(GEN_COLUMNS.length - 1)}`,
    GEN_COLUMNS.join(','),
    ...rows,
  ].join('\n');
}
const listOf = (rows) => buildLookup(parseLookupCsv(generatorList(rows), 'GeneratorList.csv').rows);

/** A GeneratorTable whose plane for generator `i` is filled by `fill(i)`.
 * `absent` names generators whose presence byte is 0. */
function generatorTable(generators, fill, absent = []) {
  const cube = new Float32Array(generators.length * HOURS);
  const presence = new Uint8Array(generators.length).fill(1);
  generators.forEach((name, index) => {
    const gone = absent.includes(name);
    if (gone) presence[index] = 0;
    for (let hour = 0; hour < HOURS; hour++) {
      cube[index * HOURS + hour] = gone ? Number.NaN : fill(index, hour);
    }
  });
  return {
    cube,
    generators: [...generators],
    presence,
    tou: new Uint8Array(HOURS),
    sourceColumns: [...generators],
    year: 2031,
    quantity: 'Generation (MWh)',
  };
}

const table = (data) => ({
  caseId: 'c1',
  caseName: 'Case 1',
  caseLabel: 'Case 1',
  slotKey: 'generator Generation (MWh)',
  data,
  mask: allHours(),
});

{
  const list = listOf([
    'ALDER,101,AREA_AV,Gas,200',
    'BIRCH,102,AREA_NV,Wind,100',
    'CEDAR,103,AREA_AV,Solar,0',
  ]);
  // DOGWOOD is in the export and in no list; CEDAR is in the list and carries
  // no data in this case.
  const data = generatorTable(['ALDER', 'BIRCH', 'DOGWOOD'], (index) => (index + 1) * 10);
  const tab = buildGeneratorTab({ tables: [table(data)], list, areas: null });

  const names = tab.rows.map((row) => row.entity);
  assert.deepEqual(names, ['ALDER', 'BIRCH', 'DOGWOOD']);
  ok('the rows are the LIST, in list order, with the export-only unit after them');

  const column = (key) => tab.columns.find((entry) => entry.key === key);
  assert.equal(column('list.FuelType').value(0), 'Gas');
  assert.equal(column('list.FuelType').value(2), null);
  ok('an export-only unit is listed with empty attributes, never dropped');

  assert.ok(!names.includes('CEDAR'));
  assert.ok(
    tab.notes.some((note) => note.startsWith('1 unit hidden')),
    `the hidden unit is counted in a note: ${tab.notes}`,
  );
  ok('a list row this export never carried is dropped, and counted in a note');

  assert.equal(column('stat.mean').value(0), 10);
  assert.equal(column('stat.mean').value(2), 30);
  ok('the stat columns agree with the planes they ranked');

  assert.equal(column('stat.cf').value(0), 10 / 200);
  ok('capacity factor is the mean over the kept hours against the nameplate');
  assert.equal(column('stat.cf').value(2), null);
  ok('an unlisted unit has no nameplate, so its capacity factor is blank');
  assert.equal(column('stat.cf').label, 'Cap factor (%)');
  assert.equal(column('stat.cf').cellClass, 'ratio');
  assert.equal(column('stat.n').cellClass, 'count');
  assert.equal(column('list.Bus ID').cellClass, 'count');
  assert.equal(column('stat.mean').cellClass, 'quantity');
  ok(
    'cap factor is a percent and says so in its label; ids and counts render bare; stats default to quantity',
  );

  assert.ok(tab.columns.filter((entry) => entry.computed).length >= STAT_COLUMNS.length);
  assert.equal(column('case').computed, false);
  assert.equal(column('stat.max').computed, true);
  ok('every computed column is marked as computed and every stored one is not');

  for (const stat of STAT_COLUMNS) {
    assert.ok(column(stat.key), `the tab carries ${stat.key}`);
  }
  ok('the tab spells its stat columns with the shared keys the Selected tab reads');

  assert.equal(column('list.Name'), undefined);
  ok('the key column is not repeated under its file spelling beside Generator');
}

{
  // Presence 0: carried by the axis, no data in this case.
  const data = generatorTable(['ALDER', 'BIRCH'], () => 5, ['BIRCH']);
  const tab = buildGeneratorTab({ tables: [table(data)], list: undefined, areas: null });
  assert.deepEqual(
    tab.rows.map((row) => row.entity),
    ['ALDER'],
  );
  ok('a NaN-filled plane is no row at all, rather than a row of blanks');
  assert.deepEqual(tab.notes, [
    'No GeneratorList loaded: names come from the export, and attribute columns are empty.',
    '1 unit hidden: no hours loaded for it in the selected case.',
  ]);
  ok('with no list loaded the tab says so, and says how many units it hid');
}

{
  // The refusal: a generator's area is a GeneratorList column,
  // so without the list that scope is a join with nothing to join to.
  const data = generatorTable(['ALDER'], () => 1);
  const tab = buildGeneratorTab({
    tables: [table(data)],
    list: undefined,
    areas: new Set(['AREA_AV']),
  });
  assert.ok(
    tab.notes.some((note) => note.includes('Area scope needs GENERATORLIST')),
    tab.notes.join(' '),
  );
  assert.equal(tab.rows.length, 1);
  ok('an area scope with no list to join says so, and shows everything rather than nothing');
}

{
  // Stats for scoped rows only, proved twice: the ranked pass is exactly as
  // long as the scope, and the excluded planes are poison.
  const POISON = 1e9;
  const list = listOf([
    'ALDER,101,AREA_AV,Gas,200',
    'BIRCH,102,AREA_NV,Wind,100',
    'CEDAR,103,AREA_NV,Solar,100',
  ]);
  const data = generatorTable(['ALDER', 'BIRCH', 'CEDAR'], (index) => (index === 0 ? 7 : POISON));
  const tab = buildGeneratorTab({
    tables: [table(data)],
    list,
    areas: new Set(['AREA_AV']),
  });

  assert.deepEqual(
    tab.rows.map((row) => row.entity),
    ['ALDER'],
  );
  ok('the area scope narrows the listing to its own rows');

  const column = (key) => tab.columns.find((entry) => entry.key === key);
  assert.equal(column('stat.max').value(0), 7);
  ok('the scoped row is ranked');
  // BIRCH and CEDAR are outside the area scope, so they arrive as export-only
  // rows with no list attributes -- and their planes are never read.
  const maxima = tab.rows.map((_, row) => column('stat.max').value(row));
  assert.ok(!maxima.includes(POISON), `no column reflects an unscoped plane: ${maxima}`);
  ok('a plane the scope excluded never reaches a stat column');

  // A unit the area scope excluded is still IN the list, so it must not come
  // back as an export-only row: an area scope that reported unjoinable
  // generators would be reporting its own filtering as a join failure.
  const withStranger = buildGeneratorTab({
    tables: [table(generatorTable(['ALDER', 'BIRCH', 'DOGWOOD'], () => 3))],
    list,
    areas: new Set(['AREA_AV']),
  });
  assert.deepEqual(
    withStranger.rows.map((row) => row.entity),
    ['ALDER', 'DOGWOOD'],
  );
  ok('an out-of-scope list unit stays out, while a unit the list never mentioned stays listed');

  const tight = buildGeneratorTab({
    tables: [table(generatorTable(['ALDER'], () => 7))],
    list,
    areas: new Set(['AREA_AV']),
  });
  assert.equal(tight.rows.length, 1);
  ok('one scoped row is one ranked row: the kernel touches exactly the scope');
}

{
  // Two cases of one quantity: the Case column is what makes case-vs-case
  // free, and a row id carries the case so the same generator in two cases is
  // two pins.
  const list = listOf(['ALDER,101,AREA_AV,Gas,200']);
  const first = table(generatorTable(['ALDER'], () => 1));
  const second = {
    ...table(generatorTable(['ALDER'], () => 2)),
    caseId: 'c2',
    caseName: 'Case 2',
    caseLabel: 'Case 2',
  };
  const tab = buildGeneratorTab({ tables: [first, second], list, areas: null });
  assert.equal(tab.rows.length, 2);
  assert.notEqual(tab.rows[0].id, tab.rows[1].id);
  const column = (key) => tab.columns.find((entry) => entry.key === key);
  assert.deepEqual([column('case').value(0), column('case').value(1)], ['Case 1', 'Case 2']);
  assert.deepEqual([column('stat.mean').value(0), column('stat.mean').value(1)], [1, 2]);
  ok('two cases are two rows with the Case column at the far left, ranked apart');
}

{
  // The masked pass is the Hours block: a stat column is over the hours the
  // scope kept and no others.
  const half = allHours();
  for (let hour = 0; hour < HOURS; hour++) if (hour % 2 === 1) half[hour] = 0;
  const data = generatorTable(['ALDER'], (_, hour) => (hour % 2 === 0 ? 4 : 100));
  const tab = buildGeneratorTab({
    tables: [{ ...table(data), mask: half }],
    list: undefined,
    areas: null,
  });
  const column = (key) => tab.columns.find((entry) => entry.key === key);
  assert.equal(column('stat.max').value(0), 4);
  assert.equal(column('stat.n').value(0), HOURS / 2);
  ok('the stat columns are over the hours the filters keep, and only those');
}

{
  // The kernel's slot layout is what the tab reads; a reordered RANKED would
  // silently relabel every column.
  assert.equal(RANKED_FIELDS, 8);
  assert.deepEqual(
    STAT_COLUMNS.map((stat) => stat.key),
    ['stat.min', 'stat.max', 'stat.mean', 'stat.sd', 'stat.p25', 'stat.p75', 'stat.n'],
  );
  assert.ok(RANKED.mean !== RANKED.min, 'the ranked slots are distinct');
  ok('the fixed stat column set is the expected one');
}

{
  // Per-unit browse tab
  const list = listOf([
    'ALDER,101,AREA_AV,Gas,200',
    'BIRCH,102,AREA_NV,Wind,100',
    'CEDAR,103,AREA_AV,Solar,0',
  ]);
  const data = generatorTable(['ALDER', 'BIRCH', 'DOGWOOD'], (index) => (index + 1) * 10);
  const tab = buildGeneratorTab({ tables: [table(data)], list, areas: null, perUnit: true });
  const column = (key) => tab.columns.find((entry) => entry.key === key);

  // The rows are percents; the saved field and the row-id token keep their names.
  assert.equal(tab.rows[0].unit, '%');
  assert.equal(tab.rows[0].perUnit, true);
  assert.ok(tab.rows[0].id.includes('p.u.'));

  // ALDER: mean 10, cap 200 -> 10 / 200 = 0.05
  assert.ok(Math.abs(column('stat.mean').value(0) - 0.05) < 1e-6);
  // The hours count is a count, never divided.
  assert.equal(column('stat.n').value(0), HOURS);
  assert.equal(column('stat.mean').cellClass, 'ratio');
  assert.equal(column('stat.mean').label, 'Average (%)');
  ok('% of range stats are ratios: whole percent, and the label says (%)');

  // DOGWOOD is unlisted: its own peak (30) is its divisor, and no note says
  // so, because the drawn line's label does.
  const dogwood = tab.rows.findIndex((row) => row.entity === 'DOGWOOD');
  assert.equal(column('stat.max').value(dogwood), 1);
  assert.ok(!tab.notes.some((note) => note.includes('own peak')), tab.notes.join(' | '));
  ok('an unlisted unit divides by its own peak, with no per-tab fallback note');
}

{
  // The divisor is the peak over every hour, not the hours the filter keeps:
  // the peak (80) is in hour 0, which the mask drops.
  const data = generatorTable(['DOGWOOD'], (_index, hour) => (hour === 0 ? 80 : 40));
  const mask = allHours();
  mask[0] = 0;
  const build = (groupBy) =>
    buildGeneratorTab({
      tables: [{ ...table(data), mask }],
      list: null,
      areas: null,
      perUnit: true,
      ...(groupBy ? { groupBy } : {}),
    });
  const max = (tab) => tab.columns.find((entry) => entry.key === 'stat.max').value(0);
  assert.equal(max(build()), 0.5, 'an ungrouped row: 40 over the unfiltered 80');
  assert.equal(max(build('case')), 0.5, 'a grouped row, the same');
  ok('a % of range stat divides by the unfiltered peak, grouped or not');
}

{
  // Bipolar and pure negative per-unit generators in browse tab
  const genCols = ['Name', 'Bus ID', 'Area Name', 'FuelType', 'PSSEMaxCap(MW)', 'PSSEMinCap(MW)'];
  const list = buildLookup(
    parseLookupCsv(
      [
        `GENERATORLIST${','.repeat(genCols.length - 1)}`,
        genCols.join(','),
        'BATTERY,101,AREA_AV,Storage,100,-50',
        'PUMP,102,AREA_AV,Hydro,0,-80',
      ].join('\n'),
      'GeneratorList.csv',
    ).rows,
  );
  // BATTERY: +50 half the time, -50 half the time
  // PUMP: -40 all the time
  const data = generatorTable(['BATTERY', 'PUMP'], (index, hour) => {
    if (index === 0) return hour % 2 === 0 ? 50 : -50;
    return -40;
  });
  const tab = buildGeneratorTab({ tables: [table(data)], list, areas: null, perUnit: true });
  const column = (key) => tab.columns.find((entry) => entry.key === key);

  // BATTERY: max +50 / 100 = 0.5; min -50 / -50 = -1.0; mean 0.5 * 0.5 + 0.5 * (-1.0) = -0.25
  assert.equal(column('stat.max').value(0), 0.5);
  assert.equal(column('stat.min').value(0), -1.0);
  assert.equal(column('stat.mean').value(0), -0.25);

  // PUMP: min -40, max -40, cap -80 -> -40 / |-80| = -0.5
  assert.equal(column('stat.max').value(1), -0.5);
  assert.equal(column('stat.min').value(1), -0.5);
  assert.equal(column('stat.mean').value(1), -0.5);

  ok(
    'generator browse tab computes mathematically exact stats for bipolar and negative per-unit units',
  );
}

// ------------------------------------------------------------- the Bus tab
//
// Only what is Bus's own: its axis is an ID, not a name.

const BUS_COLUMNS = ['BusID', 'Name', 'BaseKV', 'LoadArea'];
const busListOf = (rows) =>
  buildLookup(
    parseLookupCsv(
      [`BUS_GENERAL${','.repeat(BUS_COLUMNS.length - 1)}`, BUS_COLUMNS.join(','), ...rows].join(
        '\n',
      ),
      'BusList.csv',
    ).rows,
  );

/** A BusTable whose plane for bus `i` is filled by `fill(i, hour)`. `absent`
 * names bus IDS whose presence byte is 0. */
function busTable(buses, names, fill, absent = []) {
  const cube = new Float32Array(buses.length * HOURS);
  const presence = new Uint8Array(buses.length).fill(1);
  buses.forEach((id, index) => {
    const gone = absent.includes(id);
    if (gone) presence[index] = 0;
    for (let hour = 0; hour < HOURS; hour++) {
      cube[index * HOURS + hour] = gone ? Number.NaN : fill(index, hour);
    }
  });
  return {
    cube,
    buses: Int32Array.from(buses),
    names: [...names],
    presence,
    tou: new Uint8Array(HOURS),
    sourceColumns: [...buses],
    year: 2031,
    quantity: 'LMP ($/MWh)',
  };
}

const busTableIn = (data) => ({
  caseId: 'c1',
  caseName: 'Case 1',
  caseLabel: 'Case 1',
  slotKey: 'bus LMP ($/MWh)',
  data,
  mask: allHours(),
});

{
  // The power-flow and map fields, and the hours count, start hidden; every
  // other list column (a zone, an area) opens with the tab.
  const cols = ['BusID', 'Name', 'BaseKV', 'Type', 'VM', 'VA', 'Latitude', 'Longitude', 'LoadArea'];
  const list = buildLookup(
    parseLookupCsv(
      [
        `BUS_GENERAL${','.repeat(cols.length - 1)}`,
        cols.join(','),
        '10001,WILLOWBEND,345,1,1.01,-3.2,36.1,-119.2,AREA_AV',
      ].join('\n'),
      'BusList.csv',
    ).rows,
  );
  const data = busTable([10001], ['WILLOWBEND'], () => 10);
  const tab = buildBusTab({ tables: [busTableIn(data)], list, areas: null });
  const hidden = tab.columns.filter((column) => column.defaultHidden).map((column) => column.key);
  assert.deepEqual(hidden, [
    'list.Type',
    'list.VM',
    'list.VA',
    'list.Latitude',
    'list.Longitude',
    'stat.n',
  ]);
  const grouped = buildBusTab({
    tables: [busTableIn(data)],
    list,
    areas: null,
    groupBy: 'LoadArea',
  });
  assert.equal(grouped.columns.find((column) => column.key === 'stat.n').defaultHidden, true);
  ok('the Bus tab opens without Type, VM, VA, Latitude, Longitude and Hours');
}

{
  const list = busListOf([
    '10001,WILLOWBEND,345,AREA_AV',
    '10002,WILLOWBEND,115,AREA_NV',
    '10003,ALDER,230,AREA_AV',
  ]);
  // 10004 is in the export and in no list; 10003 is in the list and is not on
  // this export's axis at all.
  const data = busTable(
    [10001, 10002, 10004],
    ['WILLOWBEND', 'WILLOWBEND', 'POPLARVIEW'],
    (index) => (index + 1) * 10,
  );
  const tab = buildBusTab({ tables: [busTableIn(data)], list, areas: null });
  const column = (key) => tab.columns.find((entry) => entry.key === key);

  assert.deepEqual(
    tab.rows.map((row) => row.entity),
    [10001, 10002, 10004],
  );
  ok('a bus row’s entity is the NUMBER, so no identity round-trips through text');
  assert.deepEqual(
    tab.rows.map((row) => typeof row.entity),
    ['number', 'number', 'number'],
  );
  ok('the rows are the loaded buses in list order, with the export-only bus after them');

  // The whole reason the id is the identity: two different buses may carry
  // one name, and both are listed, ranked and pinnable apart.
  assert.deepEqual(
    [tab.rows[0].label, tab.rows[1].label],
    ['WILLOWBEND (10001)', 'WILLOWBEND (10002)'],
  );
  assert.notEqual(tab.rows[0].id, tab.rows[1].id);
  assert.notEqual(column('stat.mean').value(0), column('stat.mean').value(1));
  ok('two buses sharing a name are two rows, two ids and two different series');

  assert.equal(column('busid').value(1), 10002);
  assert.equal(column('busid').computed, false);
  assert.equal(column('busid').cellClass, 'count');
  ok(
    'the id is its own numeric column: the axis the export carried, not a computed one, and it renders bare',
  );

  assert.equal(column('list.BaseKV').value(0), 345);
  assert.equal(column('list.BaseKV').value(2), null);
  ok('an export-only bus is listed with empty attributes, never dropped');

  assert.ok(!tab.rows.some((row) => row.entity === 10003));
  ok('a list bus this export never carried is not a row: the list only describes loaded buses');

  const gapped = buildBusTab({
    tables: [busTableIn(busTable([10001, 10002], ['WILLOWBEND', 'WILLOWBEND'], () => 1, [10002]))],
    list,
    areas: null,
  });
  assert.deepEqual(
    gapped.rows.map((row) => row.entity),
    [10001],
  );
  assert.ok(
    gapped.notes.includes('1 bus hidden: no hours loaded for it in the selected case.'),
    gapped.notes.join(' '),
  );
  ok('a bus on the axis with no hours is dropped and counted in a note');

  assert.equal(column('list.Name'), undefined);
  assert.equal(column('list.BusID'), undefined);
  ok('neither the key column nor the name is repeated beside the Bus label');

  assert.equal(column('stat.cf'), undefined);
  ok('there is no capacity-factor column: a bus has no nameplate');

  for (const stat of STAT_COLUMNS) assert.ok(column(stat.key), `the tab carries ${stat.key}`);
  ok('the Bus tab spells its stat columns with the shared keys the Selected tab reads');
}

{
  // The area scope is a lookup join here too, through the `LoadArea` column --
  // the load/price area a bus settles in, not the power-flow model's
  // `PSSEArea`.
  const list = busListOf(['10001,WILLOWBEND,345,AREA_AV', '10002,POPLARVIEW,115,AREA_NV']);
  const POISON = 1e9;
  const data = busTable([10001, 10002], ['WILLOWBEND', 'POPLARVIEW'], (index) =>
    index === 0 ? 7 : POISON,
  );
  const scoped = buildBusTab({
    tables: [busTableIn(data)],
    list,
    areas: new Set(['AREA_AV']),
  });
  assert.deepEqual(
    scoped.rows.map((row) => row.entity),
    [10001],
  );
  ok('the area scope narrows the bus listing to its own rows');
  const maxima = scoped.rows.map((_, row) =>
    scoped.columns.find((entry) => entry.key === 'stat.max').value(row),
  );
  assert.ok(!maxima.includes(POISON), `no column reflects an unscoped plane: ${maxima}`);
  ok('a bus plane the scope excluded never reaches a stat column');

  const unjoinable = buildBusTab({
    tables: [busTableIn(data)],
    list: undefined,
    areas: new Set(['AREA_AV']),
  });
  assert.ok(
    unjoinable.notes.some((note) => note.includes('Area scope needs BUS_GENERAL')),
    unjoinable.notes.join(' '),
  );
  assert.equal(unjoinable.rows.length, 2);
  ok('an area scope with no BusList to join says so, and shows everything rather than nothing');
  assert.deepEqual(
    unjoinable.rows.map((row) => row.label),
    ['WILLOWBEND (10001)', 'POPLARVIEW (10002)'],
  );
  ok('with no list loaded the labels come from the export’s own name row');
}

{
  // % of range on the Bus tab: each row over its own unfiltered peak (no
  // limit), a negative LMP hour over its trough; stats are ratios.
  const data = busTable([10001], ['WILLOWBEND'], (_i, hour) =>
    hour === 0 ? -20 : hour === 1 ? 80 : 40,
  );
  const mask = allHours();
  mask[1] = 0;
  const tab = buildBusTab({
    tables: [{ ...busTableIn(data), mask }],
    list: undefined,
    areas: null,
    perUnit: true,
  });
  const column = (key) => tab.columns.find((entry) => entry.key === key);
  assert.equal(tab.rows[0].unit, '%');
  assert.equal(tab.rows[0].perUnit, true);
  assert.equal(column('stat.max').value(0), 0.5, '40 over the unfiltered peak 80');
  assert.equal(column('stat.min').value(0), -1, '−20 over the trough');
  assert.equal(column('stat.max').cellClass, 'ratio');
  ok('the Bus tab ranks % of range rows over their own unfiltered peak and trough');
}

// ------------------------------------------------------------ the Area tab
//
// No lookup table: the rows are the area axis.

function areaTable(areas, metrics, fill, absent = []) {
  const cube = new Float32Array(areas.length * metrics.length * HOURS);
  const presence = new Uint8Array(areas.length * metrics.length).fill(1);
  areas.forEach((area, a) => {
    metrics.forEach((metric, m) => {
      const idx = a * metrics.length + m;
      const gone = absent.some(([ar, me]) => ar === area && me === metric);
      if (gone) presence[idx] = 0;
      for (let hour = 0; hour < HOURS; hour++) {
        cube[idx * HOURS + hour] = gone ? Number.NaN : fill(a, m, hour);
      }
    });
  });
  return {
    cube,
    areas: [...areas],
    metrics: [...metrics],
    presence,
    tou: new Uint8Array(HOURS),
    sourceColumns: ['Name', 'Date', 'Hour', ...metrics],
    year: 2031,
  };
}

const areaTableIn = (data, variable = 'Load (MWh)') => ({
  caseId: 'c1',
  caseName: 'Case 1',
  caseLabel: 'Case 1',
  slotKey: 'area',
  data,
  mask: allHours(),
});

{
  // % of range on the Area tab: ungrouped and grouped, each over its own
  // unfiltered peak; a group's is the peak of the sum.
  setGroupings('Name,Grouping\nAREA_AV,Northwest\nAREA_NV,Northwest');
  const data = areaTable(['AREA_AV', 'AREA_NV'], ['Load (MWh)'], (a, _m, hour) =>
    hour === 0 ? (a + 1) * 40 : (a + 1) * 10,
  );
  const mask = allHours();
  mask[0] = 0;
  const build = (groupBy) =>
    buildAreaTab({
      tables: [{ ...areaTableIn(data), mask }],
      variable: 'Load (MWh)',
      areas: null,
      perUnit: true,
      ...(groupBy ? { groupBy } : {}),
    });
  const max = (tab, row = 0) => tab.columns.find((entry) => entry.key === 'stat.max').value(row);
  const flat = build();
  assert.equal(flat.rows[0].perUnit, true);
  assert.equal(max(flat), 0.25, 'AREA_AV: 10 over its unfiltered 40');
  const grouped = build('Group');
  assert.equal(grouped.rows[0].groupValue, 'Northwest');
  assert.equal(grouped.rows[0].perUnit, true);
  assert.equal(max(grouped), 0.25, 'the sum: 30 over its unfiltered 120');
  ok('the Area tab ranks % of range rows, grouped or not, over their own unfiltered peak');
}

{
  const data = areaTable(
    ['AREA_AV', 'AREA_NV'],
    ['Load (MWh)', 'Generation (MWh)'],
    (a, m, h) => (a + 1) * 10 + m,
  );
  const tab = buildAreaTab({
    tables: [areaTableIn(data, 'Load (MWh)')],
    variable: 'Load (MWh)',
    areas: null,
  });
  const column = (key) => tab.columns.find((entry) => entry.key === key);

  assert.deepEqual(
    tab.rows.map((row) => row.entity),
    ['AREA_AV', 'AREA_NV'],
  );
  ok('an area row’s entity is the area name from the axis');
  assert.equal(column('case').value(0), 'Case 1');
  assert.equal(column('entity').value(0), 'AREA_AV');
  assert.equal(column('stat.mean').value(0), 10);
  assert.equal(column('stat.mean').value(1), 20);
  assert.equal(column('stat.cf'), undefined);
  ok('there is no capacity-factor column: an area has no nameplate');
  for (const stat of STAT_COLUMNS) assert.ok(column(stat.key), `the tab carries ${stat.key}`);
  ok('the Area tab carries the shared stat columns');
}

{
  // The ratio metric renders percent, from Area's own rules; every other
  // metric (LMP included) is a quantity.
  const data = areaTable(
    ['AREA_AV', 'AREA_NV'],
    ['Generation / Installed Capacity'],
    (a) => 0.4312 + a,
  );
  const tab = buildAreaTab({
    tables: [areaTableIn(data, 'Generation / Installed Capacity')],
    variable: 'Generation / Installed Capacity',
    areas: null,
  });
  const mean = tab.columns.find((entry) => entry.key === 'stat.mean');
  assert.equal(mean.label, 'Average (%)');
  assert.equal(mean.cellClass, 'ratio');
  assert.equal(displayCell(mean.value(0), cellClassOf(mean, 0)), '43%');
  ok('the ratio metric renders whole percent under a (%) label');

  const load = areaTable(['AREA_AV'], ['Load (MWh)'], () => 10);
  const loadTab = buildAreaTab({
    tables: [areaTableIn(load, 'Load (MWh)')],
    variable: 'Load (MWh)',
    areas: null,
  });
  const loadMean = loadTab.columns.find((entry) => entry.key === 'stat.mean');
  assert.equal(loadMean.label, 'Average');
  assert.equal(loadMean.cellClass, 'quantity');
  ok('an MWh metric stays a quantity: intensive is not ratio, and MWh is extensive anyway');
}

{
  // The map and the rules agree, in both directions: a ratio column added to
  // the rules and not to the map would render `<1`, and a name in the map the
  // rules do not carry as a ratio would classify a metric no export can load.
  const rulesJson = (
    await import('../data/area/aggregation-rules.json', { with: { type: 'json' } })
  ).default;
  const ratioUnits = rulesJson.columns
    .filter((entry) => entry.unit === 'ratio')
    .map((entry) => entry.canonical.trim());
  for (const name of ratioUnits)
    assert.ok(RATIO_METRICS.has(name), `${name} is a ratio in the rules`);
  for (const name of RATIO_METRICS)
    assert.ok(ratioUnits.includes(name), `${name} is in the map but not in the rules`);
  ok('the area ratio map and the aggregation rules agree, in both directions');
}

{
  // Area scope narrows to scoped areas, unscoped planes are not touched
  const POISON = 1e9;
  const data = areaTable(['AREA_AV', 'AREA_NV'], ['Load (MWh)'], (a) => (a === 0 ? 5 : POISON));
  const scoped = buildAreaTab({
    tables: [areaTableIn(data, 'Load (MWh)')],
    variable: 'Load (MWh)',
    areas: new Set(['AREA_AV']),
  });
  assert.deepEqual(
    scoped.rows.map((row) => row.entity),
    ['AREA_AV'],
  );
  ok('the area scope narrows the Area tab to its own rows');
  const column = (key) => scoped.columns.find((entry) => entry.key === key);
  assert.equal(column('stat.mean').value(0), 5);
  ok('the scoped area is ranked correctly');
}

{
  // Two cases of one metric
  const first = areaTableIn(areaTable(['AREA_AV'], ['Load (MWh)'], () => 10));
  const second = {
    ...areaTableIn(areaTable(['AREA_AV'], ['Load (MWh)'], () => 20)),
    caseId: 'c2',
    caseName: 'Case 2',
    caseLabel: 'Case 2',
  };
  const tab = buildAreaTab({
    tables: [first, second],
    variable: 'Load (MWh)',
    areas: null,
  });
  assert.equal(tab.rows.length, 2);
  assert.notEqual(tab.rows[0].id, tab.rows[1].id);
  const column = (key) => tab.columns.find((entry) => entry.key === key);
  assert.deepEqual([column('case').value(0), column('case').value(1)], ['Case 1', 'Case 2']);
  assert.deepEqual([column('stat.mean').value(0), column('stat.mean').value(1)], [10, 20]);
  ok('two cases in Area are two rows with Case column at far left, ranked apart');
}

// ------------------------------------------------------- the Interface tab
//
// No lookup table and no area: rows are the interface axis.

function interfaceTable(interfaces, fill, absent = []) {
  const cube = new Float32Array(interfaces.length * HOURS);
  const presence = new Uint8Array(interfaces.length).fill(1);
  interfaces.forEach((name, index) => {
    const gone = absent.includes(name);
    if (gone) presence[index] = 0;
    for (let hour = 0; hour < HOURS; hour++) {
      cube[index * HOURS + hour] = gone ? Number.NaN : fill(index, hour);
    }
  });
  return {
    cube,
    interfaces: [...interfaces],
    presence,
    tou: new Uint8Array(HOURS),
    sourceColumns: [...interfaces],
    year: 2031,
    quantity: 'Power Flow (MW)',
    unit: 'MW',
  };
}

const interfaceTableIn = (data) => ({
  caseId: 'c1',
  caseName: 'Case 1',
  caseLabel: 'Case 1',
  slotKey: 'interface',
  data,
  mask: allHours(),
});

{
  // % of range on the Interface tab: a path over the limits main.ts hands in
  // (as numbers), a path with none over its own peak.
  const data = interfaceTable(['P01', 'P02'], (index, hour) => (hour === 0 ? -500 : 2500));
  const asked = [];
  const tab = buildInterfaceTab({
    tables: [interfaceTableIn(data)],
    areas: null,
    perUnit: true,
    limitsOf: (caseId, name, year) => {
      asked.push([caseId, name, year]);
      return name === 'P01' ? { upper: 5000, lower: -1000 } : {};
    },
  });
  const column = (key) => tab.columns.find((entry) => entry.key === key);
  assert.deepEqual(asked, [
    ['c1', 'P01', 2031],
    ['c1', 'P02', 2031],
  ]);
  assert.equal(tab.rows[0].unit, '%');
  assert.equal(tab.rows[0].perUnit, true);
  assert.equal(column('stat.max').value(0), 0.5, 'P01: 2500 over MAX 5000');
  assert.equal(column('stat.min').value(0), -0.5, 'P01: −500 over MIN −1000');
  assert.equal(column('stat.max').value(1), 1, 'P02: no limit, its own peak');
  assert.equal(column('stat.min').value(1), -1, 'and its own trough');
  ok('the Interface tab ranks % of range rows over the limits it is handed, else the peak');
}

{
  const data = interfaceTable(['P01', 'P02'], (index, hour) => (index + 1) * 10);
  const tab = buildInterfaceTab({
    tables: [interfaceTableIn(data)],
    areas: null,
  });
  const column = (key) => tab.columns.find((entry) => entry.key === key);

  assert.deepEqual(
    tab.rows.map((row) => row.entity),
    ['P01', 'P02'],
  );
  ok('an interface row’s entity is the interface name from the axis');
  assert.equal(column('case').value(0), 'Case 1');
  assert.equal(column('entity').value(0), 'P01');
  assert.equal(column('stat.mean').value(0), 10);
  assert.equal(column('stat.mean').value(1), 20);
  assert.equal(column('stat.cf'), undefined);
  ok('there is no capacity-factor column: an interface has no nameplate');
  for (const stat of STAT_COLUMNS) assert.ok(column(stat.key), `the tab carries ${stat.key}`);
  ok('the Interface tab carries the shared stat columns');
  assert.deepEqual(tab.notes, []);
}

{
  // THE STALE COLUMN. Interface's column labels say nothing about the
  // quantity, so switching variable leaves the header signature unchanged
  // and the header unrepainted; a header cell holding its column object would
  // offer the previous variable's cases. So the button carries the KEY and
  // the drawer re-resolves it (tests/test_dom_contract.mjs); this asserts the
  // property that makes that necessary.
  const flow = buildInterfaceTab({
    tables: [interfaceTableIn(interfaceTable(['P01', 'P02'], (index) => (index + 1) * 10))],
    areas: null,
  });
  const costData = interfaceTable(['P01', 'P02'], (index) => (index + 1) * 3);
  costData.quantity = 'Congestion Cost ($)';
  costData.unit = '$';
  const cost = buildInterfaceTab({
    tables: [
      { ...interfaceTableIn(costData), caseId: 'c2', caseName: 'Case 2', caseLabel: 'Case 2' },
    ],
    areas: null,
  });
  assert.equal(
    headerSignature(flow, NO_VIEW),
    headerSignature(cost, NO_VIEW),
    'the Interface header is byte-identical across a variable change — which is what made a ' +
      'captured column object outlive the rows it reads',
  );
  const caseOf = (tab) => tab.columns.find((entry) => entry.key === 'case');
  assert.equal(caseOf(flow).value(0), 'Case 1');
  assert.equal(caseOf(cost).value(0), 'Case 2');
  ok('an Interface variable change moves no header state, so the filter column must be re-read');

  // And the other half: the filter written against the old variable's case is
  // remembered per tab, keeps nothing here, and the count line has to say so
  // rather than showing an empty table that reads as an empty study.
  const stale = { ...NO_VIEW, filters: new Map([['case', { kind: 'text', text: 'Case 1' }]]) };
  assert.equal(visibleRows(cost, stale).length, 0);
  assert.deepEqual(filteringColumnLabels(cost, stale), ['Case']);
  assert.deepEqual(filteringColumnLabels(cost, NO_VIEW), []);
  assert.deepEqual(
    filteringColumnLabels(cost, {
      ...NO_VIEW,
      filters: new Map([['no.such.column', { kind: 'text', text: 'x' }]]),
    }),
    [],
    'a filter naming no column on the tab constrained nothing, so it emptied nothing',
  );
  ok('a filter left over from another variable is named, not left to look like an empty study');
}

{
  // Area scope note
  const data = interfaceTable(['P01', 'P02'], (index) => (index + 1) * 10);
  const tab = buildInterfaceTab({
    tables: [interfaceTableIn(data)],
    areas: new Set(['AREA_AV']),
  });
  assert.deepEqual(
    tab.rows.map((row) => row.entity),
    ['P01', 'P02'],
  );
  ok('an area scope does not filter interface rows');
  assert.deepEqual(tab.notes, [
    'Interfaces do not belong to an Area, so the area scope is not applied.',
  ]);
  ok('with an area scope active the Interface tab notes that it is not applied');
}

{
  // Two cases of one quantity
  const first = interfaceTableIn(interfaceTable(['P01'], () => 10));
  const second = {
    ...interfaceTableIn(interfaceTable(['P01'], () => 20)),
    caseId: 'c2',
    caseName: 'Case 2',
    caseLabel: 'Case 2',
  };
  const tab = buildInterfaceTab({
    tables: [first, second],
    areas: null,
  });
  assert.equal(tab.rows.length, 2);
  assert.notEqual(tab.rows[0].id, tab.rows[1].id);
  const column = (key) => tab.columns.find((entry) => entry.key === key);
  assert.deepEqual([column('case').value(0), column('case').value(1)], ['Case 1', 'Case 2']);
  assert.deepEqual([column('stat.mean').value(0), column('stat.mean').value(1)], [10, 20]);
  ok('two cases in Interface are two rows with Case column at far left, ranked apart');
}

// ------------------------------------------------------------------ group-by

{
  // Generator attribute columns are groupable for extensive quantities
  const list = listOf([
    'ALDER,101,AREA_AV,Gas,200',
    'BIRCH,102,AREA_NV,Wind,100',
    'CEDAR,103,AREA_AV,Solar,50',
  ]);
  const genData = generatorTable(['ALDER', 'BIRCH', 'CEDAR', 'DOGWOOD'], (i) => (i + 1) * 10);
  const genTab = buildGeneratorTab({ tables: [table(genData)], list, areas: null });

  const fuelCol = genTab.columns.find((c) => c.key === 'list.FuelType');
  assert.equal(fuelCol.groupable, true);
  assert.equal(fuelCol.groupDisabledReason, undefined);
  ok('an attribute column is groupable for an extensive generator quantity');

  const statCol = genTab.columns.find((c) => c.key === 'stat.max');
  assert.equal(statCol.groupable, undefined);
  ok('stat columns are not groupable');

  // Intensive generator quantity disables group-by
  const lmpData = { ...genData, quantity: 'LMP ($/MWh)' };
  const lmpTab = buildGeneratorTab({ tables: [table(lmpData)], list, areas: null });
  const lmpFuelCol = lmpTab.columns.find((c) => c.key === 'list.FuelType');
  assert.equal(lmpFuelCol.groupable, false);
  // Written for the reader: names the UNIT and the arithmetic, not the
  // code's word "intensive".
  assert.match(lmpFuelCol.groupDisabledReason, /\$\/MWh/);
  assert.ok(
    !/intensive/i.test(lmpFuelCol.groupDisabledReason),
    'the refusal is plain English, not the rule vocabulary',
  );
  ok('an intensive generator quantity disables group-by, and says so in plain English');

  // Only CATEGORY columns get a group control: `Long Name` or
  // `PSSEMaxCap(MW)` would make a row per unit, and no action could ever
  // enable a disabled button there.
  for (const key of ['list.Bus ID', 'list.PSSEMaxCap(MW)']) {
    const col = genTab.columns.find((c) => c.key === key);
    assert.ok(col, `${key} is listed`);
    assert.ok(!col.groupable, `${key} is not groupable`);
    assert.equal(col.groupDisabledReason, undefined, `${key} carries no disabled button either`);
  }
  assert.equal(genTab.columns.find((c) => c.key === 'list.Area Name').groupable, true);
  ok('only enum (category) list columns carry a group control at all');

  // Generator without list loaded disables group-by
  const unlistedTab = buildGeneratorTab({ tables: [table(genData)], list: undefined, areas: null });
  const unlistedFuelCol = unlistedTab.columns.find((c) => c.key === 'list.FuelType');
  assert.equal(unlistedFuelCol, undefined);
  ok('without GeneratorList loaded, attribute columns are absent');

  // Grouped generator tab collapses rows and calculates aggregate stats
  const groupedTab = buildGeneratorTab({
    tables: [table(genData)],
    list,
    areas: null,
    groupBy: 'list.FuelType',
  });
  // ALDER (Gas), CEDAR (Solar), BIRCH (Wind), DOGWOOD ((unlisted))
  assert.equal(groupedTab.rows.length, 4);
  assert.deepEqual(
    groupedTab.rows.map((r) => r.groupValue),
    ['Gas', 'Solar', 'Wind', '(unlisted)'],
  );
  assert.equal(groupedTab.rows[0].groupBy, 'FuelType');
  assert.equal(groupedTab.rows[0].groupValue, 'Gas');
  assert.equal(groupedTab.rows[0].axisIndex, -1);
  const unitsCol = groupedTab.columns.find((c) => c.key === 'group.units');
  assert.ok(unitsCol);
  assert.equal(unitsCol.value(0), 1);
  assert.equal(unitsCol.cellClass, 'count');
  // ALDER value is (0+1)*10 = 10
  assert.equal(groupedTab.columns.find((c) => c.key === 'stat.mean').value(0), 10);
  ok('grouping by FuelType collapses rows and computes aggregate fleet stats');

  // The group-editor hand-off is on the UNGROUPED tab only: a bucket label
  // filed as a unit would be flagged and unplottable forever.
  const ungroupedTab = buildGeneratorTab({ tables: [table(genData)], list, areas: null });
  assert.deepEqual(ungroupedTab.actions, [
    { id: 'add-shown-to-group', label: 'Add shown to a group…' },
  ]);
  assert.equal(groupedTab.actions, undefined);
  ok('only the ungrouped Generator tab offers "Add shown to a group…"');

  // Grouped row produces grouped subject in specFromRow
  const spec = specFromRow(groupedTab.rows[0]);
  assert.deepEqual(spec.subject, { groupBy: 'FuelType', value: 'Gas' });
  ok('a grouped browse row turns into a SeriesSpec with a grouped subject');

  // A bus attribute column offers group-by only where the QUANTITY may sum
  // and a BusList is there to join through. The default fixture is LMP,
  // which is intensive, so its refusal names the class.
  const busList = buildLookup(
    parseLookupCsv(
      [
        'BUS_GENERAL,,,',
        'BusID,Name,LoadArea,PSSEZone',
        '101,B1,AREA_AV,Z1',
        '102,B2,AREA_NV,Z1',
      ].join('\n'),
      'BusList.csv',
    ).rows,
  );
  const busLmpTab = buildBusTab({
    tables: [busTableIn(busTable([101, 102], ['B1', 'B2'], (i) => (i + 1) * 10))],
    list: busList,
    areas: null,
  });
  const lmpAreaCol = busLmpTab.columns.find((c) => c.key === 'list.LoadArea');
  assert.equal(lmpAreaCol.groupable, false);
  assert.match(lmpAreaCol.groupDisabledReason, /\$\/MWh/);
  assert.ok(
    !/never combined/.test(lmpAreaCol.groupDisabledReason),
    'the refusal names the unit, not the kind',
  );
  assert.ok(
    !/intensive/i.test(lmpAreaCol.groupDisabledReason),
    'the refusal is plain English, not the rule vocabulary',
  );
  ok('a bus column refuses group-by for an intensive quantity, by unit and in plain English');

  const loadTable = busTable([101, 102], ['B1', 'B2'], (i) => (i + 1) * 10);
  loadTable.quantity = 'Unserved Load (MWh)';
  const busLoadIn = { ...busTableIn(loadTable), slotKey: 'bus Unserved Load (MWh)' };
  const busLoadTab = buildBusTab({ tables: [busLoadIn], list: busList, areas: null });
  assert.equal(busLoadTab.columns.find((c) => c.key === 'list.LoadArea').groupable, true);
  ok('and offers it for an extensive one');

  // THE STALE HEADER. LMP -> a summable quantity keeps the same column KEYS,
  // so a key-only signature would leave every Group button disabled with the
  // LMP refusal still showing.
  assert.deepEqual(
    busLmpTab.columns.map((c) => c.key),
    busLoadTab.columns.map((c) => c.key),
    'the two variables emit the same columns — which is what made this silent',
  );
  assert.notEqual(
    headerSignature(busLmpTab, NO_VIEW),
    headerSignature(busLoadTab, NO_VIEW),
    'the header signature moves when the group controls do, not only when the keys do',
  );
  assert.equal(headerSignature(busLoadTab, NO_VIEW), headerSignature(busLoadTab, NO_VIEW));
  ok('a variable change that keeps every column key still repaints the header');

  // Only a CATEGORY column carries the control. `BaseKV` is a float and
  // `Monitored` a bool: one buckets every distinct voltage, the other buckets
  // on `true`. Neither gets a disabled button — no user action enables them.
  const busListWide = buildLookup(
    parseLookupCsv(
      [
        'BUS_GENERAL,,,,,',
        'BusID,Name,BaseKV,Monitored,LoadArea,PSSEZone',
        '101,B1,230,TRUE,AREA_AV,Z1',
        '102,B2,115,FALSE,AREA_NV,Z1',
      ].join('\n'),
      'BusList.csv',
    ).rows,
  );
  const wideTab = buildBusTab({ tables: [busLoadIn], list: busListWide, areas: null });
  for (const key of ['list.BaseKV', 'list.Monitored']) {
    const col = wideTab.columns.find((c) => c.key === key);
    assert.ok(col, `${key} is listed`);
    assert.ok(!col.groupable, `${key} is not groupable`);
    assert.equal(col.groupDisabledReason, undefined, `${key} carries no disabled button either`);
  }
  for (const key of ['list.LoadArea', 'list.PSSEZone']) {
    assert.equal(wideTab.columns.find((c) => c.key === key).groupable, true, key);
  }
  ok('a bus measurement or flag column carries no group control; its enum columns do');

  // GROUP BY CASE. The one bucket that is not a lookup column: every bus the
  // case carries. It needs no BusList, so only the quantity can refuse it.
  const caseCol = busLoadTab.columns.find((c) => c.key === 'case');
  assert.equal(caseCol.groupable, true);
  assert.equal(caseCol.groupDisabledReason, undefined);
  assert.equal(busLmpTab.columns.find((c) => c.key === 'case').groupable, false);
  assert.match(busLmpTab.columns.find((c) => c.key === 'case').groupDisabledReason, /\$\/MWh/);
  const listlessCaseCol = buildBusTab({
    tables: [busLoadIn],
    list: undefined,
    areas: null,
  }).columns.find((c) => c.key === 'case');
  assert.equal(
    listlessCaseCol.groupable,
    true,
    'a Case bucket joins to nothing, so it needs no list',
  );
  ok('the Case column offers a group-by that the quantity alone can refuse');

  const byCase = buildBusTab({ tables: [busLoadIn], list: busList, areas: null, groupBy: 'case' });
  assert.equal(byCase.rows.length, 1, 'one table is one case row');
  assert.equal(byCase.rows[0].groupBy, 'Case');
  assert.equal(byCase.rows[0].groupValue, 'Case 1');
  assert.equal(byCase.rows[0].entity, 'Case 1');
  assert.equal(byCase.rows[0].axisIndex, -1);
  assert.equal(byCase.columns.find((c) => c.key === 'group.buses').value(0), 2);
  // B1 is 10 and B2 is 20 at every hour, so the case row is 30.
  assert.equal(byCase.columns.find((c) => c.key === 'stat.mean').value(0), 30);
  // No Case column beside the bucket: the same string under two headings
  // reads as two facts.
  assert.equal(byCase.columns.filter((c) => c.key === 'case').length, 1);
  ok('grouping buses by Case sums every bus the case carries into one row');

  // A Case's label is read when a row is drawn, never copied into it: the
  // by-Case bucket keeps the Case's name in its row id, so a pin survives a
  // relabel, and the pinned line names the label of the moment.
  {
    const { resolveDraws } = await import('../src/app/draw.ts');
    const { createSeriesPool } = await import('../src/series/pool.ts');
    const { rowKeyOf } = await import('../src/model/case-model.ts');
    const relabelled = { ...busLoadIn, caseLabel: 'Base' };
    const before = buildBusTab({
      tables: [busLoadIn],
      list: busList,
      areas: null,
      groupBy: 'case',
    });
    const after = buildBusTab({
      tables: [relabelled],
      list: busList,
      areas: null,
      groupBy: 'case',
    });
    assert.equal(after.rows[0].id, before.rows[0].id, 'the by-Case row id holds across a relabel');
    assert.equal(after.rows[0].groupValue, 'Case 1', 'its group value stays the Case name');
    assert.equal(
      after.columns.find((c) => c.key === 'case').value(0),
      'Base',
      'its cell reads the label',
    );
    assert.ok(!('caseName' in after.rows[0]), 'a row carries no copy of the Case name');
    const narrowed = buildBusTab({
      tables: [relabelled],
      list: busList,
      areas: null,
      groupBy: 'case',
      keep: new Set([browseJoinKey('c1', busLoadIn.slotKey, 101)]),
    });
    assert.equal(
      rowSubject(narrowed.rows[0], () => 'Base'),
      'Base (1 bus)',
      'a frozen count stays',
    );

    let label = 'Case 1';
    const context = {
      filters: {
        months: null,
        daysOfMonth: null,
        hoursOfDay: null,
        daysOfWeek: null,
        seasons: null,
        tou: null,
      },
      caseLabel: () => label,
      areaCases: () => [],
      interfaceRows: () => [],
      busRows: () => [
        {
          key: rowKeyOf('c1', busLoadIn.slotKey),
          caseId: 'c1',
          slotKey: busLoadIn.slotKey,
          label: 'Case 1',
          data: busLoadIn.data,
        },
      ],
      generatorRows: () => [],
      busNames: () => new Map(),
      busKv: () => null,
      interfaceRange: () => ({}),
      lines: createSeriesPool(),
    };
    const pinned = [{ ref: before.rows[0], color: '#000', dashed: false }];
    assert.match(resolveDraws(context, pinned)[0].detail, /^Case 1 · .* · Case = Case 1$/);
    label = 'Base';
    const [redrawn] = resolveDraws(context, pinned);
    assert.match(redrawn.detail, /^Base · .* · Case = Base$/, redrawn.detail);
    assert.equal(redrawn.facets.caseLabel, 'Base');
    ok('a by-Case pin keeps its row id when its Case is relabelled, and its drawn line relabels');
  }

  // A bus's kV is a figure's alone: a pin saves the row's id and label, and
  // a BusList that states a kV changes neither, nor the drawn line's name.
  {
    const { resolveDraws } = await import('../src/app/draw.ts');
    const { createSeriesPool } = await import('../src/series/pool.ts');
    const { rowKeyOf } = await import('../src/model/case-model.ts');
    const withKv = buildLookup(
      parseLookupCsv(
        ['BUS_GENERAL,,,', 'BusID,Name,BaseKV', '101,B1,230', '102,B2,115'].join('\n'),
        'BusList.csv',
      ).rows,
    );
    const plain = buildBusTab({ tables: [busLoadIn], list: busList, areas: null }).rows[0];
    const listed = buildBusTab({ tables: [busLoadIn], list: withKv, areas: null }).rows[0];
    assert.equal(listed.id, plain.id);
    assert.equal(listed.id, rowIdOf(listed));
    assert.equal(listed.label, plain.label);
    assert.ok(!/kV|230/.test(listed.label ?? ''), listed.label);
    const [drawn] = resolveDraws(
      {
        filters: {
          months: null,
          daysOfMonth: null,
          hoursOfDay: null,
          daysOfWeek: null,
          seasons: null,
          tou: null,
        },
        caseLabel: () => 'Case 1',
        areaCases: () => [],
        interfaceRows: () => [],
        busRows: () => [
          {
            key: rowKeyOf('c1', busLoadIn.slotKey),
            caseId: 'c1',
            slotKey: busLoadIn.slotKey,
            label: 'Case 1',
            data: busLoadIn.data,
          },
        ],
        generatorRows: () => [],
        busNames: () => new Map([[101, 'B1']]),
        busKv: () => 230,
        interfaceRange: () => ({}),
        lines: createSeriesPool(),
      },
      [{ ref: listed, color: '#000', dashed: false }],
    );
    assert.ok(!/kV/.test(drawn.detail) && !/kV/.test(drawn.name), drawn.detail);
    assert.equal(drawn.facets.figureSubject, '101 B1 230 kV');
    ok('a bus pin’s saved label and row id carry no kV, which only its figure key states');
  }

  // Grouping by Case with no list is the case that had no path at all before:
  // `canGroup` required a BusList and the build fell back to ungrouped rows
  // with the button still lit.
  const listlessByCase = buildBusTab({
    tables: [busLoadIn],
    list: undefined,
    areas: null,
    groupBy: 'case',
  });
  assert.equal(listlessByCase.rows.length, 1);
  assert.equal(listlessByCase.columns.find((c) => c.key === 'stat.mean').value(0), 30);
  ok('and does so with no BusList loaded');

  // …and the grouped build sums the member planes.
  const busGrouped = buildBusTab({
    tables: [busLoadIn],
    list: busList,
    areas: null,
    groupBy: 'list.PSSEZone',
  });
  assert.deepEqual(
    busGrouped.rows.map((row) => row.groupValue),
    ['Z1'],
  );
  assert.equal(busGrouped.rows[0].groupBy, 'PSSEZone');
  assert.equal(busGrouped.columns.find((c) => c.key === 'group.buses').value(0), 2);
  assert.equal(busGrouped.columns.find((c) => c.key === 'stat.mean').value(0), 30, '10 + 20');
  ok('a bus group-by collapses into buckets and sums their planes');

  // An unnarrowed attribute bucket re-reads its members on every draw (so a
  // later BusList moves its line) and names no count; a narrowed one freezes
  // members and count.
  assert.equal(busGrouped.rows[0].label, 'Z1');
  const narrowedZ1 = buildBusTab({
    tables: [busLoadIn],
    list: busList,
    areas: null,
    groupBy: 'list.PSSEZone',
    keep: new Set([browseJoinKey('c1', busLoadIn.slotKey, 101)]),
  }).rows[0];
  assert.deepEqual(narrowedZ1.members, [101]);
  assert.equal(narrowedZ1.label, 'Z1 (1 bus)');
  const relisted = buildBusTab({
    tables: [busLoadIn],
    list: buildLookup(
      parseLookupCsv(
        [
          'BUS_GENERAL,,,',
          'BusID,Name,LoadArea,PSSEZone',
          '101,B1,AREA_AV,Z1',
          '102,B2,AREA_NV,Z2',
        ].join('\n'),
        'BusList.csv',
      ).rows,
    ),
    areas: null,
    groupBy: 'list.PSSEZone',
  });
  const z1At = relisted.rows.findIndex((row) => row.groupValue === 'Z1');
  assert.equal(relisted.rows[z1At].id, busGrouped.rows[0].id, 'the list change keeps the id');
  assert.equal(relisted.rows[z1At].label, busGrouped.rows[0].label, 'and the label');
  assert.equal(relisted.columns.find((c) => c.key === 'group.buses').value(z1At), 1);
  assert.equal(relisted.columns.find((c) => c.key === 'stat.mean').value(z1At), 10);
  ok('a bus bucket names no count its list can outdate; a narrowed one keeps its frozen count');

  // A bus with no BusList row still gets a bucket of its own rather than
  // being dropped -- the rule every reduce in this repo shares.
  const unlistedTable = busTable([101, 999], ['B1', 'X'], () => 5);
  unlistedTable.quantity = 'Unserved Load (MWh)';
  const busUnlisted = buildBusTab({
    tables: [busTableIn(unlistedTable)],
    list: busList,
    areas: null,
    groupBy: 'list.LoadArea',
  });
  assert.ok(
    busUnlisted.rows.some((row) => row.groupValue === '(unlisted)'),
    'a bus the list never mentioned is its own bucket',
  );
  ok('an unlisted bus is bucketed, never folded into the first label');

  // ------------------------------------------- the dedicated Bus Groups tab
  {
    const { BUS_GROUP_BY, clearBusGroups, loadBusGroups, busKeyIndex } =
      await import('../src/tables/bus/groups.ts');
    clearBusGroups();

    // Keyed on the bus NUMBER: the identity. Both fixture buses are called
    // B1 and B2 here, so the name form is exercised separately below.
    loadBusGroups(
      ['BusID,Grouping', '101,West', '102,West', '101,Metro', '77777,West'].join('\n'),
      { key: { by: 'id', idColumn: 'BusID' }, groupColumn: 'Grouping' },
      busKeyIndex(busList),
    );

    const groupTab = buildBusTab({
      tables: [busLoadIn],
      list: busList,
      areas: null,
      isGroupTab: true,
    });
    assert.equal(groupTab.id, 'bus-groups');
    assert.equal(groupTab.label, 'Bus Groups');
    assert.deepEqual(groupTab.actions, [{ id: 'edit-groups', label: 'Edit Groups…' }]);
    assert.deepEqual(
      groupTab.rows.map((row) => row.groupValue),
      ['West', 'Metro'],
    );
    assert.equal(groupTab.rows[0].groupBy, BUS_GROUP_BY);
    const busesCol = groupTab.columns.find((c) => c.key === 'group.buses');
    // 77777 is in the map and on no axis: it contributes nothing, and the
    // count says two rather than claiming a third bus.
    assert.equal(busesCol.value(0), 2, 'West is 101 + 102; the off-axis id adds nothing');
    assert.equal(groupTab.rows[0].label, 'West', 'unnarrowed: the count is in its column');
    assert.equal(groupTab.columns.find((c) => c.key === 'stat.mean').value(0), 30);
    assert.equal(busesCol.value(1), 1);
    assert.equal(groupTab.rows[1].label, 'Metro');
    ok('a bus group row aggregates its member planes; an id no table carries adds nothing');

    // A narrowed group freezes its members, so the count it froze with them
    // stays true and stays in its label.
    const narrowedWest = buildBusTab({
      tables: [busLoadIn],
      list: busList,
      areas: null,
      isGroupTab: true,
      keep: new Set([browseJoinKey('c1', busLoadIn.slotKey, 101)]),
    }).rows.find((row) => row.groupValue === 'West');
    assert.deepEqual(narrowedWest.members, [101]);
    assert.equal(narrowedWest.label, 'West (1 bus)');

    // An unnarrowed one freezes nothing: its line re-reads the map on every
    // draw, and a membership edit leaves its id -- so a pin -- unchanged. A
    // count in its label would outlive the edit.
    const west = groupTab.rows[0];
    loadBusGroups(
      ['BusID,Grouping', '101,West', '101,Metro'].join('\n'),
      { key: { by: 'id', idColumn: 'BusID' }, groupColumn: 'Grouping' },
      busKeyIndex(busList),
    );
    const shrunk = buildBusTab({
      tables: [busLoadIn],
      list: busList,
      areas: null,
      isGroupTab: true,
    });
    const westAt = shrunk.rows.findIndex((row) => row.groupValue === 'West');
    assert.equal(
      shrunk.rows[westAt].id,
      west.id,
      'a membership edit leaves the pinned id matching',
    );
    assert.equal(shrunk.rows[westAt].label, west.label, 'so the label a pin froze names no count');
    assert.equal(shrunk.columns.find((c) => c.key === 'group.buses').value(westAt), 1);
    assert.equal(shrunk.columns.find((c) => c.key === 'stat.mean').value(westAt), 10, 'B1 alone');
    ok('a membership edit changes a bus group’s numbers and its count column, never its label');
    // Back as it was, for the checks below.
    loadBusGroups(
      ['BusID,Grouping', '101,West', '102,West', '101,Metro', '77777,West'].join('\n'),
      { key: { by: 'id', idColumn: 'BusID' }, groupColumn: 'Grouping' },
      busKeyIndex(busList),
    );

    // The same tab under an intensive quantity refuses whole, keeping its
    // columns so the refusal lands in a table that still looks like the tab.
    const refused = buildBusTab({
      tables: [busTableIn(busTable([101, 102], ['B1', 'B2'], () => 1))],
      list: busList,
      areas: null,
      isGroupTab: true,
    });
    assert.deepEqual(refused.rows, []);
    assert.ok(refused.columns.length > 0);
    assert.match(refused.notes[0], /\$\/MWh/);
    ok('the Bus Groups tab refuses an intensive quantity whole, with its columns kept');

    clearBusGroups();
    const empty = buildBusTab({
      tables: [busLoadIn],
      list: busList,
      areas: null,
      isGroupTab: true,
    });
    assert.deepEqual(empty.rows, []);
    assert.match(empty.notes[0], /No bus groups are loaded yet/);
    ok('with no membership loaded the tab says so rather than showing an empty table');
  }

  // Interface columns refuse group-by permanently
  const ifaceTab = buildInterfaceTab({
    tables: [interfaceTableIn(interfaceTable(['P01'], () => 10))],
    areas: null,
  });
  const ifaceCol = ifaceTab.columns.find((c) => c.key === 'entity');
  assert.equal(ifaceCol.groupable, false);
  // Still refused, and now for the reason that survives: an arbitrary set of
  // paths is not a boundary. The Interface Groups tab is where one is built.
  assert.match(ifaceCol.groupDisabledReason, /not a boundary/);
  assert.match(ifaceCol.groupDisabledReason, /Interface Groups tab/);
  assert.ok(
    !/never combined/.test(ifaceCol.groupDisabledReason),
    'the refusal names what an attribute bucket cannot say, not the kind',
  );
  ok('an interface column refuses attribute group-by because a bucket has no direction');

  // ------------------------------------- the dedicated Interface Groups tab
  {
    const { INTERFACE_GROUP_BY, clearInterfaceGroups, setInterfaceMembership } =
      await import('../src/tables/interface/groups.ts');
    clearInterfaceGroups();

    // P01 = 10, P02 = 20, P03 = 40, so a signed sum is unmistakable.
    const paths = interfaceTable(['P01', 'P02', 'P03'], (index) => [10, 20, 40][index]);
    setInterfaceMembership(
      new Map([
        [
          'West Boundary',
          [
            { name: 'P01', direction: 'forward' },
            { name: 'P02', direction: 'reversed' },
          ],
        ],
        [
          'All Forward',
          [
            { name: 'P01', direction: 'forward' },
            { name: 'P03', direction: 'forward' },
          ],
        ],
        ['Nothing Here', [{ name: 'P99', direction: 'forward' }]],
      ]),
    );

    const groupTab = buildInterfaceTab({
      tables: [interfaceTableIn(paths)],
      areas: null,
      isGroupTab: true,
    });
    assert.equal(groupTab.id, 'interface-groups');
    assert.equal(groupTab.label, 'Interface Groups');
    assert.deepEqual(groupTab.actions, [{ id: 'edit-groups', label: 'Edit Groups…' }]);
    // "Nothing Here" names a path no case carries, so it is no row at all --
    // the same rule the other kinds' group tabs apply.
    assert.deepEqual(
      groupTab.rows.map((row) => row.groupValue),
      ['West Boundary', 'All Forward'],
    );
    assert.equal(groupTab.rows[0].groupBy, INTERFACE_GROUP_BY);
    const mean = groupTab.columns.find((c) => c.key === 'stat.mean');
    assert.equal(mean.value(0), -10, '10 + (-1 x 20)');
    assert.equal(mean.value(1), 50, '10 + 40');
    ok('an interface group row is the SIGNED sum of its member paths');

    // How many paths are counted backwards is its own column, because it
    // cannot be read off the row and it changes the sign of what is shown.
    assert.equal(groupTab.columns.find((c) => c.key === 'group.interfaces').value(0), 2);
    assert.equal(groupTab.columns.find((c) => c.key === 'group.reversed').value(0), 1);
    assert.equal(groupTab.columns.find((c) => c.key === 'group.reversed').value(1), 0);
    ok('the tab states how many of a boundary’s paths are reversed, in a column');

    // Not in the label: a pin freezes the label, but the line reads
    // directions from the map on every draw. Flip P02: same id and label,
    // different numbers.
    const before = groupTab.rows[0];
    setInterfaceMembership(
      new Map([
        [
          'West Boundary',
          [
            { name: 'P01', direction: 'forward' },
            { name: 'P02', direction: 'forward' },
          ],
        ],
      ]),
    );
    const flipped = buildInterfaceTab({
      tables: [interfaceTableIn(paths)],
      areas: null,
      isGroupTab: true,
    });
    const after = flipped.rows[0];
    assert.equal(after.id, before.id, 'a direction edit leaves the pinned id matching');
    assert.equal(after.label, before.label, 'so the label a pin froze must not depend on it');
    assert.equal(before.label, 'West Boundary');
    assert.equal(flipped.columns.find((c) => c.key === 'stat.mean').value(0), 30, '10 + 20');
    assert.equal(flipped.columns.find((c) => c.key === 'group.reversed').value(0), 0);
    ok('a direction edit changes a group’s numbers and its Reversed column, never its label');
    // Back as it was: the checks below read West Boundary with P02 reversed.
    setInterfaceMembership(
      new Map([
        [
          'West Boundary',
          [
            { name: 'P01', direction: 'forward' },
            { name: 'P02', direction: 'reversed' },
          ],
        ],
        [
          'All Forward',
          [
            { name: 'P01', direction: 'forward' },
            { name: 'P03', direction: 'forward' },
          ],
        ],
      ]),
    );

    // Membership, not only direction: removing a member moves the numbers
    // and the Paths column under the same id and label. A narrowed
    // group keeps its count, frozen together with its members.
    const narrowedBoundary = buildInterfaceTab({
      tables: [interfaceTableIn(paths)],
      areas: null,
      isGroupTab: true,
      keep: new Set([browseJoinKey('c1', 'interface', 'P01')]),
    }).rows.find((row) => row.groupValue === 'West Boundary');
    assert.deepEqual(narrowedBoundary.members, ['P01']);
    assert.equal(narrowedBoundary.label, 'West Boundary (1 path)');
    setInterfaceMembership(new Map([['West Boundary', [{ name: 'P01', direction: 'forward' }]]]));
    const trimmed = buildInterfaceTab({
      tables: [interfaceTableIn(paths)],
      areas: null,
      isGroupTab: true,
    });
    assert.equal(trimmed.rows[0].id, before.id, 'a membership edit leaves the pinned id matching');
    assert.equal(trimmed.rows[0].label, before.label, 'so the label a pin froze names no count');
    assert.equal(trimmed.columns.find((c) => c.key === 'group.interfaces').value(0), 1);
    assert.equal(trimmed.columns.find((c) => c.key === 'stat.mean').value(0), 10, 'P01 alone');
    ok('a membership edit changes an interface group’s numbers and Paths column, never its label');
    setInterfaceMembership(
      new Map([
        [
          'West Boundary',
          [
            { name: 'P01', direction: 'forward' },
            { name: 'P02', direction: 'reversed' },
          ],
        ],
        [
          'All Forward',
          [
            { name: 'P01', direction: 'forward' },
            { name: 'P03', direction: 'forward' },
          ],
        ],
      ]),
    );

    // % of range: a boundary over its paths' limits summed in its
    // directions. West = P01 − P02 = −10; its upper is P01's MAX 100 plus
    // P02's −MIN 10, its lower P01's MIN −40 plus P02's −MAX −50. All
    // Forward holds P03, which has no limit, so it divides by its peak.
    {
      const { declareInterfaceTabs } = await import('../src/tables/interface/ui/browse.ts');
      const limits = { P01: { upper: 100, lower: -40 }, P02: { upper: 50, lower: -10 } };
      const asked = [];
      const limitsOf = (caseId, name, year) => {
        asked.push([caseId, name, year]);
        return limits[name] ?? {};
      };
      const pctTab = buildInterfaceTab({
        tables: [interfaceTableIn(paths)],
        areas: null,
        isGroupTab: true,
        perUnit: true,
        limitsOf,
      });
      const column = (key) => pctTab.columns.find((c) => c.key === key);
      assert.deepEqual(asked.slice(0, 2), [
        ['c1', 'P01', 2031],
        ['c1', 'P02', 2031],
      ]);
      assert.equal(pctTab.rows[0].unit, '%');
      assert.equal(pctTab.rows[0].perUnit, true);
      assert.ok(pctTab.rows[0].id.includes('p.u.'));
      assert.ok(Math.abs(column('stat.mean').value(0) - -10 / 90) < 1e-6, '−10 over −90');
      assert.equal(column('stat.mean').value(1), 1, 'All Forward: its own peak');
      assert.equal(column('stat.mean').cellClass, 'ratio');
      assert.ok(
        pctTab.notes.some((note) => /summed in the group's directions/.test(note)),
        pctTab.notes.join(' | '),
      );
      assert.ok(
        pctTab.notes.some((note) => /best case/.test(note)),
        'the tab says the sum is a best case',
      );
      ok("an interface group's % of range divides by its paths' direction-aware summed limits");

      // A narrowed row sums only its survivors: P01 alone, 10 over 100.
      const keptTab = buildInterfaceTab({
        tables: [interfaceTableIn(paths)],
        areas: null,
        isGroupTab: true,
        perUnit: true,
        limitsOf,
        keep: new Set([browseJoinKey('c1', 'interface', 'P01')]),
      });
      const west = keptTab.rows.findIndex((row) => row.groupValue === 'West Boundary');
      assert.deepEqual(keptTab.rows[west].members, ['P01']);
      assert.ok(
        Math.abs(keptTab.columns.find((c) => c.key === 'stat.mean').value(west) - 0.1) < 1e-6,
      );
      ok('a narrowed boundary divides by its surviving paths’ limits only');

      // A non-flow quantity is never divided by a flow rating.
      const cost = interfaceTable(['P01', 'P02'], (index) => [10, 20][index]);
      cost.quantity = 'Congestion Cost ($)';
      cost.unit = '$';
      const costPct = buildInterfaceTab({
        tables: [{ ...interfaceTableIn(cost), slotKey: 'interface Congestion Cost ($)' }],
        areas: null,
        isGroupTab: true,
        perUnit: true,
        limitsOf,
      });
      assert.equal(costPct.columns.find((c) => c.key === 'stat.mean').value(0), -1, 'its trough');
      assert.ok(!costPct.notes.some((note) => /best case/.test(note)));
      ok('a non-flow boundary divides by its own peak, never a flow rating');

      const [, groupsDecl] = declareInterfaceTabs(
        { tables: [] },
        { tables: [] },
        undefined,
        undefined,
        limitsOf,
      );
      assert.equal(groupsDecl.offersRange, true);
      ok('the Interface Groups tab offers % of range');

      const { savePins, restorePins } = await import('../src/ui/browse-model.ts');
      const boundary = pctTab.rows[0];
      const wire = JSON.parse(JSON.stringify(savePins([{ ref: boundary, color: '#000' }], ['c1'])));
      const [back] = restorePins(wire, [{ id: 'c1' }]);
      assert.equal(back.ref.id, boundary.id);
      assert.equal(back.ref.perUnit, true);
      ok('a % of range boundary pin restores as the same row');
    }

    // A direction is a statement about a FLOW. On a quantity that has none a
    // reversed member subtracts, and the tab says so rather than hiding it.
    const cost = interfaceTable(['P01', 'P02', 'P03'], (index) => [10, 20, 40][index]);
    cost.quantity = 'Congestion Cost ($)';
    cost.unit = '$';
    const costTab = buildInterfaceTab({
      tables: [{ ...interfaceTableIn(cost), slotKey: 'interface Congestion Cost ($)' }],
      areas: null,
      isGroupTab: true,
    });
    assert.equal(costTab.columns.find((c) => c.key === 'stat.mean').value(0), -10);
    assert.ok(
      costTab.notes.some(
        (note) => /not a directional quantity/.test(note) && /SUBTRACT/.test(note),
      ),
      'the note names the cost of applying a direction to a quantity that has none',
    );
    ok('a reversed member on a non-directional quantity subtracts, and the tab says so');

    // An intensive quantity refuses the whole tab, keeping its columns.
    const price = interfaceTable(['P01', 'P02'], () => 1);
    price.quantity = 'Shadow Price ($/MWh)';
    price.unit = '$/MWh';
    const refused = buildInterfaceTab({
      tables: [{ ...interfaceTableIn(price), slotKey: 'interface Shadow Price ($/MWh)' }],
      areas: null,
      isGroupTab: true,
    });
    assert.deepEqual(refused.rows, []);
    assert.ok(refused.columns.length > 0);
    assert.match(refused.notes[0], /\$\/MWh/);
    ok('the Interface Groups tab refuses an intensive quantity whole, with its columns kept');

    clearInterfaceGroups();
    const empty = buildInterfaceTab({
      tables: [interfaceTableIn(paths)],
      areas: null,
      isGroupTab: true,
    });
    assert.deepEqual(empty.rows, []);
    assert.match(empty.notes[0], /No interface groups are loaded yet/);
    ok('with no membership loaded the tab says so rather than showing an empty table');
  }

  // Area grouping collapses into defined groups
  setGroupings('Name,Grouping\nAREA_AV,Northwest\nAREA_NV,Desert');
  const areaData = areaTable(['AREA_AV', 'AREA_NV'], ['Load (MWh)'], (a, m, h) => (a + 1) * 10);
  const areaGroupedTab = buildAreaTab({
    tables: [areaTableIn(areaData, 'Load (MWh)')],
    variable: 'Load (MWh)',
    areas: null,
    groupBy: 'Group',
  });
  assert.ok(areaGroupedTab.rows.length >= 2);
  const nwRow = areaGroupedTab.rows.find((r) => r.groupValue === 'Northwest');
  assert.ok(nwRow);
  assert.equal(nwRow.groupBy, 'Group');
  const nwIndex = areaGroupedTab.rows.indexOf(nwRow);
  assert.equal(areaGroupedTab.columns.find((c) => c.key === 'stat.mean').value(nwIndex), 10);
  assert.equal(areaGroupedTab.columns.find((c) => c.key === 'group.areas').cellClass, 'count');
  ok('Area tab groups by Grouping and computes aggregate series stats');

  const dedicatedGroupTab = buildAreaTab({
    tables: [areaTableIn(areaData, 'Load (MWh)')],
    variable: 'Load (MWh)',
    areas: null,
    isGroupTab: true,
  });
  assert.equal(dedicatedGroupTab.id, 'area-groups');
  assert.equal(dedicatedGroupTab.label, 'Area Groups');
  assert.deepEqual(dedicatedGroupTab.actions, [{ id: 'edit-groups', label: 'Edit Groups…' }]);
  assert.equal(dedicatedGroupTab.columns.find((c) => c.key === 'entity').groupable, false);
  assert.ok(dedicatedGroupTab.rows.some((r) => r.groupValue === 'Northwest'));
  ok('dedicated AreaGroups tab builds with action button and non-groupable group column');

  // A grouping edit moves an unnarrowed group's numbers under the same id and
  // label, so the label names no count. A group narrowed by the area
  // scope freezes its members, and keeps their count in its label.
  const nwBefore = dedicatedGroupTab.rows.find((r) => r.groupValue === 'Northwest');
  assert.equal(nwBefore.label, 'Northwest');
  const nwScoped = buildAreaTab({
    tables: [areaTableIn(areaData, 'Load (MWh)')],
    variable: 'Load (MWh)',
    areas: new Set(['AREA_AV']),
    isGroupTab: true,
  }).rows.find((r) => r.groupValue === 'Northwest');
  assert.deepEqual(nwScoped.members, ['AREA_AV']);
  assert.equal(nwScoped.label, 'Northwest (1 area)');
  setGroupings('Name,Grouping\nAREA_AV,Northwest\nAREA_NV,Northwest');
  const regrouped = buildAreaTab({
    tables: [areaTableIn(areaData, 'Load (MWh)')],
    variable: 'Load (MWh)',
    areas: null,
    isGroupTab: true,
  });
  const nwAt = regrouped.rows.findIndex((r) => r.groupValue === 'Northwest');
  assert.equal(
    regrouped.rows[nwAt].id,
    nwBefore.id,
    'a grouping edit leaves the pinned id matching',
  );
  assert.equal(
    regrouped.rows[nwAt].label,
    nwBefore.label,
    'so the label a pin froze names no count',
  );
  assert.equal(regrouped.columns.find((c) => c.key === 'group.areas').value(nwAt), 2);
  assert.equal(regrouped.columns.find((c) => c.key === 'stat.mean').value(nwAt), 30, '10 + 20');
  ok('a grouping edit changes an area group’s numbers and its count column, never its label');
  setGroupings('Name,Grouping\nAREA_AV,Northwest\nAREA_NV,Desert');

  // Switching variable on dedicated AreaGroups tab recomputes stats for the new variable
  const multiMetricAreaData = areaTable(
    ['AREA_AV', 'AREA_NV'],
    ['Load (MWh)', 'Generation (MWh)'],
    (a, m, h) => (m === 0 ? (a + 1) * 10 : (a + 1) * 50),
  );
  const genGroupTab = buildAreaTab({
    tables: [areaTableIn(multiMetricAreaData, 'Generation (MWh)')],
    variable: 'Generation (MWh)',
    areas: null,
    isGroupTab: true,
  });
  const nwGenRow = genGroupTab.rows.find((r) => r.groupValue === 'Northwest');
  assert.ok(nwGenRow);
  assert.equal(nwGenRow.variable, 'Generation (MWh)');
  const nwGenIndex = genGroupTab.rows.indexOf(nwGenRow);
  assert.equal(genGroupTab.columns.find((c) => c.key === 'stat.mean').value(nwGenIndex), 50);
  ok('dedicated AreaGroups tab recomputes aggregate values when variable changes');

  // Unsupported variable on dedicated AreaGroups tab displays refusal notes
  const unsupportedGroupTab = buildAreaTab({
    tables: [areaTableIn(multiMetricAreaData, 'NonExistent')],
    variable: 'NonExistent',
    areas: null,
    isGroupTab: true,
  });
  assert.equal(unsupportedGroupTab.rows.length, 0);
  assert.ok(unsupportedGroupTab.notes.some((n) => n.includes('no aggregation rule')));
  assert.ok(unsupportedGroupTab.columns.length > 0);
  ok('dedicated AreaGroups tab preserves columns and emits refusal note for unsupported variable');

  // ------------------------------ an AreaGroups tab never OFFERS a dead end
  //
  // A metric the tab could only refuse is left out of its dropdown,
  // including a WEIGHTED_MEAN whose weight is missing from any Case that
  // carries it; the tab says why.
  const { combinesAcrossAreas, withheldFromGroups } = await import('../src/tables/area/rules.ts');
  const WEIGHTED = 'Avg LMP Weighted by Load ($/MWh)';
  const SIMPLE = 'Simple Average LMP($/MWh)';
  const withLoad = { metrics: [WEIGHTED, 'Load (MWh)'] };
  const withoutLoad = { metrics: [WEIGHTED, 'Generation (MWh)'] };
  assert.equal(combinesAcrossAreas('Load (MWh)', [withLoad]), true, 'SUM');
  assert.equal(combinesAcrossAreas(WEIGHTED, [withLoad]), true, 'WEIGHTED_MEAN, weight loaded');
  assert.equal(combinesAcrossAreas(WEIGHTED, [withoutLoad]), false, 'weight not loaded');
  assert.equal(
    combinesAcrossAreas(WEIGHTED, [withLoad, withoutLoad]),
    false,
    'one Case without the weight is enough to refuse, as the group builder would',
  );
  assert.equal(combinesAcrossAreas(SIMPLE, [withLoad]), false, 'MEAN has no aggregate');
  assert.equal(combinesAcrossAreas('Nothing Anyone Exports', []), false, 'no rule at all');
  ok('combinesAcrossAreas offers only what a group row could be built from');

  const { createBrowseScopes: makeScopes } = await import('../src/app/browse-scope.ts');
  const noHourFilters = {
    months: null,
    daysOfMonth: null,
    hoursOfDay: null,
    daysOfWeek: null,
    seasons: null,
    tou: null,
  };
  const areaCaseNames = new Map([['c1', { name: 'Case 1', label: 'Case 1' }]]);
  const scopeArea = (scopes, metrics, kind, pairedWith, offers) =>
    scopes.scope(
      [
        {
          key: 'a1',
          caseId: 'c1',
          slotKey: 'area',
          data: { metrics, year: 2031, tou: new Uint8Array(HOURS) },
        },
      ],
      kind,
      ['c1'],
      noHourFilters,
      areaCaseNames,
      pairedWith,
      offers,
    );

  const loaded = makeScopes();
  const all = ['Load (MWh)', WEIGHTED, SIMPLE];
  assert.deepEqual(scopeArea(loaded, all, 'area').variables, [...all].sort());
  const groupsLoaded = scopeArea(loaded, all, 'area-groups', 'area', combinesAcrossAreas);
  assert.deepEqual(groupsLoaded.variables, [WEIGHTED, 'Load (MWh)']);
  assert.deepEqual(groupsLoaded.withheld, [SIMPLE]);
  assert.equal(loaded.offered('area-groups', WEIGHTED), true, 'the pairing may carry it over');

  const unweighted = makeScopes();
  const noLoad = ['Generation (MWh)', WEIGHTED, SIMPLE];
  const groupsUnweighted = scopeArea(
    unweighted,
    noLoad,
    'area-groups',
    'area',
    combinesAcrossAreas,
  );
  assert.deepEqual(groupsUnweighted.variables, ['Generation (MWh)']);
  assert.deepEqual(groupsUnweighted.withheld, [WEIGHTED, SIMPLE]);
  assert.equal(
    unweighted.offered('area-groups', WEIGHTED),
    false,
    'and the pairing does not carry it onto a tab that would drop it',
  );
  assert.notEqual(
    groupsUnweighted.signature,
    scopeArea(makeScopes(), noLoad, 'area-groups', 'area', () => true).signature,
    'what a tab withholds is in its signature, because its notes say so',
  );
  ok('the Area tab offers every loaded metric; Area Groups drops the ones it could only refuse');

  // The note. Only the weighted metric is named: a dropped file brings it
  // back, and nothing brings back the MEAN one, so saying so is noise.
  assert.match(withheldFromGroups(WEIGHTED), /weighted by "Load \(MWh\)"/);
  assert.equal(withheldFromGroups(SIMPLE), undefined);
  const groupsTab = buildAreaTab({
    tables: [areaTableIn(areaTable(['AREA_AV', 'AREA_NV'], noLoad, () => 1))],
    variable: 'Generation (MWh)',
    areas: null,
    groupBy: 'Group',
    isGroupTab: true,
    withheld: groupsUnweighted.withheld,
  });
  const said = (tab) => tab.notes.filter((note) => note.startsWith('Area Groups does not offer'));
  assert.deepEqual(said(groupsTab), [withheldFromGroups(WEIGHTED)]);
  // With only weighted metrics loaded the groups tab offers nothing and is
  // not on the bar, so the Area tab says it too -- for the metric it shows.
  const entityTab = (variable) =>
    buildAreaTab({
      tables: [areaTableIn(areaTable(['AREA_AV', 'AREA_NV'], noLoad, () => 1))],
      variable,
      areas: null,
      withheld: groupsUnweighted.withheld,
    });
  assert.deepEqual(said(entityTab(WEIGHTED)), [withheldFromGroups(WEIGHTED)]);
  assert.deepEqual(said(entityTab('Generation (MWh)')), [], 'and only for that metric');
  ok('Area Groups and the Area tab say why a weighted metric is not offered for groups');
}

{
  // Grouped per-unit generator tab
  const genCols = ['Name', 'Bus ID', 'Area Name', 'FuelType', 'PSSEMaxCap(MW)', 'PSSEMinCap(MW)'];
  const list = buildLookup(
    parseLookupCsv(
      [
        `GENERATORLIST${','.repeat(genCols.length - 1)}`,
        genCols.join(','),
        'SOLAR1,101,AREA_AV,Solar,100,0',
        'SOLAR2,102,AREA_AV,Solar,100,0',
      ].join('\n'),
      'GeneratorList.csv',
    ).rows,
  );
  // SOLAR1: 20 MW, SOLAR2: 30 MW -> aggregate is 50 MW
  // Total Solar cap: 100 + 100 = 200 MW
  // Per-unit mean should be 50 / 200 = 0.25
  const data = generatorTable(['SOLAR1', 'SOLAR2'], (index) => (index === 0 ? 20 : 30));
  const tab = buildGeneratorTab({
    tables: [table(data)],
    list,
    areas: null,
    groupBy: 'list.FuelType',
    perUnit: true,
  });
  const solarRow = tab.rows.find((r) => r.groupValue === 'Solar');
  assert.ok(solarRow);
  const solarIdx = tab.rows.indexOf(solarRow);
  const meanCol = tab.columns.find((c) => c.key === 'stat.mean');
  assert.equal(meanCol.value(solarIdx), 0.25);
  ok('grouped per-unit generator tab normalizes aggregate series by pooled capacity');
}

// ------------------------------------------------- the generator groups tab
//
// Authored injection groups as a tab and as a drawn series: aggregation, the
// resolver, and the tab-id seams.
{
  const { clearGeneratorGroups, loadGeneratorGroups, GENERATOR_GROUP_BY } =
    await import('../src/tables/generator/groups.ts');
  const { createBrowseScopes } = await import('../src/app/browse-scope.ts');

  const list = listOf([
    'ALDER,101,AREA_AV,Gas,200',
    'BIRCH,102,AREA_NV,Wind,100',
    'CEDAR,103,AREA_AV,Solar,0',
  ]);
  // ALDER 10/hr, BIRCH 20/hr, CEDAR 30/hr; DOGWOOD (export-only) in no group.
  const genData = generatorTable(
    ['ALDER', 'BIRCH', 'CEDAR', 'DOGWOOD'],
    (index) => (index + 1) * 10,
  );
  const NAME_MAPPING = { key: { by: 'name', nameColumn: 'Unit' }, groupColumn: 'Group' };
  const MEMBERSHIP = [
    'Unit,Group',
    'ALDER,River SYN',
    'BIRCH,River SYN',
    'CEDAR,Plant SYN',
    'ALDER,Plant SYN',
    'SYN-NOT-HERE,River SYN',
  ].join('\n');

  clearGeneratorGroups();
  loadGeneratorGroups(MEMBERSHIP, NAME_MAPPING, undefined);

  const tab = buildGeneratorTab({
    tables: [table(genData)],
    list,
    areas: null,
    isGroupTab: true,
  });
  const column = (key) => tab.columns.find((entry) => entry.key === key);
  const rowOf = (group) => {
    const row = tab.rows.find((entry) => entry.groupValue === group);
    assert.ok(row, `the tab lists ${group}`);
    return tab.rows.indexOf(row);
  };

  assert.equal(tab.id, 'generator-groups');
  assert.equal(tab.label, 'Generator Groups');
  assert.deepEqual(tab.actions, [{ id: 'edit-groups', label: 'Edit Groups…' }]);
  ok('the groups tab is a dedicated tab with the editor action');

  assert.deepEqual(
    tab.rows.map((row) => row.groupValue),
    ['River SYN', 'Plant SYN'],
  );
  assert.equal(column('stat.mean').value(rowOf('River SYN')), 30, 'ALDER 10 + BIRCH 20');
  assert.equal(column('stat.mean').value(rowOf('Plant SYN')), 40, 'CEDAR 30 + ALDER 10');
  assert.equal(column('stat.n').value(rowOf('River SYN')), HOURS);
  // The bigger-study name is in the map but on no axis: it contributes
  // nothing, and the count says so rather than claiming a third unit.
  assert.equal(column('group.units').value(rowOf('River SYN')), 2);
  assert.equal(tab.rows[rowOf('River SYN')].label, 'River SYN');
  ok('a group row aggregates its member planes; a name no table carries adds nothing');

  // A membership edit moves an unnarrowed group's numbers under the same id
  // and label, so the label names no count. The narrowed case, which
  // keeps its frozen count, is checked with the keep-set below.
  const river = tab.rows[rowOf('River SYN')];
  loadGeneratorGroups(
    MEMBERSHIP.split('\n')
      .filter((line) => line !== 'BIRCH,River SYN')
      .join('\n'),
    NAME_MAPPING,
    undefined,
  );
  const shrunk = buildGeneratorTab({
    tables: [table(genData)],
    list,
    areas: null,
    isGroupTab: true,
  });
  const riverAt = shrunk.rows.findIndex((row) => row.groupValue === 'River SYN');
  assert.equal(
    shrunk.rows[riverAt].id,
    river.id,
    'a membership edit leaves the pinned id matching',
  );
  assert.equal(shrunk.rows[riverAt].label, river.label, 'so the label a pin froze names no count');
  assert.equal(shrunk.columns.find((c) => c.key === 'group.units').value(riverAt), 1);
  assert.equal(shrunk.columns.find((c) => c.key === 'stat.mean').value(riverAt), 10, 'ALDER alone');
  ok('a membership edit changes a generator group’s numbers and Units column, never its label');
  loadGeneratorGroups(MEMBERSHIP, NAME_MAPPING, undefined);

  // Membership is many-to-many (ALDER is in both groups) and neither column
  // nor note may read as a fleet figure: one unit in two groups counted twice
  // is exactly the number nobody wants to read here.
  for (const entry of tab.columns) {
    assert.ok(
      !/total|fleet/i.test(`${entry.key} ${entry.label}`),
      `column ${entry.key} reads as a total`,
    );
  }
  assert.equal(column('group.units').cellClass, 'count');
  assert.ok(
    tab.notes.some((note) => /do not sum to a fleet/.test(note)),
    tab.notes.join(' '),
  );
  ok('no column or note reads as a fleet total — membership is many-to-many');

  // Row ids: a third scheme, distinct from the attribute group-by's
  // `${column}=${bucket}` and from the area groups tab's `Group=` ids.
  const attributeTab = buildGeneratorTab({
    tables: [table(genData)],
    list,
    areas: null,
    groupBy: 'list.FuelType',
  });
  const groupIds = tab.rows.map((row) => row.id);
  const attributeIds = attributeTab.rows.map((row) => row.id);
  assert.ok(groupIds.every((id) => id.includes(`${GENERATOR_GROUP_BY}=`)));
  assert.ok(
    attributeIds.every((id) => /FuelType=/.test(id) && !id.includes(`${GENERATOR_GROUP_BY}=`)),
  );
  assert.deepEqual(
    groupIds.filter((id) => attributeIds.includes(id)),
    [],
  );
  ok('group row ids carry their own scheme and collide with no attribute-group id');

  // An attribute bucket follows the authored group's rule: unnarrowed,
  // its members come from the GeneratorList on every draw, so a list loaded
  // later moves its line under an unchanged id and its label names no count.
  const gas = attributeTab.rows.find((row) => row.groupValue === 'Gas');
  assert.equal(gas.label, 'Gas');
  const narrowedGas = buildGeneratorTab({
    tables: [table(genData)],
    list,
    areas: null,
    groupBy: 'list.FuelType',
    keep: new Set([browseJoinKey('c1', 'generator Generation (MWh)', 'ALDER')]),
  }).rows.find((row) => row.groupValue === 'Gas');
  assert.deepEqual(narrowedGas.members, ['ALDER']);
  assert.equal(narrowedGas.label, 'Gas (1 unit)');
  const relisted = buildGeneratorTab({
    tables: [table(genData)],
    list: listOf([
      'ALDER,101,AREA_AV,Gas,200',
      'BIRCH,102,AREA_NV,Gas,100',
      'CEDAR,103,AREA_AV,Solar,0',
    ]),
    areas: null,
    groupBy: 'list.FuelType',
  });
  const gasAt = relisted.rows.findIndex((row) => row.groupValue === 'Gas');
  assert.equal(relisted.rows[gasAt].id, gas.id, 'the list change keeps the id');
  assert.equal(relisted.rows[gasAt].label, gas.label, 'and the label');
  assert.equal(
    relisted.columns.find((c) => c.key === 'stat.mean').value(gasAt),
    30,
    'ALDER + BIRCH',
  );
  ok(
    'a generator bucket names no count its list can outdate; a narrowed one keeps its frozen count',
  );

  // A narrowed group freezes its membership, exactly as a narrowed attribute
  // bucket does: the keep-set is the drawer's column filters, arrived as
  // survivors of the ungrouped tab.
  const keep = new Set([browseJoinKey('c1', 'generator Generation (MWh)', 'ALDER')]);
  const narrowedTab = buildGeneratorTab({
    tables: [table(genData)],
    list,
    areas: null,
    isGroupTab: true,
    keep,
  });
  const narrowedRiver = narrowedTab.rows.find((row) => row.groupValue === 'River SYN');
  assert.ok(narrowedRiver);
  assert.deepEqual(narrowedRiver.members, ['ALDER']);
  assert.equal(narrowedRiver.label, 'River SYN (1 unit)', 'its count is frozen with its members');
  assert.match(narrowedRiver.id, /m=/);
  const narrowedAt = narrowedTab.rows.indexOf(narrowedRiver);
  assert.equal(narrowedTab.columns.find((c) => c.key === 'stat.mean').value(narrowedAt), 10);
  ok('a keep-set narrows a group to its survivors and freezes them onto the row');

  // The area scope joins through the list, exactly as the attribute group-by:
  // BIRCH is River SYN but AREA_NV, so AREA_AV-only leaves ALDER's 10.
  const areaTab = buildGeneratorTab({
    tables: [table(genData)],
    list,
    areas: new Set(['AREA_AV']),
    isGroupTab: true,
  });
  const avaRiver = areaTab.rows.find((row) => row.groupValue === 'River SYN');
  assert.ok(avaRiver);
  assert.deepEqual(avaRiver.members, ['ALDER']);
  const avaAt = areaTab.rows.indexOf(avaRiver);
  assert.equal(areaTab.columns.find((c) => c.key === 'stat.mean').value(avaAt), 10);
  ok('the area scope narrows group membership through the same list join');

  // Intensive quantity: the whole tab refuses with the reason, keeping its
  // columns, exactly as the area groups tab does for an ungroupable metric.
  const lmpTab = buildGeneratorTab({
    tables: [table({ ...genData, quantity: 'LMP ($/MWh)' })],
    list,
    areas: null,
    isGroupTab: true,
  });
  assert.equal(lmpTab.rows.length, 0);
  assert.ok(lmpTab.columns.length > 0);
  assert.ok(
    lmpTab.notes.some((note) => /\$\/MWh/.test(note)),
    lmpTab.notes.join(' '),
  );
  ok('an intensive quantity refuses the groups tab with the domain reason');

  // No membership loaded: the tab still exists with its action, and says
  // what to do rather than showing an empty grid.
  clearGeneratorGroups();
  const emptyTab = buildGeneratorTab({
    tables: [table(genData)],
    list,
    areas: null,
    isGroupTab: true,
  });
  assert.equal(emptyTab.rows.length, 0);
  assert.deepEqual(emptyTab.actions, [{ id: 'edit-groups', label: 'Edit Groups…' }]);
  assert.ok(emptyTab.notes.some((note) => /No generator groups/.test(note)));
  ok('with no membership loaded the tab says so and keeps the editor action');

  // ------------------------------------------- the resolver draws group rows
  loadGeneratorGroups(MEMBERSHIP, NAME_MAPPING, undefined);
  const NO_HOUR_FILTERS = {
    months: null,
    daysOfMonth: null,
    hoursOfDay: null,
    daysOfWeek: null,
    seasons: null,
    tou: null,
  };
  const drawGen = (specish, data = genData) =>
    resolveGeneratorSeries(specish, data, NO_HOUR_FILTERS, createSeriesBuffers(), {
      name: 'river',
      detail: 'river',
      tableLabel: 'Case 1 · Generation (MWh)',
      color: '#000000',
    });

  assert.equal(
    drawGen({
      caseId: 'c1',
      source: { kind: 'generator', quantity: 'Generation (MWh)' },
      subject: { groupBy: GENERATOR_GROUP_BY, value: 'River SYN' },
    }).stats.mean,
    30,
  );
  ok('a group subject draws the aggregate over the map’s membership, with no list loaded');

  assert.equal(
    drawGen({
      caseId: 'c1',
      source: { kind: 'generator', quantity: 'Generation (MWh)' },
      subject: {
        groupBy: GENERATOR_GROUP_BY,
        value: 'River SYN',
        members: ['ALDER'],
      },
    }).stats.mean,
    10,
  );
  ok('a frozen member set is drawn as itself — the pin’s truth, not the live map');

  const refused = drawGen({
    caseId: 'c1',
    source: { kind: 'generator', quantity: 'Generation (MWh)' },
    subject: { groupBy: GENERATOR_GROUP_BY, value: 'No Such Group SYN' },
  });
  assert.equal(refused.values, null);
  assert.match(refused.refusal ?? '', /No unit of group/);
  ok('a group whose units this table does not carry refuses by name');

  const intensive = drawGen(
    {
      caseId: 'c1',
      source: { kind: 'generator', quantity: 'LMP ($/MWh)' },
      subject: { groupBy: GENERATOR_GROUP_BY, value: 'River SYN' },
    },
    { ...genData, quantity: 'LMP ($/MWh)' },
  );
  assert.equal(intensive.values, null);
  assert.match(intensive.refusal ?? '', /\$\/MWh/);
  ok('an intensive quantity refuses a group subject with the domain reason');

  // ------------------------------------ % of range on the groups tab
  //
  // A group divides by its contributing members' summed caps, the rule a
  // group-by bucket follows. River SYN = ALDER 10 + BIRCH 20 over 200 + 100;
  // Plant SYN = CEDAR 30 + ALDER 10 over ALDER's 200 alone (CEDAR's 0 is no
  // cap).
  {
    const { declareGeneratorTabs } = await import('../src/tables/generator/ui/browse.ts');
    const { savePins, restorePins } = await import('../src/ui/browse-model.ts');
    const pctTab = (extra = {}) =>
      buildGeneratorTab({
        tables: [table(genData)],
        list,
        areas: null,
        isGroupTab: true,
        perUnit: true,
        ...extra,
      });
    const meanOf = (built, group) => {
      const at = built.rows.findIndex((row) => row.groupValue === group);
      assert.ok(at >= 0, `the tab lists ${group}`);
      return built.columns.find((c) => c.key === 'stat.mean').value(at);
    };

    const pct = pctTab();
    const river = pct.rows.find((row) => row.groupValue === 'River SYN');
    assert.equal(river.unit, '%');
    assert.equal(river.perUnit, true);
    assert.ok(river.id.includes('p.u.'));
    assert.ok(Math.abs(meanOf(pct, 'River SYN') - 0.1) < 1e-6, '30 over 300');
    assert.ok(Math.abs(meanOf(pct, 'Plant SYN') - 0.2) < 1e-6, '40 over 200');
    assert.equal(pct.columns.find((c) => c.key === 'stat.mean').cellClass, 'ratio');
    assert.equal(pct.columns.find((c) => c.key === 'stat.n').value(0), HOURS);
    ok('a generator group’s % of range divides by its members’ summed caps, as ratios');

    // The same members as a Fuel Type bucket read the same number.
    const sameFuel = buildGeneratorTab({
      tables: [table(genData)],
      list: listOf([
        'ALDER,101,AREA_AV,Gas,200',
        'BIRCH,102,AREA_NV,Gas,100',
        'CEDAR,103,AREA_AV,Solar,0',
      ]),
      areas: null,
      groupBy: 'list.FuelType',
      perUnit: true,
    });
    assert.equal(meanOf(sameFuel, 'Gas'), meanOf(pct, 'River SYN'));
    ok('a group and a Fuel Type bucket with the same members agree exactly');

    // A member the keep-set drops adds no capacity: ALDER alone, 10 over 200.
    const kept = pctTab({
      keep: new Set([browseJoinKey('c1', 'generator Generation (MWh)', 'ALDER')]),
    });
    assert.ok(Math.abs(meanOf(kept, 'River SYN') - 0.05) < 1e-6);
    // An absent member likewise: BIRCH has no hours, so River is ALDER's.
    const absent = buildGeneratorTab({
      tables: [table(generatorTable(['ALDER', 'BIRCH', 'CEDAR'], (i) => (i + 1) * 10, ['BIRCH']))],
      list,
      areas: null,
      isGroupTab: true,
      perUnit: true,
    });
    assert.ok(Math.abs(meanOf(absent, 'River SYN') - 0.05) < 1e-6);
    ok('a filtered-out or absent member contributes no capacity');

    const noList = pctTab({ list: undefined });
    assert.equal(noList.rows.length, 0);
    assert.ok(noList.columns.length > 0, 'the columns stay');
    assert.ok(
      noList.notes.some((note) => /PSSEMaxCap\(MW\)/.test(note) && /GENERATORLIST/i.test(note)),
      noList.notes.join(' | '),
    );
    const absoluteNoList = buildGeneratorTab({
      tables: [table(genData)],
      list: undefined,
      areas: null,
      isGroupTab: true,
    });
    assert.ok(absoluteNoList.rows.length > 0, 'absolute values still need no list');
    ok('a power quantity’s % of range refuses the groups tab without GeneratorList');

    // Not a power unit: the group's own peak. A constant 30 is 1 every hour.
    const dollars = buildGeneratorTab({
      tables: [table({ ...genData, quantity: 'Fuel Cost ($)' })],
      list: undefined,
      areas: null,
      isGroupTab: true,
      perUnit: true,
    });
    assert.equal(meanOf(dollars, 'River SYN'), 1);
    ok('a non-power quantity divides a group by its own peak, list or not');

    // The drawn line divides by the same caps as the row, in percent.
    attachLookup(
      parseLookupCsv(
        generatorList([
          'ALDER,101,AREA_AV,Gas,200',
          'BIRCH,102,AREA_NV,Wind,100',
          'CEDAR,103,AREA_AV,Solar,0',
        ]),
        'GeneratorList.csv',
      ).rows,
    );
    try {
      const line = drawGen(specFromRow(river));
      assert.equal(line.unit, '%');
      assert.ok(Math.abs(line.stats.mean - 10) < 1e-4, `${line.stats.mean}`);
      assert.ok(line.rangeLabel?.includes('limit'), line.rangeLabel);
      const narrowed = drawGen(specFromRow(kept.rows.find((r) => r.groupValue === 'River SYN')));
      assert.ok(Math.abs(narrowed.stats.mean - 5) < 1e-4, 'the frozen member’s cap alone');
    } finally {
      clearLookups();
    }
    ok('a ticked % of range group line matches its drawer row');

    // A pin survives a bundle: saved against its Case index, restored with
    // the same id, so it is still the % of range row.
    const saved = JSON.parse(JSON.stringify(savePins([{ ref: river, color: '#000' }], ['c1'])));
    const [restored] = restorePins(saved, [{ id: 'c1' }]);
    assert.equal(restored.ref.id, river.id);
    assert.equal(restored.ref.perUnit, true);
    ok('a % of range group pin restores as the same row');

    const [, groupsTab] = declareGeneratorTabs({ tables: [] }, { tables: [] }, list, undefined);
    assert.equal(groupsTab.offersRange, true);
    ok('the Generator Groups tab offers % of range');

    // A summed unit with no usable max cap adds output but no capacity, so
    // the tab names it. CEDAR's cap is 0 and it sits in Plant SYN beside
    // ALDER's 200; River SYN is fully capped.
    const caplessNotes = (built) => built.notes.filter((note) => /summed unit/.test(note));
    assert.equal(caplessNotes(pct).length, 1, pct.notes.join(' | '));
    assert.match(caplessNotes(pct)[0], /^1 summed unit has no PSSEMaxCap\(MW\) above 0/);
    assert.match(caplessNotes(pct)[0], /\(CEDAR\)/);
    assert.match(caplessNotes(pct)[0], /over 100%/);
    ok('the groups tab names a summed unit with no max cap');

    // Group-by: CEDAR (cap 0) and DOGWOOD (unlisted) are summed into the
    // Case bucket beside capped units; the value is unchanged by the note.
    const byCase = buildGeneratorTab({
      tables: [table(genData)],
      list,
      areas: null,
      groupBy: 'case',
      perUnit: true,
    });
    assert.equal(caplessNotes(byCase).length, 1, byCase.notes.join(' | '));
    assert.match(caplessNotes(byCase)[0], /^2 summed units have .*\(CEDAR, DOGWOOD\)/);
    assert.ok(Math.abs(meanOf(byCase, byCase.rows[0].groupValue) - 100 / 300) < 1e-6);
    ok('a group-by names every capless unit it summed, and divides as before');

    // Silent: % of range off; a bucket that is capless throughout (it divides
    // by its peak); a non-power quantity; every summed unit capped.
    assert.equal(
      caplessNotes(
        buildGeneratorTab({ tables: [table(genData)], list, areas: null, isGroupTab: true }),
      ).length,
      0,
    );
    const solarOnly = buildGeneratorTab({
      tables: [table(generatorTable(['CEDAR'], () => 30))],
      list,
      areas: null,
      groupBy: 'list.FuelType',
      perUnit: true,
    });
    assert.equal(caplessNotes(solarOnly).length, 0, solarOnly.notes.join(' | '));
    assert.equal(caplessNotes(dollars).length, 0);
    const allCapped = pctTab({
      list: listOf([
        'ALDER,101,AREA_AV,Gas,200',
        'BIRCH,102,AREA_NV,Wind,100',
        'CEDAR,103,AREA_AV,Solar,50',
      ]),
    });
    assert.equal(caplessNotes(allCapped).length, 0, allCapped.notes.join(' | '));
    ok('no capless note when nothing can read over 100% because of one');

    const many = buildGeneratorTab({
      tables: [table(generatorTable(['ALDER', 'U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7'], () => 1))],
      list,
      areas: null,
      groupBy: 'case',
      perUnit: true,
    });
    assert.match(
      caplessNotes(many)[0],
      /^7 summed units have .*\(U1, U2, U3, U4, U5, and 2 more\)/,
    );
    ok('a long capless list names a handful and counts the rest');
  }

  // A Case bucket is every unit the table carries; a resolver that asked a
  // lookup column would find none. ALDER 10, BIRCH 20, CEDAR 30, DOGWOOD 40.
  assert.equal(
    drawGen({
      caseId: 'c1',
      source: { kind: 'generator', quantity: 'Generation (MWh)' },
      subject: { groupBy: CASE_GROUP_BY, value: 'Case 1' },
    }).stats.mean,
    100,
  );
  assert.equal(
    drawGen({
      caseId: 'c1',
      source: { kind: 'generator', quantity: 'Generation (MWh)' },
      subject: { groupBy: CASE_GROUP_BY, value: 'Case 1', members: ['ALDER', 'CEDAR'] },
    }).stats.mean,
    40,
  );
  ok('a Case subject draws every unit the table carries, and its frozen set when it has one');

  // …and the tab that produces such a row agrees with the resolver.
  const genByCase = buildGeneratorTab({
    tables: [table(genData)],
    list,
    areas: null,
    groupBy: 'case',
  });
  assert.equal(genByCase.rows.length, 1);
  assert.equal(genByCase.rows[0].groupBy, CASE_GROUP_BY);
  assert.equal(genByCase.rows[0].groupValue, 'Case 1');
  assert.equal(genByCase.columns.find((c) => c.key === 'group.units').value(0), 4);
  assert.equal(genByCase.columns.find((c) => c.key === 'stat.mean').value(0), 100);
  ok('and the Generator tab grouped by Case produces exactly that row');

  // ---------------------------------------- the groups tab is a paired tab
  //
  // The pairing is a property the caller states, not a tab name.
  const scopes = createBrowseScopes();
  const genRows = [
    {
      key: 'k1',
      caseId: 'c1',
      slotKey: 'generator Generation (MWh)',
      data: { quantity: 'Generation (MWh)', year: 2031, tou: new Uint8Array(HOURS) },
    },
    {
      key: 'k2',
      caseId: 'c1',
      slotKey: 'generator Fuel Cost ($)',
      data: { quantity: 'Fuel Cost ($)', year: 2031, tou: new Uint8Array(HOURS) },
    },
  ];
  const names = new Map([['c1', { name: 'Case 1', label: 'Case 1' }]]);
  const cases = ['c1'];
  const noFilters = {
    months: null,
    daysOfMonth: null,
    hoursOfDay: null,
    daysOfWeek: null,
    seasons: null,
    tou: null,
  };
  scopes.set('generator', 'Generation (MWh)');
  assert.equal(
    scopes.scope(genRows, 'generator-groups', cases, noFilters, names, 'generator').variable,
    'Generation (MWh)',
  );
  ok('a groups tab follows its entity tab’s variable — the pairing is the caller’s property');
  // Unpaired, the same tab would have taken its own first offered quantity
  // (alphabetically the other one), which is what makes the assertion above
  // a test of the pairing rather than of the sort.
  assert.equal(
    createBrowseScopes().scope(genRows, 'generator-groups', cases, noFilters, names).variable,
    'Fuel Cost ($)',
  );
  ok('a tab with no pairing stated falls back to its own first quantity');

  // ------------------------------ a groups tab never OFFERS what it refuses
  //
  // A quantity that cannot be summed across generators is not listed, not
  // pickable, and not reachable through the pairing.
  const { combinesAcrossGenerators } = await import('../src/tables/generator/rules.ts');
  assert.equal(combinesAcrossGenerators('Generation (MWh)'), true);
  assert.equal(combinesAcrossGenerators('Dispatch (MW)'), true);
  assert.equal(combinesAcrossGenerators('LMP ($/MWh)'), false, 'intensive');
  assert.equal(combinesAcrossGenerators('Capacity Factor (%)'), false, 'intensive');
  // The three polysemous GridView headers state no unit at all, which is
  // why the groups tab cannot sum them -- see data/generator/quantity-rules.json.
  assert.equal(combinesAcrossGenerators('Sec. Fuel Consmpt. / Pumping Cost'), false, 'no unit');
  ok('combinesAcrossGenerators answers for a whole quantity, before one is picked');

  const mixedRows = [
    ...genRows,
    {
      key: 'k3',
      caseId: 'c1',
      slotKey: 'generator LMP ($/MWh)',
      data: { quantity: 'LMP ($/MWh)', year: 2031, tou: new Uint8Array(HOURS) },
    },
    {
      key: 'k4',
      caseId: 'c1',
      slotKey: 'generator Commit Status',
      data: { quantity: 'Commit Status', year: 2031, tou: new Uint8Array(HOURS) },
    },
  ];
  const offeredScopes = createBrowseScopes();
  const unitsScope = offeredScopes.scope(mixedRows, 'generator', cases, noFilters, names);
  assert.deepEqual(unitsScope.variables, [
    'Commit Status',
    'Fuel Cost ($)',
    'Generation (MWh)',
    'LMP ($/MWh)',
  ]);
  const groupsScope = offeredScopes.scope(
    mixedRows,
    'generator-groups',
    cases,
    noFilters,
    names,
    'generator',
    combinesAcrossGenerators,
  );
  assert.deepEqual(groupsScope.variables, ['Fuel Cost ($)', 'Generation (MWh)']);
  ok('the units tab offers every loaded quantity; the groups tab offers only the summable ones');

  // With the entity tab on LMP, the groups tab falls back to its own first
  // OFFERED quantity, and its tables follow that.
  offeredScopes.set('generator', 'LMP ($/MWh)');
  const followed = offeredScopes.scope(
    mixedRows,
    'generator-groups',
    cases,
    noFilters,
    names,
    'generator',
    combinesAcrossGenerators,
  );
  assert.equal(followed.variable, 'Fuel Cost ($)');
  assert.deepEqual(
    followed.tables.map((entry) => entry.slotKey),
    ['generator Fuel Cost ($)'],
  );
  ok('a refused quantity is not carried onto the groups tab by the pairing');

  clearGeneratorGroups();
}

// ------------------------------------------- filter context into a group
//
// The filter chooses which units enter a bucket, the grouped tab SAYS which
// filters produced its rows, and a ticked row carries that frozen.

{
  // The constraint text is contract, not copy: it is what a context cell and
  // the Selected tab print, and what an analyst reads as the difference
  // between “the units that entered this sum” and “this sum”.
  assert.equal(filterConstraint({ kind: 'text', text: ' AREA_AE ' }), 'contains AREA_AE');
  assert.equal(filterConstraint({ kind: 'range', min: 5, max: null }), '≥ 5');
  assert.equal(filterConstraint({ kind: 'range', min: null, max: 500 }), '≤ 500');
  assert.equal(filterConstraint({ kind: 'range', min: 100, max: 500 }), '100 – 500');
  ok('a constraint states its bounds exactly: contains X, ≥ 5, ≤ 500, 100 – 500');
}

{
  // Filters apply BEFORE grouping, over the ungrouped rows. The keep-set is
  // computed from the tab's ungrouped form — the only place the filtered
  // column exists — and the grouped build consumes survivors as join keys.
  const list = listOf([
    'ALDER,101,AREA_AV,Gas,200',
    'BIRCH,102,AREA_NV,Wind,100',
    'CEDAR,103,AREA_AV,Solar,50',
  ]);
  const genData = generatorTable(['ALDER', 'BIRCH', 'CEDAR', 'DOGWOOD'], (i) => (i + 1) * 10);
  const base = buildGeneratorTab({ tables: [table(genData)], list, areas: null });
  const filters = new Map([['list.Area Name', { kind: 'text', text: 'AREA_AV' }]]);
  const keep = keptRowKeys(base, { sort: null, filters });
  assert.ok(keep);
  assert.deepEqual(
    [...keep],
    [
      browseJoinKey('c1', 'generator Generation (MWh)', 'ALDER'),
      browseJoinKey('c1', 'generator Generation (MWh)', 'CEDAR'),
    ],
  );
  ok(
    'the keep-set is the ungrouped rows that pass the filter — BIRCH and the listless DOGWOOD stay out',
  );

  const grouped = buildGeneratorTab({
    tables: [table(genData)],
    list,
    areas: null,
    groupBy: 'list.FuelType',
    keep,
  });
  assert.deepEqual(
    grouped.rows.map((r) => r.groupValue),
    ['Gas', 'Solar'],
  );
  const column = (key) => grouped.columns.find((c) => c.key === key);
  assert.equal(column('group.units').value(0), 1);
  assert.equal(column('group.units').value(1), 1);
  assert.equal(column('stat.mean').value(0), 10);
  assert.equal(column('stat.mean').value(1), 30);
  ok(
    'a filter on Area chooses which units enter each bucket: Wind never enters, and a bucket with no survivors is no row',
  );

  // The same call the drawer makes: the grouped tab comes back restating the
  // consumed filters, and its own rows carry the context frozen.
  const wrapped = carryFilterContext(grouped, base, { sort: null, filters });
  const contextCol = wrapped.columns.find((c) => c.key === 'context.list.Area Name');
  assert.ok(contextCol);
  assert.equal(contextCol.label, 'Area Name (filter)');
  assert.equal(contextCol.context, true);
  assert.equal(contextCol.value(0), 'contains AREA_AV');
  assert.equal(contextCol.value(1), 'contains AREA_AV');
  assert.deepEqual(wrapped.consumedFilters, new Set(['list.Area Name']));
  for (const row of wrapped.rows) {
    assert.deepEqual(row.filterContext, [
      { key: 'list.Area Name', label: 'Area Name', constraint: 'contains AREA_AV' },
    ]);
  }
  ok(
    'a filter the build consumed becomes a context column on every row, and the tab says which keys it consumed',
  );

  // Frozen at tick time: the context is data on the row, so clearing the
  // filters cannot rewrite what a ticked group was built under.
  const cleared = new Map();
  const regrouped = carryFilterContext(
    buildGeneratorTab({ tables: [table(genData)], list, areas: null, groupBy: 'list.FuelType' }),
    base,
    { sort: null, filters: cleared },
  );
  assert.equal(regrouped.rows[0].filterContext, undefined);
  assert.deepEqual(wrapped.rows[0].filterContext, [
    { key: 'list.Area Name', label: 'Area Name', constraint: 'contains AREA_AV' },
  ]);
  ok('a ticked row keeps the context it was built under even after the filters clear');
}

{
  // Not re-applied after: 10 and 12 pass a ≤ 15 bound, their sum of 22 does
  // not, and the grouped row stays because the build consumed the filter.
  const list = listOf(['ALDER,101,AREA_AV,Gas,200', 'CEDAR,103,AREA_AV,Gas,50']);
  const genData = generatorTable(['ALDER', 'CEDAR'], (i) => (i === 0 ? 10 : 12));
  const base = buildGeneratorTab({ tables: [table(genData)], list, areas: null });
  const filters = new Map([['stat.mean', { kind: 'range', min: null, max: 15 }]]);
  const keep = keptRowKeys(base, { sort: null, filters });
  assert.equal(keep?.size, 2);
  const grouped = carryFilterContext(
    buildGeneratorTab({
      tables: [table(genData)],
      list,
      areas: null,
      groupBy: 'list.FuelType',
      keep,
    }),
    base,
    { sort: null, filters },
  );
  assert.equal(grouped.rows.length, 1);
  assert.equal(grouped.columns.find((c) => c.key === 'stat.mean').value(0), 22);
  const view = { sort: null, filters };
  assert.equal(visibleRows(grouped, view).length, 1);
  ok('a consumed filter is not re-applied: the aggregate of two ≤ 15 units stays on screen at 22');
  // The control: without the consumed-set the same filter WOULD re-apply and
  // empty the tab — the one filter, two questions, this mechanism prevents.
  assert.equal(visibleRows({ ...grouped, consumedFilters: undefined }, view).length, 0);
  ok('the skip is what keeps it: the same tab without consumedFilters drops the row');
}

{
  // A filter on a grouped-only column was never consumed and still applies
  // after the build — the unit count is a fact about the bucket, not about
  // the units, and there is nothing to filter before the buckets exist.
  const list = listOf(['ALDER,101,AREA_AV,Gas,200', 'CEDAR,103,AREA_AV,Gas,50']);
  const genData = generatorTable(['ALDER', 'CEDAR'], (i) => (i === 0 ? 10 : 12));
  const base = buildGeneratorTab({ tables: [table(genData)], list, areas: null });
  const filters = new Map([['group.units', { kind: 'range', min: 3, max: null }]]);
  assert.equal(keptRowKeys(base, { sort: null, filters }), undefined);
  const grouped = carryFilterContext(
    buildGeneratorTab({ tables: [table(genData)], list, areas: null, groupBy: 'list.FuelType' }),
    base,
    { sort: null, filters },
  );
  assert.equal(grouped.consumedFilters, undefined);
  assert.equal(visibleRows(grouped, { sort: null, filters }).length, 0);
  ok('a filter on a grouped-only column (unit count) filters the buckets, post-pass as before');
}

{
  // Area groups carry a filter the same way: the keep-set chooses which
  // areas enter a group's aggregate.
  setGroupings('Name,Grouping\nAREA_AV,Northwest\nAREA_NV,Desert');
  const areaData = areaTable(['AREA_AV', 'AREA_NV'], ['Load (MWh)'], (a) => (a + 1) * 10);
  const base = buildAreaTab({
    tables: [areaTableIn(areaData, 'Load (MWh)')],
    variable: 'Load (MWh)',
    areas: null,
  });
  const filters = new Map([['entity', { kind: 'text', text: 'AREA_AV' }]]);
  const keep = keptRowKeys(base, { sort: null, filters });
  const grouped = buildAreaTab({
    tables: [areaTableIn(areaData, 'Load (MWh)')],
    variable: 'Load (MWh)',
    areas: null,
    groupBy: 'Group',
    keep,
  });
  assert.deepEqual(
    grouped.rows.map((r) => r.groupValue),
    ['Northwest'],
  );
  const nw = grouped.rows[0];
  assert.equal(grouped.columns.find((c) => c.key === 'group.areas').value(0), 1);
  assert.equal(grouped.columns.find((c) => c.key === 'stat.mean').value(0), 10);
  ok('an area filter chooses which areas enter a group: Desert has no survivors and is no row');
}

{
  // THE PIN DRAWS WHAT THE TABLE SAID: a Coal row filtered to one AREA_AE
  // unit must draw that unit, not all coal, including after the live filter
  // clears.
  const rows = [
    'ALDER,101,AREA_AE,Coal,200',
    'BIRCH,102,AREA_NV,Coal,120',
    'CEDAR,103,AREA_AE,Gas,80',
  ];
  const list = listOf(rows);
  const genData = generatorTable(['ALDER', 'BIRCH', 'CEDAR'], (i) => (i + 1) * 10);
  const filters = new Map([['list.Area Name', { kind: 'text', text: 'AREA_AE' }]]);
  const base = buildGeneratorTab({ tables: [table(genData)], list, areas: null });
  const keep = keptRowKeys(base, { sort: null, filters });
  const grouped = buildGeneratorTab({
    tables: [table(genData)],
    list,
    areas: null,
    groupBy: 'list.FuelType',
    keep,
  });
  const coal = grouped.rows.find((r) => r.groupValue === 'Coal');
  assert.ok(coal);
  assert.deepEqual(coal.members, ['ALDER'], 'BIRCH is coal but AREA_NV, so it never entered');
  const spec = specFromRow(coal);
  assert.ok(!('entity' in spec.subject));
  assert.deepEqual(spec.subject.members, ['ALDER']);
  ok('a grouped row built under a filter freezes its member set, and the spec carries it');

  const NO_HOUR_FILTERS = {
    months: null,
    daysOfMonth: null,
    hoursOfDay: null,
    daysOfWeek: null,
    seasons: null,
    tou: null,
  };
  const drawGen = (specish) =>
    resolveGeneratorSeries(specish, genData, NO_HOUR_FILTERS, createSeriesBuffers(), {
      name: 'coal',
      detail: 'coal',
      tableLabel: 'Case 1 · Generation (MWh)',
      color: '#000000',
    });

  attachLookup(parseLookupCsv(generatorList(rows), 'GeneratorList.csv').rows);
  try {
    // ALDER is 10 every hour; all-coal would be 10 + BIRCH's 20 = 30.
    assert.equal(drawGen(spec).stats.mean, 10);
    ok('a pin ticked under a filter draws the filtered aggregate, not the whole bucket');

    // The live filter clears: the rebuilt tab's Coal row is a different row
    // with no member set, but the ticked ref is the frozen one and keeps
    // drawing the aggregate it was ticked under.
    const cleared = buildGeneratorTab({
      tables: [table(genData)],
      list,
      areas: null,
      groupBy: 'list.FuelType',
    });
    const liveCoal = cleared.rows.find((r) => r.groupValue === 'Coal');
    assert.ok(liveCoal);
    assert.equal(liveCoal.members, undefined);
    assert.notEqual(liveCoal.id, coal.id, 'two member sets under one label are two pins');
    assert.equal(drawGen(specFromRow(coal)).stats.mean, 10);
    ok('the pin still draws the filtered aggregate after the live filter is cleared');
    assert.equal(drawGen(specFromRow(liveCoal)).stats.mean, 30);
    ok('a subject with no member set keeps today\u2019s meaning: the whole bucket');

    // A frozen member the study lacks contributes nothing and never widens
    // the set; all members gone is the empty-bucket refusal.
    const ghost = drawGen({ ...spec, subject: { ...spec.subject, members: ['ALDER', 'GHOST'] } });
    assert.equal(ghost.stats.mean, 10);
    assert.equal(ghost.n, HOURS);
    ok('a frozen member gone from the study simply does not contribute');
    const emptied = drawGen({ ...spec, subject: { ...spec.subject, members: ['GHOST'] } });
    assert.equal(emptied.values, null);
    assert.match(emptied.refusal, /No generators in .* match FuelType = "Coal"/);
    ok('a member set the study no longer carries refuses as the empty bucket, not silently');
  } finally {
    clearLookups();
  }
}

{
  // The same for area groups: the pin keeps drawing the filtered areas after
  // the filter clears.
  setGroupings('Name,Grouping\nAREA_AV,Northwest\nAREA_NV,Northwest');
  const areaData = areaTable(['AREA_AV', 'AREA_NV'], ['Load (MWh)'], (a) => (a + 1) * 10);
  const filters = new Map([['entity', { kind: 'text', text: 'AREA_AV' }]]);
  const base = buildAreaTab({
    tables: [areaTableIn(areaData, 'Load (MWh)')],
    variable: 'Load (MWh)',
    areas: null,
  });
  const keep = keptRowKeys(base, { sort: null, filters });
  const grouped = buildAreaTab({
    tables: [areaTableIn(areaData, 'Load (MWh)')],
    variable: 'Load (MWh)',
    areas: null,
    groupBy: 'Group',
    keep,
  });
  const nw = grouped.rows.find((r) => r.groupValue === 'Northwest');
  assert.ok(nw);
  assert.deepEqual(nw.members, ['AREA_AV']);

  const NO_HOUR_FILTERS = {
    months: null,
    daysOfMonth: null,
    hoursOfDay: null,
    daysOfWeek: null,
    seasons: null,
    tou: null,
  };
  const drawArea = (specish) =>
    resolveAreaSeries(specish, areaData, NO_HOUR_FILTERS, createSeriesBuffers(), {
      name: 'nw',
      detail: 'nw',
      tableLabel: 'Case 1 · Load (MWh)',
      color: '#000000',
    });

  // AREA_AV is 10 every hour; the whole group is 10 + AREA_NV's 20 = 30.
  assert.equal(drawArea(specFromRow(nw)).stats.mean, 10);
  const live = buildAreaTab({
    tables: [areaTableIn(areaData, 'Load (MWh)')],
    variable: 'Load (MWh)',
    areas: null,
    groupBy: 'Group',
  });
  const liveNw = live.rows.find((r) => r.groupValue === 'Northwest');
  assert.ok(liveNw);
  assert.equal(liveNw.members, undefined);
  assert.equal(drawArea(specFromRow(nw)).stats.mean, 10);
  assert.equal(drawArea(specFromRow(liveNw)).stats.mean, 30);
  ok(
    'an area group pinned under a filter draws the kept areas, before and after the filter clears',
  );
}

// ---------------------------------------------------------- the CSV export
//
// Full precision (a ratio as the ratio), and `#` provenance lines stating
// only what was applied.

{
  const tab = fakeTab(
    [
      { key: 'name', label: 'Name', kind: 'text' },
      { key: 'mwh', label: 'MWh', kind: 'number', computed: true },
      { key: 'cf', label: 'CF (%)', kind: 'number', computed: true, cellClass: 'ratio' },
    ],
    [
      ['ALDER', 1234567.4, 0.4312],
      ['BIRCH', 42, 0.9],
      ['CEDAR', null, null],
    ],
  );
  const meta = {
    hourFilter: 'all hours',
    variable: 'the dropdown’s variable',
    caseLabel: CASE_LABELS,
  };
  const lines = browseTableCsv(tab, NO_VIEW, meta).split('\n');

  assert.deepEqual(lines.slice(0, 4), [
    '# Cases: Case 1',
    '# Variable: Generation (MWh)',
    '# Hours: all hours',
    '',
  ]);
  ok('the descriptor opens the file — cases, variable, hour filter — then a blank line');
  assert.equal(lines[4], 'Name,MWh,CF (%)');
  ok('the header row is the column labels, in column order');

  assert.equal(lines[5], 'ALDER,1234567.4,0.4312');
  assert.equal(lines[7], 'CEDAR,,');
  assert.equal(lines[lines.length - 1], '');
  ok('a row is its cells in order, a blank cell is an empty field, and the file ends on a newline');

  assert.ok(!lines.some((line) => line.includes('1,234,567')));
  assert.ok(!lines.some((line) => line.includes('43%')));
  assert.ok(lines[5].includes('1234567.4') && lines[5].includes('0.4312'));
  ok('export is not paint: the same cell the table renders 1,234,567 and 43% leaves as the double');

  // The variable line comes from the ROWS when they can answer — the
  // dropdown’s value is only the fallback, so the descriptor describes the
  // file’s own contents and not a control’s coincidental state.
  assert.ok(lines[1].includes('Generation (MWh)'));
  assert.ok(!lines[1].includes('dropdown'));

  const asc = browseTableCsv(
    tab,
    { ...NO_VIEW, sort: { key: 'mwh', direction: 'asc' } },
    meta,
  ).split('\n');
  assert.deepEqual([asc[5], asc[6], asc[7]], ['BIRCH,42,0.9', 'ALDER,1234567.4,0.4312', 'CEDAR,,']);
  ok('the file follows the view’s sort, blanks last, exactly as the table shows it');

  const filtered = browseTableCsv(
    tab,
    {
      ...NO_VIEW,
      filters: new Map([
        ['name', { kind: 'text', text: 'ALD' }],
        ['mwh', { kind: 'range', min: 40, max: null }],
        ['gone', { kind: 'text', text: 'x' }],
      ]),
    },
    meta,
  );
  assert.ok(filtered.includes('# Column filters: Name: contains ALD; MWh: ≥ 40'));
  assert.ok(!filtered.includes('gone'));
  assert.ok(!filtered.includes('BIRCH'));
  ok(
    'a stated filter carries the context cell’s own constraint text, a stale key is stated nowhere, and the row it excluded is not in the file',
  );

  const empty = browseTableCsv(
    tab,
    { ...NO_VIEW, filters: new Map([['name', { kind: 'text', text: 'zzz' }]]) },
    meta,
  ).split('\n');
  assert.deepEqual([empty[0], empty[1]], ['# Cases: (none)', `# Variable: ${meta.variable}`]);
  ok('an empty export says (none) for cases and falls back to the dropdown’s variable');
}

{
  // Quoting: a field carrying the delimiters is quoted and its quotes
  // double, per RFC 4180 — an unquoted comma would silently split one
  // entity into two columns in every reader that opens the file.
  const quoted = fakeTab(
    [{ key: 'name', label: 'Name', kind: 'text' }],
    [['A, B'], ['Say "hi"'], ['plain']],
  );
  const lines = browseTableCsv(quoted, NO_VIEW, {
    hourFilter: 'all hours',
    variable: 'v',
    caseLabel: CASE_LABELS,
  }).split('\n');
  assert.deepEqual([lines[5], lines[6], lines[7]], ['"A, B"', '"Say ""hi"""', 'plain']);
  ok('a field with a comma or a quote is quoted and its quotes double; a plain one stays bare');
}

{
  // The paint cap does not cap the export, or its descriptor would describe
  // rows it does not contain.
  const MANY = 350;
  const many = fakeTab(
    [{ key: 'name', label: 'Name', kind: 'text' }],
    Array.from({ length: MANY }, (_, index) => [`G${index}`]),
  );
  const lines = browseTableCsv(many, NO_VIEW, {
    hourFilter: 'all hours',
    variable: 'v',
    caseLabel: CASE_LABELS,
  })
    .trimEnd()
    .split('\n');
  assert.equal(lines.length, MANY + 5);
  assert.equal(lines[5], 'G0');
  assert.equal(lines[lines.length - 1], `G${MANY - 1}`);
  ok('every visible row is written — the on-screen row cap is paint, not contents');
}

{
  // A grouped export: the group-by and the CONSUMED filter are stated at the
  // top, and the context column that restates the filter travels as a
  // column — the file’s two halves say the same thing the table’s do.
  const list = listOf([
    'ALDER,101,AREA_AE,Coal,200',
    'BIRCH,102,AREA_NV,Coal,120',
    'CEDAR,103,AREA_AE,Gas,80',
  ]);
  const genData = generatorTable(['ALDER', 'BIRCH', 'CEDAR'], (index) => (index + 1) * 10);
  const filters = new Map([['list.Area Name', { kind: 'text', text: 'AREA_AE' }]]);
  const base = buildGeneratorTab({ tables: [table(genData)], list, areas: null });
  const grouped = carryFilterContext(
    buildGeneratorTab({
      tables: [table(genData)],
      list,
      areas: null,
      groupBy: 'list.FuelType',
      keep: keptRowKeys(base, { sort: null, filters }),
    }),
    base,
    { sort: null, filters },
  );
  const csv = browseTableCsv(
    grouped,
    { sort: null, filters, groupBy: 'list.FuelType' },
    {
      hourFilter: 'all hours',
      variable: 'v',
      caseLabel: CASE_LABELS,
    },
  );
  const lines = csv.split('\n');
  assert.ok(csv.includes('# Grouped by: FuelType'));
  assert.ok(csv.includes('# Column filters: Area Name: contains AREA_AE'));
  assert.ok(lines[6].includes('Area Name (filter)'));
  assert.ok(lines[7].includes('contains AREA_AE'));
  ok(
    'a grouped export states the group-by and the consumed filter, and carries the context column as a column',
  );

  // Per-unit: the descriptor says so, because a p.u. number under a plain
  // header is a number whose denominator the file otherwise hides.
  const puTab = buildGeneratorTab({ tables: [table(genData)], list, areas: null, perUnit: true });
  const puCsv = browseTableCsv(puTab, NO_VIEW, {
    hourFilter: 'all hours',
    variable: 'v',
    caseLabel: CASE_LABELS,
  });
  assert.ok(puCsv.includes('# % of range: values are ratios of range'), puCsv);
  ok('a % of range export says so above the header');
}

{
  // The golden stats file, over a plain, a sorted and filtered, a grouped
  // and two % of range tabs. The descriptor's lines moved into a shared
  // function; this pins that every byte but the `% of range` line stayed.
  const list = listOf([
    'ALDER,101,AREA_AE,Coal,200',
    'BIRCH,102,AREA_NV,Coal,120',
    'CEDAR,103,AREA_AE,Gas,80',
  ]);
  const genData = generatorTable(['ALDER', 'BIRCH', 'CEDAR'], (index) => (index + 1) * 10);
  const meta = { hourFilter: 'Jan; HE 1-6', variable: 'Generation (MWh)', caseLabel: CASE_LABELS };
  const filters = new Map([['list.Area Name', { kind: 'text', text: 'AREA_AE' }]]);
  const base = buildGeneratorTab({ tables: [table(genData)], list, areas: null });
  const grouped = carryFilterContext(
    buildGeneratorTab({
      tables: [table(genData)],
      list,
      areas: null,
      groupBy: 'list.FuelType',
      keep: keptRowKeys(base, { sort: null, filters }),
    }),
    base,
    { sort: null, filters },
  );
  const pu = buildGeneratorTab({ tables: [table(genData)], list, areas: null, perUnit: true });
  const mixed = { ...base, rows: [...base.rows.slice(0, 1), ...pu.rows.slice(1)] };
  const files = [
    browseTableCsv(base, NO_VIEW, meta),
    browseTableCsv(
      base,
      {
        sort: { key: base.columns[1].key, direction: 'desc' },
        filters: new Map([['list.Area Name', { kind: 'text', text: 'AREA_AE' }]]),
      },
      meta,
    ),
    browseTableCsv(grouped, { sort: null, filters, groupBy: 'list.FuelType' }, meta),
    browseTableCsv(pu, NO_VIEW, meta),
    browseTableCsv(mixed, NO_VIEW, meta),
  ].join('\n=====\n');
  assert.deepEqual(files.split('\n'), GOLDEN_STATS_CSV.split('\n'));
  ok('the stats file is byte-identical to its golden copy');

  const lines = browseDescriptor(pu, NO_VIEW, meta);
  assert.deepEqual(lines, browseTableCsv(pu, NO_VIEW, meta).split('\n').slice(0, lines.length));
  ok('the stats file opens with the shared descriptor');
}

{
  // The hour filter’s sentence, in the rail’s own vocabulary and value
  // order: this is the text the descriptor prints, and a reader re-deriving
  // the mask from the file has to be able to trust its names.
  const NONE = {
    months: null,
    daysOfMonth: null,
    hoursOfDay: null,
    daysOfWeek: null,
    seasons: null,
    tou: null,
  };
  assert.equal(filtersLabel(NONE), 'all hours');
  assert.equal(
    filtersLabel({ ...NONE, months: new Set([3, 1]), hoursOfDay: new Set([24, 2]) }),
    'Month: Jan, Mar · Hour (HE): 2, 24',
  );
  assert.equal(
    filtersLabel({
      ...NONE,
      daysOfMonth: new Set([31]),
      daysOfWeek: new Set([6, 0]),
      seasons: new Set(['Winter']),
      tou: new Set(['OnPeak']),
    }),
    'Day of Month: 31 · Day: Mon, Sun · Season: Winter · TOU: OnPeak',
  );
  ok('the hour filter is a sentence in the rail’s own words, values sorted, or “all hours”');
}

// ------------------------------------------------------- the column chooser
//
// Most list columns start hidden; the chooser brings them back; no filter
// may act from behind a hidden column.

{
  // Every list column is one of the three defaults or starts hidden, so a
  // new list column enters hidden.
  const wideCols = [
    'Name',
    'GeneratorKey',
    'Bus ID',
    'Unit ID',
    'Area Name',
    'Region Name',
    'FuelType',
    'Technology',
    'PSSEMinCap(MW)',
    'PSSEMaxCap(MW)',
    'EconomicPMax',
  ];
  const wideList = buildLookup(
    parseLookupCsv(
      [
        `GENERATORLIST${','.repeat(wideCols.length - 1)}`,
        wideCols.join(','),
        'ALDER,1,101,U1,AREA_AV,North,Gas,ST,0,200,180',
        'BIRCH,2,102,U1,AREA_NV,Desert,Wind,WT,0,100,90',
      ].join('\n'),
      'GeneratorList.csv',
    ).rows,
  );
  const wideData = generatorTable(['ALDER', 'BIRCH'], (index) => (index + 1) * 10);
  const wideTab = buildGeneratorTab({ tables: [table(wideData)], list: wideList, areas: null });
  const DEFAULT_ON = new Set(['Area Name', 'FuelType', 'PSSEMaxCap(MW)']);
  for (const column of wideTab.columns) {
    if (!column.key.startsWith('list.')) continue;
    assert.equal(
      column.defaultHidden,
      !DEFAULT_ON.has(column.key.slice(5)),
      `${column.key} carries the default its name decides`,
    );
  }
  ok(
    'every list column the adapter does not name is defaultHidden — the set is named, not derived',
  );

  const identity = (key) => wideTab.columns.find((entry) => entry.key === key);
  assert.equal(identity('entity').defaultHidden, undefined);
  assert.equal(identity('case').defaultHidden, undefined);
  assert.equal(identity('stat.max').defaultHidden, undefined);
  assert.equal(identity('stat.cf').defaultHidden, undefined);
  ok(
    'identity, case and the computed stats open with the tab — the chooser is for the wall of stored attributes',
  );
}

{
  // The effective set: a default is what a tab opens with, an override is
  // what the user said, and one key works in both directions.
  const chooserTab = fakeTab(
    [
      { key: 'name', label: 'Name', kind: 'text' },
      { key: 'area', label: 'Area', kind: 'text' },
      { key: 'bus', label: 'Bus', kind: 'number', defaultHidden: true },
    ],
    [
      ['ALDER', 'AREA_AV', 101],
      ['BIRCH', 'AREA_NV', 102],
    ],
  );
  assert.deepEqual(
    visibleColumns(chooserTab, NO_VIEW).map((column) => column.key),
    ['name', 'area'],
  );
  const turnedOn = { ...NO_VIEW, columnOverrides: new Map([['bus', true]]) };
  assert.deepEqual(
    visibleColumns(chooserTab, turnedOn).map((column) => column.key),
    ['name', 'area', 'bus'],
  );
  const turnedOff = { ...NO_VIEW, columnOverrides: new Map([['area', false]]) };
  assert.deepEqual(
    visibleColumns(chooserTab, turnedOff).map((column) => column.key),
    ['name'],
  );
  ok(
    'a hidden default comes back by override and a shown one leaves by override — one key, both ways',
  );

  // THE CHOOSER'S ONE RULE: hiding a column clears its filter. The write edge is where
  // the rule lives; the two passes below are what it protects.
  const filters = new Map([['area', { kind: 'text', text: 'AREA_AV' }]]);
  const view = { sort: null, filters };
  assert.equal(visibleRows(chooserTab, view).length, 1);
  const hidden = setColumnVisible(view, 'area', false);
  assert.equal(hidden.filters.has('area'), false);
  assert.deepEqual([...hidden.columnOverrides], [['area', false]]);
  assert.equal(visibleRows(chooserTab, hidden).length, 2);
  assert.equal(visibleRows(chooserTab, view).length, 1);
  ok(
    'hiding a column clears its filter — the result set cannot widen behind a column nobody can see',
  );

  // The structural half: a filter that reaches a hidden column by any other
  // path constrains nothing, in the row pass and in the keep-set a grouped
  // build consumes — the skip is in the pass, not only in the write.
  const smuggled = { sort: null, filters, columnOverrides: new Map([['area', false]]) };
  assert.equal(visibleRows(chooserTab, smuggled).length, 2);
  assert.equal(keptRowKeys(chooserTab, smuggled), undefined);
  ok(
    'a filter sitting on a hidden column constrains nothing — the row pass and the keep-set both skip it',
  );

  // Context and group-by columns cannot be hidden: they explain the rows.
  const ctxTab = fakeTab(
    [
      { key: 'area', label: 'Area (filter)', kind: 'text', context: true },
      { key: 'fuel', label: 'FuelType', kind: 'text' },
    ],
    [['contains AREA_AV', 'Gas']],
  );
  const ctxView = {
    sort: null,
    filters: new Map(),
    columnOverrides: new Map([
      ['area', false],
      ['fuel', false],
    ]),
    groupBy: 'fuel',
  };
  assert.deepEqual(
    visibleColumns(ctxTab, ctxView).map((column) => column.key),
    ['area', 'fuel'],
  );
  ok('context columns and the group-by column stay on screen whatever the overrides say');
}

{
  // The chooser decides what lands in the CSV: the visible columns, in view order,
  // and a filter on a hidden column is stated nowhere because it constrained
  // nothing — the same two contracts the paint holds, over the same set.
  const csvTab = fakeTab(
    [
      { key: 'name', label: 'Name', kind: 'text' },
      { key: 'area', label: 'Area', kind: 'text' },
      { key: 'bus', label: 'Bus', kind: 'number', defaultHidden: true },
    ],
    [
      ['ALDER', 'AREA_AV', 101],
      ['BIRCH', 'AREA_NV', 102],
    ],
  );
  const meta = { hourFilter: 'all hours', variable: 'v', caseLabel: CASE_LABELS };
  const lines = browseTableCsv(csvTab, NO_VIEW, meta).split('\n');
  assert.equal(lines[4], 'Name,Area');
  assert.equal(lines[5], 'ALDER,AREA_AV');
  ok('a defaultHidden column is out of the CSV until the chooser turns it on');

  const chosen = browseTableCsv(
    csvTab,
    {
      ...NO_VIEW,
      columnOverrides: new Map([
        ['bus', true],
        ['area', false],
      ]),
    },
    meta,
  ).split('\n');
  assert.equal(chosen[4], 'Name,Bus');
  assert.equal(chosen[5], 'ALDER,101');
  ok('the CSV follows the chooser in both directions — the file is the table on screen');

  const hiddenFiltered = browseTableCsv(
    csvTab,
    {
      sort: null,
      filters: new Map([['bus', { kind: 'range', min: 200, max: null }]]),
      columnOverrides: new Map([['bus', false]]),
    },
    meta,
  );
  assert.ok(!hiddenFiltered.includes('Bus'));
  assert.ok(!hiddenFiltered.includes('# Column filters'));
  assert.ok(hiddenFiltered.includes('ALDER,AREA_AV'));
  ok('a filter on a hidden column is neither applied nor stated — it constrained nothing');
}

// ------------------------------------------------------ the column order
//
// One list over every column (hide and reorder commute), reconciled when
// columns change, and followed by the export.

{
  // ------------------------------------------------ the notes-row chips
  //
  // Two clears, each undoing one visible thing: filters, and the group-by.
  const tab = fakeTab(
    [
      { key: 'zone', label: 'Zone', kind: 'text', groupable: true },
      { key: 'fuel', label: 'Fuel', kind: 'text' },
      { key: 'kv', label: 'kV', kind: 'number', defaultHidden: true },
      { key: 'max', label: 'Max', kind: 'number', computed: true },
    ],
    [['NORTH', 'Gas', 345, 30]],
  );
  const filters = new Map([
    ['fuel', { kind: 'text', text: 'Gas' }],
    ['max', { kind: 'range', min: 10, max: null }],
  ]);
  const view = {
    sort: { key: 'max', direction: 'desc' },
    filters,
    columnOverrides: new Map([['kv', true]]),
    columnOrder: ['max', 'zone', 'fuel', 'kv'],
    groupBy: 'zone',
  };

  const cleared = clearFilters(view);
  assert.equal(cleared.filters.size, 0);
  assert.deepEqual(cleared.sort, view.sort, 'the sort is kept');
  assert.equal(cleared.groupBy, 'zone', 'the group-by is kept');
  assert.equal(cleared.columnOverrides, view.columnOverrides, 'hidden columns are kept');
  assert.equal(cleared.columnOrder, view.columnOrder, 'the column order is kept');
  ok('clearing filters empties the map and keeps sort, group-by, overrides and order');

  const flat = setGroupBy(view, null);
  assert.equal(flat.groupBy, null);
  assert.equal(flat.sort, null, 'a grouped sort key may not exist ungrouped');
  assert.equal(flat.filters, view.filters, 'the filters are kept');
  assert.equal(flat.columnOverrides, view.columnOverrides);
  assert.equal(flat.columnOrder, view.columnOrder);
  ok('ungrouping resets the sort and keeps filters, overrides and order');

  const plain = { sort: null, filters: new Map() };
  assert.deepEqual(viewChips(tab, plain), [], 'an untouched view lists no chips');

  const grouped = { ...tab, rows: tab.rows.map((row) => ({ ...row, groupBy: 'Zone' })) };
  const chips = viewChips(grouped, view);
  assert.deepEqual(
    chips.map((chip) => [chip.key, chip.label]),
    [
      ['filters', '2 filters'],
      ['group', 'Grouped by Zone'],
    ],
  );
  assert.equal(chips[0].clear, clearFilters);
  assert.deepEqual(
    chips[1].clear(view),
    setGroupBy(view, null),
    "the header's toggle and the chip are one move",
  );
  ok('the chips name the filter count and the group-by, each with the transform that clears it');

  // Rows with no groupBy: the build declined the group-by, so no chip claims it.
  assert.deepEqual(
    viewChips(tab, { ...view, filters: new Map() }).map((chip) => chip.key),
    [],
  );
  ok('a group-by the build declined lists no group chip');

  // Hiding a column clears its filter; a filter on a hidden column held some
  // other way (a stale key, a default-hidden column) shapes nothing.
  const hiddenFilter = {
    sort: null,
    filters: new Map([
      ['kv', { kind: 'range', min: 100, max: null }],
      ['fuel', { kind: 'text', text: 'Gas' }],
      ['gone', { kind: 'text', text: 'x' }],
    ]),
  };
  assert.deepEqual(
    viewChips(tab, hiddenFilter).map((chip) => chip.label),
    ['1 filter'],
  );
  ok('a filter on a hidden or missing column is not counted');

  // A grouped build consumed a filter from the ungrouped tab: its column is
  // not on the grouped tab, and it still shaped the rows.
  const consumed = { ...grouped, consumedFilters: new Set(['region']) };
  assert.deepEqual(
    viewChips(consumed, {
      sort: null,
      filters: new Map([['region', { kind: 'text', text: 'N' }]]),
      groupBy: 'zone',
    }).map((chip) => chip.label),
    ['1 filter', 'Grouped by Zone'],
  );
  ok('a filter the grouped build consumed is counted');
}

{
  const orderTab = fakeTab(
    [
      { key: 'name', label: 'Name', kind: 'text' },
      { key: 'area', label: 'Area', kind: 'text' },
      { key: 'bus', label: 'Bus', kind: 'number' },
      { key: 'kv', label: 'kV', kind: 'number', defaultHidden: true },
    ],
    [
      ['ALDER', 'AREA_AV', 101, 345],
      ['BIRCH', 'AREA_NV', 102, 115],
    ],
  );

  // No stored arrangement: the adapter's own emission order.
  assert.deepEqual(
    orderedColumns(orderTab, NO_VIEW).map((column) => column.key),
    ['name', 'area', 'bus', 'kv'],
  );

  // A drag moves one column; the order stored covers the WHOLE list, hidden
  // ones in place, so the arrangement knows where a hidden column sits even
  // while it is off screen.
  const dragged = moveColumnTo(orderTab, NO_VIEW, 'bus', 0);
  assert.deepEqual(
    visibleColumns(orderTab, dragged).map((column) => column.key),
    ['bus', 'name', 'area'],
  );
  assert.deepEqual(dragged.columnOrder, ['bus', 'name', 'area', 'kv']);
  ok('a drag reorders the on-screen columns and stores the whole list, hidden ones in place');

  // Reconciled, not reset: survivors keep their order, new keys append in
  // adapter order, vanished keys drop out.
  const rescoped = fakeTab(
    [
      { key: 'fuel', label: 'Fuel', kind: 'text' },
      { key: 'name', label: 'Name', kind: 'text' },
      { key: 'area', label: 'Area', kind: 'text' },
      { key: 'region', label: 'Region', kind: 'text' },
      { key: 'kv', label: 'kV', kind: 'number', defaultHidden: true },
    ],
    [
      ['Gas', 'ALDER', 'AREA_AV', 'North', 345],
      ['Wind', 'BIRCH', 'AREA_NV', 'Desert', 115],
    ],
  );
  assert.deepEqual(
    visibleColumns(rescoped, dragged).map((column) => column.key),
    ['name', 'area', 'fuel', 'region'],
  );
  ok(
    'a changed tab is reconciled: surviving keys keep their order, new ones append in adapter order',
  );

  // THE COMPOSITION THE FOOTGUN NAMES: hiding and reordering are two writes
  // to one state, so either order of the two produces the same table — the
  // visible set is a filter over the ordered list, never a second ordering.
  const hideFirst = moveColumnTo(orderTab, setColumnVisible(NO_VIEW, 'area', false), 'bus', 0);
  const reorderFirst = setColumnVisible(moveColumnTo(orderTab, NO_VIEW, 'bus', 0), 'area', false);
  assert.deepEqual(
    visibleColumns(orderTab, hideFirst).map((column) => column.key),
    ['bus', 'name'],
  );
  assert.deepEqual(
    visibleColumns(orderTab, reorderFirst).map((column) => column.key),
    visibleColumns(orderTab, hideFirst).map((column) => column.key),
  );
  ok('hide-then-reorder and reorder-then-hide are one state — the visible set filters the order');

  // A column the chooser brings back takes its place IN the arrangement, not
  // a fresh one at the end — the reason the order covers hidden columns.
  const nameLast = moveColumnTo(orderTab, NO_VIEW, 'name', 2);
  assert.deepEqual(
    visibleColumns(orderTab, nameLast).map((column) => column.key),
    ['area', 'bus', 'name'],
  );
  const kvBack = { ...nameLast, columnOverrides: new Map([['kv', true]]) };
  assert.deepEqual(
    visibleColumns(orderTab, kvBack).map((column) => column.key),
    ['area', 'bus', 'kv', 'name'],
  );
  ok('a column un-hidden after a reorder comes back between the neighbours it left');

  // A reorder never touches the filters: moving a column is not a statement
  // about which rows it should keep, and the filters map is spread by
  // reference into the next view.
  const withFilter = {
    sort: null,
    filters: new Map([['name', { kind: 'text', text: 'ALD' }]]),
  };
  const moved = moveColumnTo(orderTab, withFilter, 'bus', 0);
  assert.deepEqual([...moved.filters], [...withFilter.filters]);
  assert.equal(visibleRows(orderTab, moved).length, 1);
  ok('a reorder carries the filters untouched — the rows it shows are the rows it showed');

  // No-move writes and foreign keys: a drop on the edge a column already
  // occupies writes an order equal to the effective one, and a key the tab
  // does not carry changes nothing at all.
  assert.deepEqual(
    visibleColumns(orderTab, moveColumnTo(orderTab, NO_VIEW, 'area', 1)).map(
      (column) => column.key,
    ),
    ['name', 'area', 'bus'],
  );
  assert.deepEqual(
    visibleColumns(orderTab, moveColumnTo(orderTab, NO_VIEW, 'name', 99)).map(
      (column) => column.key,
    ),
    ['area', 'bus', 'name'],
  );
  assert.equal(moveColumnTo(orderTab, NO_VIEW, 'gone', 0), NO_VIEW);
  ok(
    'a move to the edge it holds is the same table, an out-of-range drop clamps, a foreign key is a no-op',
  );

  // The export follows the arrangement: the file's header row is the table's,
  // in the order the drag left it — the same one-function read the paint
  // takes, so the two cannot disagree.
  const meta = { hourFilter: 'all hours', variable: 'v', caseLabel: CASE_LABELS };
  const lines = browseTableCsv(orderTab, dragged, meta).split('\n');
  assert.equal(lines[4], 'Bus,Name,Area');
  assert.equal(lines[5], '101,ALDER,AREA_AV');
  ok('the CSV takes its columns in the order the view left them — the file is the table on screen');
}

// ---------------------------------------------- the shared stat plumbing
//
// Three helpers every kind's tab goes through, so each is a single point of
// failure for every tab in the drawer -- which is why these checks exist.

{
  // `statColumns` over a hand-built ranked result: two rows, the second absent.
  const ranked = new Float64Array(2 * RANKED_FIELDS);
  const set = (row, field, value) => {
    ranked[row * RANKED_FIELDS + RANKED[field]] = value;
  };
  set(0, 'min', -3);
  set(0, 'max', 11);
  set(0, 'mean', 4);
  set(0, 'sd', 2);
  set(0, 'p25', 1);
  set(0, 'p75', 7);
  set(0, 'n', 8760);
  for (const field of ['min', 'max', 'mean', 'sd', 'p25', 'p75']) set(1, field, NaN);

  const columns = statColumns(ranked);
  assert.deepEqual(
    columns.map((column) => column.key),
    STAT_COLUMNS.map((stat) => stat.key),
    'every declared stat column is produced, in declared order',
  );
  const by = new Map(columns.map((column) => [column.key, column]));
  // Each column reads ITS OWN slot. A map that pointed p75 at p25 would report a
  // plausible wrong number, which is the failure four hand-written copies
  // invited.
  assert.equal(by.get('stat.min').value(0), -3);
  assert.equal(by.get('stat.max').value(0), 11);
  assert.equal(by.get('stat.mean').value(0), 4);
  assert.equal(by.get('stat.sd').value(0), 2);
  assert.equal(by.get('stat.p25').value(0), 1);
  assert.equal(by.get('stat.p75').value(0), 7);
  assert.equal(by.get('stat.n').value(0), 8760);
  // NaN is a BLANK, never a zero: an absent hour and a measured zero are
  // different answers.
  assert.equal(by.get('stat.mean').value(1), null);
  assert.equal(by.get('stat.n').value(1), 0, 'a count of zero is a number, not a blank');
  assert.ok(
    columns.every((column) => column.computed === true),
    'a computed number must say so -- a derived figure that looks stored is how this table lies',
  );
  assert.equal(by.get('stat.n').cellClass, 'count');
  assert.equal(by.get('stat.max').cellClass, 'quantity');
  ok('statColumns reads each stat from its own slot and blanks NaN');
  ok('the hours stat is a count whatever the quantity, and the rest default to quantity');
}

{
  // The ratio class relabels the six value stats, keeps hours a count, and
  // the accessor keeps the raw double.
  const ranked = new Float64Array(RANKED_FIELDS);
  ranked[RANKED.max] = 1234567.4;
  ranked[RANKED.mean] = 0.4312;
  ranked[RANKED.n] = 8760;
  const asRatio = new Map(statColumns(ranked, 'ratio').map((c) => [c.key, c]));
  assert.equal(asRatio.get('stat.max').label, 'Max (%)');
  assert.equal(asRatio.get('stat.mean').label, 'Average (%)');
  assert.equal(asRatio.get('stat.n').label, 'Hours');
  assert.equal(asRatio.get('stat.max').cellClass, 'ratio');
  assert.equal(asRatio.get('stat.n').cellClass, 'count');
  assert.equal(displayCell(asRatio.get('stat.mean').value(0), 'ratio'), '43%');
  ok('a ratio stat column says (%) in its label, renders whole percent, and keeps Hours a count');

  const plain = statColumns(ranked).find((c) => c.key === 'stat.max');
  assert.equal(plain.value(0), 1234567.4);
  assert.equal(displayCell(plain.value(0), cellClassOf(plain, 0)), '1,234,567');
  ok('rounding is paint-only: the value under the cell keeps full precision');
}

{
  // `statColumnsFrom` over one stats object per row, for a grouped tab.
  const groups = [{ n: 12, mean: 5, min: 1, max: 9, sd: 2, p25: 3, p75: 7 }, null];
  const columns = new Map(
    statColumnsFrom((row) => groups[row]).map((column) => [column.key, column]),
  );
  assert.equal(columns.get('stat.p25').value(0), 3);
  assert.equal(columns.get('stat.p75').value(0), 7);
  assert.equal(columns.get('stat.mean').value(0), 5);
  // A group whose members carried nothing for this variable has no average.
  // Printing 0 would be an answer rather than an absence.
  assert.equal(columns.get('stat.mean').value(1), null);
  assert.equal(columns.get('stat.n').value(1), null);
  ok('statColumnsFrom reads each stat from its own field and blanks a missing group');
}

{
  // Every kind's tab, grouped or not, builds its stats here, so this is the
  // one place the hours count's default is decided.
  const hiddenOf = (columns) =>
    columns.filter((column) => column.defaultHidden).map((column) => column.key);
  assert.deepEqual(hiddenOf(statColumns(new Float64Array(0))), ['stat.n']);
  assert.deepEqual(hiddenOf(statColumnsFrom(() => null)), ['stat.n']);
  ok('every tab opens with the hours count hidden and the other stats shown');
}

{
  // `rankScopedRows` over two tables of two rows each. Row 2 of table 1 and row
  // 1 of table 2 are absent from their cubes, so their stats must be blank
  // rather than whatever sits at offset 0.
  const plane = (fill) => {
    const values = new Float32Array(HOURS_PER_YEAR);
    values.fill(fill);
    return values;
  };
  const cubeOf = (a, b) => {
    const cube = new Float32Array(2 * HOURS_PER_YEAR);
    cube.set(plane(a), 0);
    cube.set(plane(b), HOURS_PER_YEAR);
    return cube;
  };
  const mask = new Uint8Array(HOURS_PER_YEAR);
  mask.fill(1);
  const tables = [
    { data: { cube: cubeOf(4, 999), presence: new Uint8Array([1, 0]) }, mask },
    { data: { cube: cubeOf(888, 6), presence: new Uint8Array([0, 1]) }, mask },
  ];
  // Rows laid out table by table, which is the documented contract.
  const axisIndexes = [0, 1, 0, 1];
  const ranked = rankScopedRows({
    tables,
    rowCounts: [2, 2],
    axisIndexOf: (row) => axisIndexes[row],
    planesOf: (data) => ({
      presence: data.presence,
      planeStart: (axisIndex) => axisIndex * HOURS_PER_YEAR,
    }),
    scratch: new Float32Array(HOURS_PER_YEAR),
  });
  assert.equal(ranked.length, 4 * RANKED_FIELDS, 'one row of fields per scoped row');
  const mean = (row) => ranked[row * RANKED_FIELDS + RANKED.mean];
  assert.equal(mean(0), 4, "table 1's present row reads table 1's cube");
  assert.equal(mean(3), 6, "table 2's present row reads table 2's cube");
  // The poison planes: 999 and 888 sit in the cubes and must never be read,
  // because presence says the case does not carry those rows.
  assert.ok(Number.isNaN(mean(1)), 'an absent row is blank, not the value sitting at its offset');
  assert.ok(Number.isNaN(mean(2)), 'and the same across the table boundary');
  assert.equal(ranked[1 * RANKED_FIELDS + RANKED.n], 0, 'an absent row counts no hours');
  ok('rankScopedRows ranks each table against its own cube, mask and presence');
}

// ------------------------------------------------- the drag's height range
//
// Floor at the bar, ceiling one pane header short of the cell, snapping near
// detents. Geometry below: half at 400px, full at 680px, range [36, 772].
{
  const CELL = 800;
  assert.equal(clampHeight(-5000, CELL), BAR_HEIGHT_PX);
  ok('the drag range is floored at the bar: a drawer dragged below its own bar would clip it');
  assert.equal(clampHeight(5000, CELL), CELL - PANE_HEADER_PX);
  ok('the drag range is ceilinged one pane header below the top of the chart cell');

  assert.deepEqual(settleHeight(390, CELL), { detent: 'half', heightPx: null });
  assert.deepEqual(settleHeight(410, CELL), { detent: 'half', heightPx: null });
  assert.deepEqual(settleHeight(690, CELL), { detent: 'full', heightPx: null });
  ok('a drag within reach of a detent snaps to it and carries no pixel height of its own');

  assert.deepEqual(settleHeight(680 - SNAP_PX, CELL), { detent: 'full', heightPx: null });
  const justOutside = settleHeight(680 - SNAP_PX - 1, CELL);
  assert.equal(justOutside.heightPx, 680 - SNAP_PX - 1);
  assert.equal(justOutside.detent, 'full');
  ok('the snap zone is inclusive at its edge, and one pixel outside it the height is carried');

  assert.deepEqual(settleHeight(540, CELL), { detent: 'full', heightPx: 540 });
  assert.deepEqual(settleHeight(539, CELL), { detent: 'half', heightPx: 539 });
  ok(
    'between the snap zones the height is carried with the detent it last matched; a tie rounds up to full',
  );

  // A sweep, because the explicit cases above only walk the edges they name:
  // whatever comes in, what comes out is either snapped or inside the range.
  for (let px = -100; px <= 1200; px += 7) {
    const { detent, heightPx } = settleHeight(px, CELL);
    if (heightPx !== null) {
      assert.ok(heightPx >= BAR_HEIGHT_PX && heightPx <= CELL - PANE_HEADER_PX, `at ${px}`);
      assert.ok(detent === 'half' || detent === 'full');
    }
  }
  ok('every settled height is snapped or inside the range, at any pointer position');

  assert.equal(clampHeight(50, 60), BAR_HEIGHT_PX);
  assert.equal(settleHeight(500, 60).detent, 'half');
  ok('a cell too short to honour both bounds collapses to the floor, never past it');

  assert.deepEqual(settleHeight(Number.NaN, CELL), { detent: 'half', heightPx: null });
  assert.equal(clampHeight(400, Number.NaN), BAR_HEIGHT_PX);
  ok('a non-finite height settles on the half detent rather than reaching the CSS as NaN');

  assert.equal(clampHeight(400.4, CELL), 400);
  ok('a settled height is a whole number of pixels, as the CSS length needs');

  // The shares are pinned to the CSS fallbacks by test_dom_contract.mjs; here
  // what matters is their ORDER, because the snap loop trusts half to be the
  // nearer destination on a short cell.
  assert.ok(DETENT_SHARE.half < DETENT_SHARE.full);
  ok(
    'half is the smaller share, so a short cell with overlapping snap zones settles on the smaller detent',
  );
}

console.log(`\n${checks} checks passed.`);

// ------------------------------------- the three fuel columns on the tab
//
// The classifier is proved in tests/test_fuel_and_multiselect.mjs; this
// proves the wiring: all three depths, the right source columns, grouping by
// them, and the registry as the path.
{
  const FUEL_LIST_COLUMNS = ['Name', 'Bus ID', 'Area Name', 'FuelType', 'Technology', 'SubType'];
  const fuelList = buildLookup(
    parseLookupCsv(
      [
        `GENERATORLIST${','.repeat(FUEL_LIST_COLUMNS.length - 1)}`,
        FUEL_LIST_COLUMNS.join(','),
        // A plain thermal unit, a unit whose FuelType says nothing and whose
        // Technology does, a pumped unit marked in SubType only, and a
        // battery under the unit-of-measure spelling.
        'ALDER,101,AREA_AV,BIT,,',
        'BIRCH,102,AREA_AV,NA,Sun,PV-Tracking',
        'CEDAR,103,AREA_AV,HY,,PumpedStorage',
        'DOGWOOD,104,AREA_AV,MWH,,',
      ].join('\n'),
      'GeneratorList.csv',
    ).rows,
  );
  const data = generatorTable(['ALDER', 'BIRCH', 'CEDAR', 'DOGWOOD'], (index) => index + 1);
  const tab = buildGeneratorTab({ tables: [table(data)], list: fuelList, areas: null });

  const labelOfKey = (key) => tab.columns.find((column) => column.key === key);
  const cleaned = labelOfKey('computed.fuelClean');
  const group = labelOfKey('computed.fuelGroup');
  assert.ok(cleaned && group, 'the tab carries both fuel columns');
  assert.deepEqual([cleaned.label, group.label], ['Fuel Type (Cleaned)', 'Fuel Group']);
  // The detailed one on screen, the five buckets a click away.
  assert.equal(cleaned.defaultHidden, false);
  assert.equal(group.defaultHidden, true);
  // The broad category column is RETIRED. It knew fuel words but not the
  // codes a fleet is written in, and answered Other for most of them.
  assert.equal(labelOfKey('computed.fuelCategory'), undefined);

  assert.deepEqual(
    tab.rows.map((_, row) => cleaned.value(row)),
    ['Bituminous Coal', 'Solar', 'Pumped Storage', 'Battery Storage'],
  );
  assert.deepEqual(
    tab.rows.map((_, row) => group.value(row)),
    ['Thermal', 'Solar', 'Storage', 'Storage'],
  );
  // A view saved against the retired column opens on its successor, rather
  // than falling back to an ungrouped tab with nothing said.
  const legacyTab = buildGeneratorTab({
    tables: [table(data)],
    list: fuelList,
    areas: null,
    groupBy: 'computed.fuelCategory',
  });
  assert.equal(legacyTab.rows[0].groupBy, 'Fuel Type (Cleaned)');

  const groupedTab = buildGeneratorTab({
    tables: [table(data)],
    list: fuelList,
    areas: null,
    groupBy: 'computed.fuelGroup',
  });
  assert.deepEqual(
    groupedTab.rows.map((row) => row.groupValue),
    ['Solar', 'Storage', 'Thermal'],
  );
  assert.equal(groupedTab.rows[0].groupBy, 'Fuel Group');
  const groupedUnits = groupedTab.columns.find((column) => column.key === 'group.units');
  // CEDAR and DOGWOOD are both Storage: pumped and battery, one bucket.
  assert.equal(groupedUnits.value(1), 2);
  const groupedLabel = groupedTab.columns.find((column) => column.key === 'computed.fuelGroup');
  assert.ok(groupedLabel, 'the grouped tab names the column it grouped by');

  ok('the tab carries both fuel depths, each reading its own columns, and groups by either');
}

// ----------------------------------- the scope signature names what a build reads
//
// A slot key outlives its table (re-drops replace in place) and does not
// carry the Case NAME the Case column renders, so the signature must name
// both, or a stale ranking stays on screen.
{
  const { createBrowseScopes } = await import('../src/app/browse-scope.ts');
  const scopes = createBrowseScopes();
  const noFilters = {
    months: null,
    daysOfMonth: null,
    hoursOfDay: null,
    daysOfWeek: null,
    seasons: null,
    tou: null,
  };
  const table = () => ({ quantity: 'Load (MW)', year: 2031, tou: new Uint8Array(HOURS) });
  const rows = (data) => [{ key: 'c1 bus', caseId: 'c1', slotKey: 'bus', data }];
  const signatureOf = (data, name = 'Case 1', label = name) =>
    scopes.scope(rows(data), 'bus', ['c1'], noFilters, new Map([['c1', { name, label }]]))
      .signature;

  const loaded = table();
  assert.equal(signatureOf(loaded), signatureOf(loaded), 'the same table is the same signature');
  assert.notEqual(
    signatureOf(loaded),
    signatureOf(table()),
    'a table replaced in the same (Case, slot) moves the signature',
  );
  assert.notEqual(
    signatureOf(loaded),
    signatureOf(loaded, 'Case 1 (rerun)'),
    'a Case whose name changed moves it: a by-Case bucket keys on the name',
  );
  assert.notEqual(
    signatureOf(loaded),
    signatureOf(loaded, 'Case 1', 'Base'),
    'a Case whose label changed moves it: the Case column renders the label',
  );
  ok(
    'the scope signature moves on a replaced table and a renamed or relabelled Case, and holds for the same one',
  );

  // Likewise `lookups`: a second GeneratorList merges under the same source
  // name, so the term must name the list objects.

  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  // Up to the next field of the record, however prettier wraps it.
  const term = main.match(/^\s*lookups: ([\s\S]*?),\n\s*groupingsRev,/m);
  assert.ok(term, "main.ts names a `lookups` term in the drawer's signature");
  assert.match(term[1], /identityOf/, 'and it names the list objects, not their file names');
  ok("the drawer's lookup term moves when a list is merged into, not only when it is renamed");
}

// ----------------------------------------- a group-by the build declined
//
// LMP after grouping Load by BaseKV keeps `view.groupBy` while the build
// lists buses; the filters must then not be marked consumed. Run through
// `tabFor` on both quantities.
{
  const list = busListOf(['1,ALDER,345,AREA_AV', '2,BIRCH,115,AREA_NV', '3,CEDAR,230,AREA_AV']);
  const view = {
    sort: null,
    filters: new Map([['list.LoadArea', { kind: 'text', text: 'AREA_AV' }]]),
    groupBy: 'list.BaseKV',
  };
  const drawerTab = (quantity) => {
    const data = {
      ...busTable([1, 2, 3], ['ALDER', 'BIRCH', 'CEDAR'], (i) => 10 * (i + 1)),
      quantity,
    };
    const tables = [busTableIn(data)];
    const base = buildBusTab({ tables, list, areas: null });
    const tab = buildBusTab({
      tables,
      list,
      areas: null,
      groupBy: view.groupBy,
      keep: keptRowKeys(base, view),
    });
    return declinedGroupBy(tab) ? tab : carryFilterContext(tab, base, view);
  };
  const shown = (tab) =>
    Array.from(visibleRows(tab, builtView(tab, view)), (row) => tab.rows[row].label);

  const load = drawerTab('Unserved Load (MWh)');
  assert.equal(declinedGroupBy(load), false, 'a quantity that sums is grouped');
  assert.equal(
    builtView(load, view),
    view,
    'and the remembered view is the one it was built under',
  );
  assert.ok(load.consumedFilters?.has('list.LoadArea'), 'the grouped build consumed the filter');

  const lmp = drawerTab('LMP ($/MWh)');
  assert.equal(declinedGroupBy(lmp), true, 'a $/MWh is listed per bus, not grouped');
  assert.equal(builtView(lmp, view).groupBy, null, 'so it is painted as the ungrouped tab it is');
  assert.equal(lmp.consumedFilters, undefined, 'and nothing was consumed');
  assert.deepEqual(
    shown(lmp),
    ['ALDER (1)', 'CEDAR (3)'],
    'the LoadArea filter still applies: BIRCH (AREA_NV) is not listed under "contains AREA_AV"',
  );
  assert.ok(
    !lmp.columns.some((column) => column.context),
    'and no context column claims a filter the build never consumed',
  );
  assert.equal(declinedGroupBy({ ...lmp, rows: [] }), false, 'an empty tab is not a refusal');
  ok('a group-by the build declined is painted, filtered and exported as the ungrouped tab it is');
}

// ------------------------------------------- pins restored from a bundle
//
// Pins are stored by Case INDEX and their row ids rebuilt by `rowIdOf`, the
// same function every tab uses (asserted as text, since a hand-built id would
// pass every value check until a restore).
{
  const saved = [
    {
      case: 1,
      color: '#111',
      ref: {
        kind: 'bus',
        slotKey: 'bus LMP ($/MWh)',
        entity: 10001,
        variable: 'LMP ($/MWh)',
        unit: '$/MWh',
        axisIndex: 0,
      },
    },
    {
      case: 2,
      color: '#222',
      ref: { kind: 'area', slotKey: 'area ', entity: 'North', variable: 'Load', unit: 'MW' },
    },
  ];
  const made = [
    { id: 'case-a', name: 'Summer' },
    { id: 'case-b', name: 'Winter' },
  ];
  const [pin, ...rest] = restorePins(saved, made);
  assert.equal(rest.length, 0, 'a pin whose Case the bundle did not restore is dropped');
  assert.equal(pin.ref.caseId, 'case-b', 'the pin names the Case made from its index');
  assert.ok(!('caseName' in pin.ref), 'and no copy of its name, which is read when drawn');
  assert.equal(pin.ref.id, rowIdOf(pin.ref), 'its id is rebuilt from its parts');
  assert.equal(pin.color, '#111', 'its colour is kept');
  assert.equal(saved[0].ref.caseId, undefined, 'the saved entries are not mutated');

  const { readFileSync } = await import('node:fs');
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const restores = main.match(/browseDrawer\.setSelection\([^;]*;/g) ?? [];
  assert.ok(restores.length > 0, 'main.ts restores the pinned selection');
  for (const call of restores) {
    assert.match(call, /restorePins\(loaded\.pins, made\)/, call);
  }
  for (const kind of ['area', 'bus', 'generator', 'interface']) {
    const source = readFileSync(
      new URL(`../src/tables/${kind}/ui/browse.ts`, import.meta.url),
      'utf8',
    );
    const pushes = source.match(/[rR]efs\.push\(\s*\S+/g) ?? [];
    assert.ok(pushes.length > 0, `${kind}: its tab builder pushes rows`);
    for (const push of pushes) {
      assert.match(push, /push\(\s*withRowId\(/, `${kind}: every row's id comes from rowIdOf`);
    }
  }
  ok('pins restored from a bundle name the Cases the restore made, by rebuilt ids');
}

// ---------------------------------- the Area groups tab states its weighting
//
// A weight column that sums to zero in some hours makes those hours a plain
// mean, and the tab that RANKS the groups must say so, not only the pinned
// chart.
{
  setGroupings('Name,Grouping\nAREA_AV,Northwest\nAREA_NV,Northwest');
  const PRICE = 'Avg LMP Weighted by Load ($/MWh)';
  // Load is zero in the first day's 24 hours for both areas.
  const data = areaTable(['AREA_AV', 'AREA_NV'], [PRICE, 'Load (MWh)'], (a, m, h) =>
    m === 0 ? (a + 1) * 10 : h < 24 ? 0 : 100,
  );
  const tab = buildAreaTab({
    tables: [areaTableIn(data)],
    variable: PRICE,
    areas: null,
    isGroupTab: true,
  });
  assert.ok(tab.rows.length > 0, 'the price groups: its weight column is loaded');
  const caveats = tab.notes.filter((note) => /of zero/.test(note));
  assert.equal(caveats.length, 1, 'the groups tab says which hours were a plain mean, once');
  assert.match(caveats[0], /^24 hour\(s\) have a total "Load \(MWh\)" of zero/);
  ok('the Area groups tab carries the zero-weight warning its ranking was built under');
}

{
  // The mask memo is keyed on the table object, so a restore's masks are
  // collected. Checked with a WeakRef after two restores and a GC.
  const { setFlagsFromString } = await import('node:v8');
  const { runInNewContext } = await import('node:vm');
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc');

  const { createBrowseScopes } = await import('../src/app/browse-scope.ts');
  const scopes = createBrowseScopes();
  const filters = {
    months: null,
    daysOfMonth: null,
    hoursOfDay: null,
    daysOfWeek: null,
    seasons: null,
    tou: null,
  };
  const restore = (caseId) => [
    {
      key: `${caseId}\u0000bus Load (MW)`,
      caseId,
      slotKey: 'bus Load (MW)',
      data: { quantity: 'Load (MW)', year: 2031, tou: new Uint8Array(HOURS) },
    },
  ];
  const scopeOf = (rows) =>
    scopes.scope(rows, 'bus', [rows[0].caseId], filters, new Map([[rows[0].caseId, 'Case']]));

  const first = (() => new WeakRef(scopeOf(restore('restore-1')).tables[0].mask))();
  const second = restore('restore-2');
  const kept = scopeOf(second).tables[0].mask;
  assert.equal(scopeOf(second).tables[0].mask, kept, 'a render reuses its table’s mask');
  // A WeakRef holds its target until the job that made or read it ends, so
  // each collection runs after a yield and the ref is read once, last.
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc();
  }
  assert.equal(first.deref(), undefined, 'the first restore’s mask outlived its table');
  ok('the browse mask memo holds no mask for a table that is gone');
}

{
  // The Selected tab is the register of what is drawn: every line on the
  // panes is a pin (or the one preview), so every line can be unticked there.
  // A fallback view drawn with nothing pinned would put lines on screen that
  // no row lists. Text, because main.ts builds the DOM at import.
  const { readFileSync } = await import('node:fs');
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const start = main.indexOf('\nfunction render(');
  assert.ok(start >= 0, 'main.ts declares render()');
  const render = main.slice(start, main.indexOf('\n}\n', start) + 2);
  const writes = render.match(/\bseries = [^;]*;/g) ?? [];
  assert.ok(writes.length > 0, 'render() assigns the drawn series');
  for (const write of writes) {
    assert.match(write, /^series = resolveDraws\(drawContext, draws\);$/, write);
  }
  assert.match(render, /const draws = allBrowseDraws\(\);/);
  ok('only pins and the preview are drawn, so the Selected tab lists every line');
}

// ------------------------------------------------ the Selected tab's switch
//
// Every pin moved to another variable at once. Offered only when EVERY pin
// can take it, so a switch never leaves some pins behind.

{
  setGroupings('Name,Grouping\nAREA_AV,Northwest\nAREA_NV,Northwest\nAREA_CA,Desert');
  const LOAD = 'Load (MWh)';
  const GEN = 'Generation (MWh)';
  const LMP = 'Simple Average LMP($/MWh)';
  const WLMP = 'Avg LMP Weighted by Load ($/MWh)';
  const UNSERVED = 'Unserved Load (MWh)';
  const c1 = areaTable(
    ['AREA_AV', 'AREA_NV', 'AREA_CA'],
    [LOAD, GEN, LMP, WLMP, UNSERVED],
    () => 1,
    [['AREA_NV', UNSERVED]],
  );
  const c2 = areaTable(['AREA_AV'], [LOAD, GEN], () => 1);
  const kinds = {
    area: areaRetarget(
      [
        { caseId: 'c1', slotKey: 'area', data: c1 },
        { caseId: 'c2', slotKey: 'area', data: c2 },
      ],
      (variable, data) => combinesAcrossAreas(variable, [data]),
    ),
  };
  const ref = (caseId, entity, extra = {}) =>
    withRowId({
      kind: 'area',
      caseId,
      slotKey: 'area',
      entity,
      variable: LOAD,
      unit: 'MWh',
      axisIndex: 0,
      ...extra,
    });
  const av1 = ref('c1', 'AREA_AV');
  const nv1 = ref('c1', 'AREA_NV', { axisIndex: 1 });
  const av2 = ref('c2', 'AREA_AV');

  let offered = variableSwitch([av1, nv1, av2], kinds);
  assert.deepEqual(offered.variables, [GEN, LOAD], 'only what every pinned Case holds');
  assert.equal(offered.variable, LOAD);
  assert.equal(offered.refusal, undefined);

  offered = variableSwitch([av1, nv1], kinds);
  assert.ok(offered.variables.includes(LMP), 'c2 unpinned, its gaps no longer withhold');
  assert.ok(!offered.variables.includes(UNSERVED), 'an area without rows for it withholds it');

  const live = ref('c1', 'Northwest', {
    axisIndex: -1,
    groupBy: 'Group',
    groupValue: 'Northwest',
  });
  offered = variableSwitch([live], kinds);
  assert.ok(!offered.variables.includes(LMP), 'a group never lands on a plain mean');
  assert.ok(offered.variables.includes(WLMP), 'a weighted mean with its weight is offered');
  assert.ok(offered.variables.includes(UNSERVED), 'one member with data draws a group');
  const noWeight = areaTable(['AREA_AV'], [LOAD.replace('Load', 'Gen'), WLMP], () => 1);
  const weightless = {
    area: areaRetarget([{ caseId: 'c1', slotKey: 'area', data: noWeight }], (v, d) =>
      combinesAcrossAreas(v, [d]),
    ),
  };
  assert.equal(
    targetOf(weightless, { ...live, variable: 'x' }, WLMP),
    null,
    'a weighted mean whose weight is not in the table is withheld from a group',
  );

  // The current variable is always listed, even when a pin could not be
  // re-taken onto it, or the dropdown would show a variable it is not on.
  const frozenDry = ref('c1', 'Dry', {
    axisIndex: -1,
    groupBy: 'Group',
    groupValue: 'Dry',
    members: ['AREA_NV'],
    variable: UNSERVED,
  });
  offered = variableSwitch([frozenDry], kinds);
  assert.ok(offered.variables.includes(UNSERVED), 'the current variable is always offered');

  assert.match(
    variableSwitch([av1, { ...av1, kind: 'bus' }], kinds).refusal ?? '',
    /one kind/,
    'mixed kinds refuse, naming why',
  );
  assert.match(
    variableSwitch([av1, { ...nv1, variable: GEN }], kinds).refusal ?? '',
    /several variables/,
  );
  assert.ok(variableSwitch([], kinds).refusal, 'nothing pinned, nothing to switch');
  assert.ok(
    variableSwitch([av2], kinds).refusal === undefined,
    'one other variable is enough to switch',
  );

  // The switch: colour and order kept, ids rebuilt, the slot kept (one Area
  // table holds every metric), the unit from the rule.
  const entries = [
    { ref: av1, color: '#a' },
    { ref: live, color: '#b' },
    { ref: nv1, color: '#c' },
  ];
  const moved = retargetVariable(entries, GEN, kinds);
  assert.deepEqual(
    moved.map((entry) => entry.color),
    ['#a', '#b', '#c'],
    'colours and order are kept',
  );
  for (const [i, entry] of moved.entries()) {
    assert.equal(entry.ref.variable, GEN);
    assert.equal(entry.ref.slotKey, 'area', 'an Area switch keeps its slot');
    assert.equal(entry.ref.id, rowIdOf(entry.ref), 'the id is rebuilt from the new parts');
    assert.notEqual(entry.ref.id, entries[i].ref.id);
  }
  assert.equal(moved[1].ref.groupValue, 'Northwest', 'a group keeps its subject');
  const frozen = ref('c1', 'Northwest', {
    axisIndex: -1,
    groupBy: 'Group',
    groupValue: 'Northwest',
    members: ['AREA_AV', 'AREA_NV'],
  });
  const back = retargetVariable(
    retargetVariable([{ ref: frozen, color: '#d' }], GEN, kinds),
    LOAD,
    kinds,
  );
  assert.deepEqual(back[0].ref.members, ['AREA_AV', 'AREA_NV'], 'frozen members survive');
  assert.equal(back[0].ref.id, frozen.id, 'and switching back is the same pin');
  const stuck = retargetVariable([{ ref: frozenDry, color: '#d' }], LOAD, kinds);
  assert.equal(
    retargetVariable(stuck, UNSERVED, kinds)[0].ref.variable,
    LOAD,
    'a pin with no data for the target is left where it is, never emptied',
  );
  const percent = retargetVariable(
    [{ ref: withRowId({ ...av1, perUnit: true, unit: '%' }), color: '#e' }],
    GEN,
    kinds,
  );
  assert.equal(percent[0].ref.unit, '%', 'a % pin stays %');

  // A switched pin is an ordinary pin: it saves and restores to the same id.
  const [restored] = restorePins(savePins(moved.slice(0, 1), ['c1']), [{ id: 'c1', name: 'c1' }]);
  assert.equal(restored.ref.id, moved[0].ref.id);
  assert.equal(restored.color, '#a');
  ok('the Selected tab switches every Area pin to a variable every pin can take');
}

{
  // The switch lands through its own drawer call, never the bundle-restore
  // one, and the kind's tabs follow before the pins land.
  const { readFileSync } = await import('node:fs');
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const at = main.indexOf('onSelectedVariableChange(variable)');
  assert.ok(at >= 0, 'main.ts handles a Selected-tab variable change');
  const body = main.slice(at, main.indexOf('\n  },', at));
  assert.ok(body.indexOf('browse.set(') < body.indexOf('browseDrawer.replacePins('));
  ok('a Selected-tab switch moves the tabs, then the pins, in one render');
}

{
  // Bus, Generator and Interface keep one quantity per slot, so a switch
  // MOVES the pin to another table and reads presence, axis index and a bus
  // label from it.
  const { busAnswers } = await import('../src/tables/bus/ui/retarget.ts');
  const { generatorAnswers } = await import('../src/tables/generator/ui/retarget.ts');
  const { interfaceAnswers } = await import('../src/tables/interface/ui/retarget.ts');
  const busRetarget = (rows, combines) => retargetOf(busAnswers, rows, combines);
  const generatorRetarget = (rows, combines) => retargetOf(generatorAnswers, rows, combines);
  const interfaceRetarget = (rows, combines) => retargetOf(interfaceAnswers, rows, combines);
  const { combinesAcrossBuses } = await import('../src/tables/bus/rules.ts');
  const { combinesAcrossGenerators } = await import('../src/tables/generator/rules.ts');
  const { combinesAcrossInterfaces } = await import('../src/tables/interface/rules.ts');
  const { BUS_GROUP_BY, setBusMembership, clearBusGroups } =
    await import('../src/tables/bus/groups.ts');
  const { GENERATOR_GROUP_BY, setGeneratorMembership, clearGeneratorGroups } =
    await import('../src/tables/generator/groups.ts');
  const { INTERFACE_GROUP_BY, setInterfaceMembership, clearInterfaceGroups } =
    await import('../src/tables/interface/groups.ts');
  clearLookups();

  const present = (flags) => Uint8Array.from(flags);
  const bus = (quantity, ids, names, flags) => ({
    buses: Int32Array.from(ids),
    names,
    presence: present(flags),
    quantity,
  });
  const LMP = 'LMP ($/MWh)';
  const LOAD = 'Load (MWh)';
  const GEN = 'Generation (MWh)';
  const busKinds = {
    bus: busRetarget(
      [
        {
          caseId: 'c1',
          slotKey: 'bus LMP',
          data: bus(LMP, [101, 102], ['ALDER', 'BIRCH'], [1, 1]),
        },
        // Another file: its own axis order, its own names, and 102 absent.
        { caseId: 'c1', slotKey: 'bus Load', data: bus(LOAD, [102, 101], ['', 'ALDER_B'], [0, 1]) },
        { caseId: 'c1', slotKey: 'bus Gen', data: bus(GEN, [101], ['ALDER'], [1]) },
        { caseId: 'c1', slotKey: 'bus Gen 2', data: bus(GEN, [101], ['ALDER'], [1]) },
      ],
      (variable) => combinesAcrossBuses(variable),
    ),
  };
  const busRef = (entity, extra = {}) =>
    withRowId({
      kind: 'bus',
      caseId: 'c1',
      slotKey: 'bus LMP',
      entity,
      label: `LIST_NAME (${entity})`,
      variable: LMP,
      unit: '$/MWh',
      axisIndex: entity === 101 ? 0 : 1,
      ...extra,
    });
  const b101 = busRef(101);
  const [moved] = retargetVariable([{ ref: b101, color: '#a' }], LOAD, busKinds);
  assert.equal(moved.ref.slotKey, 'bus Load', 'a Bus switch moves to the other file');
  assert.equal(moved.ref.axisIndex, 1, 'the axis index is the target file’s');
  assert.equal(moved.ref.label, 'ALDER_B (101)', 'the label is the target file’s name');
  assert.equal(moved.ref.unit, 'MWh');
  assert.equal(moved.ref.id, rowIdOf(moved.ref));
  const [unnamed] = retargetVariable([{ ref: busRef(102), color: '#a' }], LMP, busKinds);
  assert.equal(unnamed.ref.label, 'LIST_NAME (102)', 'no name in the file keeps the list’s');

  let offered = variableSwitch([b101], busKinds);
  assert.ok(offered.variables.includes(LOAD));
  assert.ok(!offered.variables.includes(GEN), 'two slots for one quantity refuse it');
  offered = variableSwitch([b101, busRef(102)], busKinds);
  assert.ok(!offered.variables.includes(LOAD), 'a bus absent from the file withholds it');

  setBusMembership(new Map([['North', [102]]]));
  const northLoad = busRef('North', {
    axisIndex: -1,
    groupBy: BUS_GROUP_BY,
    groupValue: 'North',
    variable: LOAD,
    unit: 'MWh',
    slotKey: 'bus Load',
  });
  assert.equal(
    targetOf(busKinds, { ...northLoad, variable: 'x' }, LOAD),
    null,
    'a live group with no member in the file withholds it',
  );
  const bothLoad = { ...northLoad, groupValue: 'Both', members: [101, 102] };
  assert.notEqual(targetOf(busKinds, bothLoad, LOAD), null, 'one member with data draws');
  assert.equal(
    targetOf(busKinds, bothLoad, LMP),
    null,
    'an intensive quantity never lands on a group',
  );
  clearBusGroups();

  // Generator: a derived or list bucket, an authored group, and "% of range".
  const gen = (quantity, names, flags) => ({
    generators: names,
    presence: present(flags),
    quantity,
  });
  const genKinds = {
    generator: generatorRetarget(
      [
        { caseId: 'c1', slotKey: 'g Gen', data: gen(GEN, ['U1', 'U2'], [1, 1]) },
        {
          caseId: 'c1',
          slotKey: 'g Pmax',
          data: gen('Available Capacity (MW)', ['U2', 'U1'], [1, 0]),
        },
        { caseId: 'c1', slotKey: 'g Cost', data: gen('Cost ($)', ['U1'], [1]) },
      ],
      (variable) => combinesAcrossGenerators(variable),
    ),
  };
  const genRef = (entity, extra = {}) =>
    withRowId({
      kind: 'generator',
      caseId: 'c1',
      slotKey: 'g Gen',
      entity,
      variable: GEN,
      unit: 'MWh',
      axisIndex: 0,
      ...extra,
    });
  const [u1] = retargetVariable([{ ref: genRef('U1'), color: '#a' }], 'Cost ($)', genKinds);
  assert.equal(u1.ref.slotKey, 'g Cost');
  assert.equal(u1.ref.unit, '$');
  assert.equal(
    targetOf(genKinds, genRef('U1'), 'Available Capacity (MW)'),
    null,
    'a unit absent from the target file withholds it',
  );
  setGeneratorMembership(new Map([['Pool', ['U1', 'U2']]]));
  const pool = genRef('Pool', { axisIndex: -1, groupBy: GENERATOR_GROUP_BY, groupValue: 'Pool' });
  assert.equal(targetOf(genKinds, pool, 'Available Capacity (MW)').axisIndex, -1);
  const poolPct = withRowId({ ...pool, perUnit: true, unit: '%' });
  assert.equal(
    targetOf(genKinds, poolPct, 'Available Capacity (MW)'),
    null,
    'a % group on a power quantity needs GeneratorList, so it is withheld without one',
  );
  assert.equal(targetOf(genKinds, poolPct, 'Cost ($)')?.unit, '%', 'a % pin stays %');
  const fuel = genRef('Gas', { axisIndex: -1, groupBy: 'Fuel', groupValue: 'Gas' });
  assert.equal(targetOf(genKinds, fuel, 'Cost ($)'), null, 'a list bucket needs its list');
  clearGeneratorGroups();

  // Interface: the boundary keeps its members and their directions.
  const iface = (quantity, unit, names, flags) => ({
    interfaces: names,
    presence: present(flags),
    quantity,
    unit,
  });
  const FLOW = 'Power Flow (MW)';
  const SHADOW = 'Shadow Price ($/MWh)';
  const ifaceKinds = {
    interface: interfaceRetarget(
      [
        { caseId: 'c1', slotKey: 'i Flow', data: iface(FLOW, 'MW', ['P01', 'P02'], [1, 1]) },
        { caseId: 'c1', slotKey: 'i Price', data: iface(SHADOW, '$/MWh', ['P01'], [1]) },
      ],
      (variable, data) => combinesAcrossInterfaces(variable, [data]),
    ),
  };
  setInterfaceMembership(
    new Map([
      [
        'Boundary',
        [
          { name: 'P01', direction: 'forward' },
          { name: 'P02', direction: 'reversed' },
        ],
      ],
    ]),
  );
  const boundary = withRowId({
    kind: 'interface',
    caseId: 'c1',
    slotKey: 'i Flow',
    entity: 'Boundary',
    variable: FLOW,
    unit: 'MW',
    axisIndex: -1,
    groupBy: INTERFACE_GROUP_BY,
    groupValue: 'Boundary',
  });
  const path = withRowId({
    ...boundary,
    entity: 'P01',
    axisIndex: 0,
    groupBy: undefined,
    groupValue: undefined,
  });
  const [priced] = retargetVariable([{ ref: path, color: '#a' }], SHADOW, ifaceKinds);
  assert.equal(priced.ref.slotKey, 'i Price');
  assert.equal(priced.ref.unit, '$/MWh', 'the unit is the target table’s');
  assert.equal(
    targetOf(ifaceKinds, boundary, SHADOW),
    null,
    'a price is never summed across a boundary',
  );
  clearInterfaceGroups();
  ok('the switch moves Bus, Generator and Interface pins to the target file, or withholds it');
}

{
  // "% of range" for every pin at once: on for all when any pin is in its
  // own unit, off only when all are %, merged first-wins, refused when a pin
  // cannot be drawn as %.
  const { generatorAnswers } = await import('../src/tables/generator/ui/retarget.ts');
  const generatorRetarget = (rows, combines) => retargetOf(generatorAnswers, rows, combines);
  const { combinesAcrossGenerators } = await import('../src/tables/generator/rules.ts');
  clearLookups();
  const LOAD = 'Load (MWh)';
  const table = areaTable(['AREA_AV', 'AREA_NV'], [LOAD], () => 1);
  const kinds = {
    area: areaRetarget([{ caseId: 'c1', slotKey: 'area', data: table }], (v, d) =>
      combinesAcrossAreas(v, [d]),
    ),
    generator: generatorRetarget(
      [
        {
          caseId: 'c1',
          slotKey: 'g Gen',
          data: {
            generators: ['U1'],
            presence: Uint8Array.from([1]),
            quantity: 'Generation (MWh)',
          },
        },
      ],
      (v) => combinesAcrossGenerators(v),
    ),
  };
  const ref = (entity, extra = {}) =>
    withRowId({
      kind: 'area',
      caseId: 'c1',
      slotKey: 'area',
      entity,
      variable: LOAD,
      unit: 'MWh',
      axisIndex: 0,
      ...extra,
    });
  const av = ref('AREA_AV');
  const avPct = ref('AREA_AV', { perUnit: true, unit: '%' });
  const nv = ref('AREA_NV', { axisIndex: 1 });

  assert.deepEqual(percentSwitch([av, nv], kinds), { on: false, next: true });
  assert.deepEqual(percentSwitch([avPct], kinds), { on: true, next: false });
  assert.equal(percentSwitch([av, avPct], kinds).on, false, 'mixed reads as not all %');
  assert.ok(percentSwitch([], kinds).refusal);

  // Mixed turns on, and the MW twin of a % pin merges into the first entry.
  const on = retargetPercent(
    [
      { ref: av, color: '#a' },
      { ref: nv, color: '#b' },
      { ref: avPct, color: '#c' },
    ],
    true,
    kinds,
  );
  assert.deepEqual(
    on.map((entry) => [entry.ref.entity, entry.color]),
    [
      ['AREA_AV', '#a'],
      ['AREA_NV', '#b'],
    ],
    'the pair merges into one pin, keeping the first colour and place',
  );
  assert.ok(on.every((entry) => entry.ref.perUnit === true && entry.ref.unit === '%'));
  assert.equal(on[0].ref.id, avPct.id, 'the id is the % row’s');

  const off = retargetPercent(on, false, kinds);
  assert.equal(off[0].ref.unit, 'MWh', 'off restores the kind’s unit');
  assert.equal(off[0].ref.perUnit, undefined, 'and drops the flag, so the id is the MW row’s');
  assert.equal(off[0].ref.id, av.id);

  const gen = withRowId({
    kind: 'generator',
    caseId: 'c1',
    slotKey: 'g Gen',
    entity: 'Pool',
    label: 'Pool',
    variable: 'Generation (MWh)',
    unit: 'MWh',
    axisIndex: -1,
    groupBy: 'Injection Group',
    groupValue: 'Pool',
  });
  assert.match(
    percentSwitch([av, gen], kinds).refusal ?? '',
    /^Pool: % of range .*generatorlist/i,
    'a Generator power group without the list refuses, naming the pin and the reason',
  );
  ok('the Selected tab turns every pin to % of range and back, merging twins first-wins');
}

{
  // The Selected tab's % click goes to the root, which moves the drawer's
  // mode before the pins land; the drawer never flips its mode on that click.
  const { readFileSync } = await import('node:fs');
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const at = main.indexOf('onSelectedPercent(on)');
  const body = main.slice(at, main.indexOf('\n  },', at));
  assert.ok(body.indexOf('browseDrawer.setPerUnit(') >= 0);
  assert.ok(body.indexOf('browseDrawer.setPerUnit(') < body.indexOf('browseDrawer.replacePins('));
  const drawer = readFileSync(new URL('../src/ui/browse-drawer.ts', import.meta.url), 'utf8');
  const click = drawer.slice(drawer.indexOf("perUnitToggle.addEventListener('click'"));
  assert.ok(
    click.indexOf('handlers.onSelectedPercent(') < click.indexOf('applyPerUnit('),
    'on the Selected tab the click hands off before touching the mode',
  );
  ok('a Selected-tab % switch moves the mode, then the pins, in one render');
}

{
  // A filtered group pin says what chose its members once a switch moves it
  // off that: "Max ≥ 500" on Load says nothing about Generation, and a bound
  // chosen in % is not one in MWh. A list attribute is true on every variable.
  setGroupings('Name,Grouping\nAREA_AV,Northwest\nAREA_NV,Northwest');
  const LOAD = 'Load (MWh)';
  const GEN = 'Generation (MWh)';
  const table = areaTable(['AREA_AV', 'AREA_NV'], [LOAD, GEN], () => 1);
  const kinds = {
    area: areaRetarget([{ caseId: 'c1', slotKey: 'area', data: table }], (v, d) =>
      combinesAcrossAreas(v, [d]),
    ),
  };
  const context = [
    { key: 'stat.max', label: 'Max', constraint: '≥ 500' },
    { key: 'Zone', label: 'Zone', constraint: 'is North' },
    { key: 'stat.n', label: 'Hours', constraint: '≥ 100' },
  ];
  const group = withRowId({
    kind: 'area',
    caseId: 'c1',
    slotKey: 'area',
    entity: 'Northwest',
    variable: LOAD,
    unit: 'MWh',
    axisIndex: -1,
    groupBy: 'Group',
    groupValue: 'Northwest',
    members: ['AREA_AV', 'AREA_NV'],
    filterContext: context,
  });
  const read = (ref) => ref.filterContext.map((entry) => pinnedConstraint(entry, ref));

  assert.deepEqual(read(group), ['≥ 500', 'is North', '≥ 100'], 'an unswitched pin reads as today');
  const [onGen] = retargetVariable([{ ref: group, color: '#a' }], GEN, kinds);
  assert.deepEqual(
    read(onGen.ref),
    ['≥ 500 (chosen on Load (MWh))', 'is North', '≥ 100'],
    'only the stat filter names what it was chosen on',
  );
  const [pct] = retargetPercent([onGen], true, kinds);
  assert.equal(
    read(pct.ref)[0],
    '≥ 500 (chosen on Load (MWh), in MWh)',
    'the first stamp holds through a second switch',
  );
  const [home] = retargetPercent(retargetVariable([pct], LOAD, kinds), false, kinds);
  assert.equal(read(home.ref)[0], '≥ 500', 'back where it was chosen, no note');

  const [pctGroup] = retargetPercent([{ ref: group, color: '#a' }], true, kinds);
  const [backToMwh] = retargetPercent([pctGroup], false, kinds);
  assert.equal(read(pctGroup.ref)[0], '≥ 500 (chosen in MWh)');
  assert.equal(read(backToMwh.ref)[0], '≥ 500');
  const chosenInPct = withRowId({
    ...group,
    perUnit: true,
    unit: '%',
    filterContext: [{ key: 'stat.max', label: 'Max', constraint: '≥ 80' }],
  });
  const [inMwh] = retargetPercent([{ ref: chosenInPct, color: '#a' }], false, kinds);
  assert.equal(read(inMwh.ref)[0], '≥ 80 (chosen in %)', 'a bound chosen in % says so in MWh');

  // A stamped pin is wire format: it saves and restores, and a pin without a
  // stamp restores unchanged.
  const wire = JSON.parse(JSON.stringify(savePins([onGen, { ref: group, color: '#b' }], ['c1'])));
  const [back, plain] = restorePins(wire, [{ id: 'c1', name: 'c1' }]);
  assert.deepEqual(read(back.ref), read(onGen.ref));
  assert.deepEqual(plain.ref.filterContext, context);
  ok('a switched filtered group pin names what chose its members, only where it matters');
}

{
  // The review's cases. Area Groups and Bus Groups list their rows in %, so
  // a group pin switched to % is still listed on the Selected tab.
  setGroupings('Name,Grouping\nAREA_AV,North\nAREA_NV,North');
  const LOAD = 'Load (MWh)';
  const area = areaTable(['AREA_AV', 'AREA_NV'], [LOAD, 'Mystery (x)'], (a) => (a + 1) * 10);
  const groups = buildAreaTab({
    tables: [areaTableIn(area, LOAD)],
    variable: LOAD,
    areas: null,
    groupBy: 'Group',
    isGroupTab: true,
    perUnit: true,
  });
  assert.equal(groups.rows[0].perUnit, true);
  assert.equal(groups.rows[0].unit, '%');
  assert.equal(groups.columns.find((c) => c.key === 'stat.max').value(0), 1, 'its own peak');

  const { BUS_GROUP_BY, setBusMembership, clearBusGroups } =
    await import('../src/tables/bus/groups.ts');
  setBusMembership(new Map([['West', [101, 102]]]));
  const bus = { ...busTable([101, 102], ['A', 'B'], (i) => i + 1), quantity: 'Load (MWh)' };
  const busGroups = buildBusTab({
    tables: [{ ...busTableIn(bus), slotKey: 'bus Load' }],
    list: undefined,
    areas: null,
    isGroupTab: true,
    perUnit: true,
  });
  assert.equal(busGroups.rows[0].groupBy, BUS_GROUP_BY);
  assert.equal(busGroups.rows[0].perUnit, true);
  assert.equal(busGroups.columns.find((c) => c.key === 'stat.max').value(0), 1);
  clearBusGroups();

  // A metric with no aggregation rule is refused by the Area draw, so it is
  // never offered.
  const kinds = {
    area: areaRetarget([{ caseId: 'c1', slotKey: 'area', data: area }], (v, d) =>
      combinesAcrossAreas(v, [d]),
    ),
  };
  const pin = withRowId({
    kind: 'area',
    caseId: 'c1',
    slotKey: 'area',
    entity: 'AREA_AV',
    variable: LOAD,
    unit: 'MWh',
    axisIndex: 0,
  });
  assert.equal(targetOf(kinds, pin, 'Mystery (x)'), null);

  // Mixed %, and one pin that cannot go to %: the click brings the rest back
  // rather than leaving the set stuck half moved.
  const { generatorAnswers } = await import('../src/tables/generator/ui/retarget.ts');
  clearLookups();
  const genKinds = {
    ...kinds,
    generator: retargetOf(
      generatorAnswers,
      [
        {
          caseId: 'c1',
          slotKey: 'g',
          data: {
            generators: ['U1'],
            presence: Uint8Array.from([1]),
            quantity: 'Generation (MWh)',
          },
        },
      ],
      () => true,
    ),
  };
  const pool = withRowId({
    kind: 'generator',
    caseId: 'c1',
    slotKey: 'g',
    entity: 'Pool',
    variable: 'Generation (MWh)',
    unit: 'MWh',
    axisIndex: -1,
    groupBy: 'Injection Group',
    groupValue: 'Pool',
  });
  const pct = withRowId({ ...pin, perUnit: true, unit: '%' });
  assert.deepEqual(percentSwitch([pool, pct], genKinds), { on: false, next: false });
  assert.ok(percentSwitch([pool], genKinds).refusal, 'alone, it refuses');

  // A switch rescales the Selected tab's stat columns, so its bounds go.
  const { readFileSync } = await import('node:fs');
  const drawer = readFileSync(new URL('../src/ui/browse-drawer.ts', import.meta.url), 'utf8');
  const replace = drawer.slice(drawer.indexOf('replacePins(entries) {'));
  assert.ok(replace.indexOf('dropBounds(SELECTED)') < replace.indexOf('adoptPins('));
  ok('groups tabs list % rows; an unruled metric, a stuck % set and stale bounds are handled');
}
