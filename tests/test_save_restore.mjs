// tests/test_save_restore.mjs — save and both restore paths, through
// `createSaveRestore` and a fake host.
//
// The Case store and the limits store are the real ones, so what a restore
// leaves behind is read off them. Everything else the host does is recorded
// in one list, so each ordering rule is an index comparison: a restore builds
// before it removes, display names land before the view repaints, and the
// inventory is reconciled after every input it reconciles against.
//
// Run: node tests/test_save_restore.mjs

import assert from 'node:assert/strict';
import './test_loader.mjs';

const { createSaveRestore } = await import('../src/app/save-restore.ts');
const { CaseStore } = await import('../src/model/case-model.ts');
const { createLimitsStore } = await import('../src/limits/store.ts');

let passed = 0;
async function check(label, fn) {
  await fn();
  passed++;
  console.log(`ok - ${label}`);
}

const AREA = { kind: 'area' };
const FLOW = { kind: 'interface', variant: 'Power Flow (MW)' };

/** A limits table naming one path, told apart by its value. */
function limitTable(source, value) {
  return {
    source,
    byInterface: new Map([['SAMPLE_P01', { max: new Float32Array(12).fill(value) }]]),
  };
}

/** A restored Case holding the given slots; the data is a label, since the
 * store never looks inside a table. */
function savedCase(name, slots, displayName) {
  const tables = new Map(
    slots.map((key) => [JSON.stringify(key), { key, data: `${name}:${key.kind}` }]),
  );
  return { id: `saved-${name}`, name, tables, ...(displayName ? { displayName } : {}) };
}

/** A bundle as the storage readers hand it over. */
function bundle(restoredCases, extra = {}) {
  return {
    restoredCases,
    warnings: ['SAMPLE warning: a kind this build skips.'],
    pins: [],
    groupings: null,
    generatorGroups: null,
    busGroups: null,
    interfaceGroups: null,
    lookups: new Map(),
    limits: { shared: undefined, byIndex: new Map(), dropped: 0 },
    inventory: { records: [] },
    ...extra,
  };
}

/** A loaded study, a fake host over it and the list of what the host did. */
function setup({ read, load, download, attachThrowsOn } = {}) {
  const store = new CaseStore();
  const old = store.createCase('SAMPLE_old');
  store.attachTable(old.id, AREA, 'old:area');
  const limits = createLimitsStore();
  limits.setCaseLimits(old.id, limitTable('old.csv', 1));
  const calls = [];
  const said = new Map();

  const cases = {
    listCases: () => store.listCases(),
    createCase: (name) => {
      calls.push(`createCase ${name}`);
      return store.createCase(name);
    },
    attachTable: (id, key, data, opts) => {
      if (attachThrowsOn !== undefined && data === attachThrowsOn) throw new Error('SAMPLE slot');
      store.attachTable(id, key, data, opts);
    },
    removeCase: (id) => {
      calls.push(`removeCase ${id}`);
      store.removeCase(id);
    },
    setDisplayName: (id, text) => {
      calls.push(`setDisplayName ${text}`);
      store.setDisplayName(id, text);
    },
  };
  const host = {
    cases,
    limits: {
      dropCaseLimits: (id) => limits.dropCaseLimits(id),
      adoptLimits: (shared, byCase) => {
        calls.push('adoptLimits');
        limits.adoptLimits(shared, byCase);
      },
      caseLimits: () => limits.caseLimits(),
    },
    inventory: {
      restore: (saved, context) => calls.push({ restore: context }),
      logRefused: (files, reason) => calls.push(`logRefused ${reason}`),
      logRefusedSource: (source, reason) => calls.push(`logRefusedSource ${source}: ${reason}`),
    },
    storage: {
      downloadBundle: async (loaded, progress, contents) => {
        calls.push({ download: loaded, contents });
        if (download) return download();
        return 'SAMPLE.gvmb';
      },
      saveBundle: async (loaded, progress, contents) => calls.push({ save: loaded, contents }),
      readBundleFile: async () => read(),
      loadBundle: async () => load(),
    },
    say: (channel, lines) => said.set(channel, [...lines]),
    setBusy: (message) => calls.push(`busy ${message}`),
    render: () => calls.push('render'),
    closeContents: () => calls.push('closeContents'),
    dropCaseBuffers: (id) => calls.push(`dropCaseBuffers ${id}`),
    contents: () => {
      calls.push('contents');
      return { layout: ['time'] };
    },
    restoreView: (loaded, made) => calls.push({ restoreView: made }),
    adoptGroups: (loaded, named, taken) => {
      calls.push('adoptGroups');
      taken.add('groups:area');
      return [`groups from ${named.inline}`];
    },
    adoptLookups: () => calls.push('adoptLookups'),
    lookupSources: () => ['SAMPLE_list.csv'],
  };
  for (const kind of ['area', 'interface', 'bus', 'generator']) said.set(kind, [`${kind} account`]);
  said.set('session', ['earlier session note']);
  return { store, old, limits, calls, said, flow: createSaveRestore(host) };
}

