// tests/test_inventory.mjs — the Contents panel's inventory, through its
// public API only: record what the ingest host attached, then read the pivot,
// the readout's file count and a record's detail.
//
// The rules it guards: a record is a FILE, not a name and not a table. Two
// same-named files are two records; one long file behind several metric slots
// is one record listed in each; a merged table lists every member. Every kind
// column is in every row, so a blank cell is visible.

import assert from 'node:assert/strict';
import './test_loader.mjs';

const { createInventory, cellSummary, NOT_RECORDED } = await import('../src/inventory/store.ts');

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`ok - ${label}`);
}

const COLUMNS = [
  { kind: 'alpha', label: 'Alpha', enables: 'alpha things' },
  { kind: 'beta', label: 'Beta', enables: 'beta things' },
  { kind: 'gamma', label: 'Gamma', enables: 'gamma things' },
];
const CASES = [
  { id: 'c1', name: 'One', color: '#111111' },
  { id: 'c2', name: 'Two', color: '#222222' },
];

const file = (name, size = 10, lastModified = 1_700_000_000_000) =>
  new File(['x'.repeat(size)], name, { lastModified });
const wide = (f, kept = 3, inSource = 4) => ({
  file: f,
  shape: 'W',
  counts: { of: 'entities', kept, inSource },
});
const long = (f, of = 'entities', kept = 5, inSource = 5) => ({
  file: f,
  shape: 'L',
  counts: { of, kept, inSource },
});

/** The text a cell reads as: `variant: a + b`, one line per table. */
const cellText = (lines) =>
  lines.map((line) =>
    [
      line.variant === undefined ? '' : `${line.variant}: `,
      line.files.map((f) => f.name).join(' + '),
    ].join(''),
  );

check('several variants of one kind stack in one cell, in variant order', () => {
  const inventory = createInventory(() => 0);
  inventory.recordTable('c1', { kind: 'beta', variant: 'Q2' }, [wide(file('SAMPLE_q2.csv'))]);
  inventory.recordTable('c1', { kind: 'beta', variant: 'Q1' }, [wide(file('SAMPLE_q1.csv'))]);
  const view = inventory.pivot(CASES, COLUMNS);
  assert.deepEqual(cellText(view.rows[0].cells[1].lines), [
    'Q1: SAMPLE_q1.csv',
    'Q2: SAMPLE_q2.csv',
  ]);
});

check('a pivot row reads as the Case label, with the name drops join on beside it', () => {
  const inventory = createInventory(() => 0);
  const view = inventory.pivot(
    [{ id: 'c1', name: 'Peak', original: 'SAMPLE_run_v3', color: '#111111' }, CASES[1]],
    COLUMNS,
  );
  assert.equal(view.rows[0].name, 'Peak');
  assert.equal(view.rows[0].original, 'SAMPLE_run_v3');
  assert.ok(!('original' in view.rows[1]), 'a Case shown by its name has no second name');
});

check('a table with no variant reads as just its filename', () => {
  const inventory = createInventory(() => 0);
  inventory.recordTable('c1', { kind: 'alpha' }, [long(file('SAMPLE_a.csv'), 'metrics')]);
  const view = inventory.pivot(CASES, COLUMNS);
  assert.deepEqual(cellText(view.rows[0].cells[0].lines), ['SAMPLE_a.csv']);
});

check('a merged table lists every member file, joined by +', () => {
  const inventory = createInventory(() => 0);
  const halves = [file('SAMPLE_h1.csv'), file('SAMPLE_h2.csv')];
  inventory.recordTable(
    'c2',
    { kind: 'beta', variant: 'Q1' },
    halves.map((f) => wide(f)),
  );
  const view = inventory.pivot(CASES, COLUMNS);
  assert.deepEqual(cellText(view.rows[1].cells[1].lines), ['Q1: SAMPLE_h1.csv + SAMPLE_h2.csv']);
  assert.equal(inventory.fileCount(['c2']), 2, 'two files went in');
});

