// tests/test_attach.mjs
//
// The ingest host's attach (src/app/attach.ts), over a real Case store, a real
// inventory and the real kinds' joins:
//   - a generator table split across two drops joins at the cube and lists
//     both files behind its slot, with the loaded table left untouched
//   - a table whose years extend its Case is held, and committed at settle
//   - an Area and a Generator table extended in one drop attach together
//   - an Area-only extension of a two-kind Case is refused at settle, naming
//     the table that differs, and the loaded tables are the same objects
//   - a second held join that throws attaches nothing of its Case
//   - a declined price refuses only that table
//   - a table whose years do not cover the Case's is refused at attach
//   - held Area tables are reindexed when the axis widens
//
// Run: node tests/test_attach.mjs

import assert from 'node:assert/strict';

import './test_loader.mjs';

const { createTableAttach } = await import('../src/app/attach.ts');
const { CaseStore, slotKey } = await import('../src/model/case-model.ts');
const { createInventory } = await import('../src/inventory/store.ts');
const { appendTableOf, appendSizeOf } = await import('../src/tables/registry.ts');
const { reindexCase } = await import('../src/tables/area/axis.ts');
const { YEAR_SLOT_HOURS: H } = await import('../src/model/calendar.ts');

let checks = 0;
async function check(label, fn) {
  await fn();
  checks++;
  console.log(`ok - ${label}`);
}

const AREA = { kind: 'area' };
const GEN = { kind: 'generator', variant: 'Generation (MW)' };
const AREAS = ['ALDER', 'BIRCH'];

function planes(n, firstYear, numYears, seed) {
  const hours = numYears * H;
  const cube = new Float32Array(n * hours);
  for (let p = 0; p < n; p++)
    for (let h = 0; h < hours; h++) cube[p * hours + h] = seed + p * 10 + (h % 5);
  return {
    cube,
    tou: new Uint8Array(hours).fill(1),
    hoursPresent: new Uint8Array(hours).fill(1),
    firstYear,
    numYears,
  };
}
const gen = (names, firstYear = 2030, numYears = 1, seed = 0) => ({
  ...planes(names.length, firstYear, numYears, seed),
  presence: new Uint8Array(names.length).fill(1),
  generators: names,
  sourceColumns: names.slice(),
  quantity: 'Generation (MW)',
});
const area = (metrics, firstYear = 2030, numYears = 1, seed = 0, areas = AREAS) => ({
  ...planes(areas.length * metrics.length, firstYear, numYears, seed),
  presence: new Uint8Array(areas.length * metrics.length).fill(1),
  areas,
  metrics,
  sourceColumns: metrics.slice(),
});
const sources = (...names) =>
  names.map((name) => ({
    file: new File([''], name),
    shape: 'W',
    counts: { of: 'entities', kept: 1, inSource: 1 },
  }));

function session({ confirm = () => true, append = appendTableOf } = {}) {
  const store = new CaseStore();
  const inventory = createInventory(() => 0);
  const asked = [];
  const attach = createTableAttach({
    store,
    inventory,
    append,
    appendSize: appendSizeOf,
    confirmMerge: async (ask) => {
      asked.push(ask);
      return confirm(ask);
    },
    tableLabel: (caseId, slot) => `S's ${slot.kind}${slot.variant ? ' ' + slot.variant : ''} table`,
  });
  const id = store.createCase('S').id;
  const at = (slot) => store.listCases()[0].tables.get(slotKey(slot))?.data;
  return { store, inventory, attach, asked, id, at };
}

const bytes = (t) => Buffer.from(t.cube.buffer.slice(0)).toString('base64');