const index = (calls, match) =>
  calls.findIndex((call) => (typeof match === 'string' ? call === match : match(call)));
const file = (name) => ({ name });

// ------------------------------------------------------------------- save

await check('save refuses a study with no table, and writes nothing', async () => {
  const { store, old, calls, said, flow } = setup();
  store.detachTable(old.id, AREA);
  await flow.saveAll();
  assert.deepEqual(said.get('session'), ['Nothing to save yet — drop a CSV export first.']);
  assert.equal(
    index(calls, (call) => call.download || call.save),
    -1,
    'no writer ran',
  );
});

await check('save hands both writers every Case, reads its contents once', async () => {
  const { store, calls, said, flow } = setup();
  // An Interface-only Case: a save that kept only Area tables would leave it
  // out of the .gvmb and OPFS.
  const flowOnly = store.createCase('SAMPLE_flow_only');
  store.attachTable(flowOnly.id, FLOW, 'flow');
  await flow.saveAll();
  const download = calls.find((call) => call.download);
  const save = calls.find((call) => call.save);
  assert.equal(download.download.length, 2, 'the file gets both Cases');
  assert.equal(save.save.length, 2, 'and so does origin-private storage');
  assert.equal(download.contents, save.contents, 'one read of the contents serves both');
  assert.equal(calls.filter((call) => call === 'contents').length, 1);
  assert.ok(index(calls, (call) => call.download) < index(calls, (call) => call.save));
  assert.match(said.get('session')[0], /^Saved 2 case\(s\) \(2 table\(s\)\) to SAMPLE\.gvmb/);
  assert.equal(calls.at(-1), 'busy null', 'and the busy line ends');
});

await check('a cancelled save says so, and ends the busy line', async () => {
  const { calls, said, flow } = setup({
    download: () => {
      throw new DOMException('cancelled', 'AbortError');
    },
  });
  await flow.saveAll();
  assert.deepEqual(said.get('session'), ['Save cancelled.']);
  assert.equal(
    index(calls, (call) => call.save),
    -1,
    'the second writer never ran',
  );
  assert.equal(calls.at(-1), 'busy null');
});

// ------------------------------------------------------------ restore

await check('a bundle with no readable table is refused, the study untouched', async () => {
  const empty = bundle([savedCase('SAMPLE_empty', [])]);
  for (const path of ['file', 'load']) {
    const { store, old, calls, said, flow } = setup({ read: () => empty, load: () => empty });
    const notes =
      path === 'file'
        ? await flow.restoreBundleFile(file('SAMPLE.gvmb'))
        : (await flow.loadAll(), said.get('session'));
    assert.deepEqual(
      store.listCases().map((entry) => entry.id),
      [old.id],
      `${path}: the loaded study is left as it was`,
    );
    assert.match(notes[0], /carried no table this build can read/, path);
    assert.ok(notes.includes(empty.warnings[0]), `${path}: the warnings are said even so`);
    assert.ok(
      index(calls, (call) => typeof call === 'string' && call.startsWith('logRefused')) >= 0,
      `${path}: the refusal is logged`,
    );
    assert.equal(
      index(calls, (call) => call.restoreView),
      -1,
      `${path}: nothing is adopted`,
    );
    assert.equal(said.get('area')[0], 'area account', `${path}: no kind channel is cleared`);
  }
});

await check('a restore builds every Case before it removes one, with every slot', async () => {
  const saved = bundle([
    savedCase('SAMPLE_a', [AREA, FLOW]),
    savedCase('SAMPLE_b', [FLOW], 'SAMPLE shown'),
  ]);
  const { store, old, limits, calls, flow } = setup({ read: () => saved });
  const notes = await flow.restoreBundleFile(file('SAMPLE.gvmb'));
  assert.equal(notes[0], 'Restored 2 case(s) from SAMPLE.gvmb.');
  assert.ok(notes.includes(saved.warnings[0]), 'the warnings are said');
  assert.ok(
    index(calls, 'createCase SAMPLE_b') < index(calls, `removeCase ${old.id}`),
    'the old Case goes only once every new one exists',
  );
  const now = store.listCases();
  assert.deepEqual(
    now.map((entry) => [entry.name, [...entry.tables.values()].map((t) => t.data)]),
    [
      ['SAMPLE_a', ['SAMPLE_a:area', 'SAMPLE_a:interface']],
      ['SAMPLE_b', ['SAMPLE_b:interface']],
    ],
    'every slot of every saved Case is attached, not only Area',
  );
  assert.equal(now[1].displayName, 'SAMPLE shown', 'a saved display name is adopted');
  assert.equal(limits.caseLimits().has(old.id), false, "the old Case's limits go with it");
  assert.ok(index(calls, `dropCaseBuffers ${old.id}`) >= 0, 'and so do its drawn buffers');
});

