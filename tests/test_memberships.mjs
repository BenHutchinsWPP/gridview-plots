// tests/test_memberships.mjs
// Keep categorical membership filtering independent of scalar cells and row order.

import assert from 'node:assert/strict';
import './test_loader.mjs';

const {
  membershipColumn,
  visibleRows,
  keptRowKeys,
  withoutEmptyRows,
  carryFilterContext,
  setColumnVisible,
  setSliced,
  slicerColumns,
  filterConstraint,
} = await import('../src/ui/browse-model.ts');
const { distinctValues, checklistChoices } = await import('../src/ui/value-checklist.ts');
const { browseTableCsv, browseDescriptor } = await import('../src/ui/browse-csv.ts');

const memberships = [
  ['West'],
  ['Coastal', 'West'],
  ['Coastal'],
  [],
  ['West Coast'],
  ['A; B', 'Comma, "quoted"'],
];
const column = membershipColumn('membership.test', 'Memberships', (row) => memberships[row]);
const tab = {
  id: 'test',
  label: 'Test',
  notes: [],
  rows: memberships.map((_, row) => ({
    id: `${row}`,
    entity: `${row}`,
    caseId: 'c',
    slotKey: 's',
    variable: 'V',
  })),
  columns: [column, { key: 'stat.n', kind: 'number', value: (row) => (row === 1 ? 0 : 1) }],
};
let view = setColumnVisible(tab, { sort: null, filters: new Map() }, column.key, true);
const filtered = (values) => ({
  ...view,
  filters: new Map([[column.key, { kind: 'values', values }]]),
});
assert.equal(column.value(1), 'Coastal; West');
assert.equal(typeof column.value(1), 'string');
assert.equal(column.value(3), null);
assert.equal(column.groupable, undefined);
assert.equal(column.defaultHidden, true);
assert.deepEqual([...visibleRows(tab, filtered(['West', 'Coastal']))], [0, 1, 2]);
assert.equal(keptRowKeys(tab, filtered(['West', 'Coastal'])).size, 3);
assert.deepEqual([...visibleRows(tab, filtered(['West']))], [0, 1]);
assert.deepEqual([...visibleRows(tab, filtered(['']))], [3]);
assert.deepEqual([...visibleRows(tab, filtered(['A; B']))], [5]);
const text = (text) => ({ ...view, filters: new Map([[column.key, { kind: 'text', text }]]) });
assert.deepEqual([...visibleRows(tab, text('WEST'))], [0, 1, 4]);
assert.deepEqual([...visibleRows(tab, text('Coastal; West'))], []);
assert.deepEqual([...visibleRows(tab, text(''))], [0, 1, 2, 3, 4, 5]);
assert.deepEqual(distinctValues(column, 6), [
  'A; B',
  'Coastal',
  'Comma, "quoted"',
  'West',
  'West Coast',
  '',
]);
const absent = checklistChoices(column, 6, ['Deleted', 'West']);
assert.deepEqual([...absent.absent], ['Deleted']);
assert.ok(absent.values.includes('Deleted'));
const gone = { ...column, filterValues: () => [], value: () => null };
assert.deepEqual([...checklistChoices(gone, 6, ['West']).absent], ['West']);
assert.deepEqual([...checklistChoices(column, 6, ['West']).absent], []);
assert.deepEqual([...visibleRows(tab, filtered(['Deleted']))], []);
const remapped = withoutEmptyRows(tab);
assert.equal(remapped.columns[0].value(1), 'Coastal');
assert.deepEqual(remapped.columns[0].filterValues(1), ['Coastal']);
assert.deepEqual([...visibleRows(remapped, filtered(['Coastal']))], [1]);
assert.equal(keptRowKeys(remapped, filtered(['Coastal'])).size, 1);
const context = carryFilterContext({ ...tab, rows: [], columns: [] }, tab, filtered(['West']));
assert.equal(context.columns[0].value(0), 'in any of (West)');
const meta = { caseLabel: (id) => id, hourFilter: 'All hours', variable: 'V' };
assert.match(
  browseDescriptor(context, filtered(['West']), meta).join('\n'),
  /Memberships: in any of \(West\)/,
);
assert.match(browseTableCsv(tab, view, meta), /"A; B; Comma, ""quoted"""/);
assert.deepEqual(
  [...visibleRows(tab, { ...view, sort: { key: column.key, direction: 'asc' } })],
  [5, 2, 1, 0, 4, 3],
);
view = setSliced(tab, filtered(['West']), column.key, true);
assert.ok(slicerColumns(tab, view).includes(column));
const unsliced = setSliced(tab, view, column.key, false);
assert.equal(unsliced.filters.get(column.key), view.filters.get(column.key));
const hidden = setColumnVisible(tab, view, column.key, false);
assert.equal(hidden.filters.has(column.key), false);
assert.equal(slicerColumns(tab, hidden).includes(column), false);
assert.equal(filterConstraint({ kind: 'values', values: ['West'] }), 'is West');
const scalar = { key: 's', kind: 'text', value: (row) => ['  West  ', null, 'West Coast'][row] };
const scalarTab = { ...tab, rows: tab.rows.slice(0, 3), columns: [scalar] };
assert.deepEqual(distinctValues(scalar, 3), ['West', 'West Coast', '']);
assert.deepEqual(
  [
    ...visibleRows(scalarTab, {
      ...view,
      filters: new Map([['s', { kind: 'values', values: ['West'] }]]),
    }),
  ],
  [0],
);
assert.deepEqual([...checklistChoices(scalar, 3, ['Deleted']).absent], []);
console.log(
  'ok - individual memberships share union, blank, text, remapping, choices, context and scalar exports',
);