await check('a generator table split across two drops joins and lists both files', async () => {
  const s = session();
  const west = gen(['A', 'B'], 2030, 1, 0);
  const east = gen(['C'], 2030, 1, 500);
  const before = bytes(west);
  assert.deepEqual(await s.attach.attach(s.id, GEN, west, sources('west.csv'), 'add'), {
    held: false,
    notes: [],
  });
  assert.equal(s.asked.length, 0, 'an empty slot costs no join');
  const result = await s.attach.attach(s.id, GEN, east, sources('east.csv'), 'add');
  assert.equal(result.held, false);
  assert.match(
    result.notes.join(' '),
    /east\.csv joined S's generator Generation \(MW\) table: 1 new generator/,
  );
  assert.equal(s.asked.length, 1, 'the join was priced');
  assert.match(s.asked[0].what, /^the merged S's generator/);
  const t = s.at(GEN);
  assert.deepEqual(t.generators, ['A', 'B', 'C']);
  assert.notEqual(t, west);
  assert.equal(bytes(west), before, 'the loaded cube is untouched');
  assert.deepEqual(
    s.inventory.slotFileNames(s.id).map((e) => e.names),
    [['west.csv', 'east.csv']],
  );
  assert.ok(
    !s.inventory
      .log({ cases: [], rows: [], columns: [] })
      .some((l) => l.event === 'replaced' && l.files.some((f) => f.name === 'east.csv')),
  );
});

await check('a replace takes the slot whole and records without merge', async () => {
  const s = session();
  await s.attach.attach(s.id, GEN, gen(['A']), sources('a.csv'), 'add');
  const next = gen(['Z']);
  await s.attach.attach(s.id, GEN, next, sources('z.csv'), 'replace');
  assert.equal(s.at(GEN), next);
  assert.equal(s.asked.length, 0);
  assert.deepEqual(s.inventory.slotFileNames(s.id)[0].names, ['z.csv']);
});

await check(
  'replacing every slot can change the Case span, and a missing replacement keeps both',
  async () => {
    for (const complete of [false, true]) {
      const s = session();
      const a = area(['Load (MW)']);
      const g = gen(['A']);
      await s.attach.attach(s.id, AREA, a, sources('a30.csv'), 'add');
      await s.attach.attach(s.id, GEN, g, sources('g30.csv'), 'add');
      s.attach.prepare([
        { caseName: 'S', ...AREA, shape: 'W', mode: 'replace' },
        { caseName: 'S', ...GEN, shape: 'W', mode: 'replace' },
      ]);
      assert.deepEqual(s.attach.spansOf('S'), []);
      assert.equal(
        (
          await s.attach.attach(
            s.id,
            AREA,
            area(['Load (MW)'], 2037),
            sources('a37.csv'),
            'replace',
          )
        ).held,
        true,
      );
      if (complete)
        await s.attach.attach(s.id, GEN, gen(['Z'], 2037), sources('g37.csv'), 'replace');
      assert.equal(s.at(AREA), a);
      assert.equal(s.at(GEN), g);
      const outcomes = await s.attach.settle();
      if (complete) {
        assert.ok(outcomes.every((o) => o.outcome.failures.length === 0));
        assert.deepEqual([s.at(AREA).firstYear, s.at(GEN).firstYear], [2037, 2037]);
        assert.deepEqual(s.at(GEN).generators, ['Z']);
      } else {
        assert.ok(outcomes.some((o) => o.outcome.failures.length > 0));
        assert.equal(s.at(AREA), a);
        assert.equal(s.at(GEN), g);
      }
      s.attach.discard();
      assert.equal(s.attach.spansOf('S').length, 2, 'the next drop sees the committed spans');
    }
  },
);

await check('a one-table Case: the extension is held, then committed at settle', async () => {
  const s = session();
  const old = gen(['A', 'B'], 2030, 1, 0);
  await s.attach.attach(s.id, GEN, old, sources('y2030.csv'), 'add');
  const later = gen(['A', 'B'], 2031, 1, 100);
  const result = await s.attach.attach(s.id, GEN, later, sources('y2031.csv'), 'add');
  assert.deepEqual(result, { held: true, notes: [] });
  assert.equal(s.at(GEN), old, 'nothing committed yet');
  assert.deepEqual(s.inventory.slotFileNames(s.id)[0].names, ['y2030.csv']);
  assert.equal(s.asked.length, 0, 'priced at settle, not at hold');
  const out = await s.attach.settle();
  assert.deepEqual(
    out.map((o) => o.kind),
    ['generator'],
  );
  assert.deepEqual(out[0].outcome.failures, []);
  assert.match(out[0].outcome.warnings[0].note, /now spans 2030-2031/);
  const t = s.at(GEN);
  assert.deepEqual([t.firstYear, t.numYears], [2030, 2]);
  assert.equal(t.cube[H + 3], later.cube[3], 'the new year is in place');
  assert.deepEqual(s.inventory.slotFileNames(s.id)[0].names, ['y2030.csv', 'y2031.csv']);
  assert.equal(s.asked.length, 1);
  assert.deepEqual(await s.attach.settle(), [], 'the queue was released');
});

await check('an Area and a Generator table extended in one drop attach together', async () => {
  const s = session();
  await s.attach.attach(s.id, AREA, area(['Load (MW)']), sources('area30.csv'), 'add');
  await s.attach.attach(s.id, GEN, gen(['A']), sources('gen30.csv'), 'add');
  assert.equal(
    (await s.attach.attach(s.id, AREA, area(['Load (MW)'], 2031), sources('area31.csv'), 'add'))
      .held,
    true,
  );
  assert.equal(
    (await s.attach.attach(s.id, GEN, gen(['A'], 2031), sources('gen31.csv'), 'add')).held,
    true,
  );
  const out = await s.attach.settle();
  assert.deepEqual(out.map((o) => o.kind).sort(), ['area', 'generator']);
  assert.ok(out.every((o) => o.outcome.failures.length === 0));
  assert.deepEqual([s.at(AREA).firstYear, s.at(AREA).numYears], [2030, 2]);
  assert.deepEqual([s.at(GEN).firstYear, s.at(GEN).numYears], [2030, 2]);
});

await check('later tables on a held slot join in order and price the cumulative cube', async () => {
  const s = session();
  const old = gen(['A']);
  await s.attach.attach(s.id, GEN, old, sources('a30.csv'), 'add');
  await s.attach.attach(s.id, GEN, gen(['A', 'B'], 2031, 1, 100), sources('ab31.csv'), 'add');
  await s.attach.attach(s.id, GEN, gen(['A', 'C'], 2032, 1, 200), sources('ac32.csv'), 'add');
  assert.equal(s.at(GEN), old);
  const out = await s.attach.settle();
  assert.deepEqual(out[0].outcome.failures, []);
  const t = s.at(GEN);
  assert.deepEqual(t.generators, ['A', 'B', 'C']);
  assert.deepEqual([t.firstYear, t.numYears], [2030, 3]);
  assert.equal(t.cube[H], 100);
  assert.equal(t.cube[2 * H], 200);
  assert.match(s.asked[1].cost.arithmetic, /3 generators/);
  assert.deepEqual(s.inventory.slotFileNames(s.id)[0].names, ['a30.csv', 'ab31.csv', 'ac32.csv']);
});

await check(
  'an Area-only extension of a two-kind Case is refused and the old tables stay',
  async () => {
    const s = session();
    const a = area(['Load (MW)']);
    const g = gen(['A']);
    await s.attach.attach(s.id, AREA, a, sources('area30.csv'), 'add');
    await s.attach.attach(s.id, GEN, g, sources('gen30.csv'), 'add');
    await s.attach.attach(s.id, AREA, area(['Load (MW)'], 2031), sources('area31.csv'), 'add');
    const out = await s.attach.settle();
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'area');
    assert.equal(out[0].outcome.failures.length, 1);
    assert.deepEqual(
      out[0].outcome.failures[0].files.map((f) => f.name),
      ['area31.csv'],
    );
    assert.match(
      out[0].outcome.failures[0].note,
      /area31\.csv would make this Case 2030-2031, but S's generator Generation \(MW\) table spans 2030/,
    );
    assert.equal(s.at(AREA), a);
    assert.equal(s.at(GEN), g);
    assert.deepEqual(
      s.inventory.slotFileNames(s.id).flatMap((e) => e.names),
      ['area30.csv', 'gen30.csv'],
    );
  },
);