check('one long file behind N metric slots is ONE record, named under each slot', () => {
  const inventory = createInventory(() => 0);
  const one = file('SAMPLE_long.csv');
  for (const variant of ['M1', 'M2', 'M3']) {
    inventory.recordTable('c1', { kind: 'gamma', variant }, [long(one)]);
  }
  const lines = inventory.pivot(CASES, COLUMNS).rows[0].cells[2].lines;
  assert.deepEqual(cellText(lines), [
    'M1: SAMPLE_long.csv',
    'M2: SAMPLE_long.csv',
    'M3: SAMPLE_long.csv',
  ]);
  const ids = new Set(lines.map((line) => line.files[0].id));
  assert.equal(ids.size, 1, 'the same record, not three');
  assert.equal(inventory.fileCount(['c1']), 1, 'the readout counts it once');
  const detail = inventory.detail([...ids][0]);
  assert.equal(detail.fields.find((f) => f.label === 'Variants').value, 'M1, M2, M3');
});

check('two same-named files are two records', () => {
  const inventory = createInventory(() => 0);
  const left = file('SAMPLE_same.csv', 10);
  const right = file('SAMPLE_same.csv', 20);
  inventory.recordTable('c1', { kind: 'alpha' }, [long(left, 'metrics')]);
  inventory.recordTable('c2', { kind: 'alpha' }, [long(right, 'metrics')]);
  assert.equal(inventory.fileCount(['c1', 'c2']), 2);
  const [one, two] = inventory
    .pivot(CASES, COLUMNS)
    .rows.map((row) => row.cells[0].lines[0].files[0]);
  assert.notEqual(one.id, two.id);
  // Notes attach by the File object: a note about the second never lands on
  // the first, though their names are equal.
  inventory.noteFiles([right], 'about the second only');
  assert.deepEqual(inventory.detail(one.id).notes, []);
  assert.deepEqual(inventory.detail(two.id).notes, ['about the second only']);
});

check('every column is in every row; an unloaded kind is a blank cell', () => {
  const inventory = createInventory(() => 0);
  inventory.recordTable('c1', { kind: 'alpha' }, [long(file('SAMPLE_a.csv'), 'metrics')]);
  const view = inventory.pivot(CASES, COLUMNS);
  assert.deepEqual(
    view.columns.map((column) => [column.kind, column.enables]),
    COLUMNS.map((column) => [column.kind, column.enables]),
  );
  for (const row of view.rows) assert.equal(row.cells.length, COLUMNS.length);
  assert.deepEqual(view.rows[0].cells[1], { lines: [] });
  assert.deepEqual(view.rows[0].cells[2], { lines: [] });
  assert.deepEqual(
    view.rows[1].cells.map((cell) => cell.lines.length),
    [0, 0, 0],
    'a Case with nothing recorded is still a row',
  );
  assert.deepEqual(
    view.rows.map((row) => [row.caseId, row.name, row.color]),
    CASES.map((entry) => [entry.id, entry.name, entry.color]),
    'rows come in the order the caller gave',
  );
});

check('a re-attached slot lists the new files only', () => {
  const inventory = createInventory(() => 0);
  inventory.recordTable('c1', { kind: 'alpha' }, [long(file('SAMPLE_old.csv'), 'metrics')]);
  inventory.recordTable('c1', { kind: 'alpha' }, [long(file('SAMPLE_new.csv'), 'metrics')]);
  assert.deepEqual(cellText(inventory.pivot(CASES, COLUMNS).rows[0].cells[0].lines), [
    'SAMPLE_new.csv',
  ]);
  assert.equal(inventory.fileCount(['c1']), 1, 'the replaced file is no longer behind anything');
});

check('the readout counts distinct files behind the Cases it is given', () => {
  const inventory = createInventory(() => 0);
  const shared = file('SAMPLE_long.csv');
  inventory.recordTable('c1', { kind: 'gamma', variant: 'M1' }, [long(shared)]);
  inventory.recordTable('c1', { kind: 'gamma', variant: 'M2' }, [long(shared)]);
  inventory.recordTable('c1', { kind: 'alpha' }, [long(file('SAMPLE_a.csv'), 'metrics')]);
  inventory.recordTable('c2', { kind: 'beta' }, [wide(file('SAMPLE_b.csv'))]);
  assert.equal(inventory.fileCount(['c1', 'c2']), 3);
  assert.equal(inventory.fileCount(['c1']), 2);
  assert.equal(inventory.fileCount([]), 0, 'a Case no longer loaded counts for nothing');
});

