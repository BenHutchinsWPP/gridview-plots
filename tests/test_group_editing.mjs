// tests/test_group_editing.mjs — the one group-editing flow Generator, Bus and
// Interface share, driven through a fake kind and a fake host.
//
// What has to be right:
//
//   * **an editor's file is recorded after Apply adopts it, never on
//     cancel**, and an Apply that throws is said, not recorded.
//   * **every change to a map moves the kind's revision**, which the browse
//     rebuild key reads; a restore of the map already loaded moves nothing.
//   * **a bundle carrying no map leaves the session's alone**, and says so.
//   * **"add shown" drops grouped rows and states both counts** when the rows
//     are more than the members, and opens nothing on an empty table.
//   * **the module holds no app state**: it imports no store and resolves no
//     DOM id, and main.ts drives all three kinds through it.
//
// Run:  node tests/test_group_editing.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './test_loader.mjs';

const { groupEditing } = await import('../src/app/group-editing.ts');

let checks = 0;
async function check(what, fn) {
  await fn();
  checks++;
  console.log(`ok - ${what}`);
}

/** A kind whose map is a plain array, logging every call in order. */
function fixture({ answer = null, throwOnSet = false } = {}) {
  const log = [];
  let map = null;
  let rev = 0;
  let opened;
  const spec = {
    kind: 'bus',
    nouns: {
      tab: 'Bus',
      member: 'bus',
      members: 'buses',
      counted: 'bus(es)',
      keyedBy: 'bus number',
    },
    keyOf: (entity) => (Number.isInteger(Number(entity)) ? Number(entity) : undefined),
    edit: (from) => {
      opened = from;
      log.push('edit');
      return Promise.resolve(answer);
    },
    load: (text) => {
      map = text.split(',');
      return { groups: map.length };
    },
    set: (edit) => {
      log.push('set');
      if (throwOnSet) throw new Error('refused');
      map = edit;
    },
    summarize: () => ({ groups: map === null ? 0 : map.length }),
    notes: (summary, lead) => [`${lead}: ${summary.groups}`],
    exported: () => map,
    adopt: (saved) => {
      map = saved;
    },
    bump: () => rev++,
  };
  const said = [];
  const host = {
    say: (lines) => {
      said.push(lines);
      log.push('say');
    },
    render: () => log.push('render'),
    recordEditor: (kind, applied) => log.push(`record ${kind} ${applied.source?.file ?? 'none'}`),
  };
  return {
    editing: groupEditing(spec, host),
    log,
    said,
    rev: () => rev,
    map: () => map,
    opened: () => opened,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const row = (entity, groupBy) => ({ entity, groupBy });

await check('Apply adopts, moves the revision, says, renders, then records', async () => {
  const f = fixture({ answer: { value: ['A', 'B'], source: { file: 'g.csv' }, changed: true } });
  f.editing.editFromTab(undefined);
  await settle();
  assert.deepEqual(f.log, ['edit', 'set', 'say', 'render', 'record bus g.csv']);
  assert.equal(f.rev(), 1);
  assert.deepEqual(f.said, [['Bus groups updated: 2']]);
  assert.equal(f.opened(), undefined, 'an unfiltered tab offers no picker');
});

await check('a cancel records nothing and moves nothing', async () => {
  const f = fixture({ answer: null });
  f.editing.editFromTab([row(1)]);
  await settle();
  assert.deepEqual(f.log, ['edit']);
  assert.equal(f.rev(), 0);
  assert.deepEqual(f.opened(), { members: new Set([1]), open: false });
});

await check('an Apply that throws is said and never recorded', async () => {
  const f = fixture({ answer: { value: [], source: null, changed: true }, throwOnSet: true });
  f.editing.editFromTab(undefined);
  await settle();
  assert.deepEqual(f.log, ['edit', 'set', 'say', 'render']);
  assert.deepEqual(f.said, [['refused']]);
});

await check('a dropped file loads, moves the revision and returns its notes', async () => {
  const f = fixture();
  assert.deepEqual(f.editing.loadFile('A,B,C', {}, 'groups.csv'), [
    'groups.csv: bus groups loaded: 3',
  ]);
  assert.equal(f.rev(), 1);
});

await check('a bundle with no map, or the same map, leaves the session alone', async () => {
  const f = fixture();
  f.editing.loadFile('A', {}, 'x');
  assert.deepEqual(f.editing.adoptSaved(null, 'study.gvmb'), [
    'study.gvmb carried no bus group membership — the map now loaded was left alone.',
  ]);
  assert.deepEqual(f.editing.adoptSaved(['A'], 'study.gvmb'), []);
  assert.equal(f.rev(), 1, 'neither moves the revision');
  assert.deepEqual(f.editing.adoptSaved(['A', 'B'], 'study.gvmb'), [
    'Bus groups came from study.gvmb: 2',
  ]);
  assert.equal(f.rev(), 2);
  assert.deepEqual(f.map(), ['A', 'B']);
});

await check('"add shown" drops grouped rows and states both counts', async () => {
  const f = fixture();
  f.editing.addShown([row(7), row(7), row('NORTH', 'zone'), row('x')]);
  await settle();
  assert.deepEqual(f.opened(), { members: new Set([7]), open: true });
  assert.deepEqual(f.said, [
    [
      'Bus groups: 4 shown row(s) are 1 distinct bus(es) — membership is by bus number, ' +
        'so a bus in several cases is one member.',
    ],
  ]);
});

await check('"add shown" on a table with no members opens nothing', async () => {
  const f = fixture();
  f.editing.addShown([row('NORTH', 'zone')]);
  await settle();
  assert.deepEqual(f.log, ['say', 'render']);
  assert.deepEqual(f.said, [
    ['Nothing to add: the Bus tab is showing no rows, so its filters keep no buses.'],
  ]);
});

await check('the flow holds no app state, and main.ts drives every kind through it', () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const code = read('src/app/group-editing.ts')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
    .join('\n');
  const imports = [...code.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(
    imports.filter((path) => /store|case-model|main|storage|limits|lookups|tables\//.test(path)),
    [],
    'the group-editing flow imports no store and no kind',
  );
  assert.doesNotMatch(code, /document\.|getElementById|querySelector/, 'and resolves no DOM id');
  const main = read('src/main.ts');
  const kinds = read('src/app/group-kinds.ts');
  for (const kind of ['generator', 'bus', 'interface']) {
    assert.match(
      kinds,
      new RegExp(`const ${kind}Editing = groupEditing\\(\\s*\\{\\s*kind: '${kind}'`),
      `group-kinds.ts states the ${kind} spec`,
    );
    assert.match(kinds, new RegExp(`bump: source\\.bump\\.${kind},`), `${kind} bumps the root's`);
    assert.match(main, new RegExp(`${kind}: \\(\\) => ${kind}GroupsRev\\+\\+`), `${kind} revision`);
  }
  assert.match(
    main,
    /const groupKinds = createGroupKinds\(/,
    'main.ts drives every kind through it',
  );
  assert.match(main, /recordEditor: recordEditorGroups/, 'the host records through the inventory');
});

console.log(`\n${checks} group-editing checks passed.`);