await check('a held join that throws attaches nothing of its Case', async () => {
  const append = (kind) =>
    kind === 'generator'
      ? () => {
          throw new RangeError('Array buffer allocation failed');
        }
      : appendTableOf(kind);
  const s = session({ append });
  const a = area(['Load (MW)']);
  const g = gen(['A']);
  await s.attach.attach(s.id, AREA, a, sources('area30.csv'), 'add');
  await s.attach.attach(s.id, GEN, g, sources('gen30.csv'), 'add');
  await s.attach.attach(s.id, AREA, area(['Load (MW)'], 2031), sources('area31.csv'), 'add');
  await s.attach.attach(s.id, GEN, gen(['A'], 2031), sources('gen31.csv'), 'add');
  const out = await s.attach.settle();
  assert.deepEqual(
    out.flatMap((o) => o.outcome.failures.map((f) => f.files.map((x) => x.name))).sort(),
    [['area31.csv'], ['gen31.csv']],
  );
  assert.ok(out.every((o) => o.outcome.warnings.length === 0));
  assert.equal(s.at(AREA), a, 'the Area join built first was not attached');
  assert.equal(s.at(GEN), g);
  assert.deepEqual(
    s.inventory.slotFileNames(s.id).flatMap((e) => e.names),
    ['area30.csv', 'gen30.csv'],
  );
});