check('counts read as kept of in-source, as metrics or entities', () => {
  const inventory = createInventory(() => 0);
  inventory.recordTable('c1', { kind: 'alpha' }, [long(file('SAMPLE_a.csv'), 'metrics', 2, 7)]);
  inventory.recordTable('c1', { kind: 'beta' }, [wide(file('SAMPLE_b.csv'), 3, 4)]);
  const [alpha, beta] = inventory
    .pivot(CASES, COLUMNS)
    .rows[0].cells.slice(0, 2)
    .map((cell) => inventory.detail(cell.lines[0].files[0].id));
  assert.equal(alpha.fields.find((f) => f.label === 'Metrics').value, '2 kept of 7 in the file');
  assert.equal(beta.fields.find((f) => f.label === 'Entities').value, '3 kept of 4 in the file');
});

check("a record's detail states size, dates, kind and shape", () => {
  const inventory = createInventory(() => 1_700_000_100_000);
  inventory.recordTable('c1', { kind: 'beta', variant: 'Q1' }, [
    wide(file('SAMPLE_b.csv', 2048, 1_700_000_000_000)),
  ]);
  const id = inventory.pivot(CASES, COLUMNS).rows[0].cells[1].lines[0].files[0].id;
  const detail = inventory.detail(id);
  const field = (label) => detail.fields.find((f) => f.label === label)?.value;
  assert.equal(detail.title, 'SAMPLE_b.csv');
  assert.match(field('Size'), /^2\.0 KB \(2,048 B\)$/);
  assert.match(field('Last modified'), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.match(field('Loaded'), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.equal(field('Kind'), 'beta');
  assert.equal(field('Shape'), 'W');
  assert.equal(field('Variant'), 'Q1');
  assert.equal(inventory.detail('no-such-record'), undefined);
  assert.equal(NOT_RECORDED, 'not recorded');
});

check('a note about a file with no record is handed back, not lost', () => {
  const inventory = createInventory(() => 0);
  const refused = file('SAMPLE_refused.csv');
  const loaded = file('SAMPLE_loaded.csv');
  inventory.recordTable('c1', { kind: 'alpha' }, [long(loaded, 'metrics')]);
  assert.deepEqual(inventory.noteFiles([refused, loaded], 'a note'), [refused]);
});

// ------------------------------------------------------- session inputs
//
// Inputs that serve every Case (reference lists, shared limits, group files)
// are one strip row each, declared by the caller. A Case's own limits file is
// a pivot column that falls back to the shared one.

const ROWS = [
  { input: 'list-a', label: 'ListA', enables: 'list a things' },
  { input: 'shared', label: 'Shared', enables: 'shared things' },
  { input: 'groups', label: 'Groups', enables: 'group things' },
];
const WITH_LIMITS = [
  ...COLUMNS,
  {
    kind: 'own',
    label: 'Own',
    enables: 'own things',
    fallback: { input: 'shared', label: 'shared' },
  },
];

check('a merged reference list shows every source file', () => {
  const inventory = createInventory(() => 0);
  inventory.recordSessionInput('list-a', [file('SAMPLE_list1.csv')], 'ListA', { merge: true });
  inventory.recordSessionInput('list-a', [file('SAMPLE_list2.csv')], 'ListA', { merge: true });
  const [list, shared, groups] = inventory.strip(ROWS);
  assert.deepEqual(
    list.files.map((f) => f.name),
    ['SAMPLE_list1.csv', 'SAMPLE_list2.csv'],
  );
  assert.equal(list.enables, 'list a things', 'the row carries the line it was declared with');
  assert.deepEqual(shared.files, [], 'an input never loaded is a blank row, still listed');
  assert.deepEqual(groups.files, []);
  assert.equal(inventory.fileCount([]), 2, 'session files count though no Case is loaded');
});

check('a second shared limits file supersedes the first', () => {
  const inventory = createInventory(() => 0);
  inventory.recordSessionInput('shared', [file('SAMPLE_limits1.csv')], 'Limits');
  inventory.recordSessionInput('shared', [file('SAMPLE_limits2.csv')], 'Limits');
  assert.deepEqual(
    inventory.strip(ROWS)[1].files.map((f) => f.name),
    ['SAMPLE_limits2.csv'],
  );
  assert.equal(inventory.fileCount([]), 1, 'the superseded file is behind nothing');
});

check('a Case with no limits of its own reads `shared` when the shared file serves it', () => {
  const inventory = createInventory(() => 0);
  const before = inventory.pivot(CASES, WITH_LIMITS).rows[0].cells[3];
  assert.deepEqual(before, { lines: [] }, 'no shared file and none of its own: a blank');

  inventory.recordSessionInput('shared', [file('SAMPLE_limits.csv')], 'Limits');
  inventory.recordCaseFile('c2', 'own', file('SAMPLE_own.csv'), 'Limits');
  const [one, two] = inventory.pivot(CASES, WITH_LIMITS).rows.map((row) => row.cells[3]);
  assert.deepEqual(one, { lines: [], fallback: 'shared' });
  assert.deepEqual(cellText(two.lines), ['SAMPLE_own.csv'], "a Case's own file wins");
  assert.equal(two.fallback, undefined);
  // The kind columns never fall back.
  assert.equal(inventory.pivot(CASES, WITH_LIMITS).rows[0].cells[0].fallback, undefined);
});

check("a per-Case limits file's detail names it as limits, with no shape", () => {
  const inventory = createInventory(() => 0);
  inventory.recordCaseFile('c1', 'own', file('SAMPLE_own.csv'), 'Limits');
  const id = inventory.pivot(CASES, WITH_LIMITS).rows[0].cells[3].lines[0].files[0].id;
  const detail = inventory.detail(id);
  assert.equal(detail.fields.find((f) => f.label === 'Kind').value, 'Limits');
  assert.equal(
    detail.fields.find((f) => f.label === 'Shape'),
    undefined,
    'a limits file is not read as W or L',
  );
});

check('a group file replaces the one before, and the row can say it was edited', () => {
  const inventory = createInventory(() => 0);
  inventory.recordSessionInput('groups', [file('SAMPLE_groups1.csv')], 'Groups');
  inventory.recordSessionInput('groups', [file('SAMPLE_groups2.csv')], 'Groups', {
    editedInApp: true,
  });
  const row = inventory.strip(ROWS)[2];
  assert.deepEqual(
    row.files.map((f) => f.name),
    ['SAMPLE_groups2.csv'],
  );
  assert.equal(row.editedInApp, true);
});

// ------------------------------------------------------------------ the Log
//
// Every load, replace, partial load, refusal and skip, in order. A drop's
// accepted files are one `loaded` event, which also carries every note that
// named no file; nothing said at load is lost. A refused or skipped file is
// logged and never becomes a current-state entry.

const CONTEXT = { cases: CASES, columns: COLUMNS, rows: ROWS };
const events = (inventory) => inventory.log(CONTEXT).map((line) => line.event);
const names = (line) => line.files.map((f) => f.name);

check('a drop logs one `loaded` naming its files, with the notes that named none', () => {
  const inventory = createInventory(() => 0);
  const a = file('SAMPLE_a.csv');
  const b = file('SAMPLE_b.csv');
  const refused = file('SAMPLE_refused.csv');
  inventory.beginDrop();
  inventory.recordTable('c1', { kind: 'alpha' }, [long(a, 'metrics')]);
  inventory.recordTable('c1', { kind: 'beta' }, [wide(b)]);
  inventory.recordOutcome({
    failures: [{ files: [refused], note: 'SAMPLE_refused.csv: no header' }],
    warnings: [
      { files: [], note: 'kept 3 of 4 metrics' },
      { files: [a], note: 'about a' },
      { files: [refused], note: 'about a file that loaded nothing' },
    ],
  });
  assert.deepEqual(events(inventory), ['refused'], 'the drop is logged when it ends');
  inventory.endDrop(['said by the root']);
  const log = inventory.log(CONTEXT);
  assert.deepEqual(
    log.map((line) => line.event),
    ['refused', 'loaded'],
  );
  assert.deepEqual(names(log[0]), ['SAMPLE_refused.csv']);
  assert.equal(log[0].reason, 'SAMPLE_refused.csv: no header');
  assert.equal(log[0].files[0].id, undefined, 'a refused file has no record to open');
  assert.deepEqual(names(log[1]), ['SAMPLE_a.csv', 'SAMPLE_b.csv']);
  assert.deepEqual(log[1].notes, [
    'kept 3 of 4 metrics',
    'about a file that loaded nothing',
    'said by the root',
  ]);
  const aId = log[1].files[0].id;
  assert.deepEqual(inventory.detail(aId).notes, ['about a'], "a file's own note stays on it");
  assert.match(log[1].at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
});

check('a drop that loaded nothing still logs its batch notes', () => {
  const inventory = createInventory(() => 0);
  inventory.beginDrop();
  inventory.noteDrop('nothing matched');
  inventory.endDrop();
  const [line] = inventory.log(CONTEXT);
  assert.equal(line.event, 'loaded');
  assert.deepEqual(line.files, []);
  assert.deepEqual(line.notes, ['nothing matched']);
  inventory.beginDrop();
  inventory.endDrop();
  assert.equal(inventory.log(CONTEXT).length, 1, 'an empty drop logs nothing');
});

check('a long file whose metric slot failed is `partial`, with counts, not `loaded`', () => {
  const inventory = createInventory(() => 0);
  const one = file('SAMPLE_long.csv');
  inventory.beginDrop();
  for (const variant of ['M1', 'M2']) {
    inventory.recordTable('c1', { kind: 'gamma', variant }, [long(one)]);
  }
  inventory.recordOutcome({
    failures: [{ files: [one], note: 'M3 could not attach' }],
    warnings: [],
  });
  inventory.endDrop();
  const log = inventory.log(CONTEXT);
  assert.deepEqual(
    log.map((line) => line.event),
    ['partial'],
  );
  assert.equal(log[0].reason, '2 of 3 slot(s) loaded');
  assert.deepEqual(log[0].notes, ['M3 could not attach']);
  assert.deepEqual(inventory.detail(log[0].files[0].id).notes, ['M3 could not attach']);
  assert.equal(inventory.fileCount(['c1']), 1, 'what did load is still current');
});

check('a refused merge group logs each member with the group reason, and records nothing', () => {
  const inventory = createInventory(() => 0);
  const halves = [file('SAMPLE_h1.csv'), file('SAMPLE_h2.csv')];
  inventory.beginDrop();
  inventory.recordOutcome({
    failures: [{ files: halves, note: 'the group could not attach' }],
    refusal: { files: [file('SAMPLE_late.csv')], note: 'no SIMD' },
    warnings: [],
  });
  inventory.endDrop();
  const log = inventory.log(CONTEXT);
  assert.deepEqual(
    log.map((line) => [line.event, names(line), line.reason]),
    [
      ['refused', ['SAMPLE_h1.csv', 'SAMPLE_h2.csv'], 'the group could not attach'],
      ['refused', ['SAMPLE_late.csv'], 'no SIMD'],
    ],
  );
  assert.equal(inventory.fileCount(['c1', 'c2']), 0);
  assert.deepEqual(
    inventory.pivot(CASES, COLUMNS).rows.flatMap((row) => row.cells.flatMap((c) => c.lines)),
    [],
  );
});

check('two same-named files: a failure about one never touches the other', () => {
  const inventory = createInventory(() => 0);
  const left = file('SAMPLE_same.csv', 10);
  const right = file('SAMPLE_same.csv', 20);
  inventory.beginDrop();
  inventory.recordTable('c1', { kind: 'alpha' }, [long(left, 'metrics')]);
  inventory.recordOutcome({ failures: [{ files: [right], note: 'bad rows' }], warnings: [] });
  inventory.endDrop();
  const log = inventory.log(CONTEXT);
  assert.deepEqual(
    log.map((line) => line.event),
    ['refused', 'loaded'],
  );
  assert.equal(log[0].files[0].id, undefined);
  assert.notEqual(log[1].files[0].id, undefined);
  assert.deepEqual(inventory.detail(log[1].files[0].id).notes, []);
});

check('a stopped batch and removed files are `skipped`, never refused, and record nothing', () => {
  const inventory = createInventory(() => 0);
  const picked = file('SAMPLE_picked.csv');
  const removed = file('SAMPLE_removed.csv');
  inventory.beginDrop();
  inventory.logSkipped([removed], 'removed in the Import dialog');
  inventory.recordOutcome({ failures: [], stop: { files: [picked], notes: [] }, warnings: [] });
  inventory.endDrop();
  const log = inventory.log(CONTEXT);
  assert.deepEqual(
    log.map((line) => [line.event, names(line)]),
    [
      ['skipped', ['SAMPLE_removed.csv']],
      ['skipped', ['SAMPLE_picked.csv']],
    ],
  );
  assert.equal(log[0].reason, 'removed in the Import dialog');
  assert.ok(log[1].reason.length > 0, 'a silent stop still says why');
  assert.equal(inventory.fileCount([]), 0);
});

check("a replaced slot's old records move to the Log, named with where they were", () => {
  const inventory = createInventory(() => 0);
  const halves = [file('SAMPLE_old1.csv'), file('SAMPLE_old2.csv')];
  inventory.recordTable(
    'c1',
    { kind: 'beta', variant: 'Q1' },
    halves.map((f) => wide(f)),
  );
  inventory.recordTable('c1', { kind: 'beta', variant: 'Q1' }, [wide(file('SAMPLE_new.csv'))]);
  const log = inventory.log(CONTEXT);
  assert.deepEqual(
    log.map((line) => line.event),
    ['loaded', 'replaced', 'loaded'],
  );
  const replaced = log[1];
  assert.deepEqual(names(replaced), ['SAMPLE_old1.csv', 'SAMPLE_old2.csv']);
  assert.equal(replaced.where, 'One · Beta: Q1');
  assert.equal(replaced.reason, 'by SAMPLE_new.csv');
  assert.ok(
    replaced.files.every((f) => inventory.detail(f.id) !== undefined),
    'an old record can still be opened',
  );
  assert.equal(inventory.fileCount(['c1']), 1);
});

check('a second shared limits file logs the first as replaced; a merged list does not', () => {
  const inventory = createInventory(() => 0);
  inventory.recordSessionInput('shared', [file('SAMPLE_limits1.csv')], 'Limits');
  inventory.recordSessionInput('shared', [file('SAMPLE_limits2.csv')], 'Limits');
  inventory.recordSessionInput('list-a', [file('SAMPLE_list1.csv')], 'ListA', { merge: true });
  inventory.recordSessionInput('list-a', [file('SAMPLE_list2.csv')], 'ListA', { merge: true });
  const log = inventory.log(CONTEXT);
  assert.deepEqual(
    log.map((line) => line.event),
    ['loaded', 'replaced', 'loaded', 'loaded', 'loaded'],
  );
  assert.deepEqual(names(log[1]), ['SAMPLE_limits1.csv']);
  assert.equal(log[1].where, 'Shared');
});

check('a list with duplicate keys dropped is `partial` with its count', () => {
  const inventory = createInventory(() => 0);
  inventory.beginDrop();
  inventory.recordSessionInput('list-a', [file('SAMPLE_list.csv')], 'ListA', {
    merge: true,
    partial: '4 row(s) with a key already read were dropped',
  });
  inventory.endDrop();
  const log = inventory.log(CONTEXT);
  assert.deepEqual(
    log.map((line) => [line.event, line.reason]),
    [['partial', '4 row(s) with a key already read were dropped']],
  );
  assert.deepEqual(
    inventory.strip(ROWS)[0].files.map((f) => f.name),
    ['SAMPLE_list.csv'],
    'what loaded is still the row',
  );
});

check('a refused drop (a load already running) is logged and records nothing', () => {
  const inventory = createInventory(() => 0);
  inventory.logRefused([file('SAMPLE_busy.csv')], 'A load is already running');
  inventory.logRefused([], 'nothing to say');
  assert.deepEqual(events(inventory), ['refused']);
  assert.equal(inventory.fileCount([]), 0);
});

check('a Case no longer loaded is still named in the Log', () => {
  const inventory = createInventory(() => 0);
  inventory.recordTable('gone', { kind: 'alpha' }, [long(file('SAMPLE_1.csv'), 'metrics')]);
  inventory.recordTable('gone', { kind: 'alpha' }, [long(file('SAMPLE_2.csv'), 'metrics')]);
  assert.equal(inventory.log(CONTEXT)[1].where, 'a Case no longer loaded · Alpha');
});

check('a group file applied from an editor logs itself, and says it was edited', () => {
  const inventory = createInventory(() => 0);
  inventory.recordSessionInput('groups', [file('SAMPLE_g1.csv')], 'Groups');
  inventory.recordSessionInput('groups', [file('SAMPLE_g2.csv')], 'Groups', {
    editedInApp: true,
  });
  const log = inventory.log(CONTEXT);
  assert.deepEqual(
    log.map((line) => [line.event, names(line), line.reason]),
    [
      ['loaded', ['SAMPLE_g1.csv'], undefined],
      ['replaced', ['SAMPLE_g1.csv'], 'by SAMPLE_g2.csv'],
      ['loaded', ['SAMPLE_g2.csv'], 'edited in app before Apply'],
    ],
  );
});

check('an edit with no new file flags the row that stands; a blank row stays blank', () => {
  const inventory = createInventory(() => 0);
  inventory.markEdited('groups');
  assert.deepEqual(inventory.strip(ROWS)[2], { ...ROWS[2], files: [], editedInApp: false });
  inventory.recordSessionInput('groups', [file('SAMPLE_g.csv')], 'Groups');
  assert.equal(inventory.strip(ROWS)[2].editedInApp, false);
  inventory.markEdited('groups');
  assert.equal(inventory.strip(ROWS)[2].editedInApp, true);
  assert.deepEqual(
    inventory.strip(ROWS)[2].files.map((f) => f.name),
    ['SAMPLE_g.csv'],
  );
});

// ------------------------------------------------------------------ Copy
//
// A tab-separated long form: one row per (file, slot), one per blank slot
// with an empty filename, every recorded field, and nothing inside a value
// can break a row.

const parseTsv = (text) => {
  assert.ok(text.endsWith('\n'));
  const [header, ...rows] = text
    .slice(0, -1)
    .split('\n')
    .map((line) => line.split('\t'));
  for (const row of rows) assert.equal(row.length, header.length, `a whole row: ${row}`);
  return rows.map((row) => Object.fromEntries(header.map((name, i) => [name, row[i]])));
};

check('Copy: a row per (file, slot), a row per blank, and every recorded field', () => {
  const inventory = createInventory(() => 1_700_000_100_000);
  const one = file('SAMPLE_long.csv', 30, 1_700_000_000_000);
  inventory.beginDrop();
  for (const variant of ['M1', 'M2']) {
    inventory.recordTable('c1', { kind: 'gamma', variant }, [long(one, 'entities', 4, 6)]);
  }
  inventory.recordTable(
    'c2',
    { kind: 'beta', variant: 'Q1' },
    [file('SAMPLE_h1.csv'), file('SAMPLE_h2.csv')].map((f) => wide(f)),
  );
  inventory.recordSessionInput('shared', [file('SAMPLE_limits.csv')], 'Limits');
  inventory.recordSessionInput('groups', [file('SAMPLE_g.csv')], 'Groups', { editedInApp: true });
  inventory.endDrop();
  inventory.noteFiles([one], 'line one\nline\ttwo');

  const rows = parseTsv(inventory.tsv(CASES, WITH_LIMITS, ROWS));
  const key = (row) => [row.Case, row.Input, row.Variant, row.State, row.File].join('|');
  assert.deepEqual(rows.map(key), [
    '|ListA||blank|',
    '|Shared||loaded|SAMPLE_limits.csv',
    '|Groups||loaded|SAMPLE_g.csv',
    'One|Alpha||blank|',
    'One|Beta||blank|',
    'One|Gamma|M1|loaded|SAMPLE_long.csv',
    'One|Gamma|M2|loaded|SAMPLE_long.csv',
    'One|Own||shared|',
    'Two|Alpha||blank|',
    'Two|Beta|Q1|loaded|SAMPLE_h1.csv',
    'Two|Beta|Q1|loaded|SAMPLE_h2.csv',
    'Two|Gamma||blank|',
    'Two|Own||shared|',
  ]);
  const m1 = rows[5];
  assert.equal(m1['Size (bytes)'], '30');
  assert.match(m1['Last modified'], /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.match(m1.Loaded, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.equal(m1.Kind, 'gamma');
  assert.equal(m1.Shape, 'L');
  assert.equal(m1.Variants, 'M1, M2');
  assert.deepEqual([m1.Counted, m1.Kept, m1['In file']], ['entities', '4', '6']);
  assert.equal(m1.Notes, 'line one line two', 'a tab or newline in a note stays in its cell');
  assert.equal(rows[2]['Edited in app'], 'yes');
  assert.equal(rows[1]['Edited in app'], '');
  const blank = rows[0];
  assert.ok(
    Object.entries(blank).every(([name, value]) =>
      ['Input', 'State'].includes(name) ? value !== '' : value === '',
    ),
    'a blank row names its slot and nothing else',
  );
});

check('Copy: a filename with a tab or newline cannot break the row', () => {
  const inventory = createInventory(() => 0);
  inventory.recordTable('c1', { kind: 'alpha', variant: 'odd\tvariant' }, [
    long(file('SAMPLE_\nodd\t.csv'), 'metrics'),
  ]);
  const rows = parseTsv(inventory.tsv(CASES, COLUMNS, []));
  const loaded = rows.filter((row) => row.State === 'loaded');
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].File, 'SAMPLE_ odd .csv');
  assert.equal(loaded[0].Variant, 'odd variant');
});

check('a load that stopped part-way hands back only the files nothing accounted for', () => {
  const inventory = createInventory(() => 0);
  const [loaded, refused, skipped, unreached] = [
    'SAMPLE_loaded.csv',
    'SAMPLE_refused.csv',
    'SAMPLE_skipped.csv',
    'SAMPLE_unreached.csv',
  ].map((name) => file(name));
  inventory.beginDrop();
  inventory.recordTable('c1', { kind: 'alpha' }, [wide(loaded)]);
  inventory.logRefused([refused], 'unreadable');
  inventory.logSkipped([skipped], 'removed in the Import dialog');
  assert.deepEqual(inventory.unaccounted([loaded, refused, skipped, unreached]), [unreached]);
  inventory.endDrop();
});

check('a cell summarises as a count: metrics where it has variants, else files', () => {
  const inventory = createInventory(() => 0);
  const one = file('SAMPLE_long.csv');
  for (const variant of ['M1', 'M2', 'M3']) {
    inventory.recordTable('c1', { kind: 'gamma', variant }, [long(one)]);
  }
  inventory.recordTable('c1', { kind: 'beta', variant: 'Q1' }, [wide(file('SAMPLE_q1.csv'))]);
  inventory.recordTable('c1', { kind: 'alpha' }, [
    wide(file('SAMPLE_h1.csv')),
    wide(file('SAMPLE_h2.csv')),
  ]);
  const [alpha, beta, gamma] = inventory.pivot(CASES, COLUMNS).rows[0].cells;
  assert.equal(
    cellSummary(gamma),
    '3 metrics',
    'one long file behind three slots is three metrics',
  );
  assert.equal(cellSummary(beta), '1 metric');
  assert.equal(cellSummary(alpha), '2 files', 'a table with no variant counts its files');
  assert.equal(cellSummary(inventory.pivot(CASES, COLUMNS).rows[1].cells[0]), undefined);
});

console.log(`\n${passed} checks passed.`);