await check('a restore that throws part-way rolls back and keeps the study', async () => {
  const saved = bundle([savedCase('SAMPLE_a', [AREA]), savedCase('SAMPLE_b', [AREA])]);
  const { store, old, said, flow } = setup({ read: () => saved, attachThrowsOn: 'SAMPLE_b:area' });
  const notes = await flow.restoreBundleFile(file('SAMPLE.gvmb'));
  assert.deepEqual(notes, ['SAMPLE.gvmb: SAMPLE slot']);
  assert.deepEqual(
    store.listCases().map((entry) => entry.id),
    [old.id],
    'the half-built Cases are removed and the loaded one kept',
  );
  assert.equal(said.get('area')[0], 'area account', 'no kind channel is cleared');
});

await check('a restore clears every kind channel, and not session', async () => {
  const saved = bundle([savedCase('SAMPLE_a', [AREA])]);
  const { said, flow } = setup({ read: () => saved });
  await flow.restoreBundleFile(file('SAMPLE.gvmb'));
  for (const kind of ['area', 'interface', 'bus', 'generator']) {
    assert.deepEqual(said.get(kind), [], `${kind}: an account of Cases that are gone`);
  }
  assert.deepEqual(said.get('session'), ['earlier session note'], 'the caller writes session');
});

await check('both restore paths adopt one session, in one order, by the Cases made', async () => {
  const saved = () =>
    bundle([savedCase('SAMPLE_a', [AREA]), savedCase('SAMPLE_b', [FLOW], 'SAMPLE shown')], {
      // Pinned to the SECOND Case only, so a restore by the saved id or from
      // the wrong end is caught.
      limits: {
        shared: undefined,
        byIndex: new Map([[1, limitTable('own.csv', 250)]]),
        dropped: 1,
      },
      lookups: new Map([['buslist', { rowCount: 3, entity: 'bus' }]]),
    });
  const orders = [];
  for (const path of ['file', 'load']) {
    const { store, limits, calls, said, flow } = setup({ read: saved, load: saved });
    const notes =
      path === 'file'
        ? await flow.restoreBundleFile(file('SAMPLE.gvmb'))
        : (await flow.loadAll(), said.get('session'));
    const made = store.listCases();
    assert.equal(limits.limitFor(made[1].id, 'SAMPLE_P01')?.max[0], 250, `${path}: by index`);
    assert.equal(limits.limitFor(made[0].id, 'SAMPLE_P01'), undefined, path);
    assert.ok(
      notes.some((line) => /limits pinned to 1 case\(s\)\. 1 case-specific limit table/.test(line)),
      `${path}: the dropped limit table is said`,
    );
    assert.ok(
      notes.some((line) => /3 bus row\(s\), from SAMPLE_list\.csv/.test(line)),
      path,
    );
    const restore = calls.find((call) => call.restore).restore;
    assert.deepEqual(
      restore.made.map((entry) => entry.id),
      made.map((entry) => entry.id),
      `${path}: the inventory is re-keyed onto the Cases made`,
    );
    assert.ok(restore.adopted.has('groups:area'), `${path}: an input the groups took is adopted`);
    assert.ok(restore.adopted.has('buslist'), `${path}: a carried list is adopted`);
    orders.push(
      calls
        .filter((call) =>
          typeof call === 'object'
            ? call.restoreView || call.restore
            : /^(setDisplayName|adopt)/.test(call),
        )
        .map((call) => (typeof call === 'object' ? Object.keys(call)[0] : call.split(' ')[0])),
    );
  }
  assert.deepEqual(orders[0], [
    'setDisplayName',
    'restoreView',
    'adoptGroups',
    'adoptLookups',
    'adoptLimits',
    'restore',
  ]);
  assert.deepEqual(orders[1], orders[0], 'Load… adopts exactly what a dropped bundle does');
});

await check('Load… closes the Contents panel first, and logs a bundle it refuses', async () => {
  const { calls, flow } = setup({
    load: () => {
      throw new Error('SAMPLE stale version');
    },
  });
  await assert.rejects(flow.loadAll(), /SAMPLE stale version/, 'the caller hears the failure');
  assert.equal(calls[0], 'closeContents');
  assert.equal(calls[1], 'busy Loading…');
  assert.ok(calls.includes('logRefusedSource origin-private storage: SAMPLE stale version'));
  assert.equal(calls.at(-1), 'busy null');
});

console.log(`\n${passed} save/restore checks passed.`);