await check('a declined price refuses only that table', async () => {
  const s = session({ confirm: (ask) => !/generator/.test(ask.what) });
  const a = area(['Load (MW)', 'Gen (MW)']);
  const g = gen(['A']);
  await s.attach.attach(s.id, AREA, a, sources('area.csv'), 'add');
  await s.attach.attach(s.id, GEN, g, sources('gen.csv'), 'add');
  await assert.rejects(
    s.attach.attach(s.id, GEN, gen(['B'], 2030, 1, 9), sources('gen2.csv'), 'add'),
    /2 generators .*MB.*not confirmed/s,
  );
  assert.equal(s.at(GEN), g);
  const joined = await s.attach.attach(
    s.id,
    AREA,
    area(['Other (MW)'], 2030, 1, 3),
    sources('area2.csv'),
    'add',
  );
  assert.equal(joined.held, false);
  assert.deepEqual(s.at(AREA).metrics, ['Load (MW)', 'Gen (MW)', 'Other (MW)']);
  assert.equal(s.asked[0].lever, 'fewer generators');
});

await check('a declined price at settle refuses the Case whole', async () => {
  const s = session({ confirm: (ask) => !/generator/.test(ask.what) });
  const a = area(['Load (MW)']);
  const g = gen(['A']);
  await s.attach.attach(s.id, AREA, a, sources('a30.csv'), 'add');
  await s.attach.attach(s.id, GEN, g, sources('g30.csv'), 'add');
  await s.attach.attach(s.id, AREA, area(['Load (MW)'], 2031), sources('a31.csv'), 'add');
  await s.attach.attach(s.id, GEN, gen(['A'], 2031), sources('g31.csv'), 'add');
  const out = await s.attach.settle();
  assert.ok(out.every((o) => o.outcome.failures.length === 1 && o.outcome.warnings.length === 0));
  assert.equal(s.at(AREA), a);
  assert.equal(s.at(GEN), g);
});

await check("a table that does not cover the Case's years is refused at attach", async () => {
  const s = session();
  await s.attach.attach(s.id, AREA, area(['Load (MW)'], 2030, 2), sources('a.csv'), 'add');
  await assert.rejects(
    s.attach.attach(s.id, GEN, gen(['A'], 2030, 1), sources('g.csv'), 'add'),
    /g\.csv spans 2030, but S's area table spans 2030-2031/,
  );
  assert.equal(s.at(GEN), undefined);
});

await check('discard drops the held tables', async () => {
  const s = session();
  const g = gen(['A']);
  await s.attach.attach(s.id, GEN, g, sources('g30.csv'), 'add');
  await s.attach.attach(s.id, GEN, gen(['A'], 2031), sources('g31.csv'), 'add');
  s.attach.discard();
  assert.deepEqual(await s.attach.settle(), []);
  assert.equal(s.at(GEN), g);
});

await check('held Area tables are reindexed with the axis, the original untouched', async () => {
  const s = session();
  await s.attach.attach(s.id, AREA, area(['Load (MW)']), sources('a30.csv'), 'add');
  const fresh = area(['Gen (MW)'], 2031, 1, 7);
  await s.attach.attach(s.id, AREA, fresh, sources('a31.csv'), 'add');
  const axis = ['AARDVARK', 'ALDER', 'BIRCH'];
  s.store.attachTable(s.id, AREA, reindexCase(s.at(AREA), axis), { replace: true });
  s.attach.reindexHeld('area', (t) => reindexCase(t, axis));
  assert.deepEqual(fresh.areas, AREAS, 'the held table as built is not written');
  const out = await s.attach.settle();
  assert.deepEqual(out[0].outcome.failures, []);
  const t = s.at(AREA);
  assert.deepEqual(t.areas, axis);
  assert.deepEqual(t.metrics, ['Load (MW)', 'Gen (MW)']);
  assert.deepEqual([t.firstYear, t.numYears], [2030, 2]);
  assert.equal(t.cube[(1 * 2 + 1) * 2 * H + H + 3], fresh.cube[3]);
});

console.log(`\n${checks} attach checks passed.`);
