// tests/test_ingest_batch.mjs — the ingest engines' SEQUENCE, with stub
// readers and host: which file drops when a header fails, how often a picker
// opens, that a cancelled picker never keeps everything, and that one file's
// block failure never costs another's commit.

import './test_loader.mjs';

import assert from 'node:assert/strict';

const wideEngine = await import('../src/app/ingest-wide.ts');
const longEngine = await import('../src/app/ingest-long.ts');
const { groupByCase, commitAll, fileNote, outcomeNotes } = await import('../src/app/batch.ts');

// The engines return a structured outcome; the checks written against the
// notes the user reads go through `outcomeNotes`, the root's own rendering,
// so they assert exactly what is shown.
const rendered =
  (factory) =>
  (...setup) => {
    const run = factory(...setup);
    return async (...args) => outcomeNotes(await run(...args));
  };
const createWideIngest = rendered(wideEngine.createWideIngest);
const createAreaLongIngest = rendered(longEngine.createAreaLongIngest);
const createEntityLongIngest = rendered(longEngine.createEntityLongIngest);

let checks = 0;
function check(name, fn) {
  fn();
  checks++;
  console.log(`ok - ${name}`);
}
async function checkAsync(name, fn) {
  await fn();
  checks++;
  console.log(`ok - ${name}`);
}

/** A dropped file, as the Import Dialog hands one over. */
const drop = (name, caseName, variant) => ({
  file: { name },
  caseName,
  variant,
});

/** A host that records every attach and every progress line. */
function recordingHost() {
  const attached = [];
  const busy = [];
  return {
    attached,
    busy,
    setBusy(message) {
      busy.push(message);
    },
    caseIdForName(name) {
      return `case:${name}`;
    },
    attach(caseId, slot, table, sources) {
      attached.push({ caseId, slot, table, sources });
    },
  };
}

/** A scripted wide reader: `unreadable` headers throw; `failedPlans` fail
 * their blocks. */
function wideReader({ unreadable = [], failedPlans = [], simd = true } = {}) {
  const calls = { plans: [], ingests: 0 };
  return {
    calls,
    hasSimd: () => simd,
    NO_SIMD_MESSAGE: 'no simd',
    async readCasePlan(file) {
      if (unreadable.includes(file.name)) throw new Error(`${file.name}: unreadable header`);
      calls.plans.push(file.name);
      return {
        file,
        header: { entityNames: ['E1', 'E2', 'E3'] },
        preamble: [],
        title: {},
        dataStart: 0,
        year: 2030,
      };
    },
    async ingest(plans, retained, onProgress, groupOf) {
      calls.ingests++;
      calls.retained = retained;
      calls.groupOf = groupOf;
      onProgress?.(1, plans.length);
      const ok = plans.map((_, i) => i).filter((i) => !failedPlans.includes(i));
      return {
        cases: ok.map((i) => ({ name: plans[i].file.name })),
        ok,
        warnings: [{ message: 'a warning from the reader', plans: ok }],
        failures: failedPlans.map((i) => ({
          index: i,
          file: plans[i].file.name,
          message: 'a block failed',
        })),
      };
    },
  };
}

/** The batch every wide check starts from: no picker, no adopt. */
function wideBatch(reader, overrides = {}) {
  return {
    reader,
    noun: 'thing',
    plural: 'things',
    async entities() {
      return { entities: ['E1', 'E2'] };
    },
    slot: (d) => ({ kind: 'bus', variant: d.variant }),
    refresh() {},
    ...overrides,
  };
}

// ---------------------------------------------------------------- shape W

await checkAsync('a file whose header will not parse costs that file, not the batch', async () => {
  const host = recordingHost();
  const reader = wideReader({ unreadable: ['b.csv'] });
  const notes = await createWideIngest(host)(wideBatch(reader), [
    drop('a.csv', 'Study'),
    drop('b.csv', 'Study'),
    drop('c.csv', 'Study'),
  ]);
  assert.deepEqual(reader.calls.plans, ['a.csv', 'c.csv'], 'the other two still parse');
  assert.equal(host.attached.length, 2, 'and both still commit');
  assert.ok(
    notes.some((note) => note.includes('b.csv') && note.includes('unreadable header')),
    'the dropped file is NAMED -- a file that silently vanishes is worse than a refusal',
  );
});

await checkAsync(
  'every header failing returns the failures and never reaches the reader',
  async () => {
    const host = recordingHost();
    const reader = wideReader({ unreadable: ['a.csv', 'b.csv'] });
    const notes = await createWideIngest(host)(wideBatch(reader), [
      drop('a.csv', 'S'),
      drop('b.csv', 'S'),
    ]);
    assert.equal(reader.calls.ingests, 0, 'an empty batch must not compile wasm or spawn workers');
    assert.equal(notes.length, 2);
    assert.equal(host.attached.length, 0);
  },
);

await checkAsync('the whole batch is ONE dispatch, however many files it carries', async () => {
  const host = recordingHost();
  const reader = wideReader();
  await createWideIngest(host)(wideBatch(reader), [
    drop('a.csv', 'S'),
    drop('b.csv', 'S'),
    drop('c.csv', 'S'),
    drop('d.csv', 'S'),
  ]);
  // N dispatches over one shared worker pool could let a stale reply from
  // one settle the next and blit one file's blocks into another file's cube.
  // One call is the guarantee.
  assert.equal(reader.calls.ingests, 1);
});

await checkAsync('the entity decision is made ONCE for the batch', async () => {
  const host = recordingHost();
  let asked = 0;
  const reader = wideReader();
  await createWideIngest(host)(
    wideBatch(reader, {
      async entities() {
        asked++;
        return { entities: ['E1'] };
      },
    }),
    [drop('a.csv', 'S'), drop('b.csv', 'S'), drop('c.csv', 'S')],
  );
  // Per file, the user would see N modals and file 2's new entities would be
  // silently dropped from file 1's cube.
  assert.equal(asked, 1);
});

await checkAsync('a stopped batch loads nothing and never falls back to every entity', async () => {
  const host = recordingHost();
  const reader = wideReader();
  const notes = await createWideIngest(host)(
    wideBatch(reader, {
      async entities() {
        return { stop: ['No bus was selected.'] };
      },
    }),
    [drop('a.csv', 'S')],
  );
  assert.equal(reader.calls.ingests, 0, 'keeping everything is the allocation the picker prevents');
  assert.equal(host.attached.length, 0);
  assert.deepEqual(notes, ['No bus was selected.']);
});

await checkAsync('an empty stop is silent, and still loads nothing', async () => {
  const host = recordingHost();
  const reader = wideReader();
  const notes = await createWideIngest(host)(
    wideBatch(reader, {
      async entities() {
        return { stop: [] };
      },
    }),
    [drop('a.csv', 'S')],
  );
  assert.equal(reader.calls.ingests, 0);
  assert.deepEqual(notes, [], 'a closed dialog needs no sentence saying it closed');
});

await checkAsync('a failed block costs its own file and is attributed by index', async () => {
  const host = recordingHost();
  // Plan 1 is b.csv. Its failure must not cost a.csv or c.csv their commit, and
  // the note must name b.csv -- attribution by index, never by filename, because
  // one drop can carry two files of the same name from different folders.
  const reader = wideReader({ failedPlans: [1] });
  const notes = await createWideIngest(host)(wideBatch(reader), [
    drop('a.csv', 'S'),
    drop('b.csv', 'S'),
    drop('c.csv', 'S'),
  ]);
  assert.deepEqual(
    host.attached.map((entry) => entry.table.name),
    ['a.csv', 'c.csv'],
  );
  assert.ok(notes.some((note) => note.includes('b.csv') && note.includes('a block failed')));
});

await checkAsync('a commit that throws costs its own table, not the batch', async () => {
  const host = recordingHost();
  const attach = host.attach;
  host.attach = (caseId, slot, table, sources) => {
    if (table.name === 'b.csv') throw new Error('slot occupied');
    attach(caseId, slot, table, sources);
  };
  const notes = await createWideIngest(host)(wideBatch(wideReader()), [
    drop('a.csv', 'S'),
    drop('b.csv', 'S'),
    drop('c.csv', 'S'),
  ]);
  // The bug: a bare loop means the FIRST throw abandons every table after it
  // with no note naming any of them.
  assert.deepEqual(
    host.attached.map((entry) => entry.table.name),
    ['a.csv', 'c.csv'],
  );
  assert.ok(notes.includes('slot occupied'));
});

await checkAsync('the adopt hook runs once, and only when something committed', async () => {
  const adopted = [];
  const host = recordingHost();
  await createWideIngest(host)(
    wideBatch(wideReader(), { adopt: (entities) => adopted.push(entities) }),
    [drop('a.csv', 'S'), drop('b.csv', 'S')],
  );
  assert.deepEqual(adopted, [['E1', 'E2']], 'once per batch, never once per file');

  // Nothing committed: with no cube on the wider axis there is nothing to
  // overlay, so a reindex of every loaded cube would buy nothing.
  const empty = [];
  await createWideIngest(recordingHost())(
    wideBatch(wideReader({ failedPlans: [0] }), { adopt: (e) => empty.push(e) }),
    [drop('a.csv', 'S')],
  );
  assert.deepEqual(empty, []);
});

await checkAsync('a reader with no SIMD refuses before it is asked for a plan', async () => {
  const host = recordingHost();
  const reader = wideReader({ simd: false });
  const notes = await createWideIngest(host)(wideBatch(reader), [drop('a.csv', 'S')]);
  assert.deepEqual(notes, ['no simd']);
  assert.deepEqual(reader.calls.plans, []);
});

await checkAsync('the progress line is always cleared, even when the batch throws', async () => {
  const host = recordingHost();
  const notes = await createWideIngest(host)(
    wideBatch(wideReader(), {
      async entities() {
        throw new Error('the picker exploded');
      },
    }),
    [drop('a.csv', 'S')],
  );
  assert.equal(host.busy.at(-1), null, 'a stuck "Parsing…" outlives the batch that set it');
  assert.ok(notes.includes('the picker exploded'));
});

// --------------------------------------------------------- grouping by case

check('files the user put in one study share a group; two studies do not', () => {
  assert.deepEqual(groupByCase([drop('a', 'One'), drop('b', 'Two'), drop('c', 'One')]), [0, 1, 0]);
});

check('one Case can hold two quantities, and they are two groups', () => {
  // Merging them would stack two measurements on one cube -- the mistake the
  // shape's own quantity check refuses a beat later.
  assert.deepEqual(
    groupByCase([drop('a', 'One', 'Power Flow'), drop('b', 'One', 'Congestion Cost')]),
    [0, 1],
  );
});

check('a Case name containing the separator cannot collide with a variant', () => {
  // Any printable separator is a character a user-typed Case name or a
  // title-line quantity may legitimately contain.
  const ids = groupByCase([drop('a', 'One', 'X'), drop('b', 'One X', undefined)]);
  assert.notEqual(ids[0], ids[1]);
});

// ------------------------------------------------------------------ notes

check('a filename is not repeated when the error already opens with it', () => {
  assert.equal(fileNote('a.csv', 'a.csv: broken'), 'a.csv: broken');
  assert.equal(fileNote('a.csv', 'broken'), 'a.csv: broken');
});

check('commitAll reports every failure and keeps going', () => {
  const seen = [];
  const failures = commitAll([1, 2, 3], (value) => {
    if (value === 2) throw new Error('two is bad');
    seen.push(value);
  });
  assert.deepEqual(seen, [1, 3]);
  assert.deepEqual(failures, [{ index: 1, message: 'two is bad' }]);
});

// ---------------------------------------------------------------- shape L

/** A long reader: the header read, then the scan pass that reads the axis. */
function longReader({ unreadable = [], scanFailed = [], simd = true } = {}) {
  const calls = { plans: [], scans: 0, parses: 0 };
  return {
    calls,
    hasSimd: () => simd,
    NO_SIMD_MESSAGE: 'no simd',
    async readCasePlan(file, sig) {
      assert.ok(sig, "a long plan is never read on the reader's area default");
      if (unreadable.includes(file.name)) throw new Error(`${file.name}: unreadable header`);
      calls.plans.push(file.name);
      return {
        file,
        header: { metricNames: ['Load', 'LMP', 'Other'] },
        entities: ['1001', '1002'],
        rowsPerBlock: [],
      };
    },
    async discoverEntities(plans, onProgress) {
      calls.scans++;
      onProgress?.(1, plans.length);
      return {
        ok: plans.map((_, i) => i).filter((i) => !scanFailed.includes(plans[i].file.name)),
        failures: plans
          .map((plan, index) => ({ plan, index }))
          .filter(({ plan }) => scanFailed.includes(plan.file.name))
          .map(({ plan, index }) => ({ index, file: plan.file.name, message: 'the scan failed' })),
      };
    },
  };
}

const AREA_SIG = { keys: ['Name'], entityCol: 3, noun: 'area' };

function areaLongBatch(reader, overrides = {}) {
  const parsed = { count: 0 };
  return {
    parsed,
    batch: {
      reader,
      sig: AREA_SIG,
      union: () => ['Load', 'LMP'],
      axis: () => ['A1', 'A2'],
      async retained() {
        return ['Load'];
      },
      async parse(plans, retained, axis, onProgress, groupOf) {
        parsed.count++;
        parsed.retained = retained;
        parsed.axis = axis;
        parsed.groupOf = groupOf;
        onProgress(1, plans.length);
        return {
          cases: plans.map((plan) => ({ name: plan.file.name })),
          ok: plans.map((_, i) => i),
          warnings: [],
          failures: [],
        };
      },
      adoptAxis() {},
      slot: { kind: 'area' },
      refresh() {},
      ...overrides,
    },
  };
}

await checkAsync('the long axis is scanned ONCE, over the files that survived P1', async () => {
  const host = recordingHost();
  const reader = longReader({ unreadable: ['b.csv'] });
  const { batch, parsed } = areaLongBatch(reader);
  await createAreaLongIngest(
    host,
    batch,
  )([drop('a.csv', 'S'), drop('b.csv', 'S'), drop('c.csv', 'S')]);
  // Inside a per-file loop, file 1's axis would be discovered without file 2's
  // names and every cube would be indexed differently.
  assert.equal(reader.calls.scans, 1);
  assert.deepEqual(reader.calls.plans, ['a.csv', 'c.csv']);
  assert.equal(parsed.count, 1);
});

await checkAsync('a file whose scan blocks fail contributes no names and no table', async () => {
  const host = recordingHost();
  const reader = longReader({ scanFailed: ['b.csv'] });
  const { batch } = areaLongBatch(reader);
  const notes = await createAreaLongIngest(host, batch)([drop('a.csv', 'S'), drop('b.csv', 'S')]);
  assert.deepEqual(
    host.attached.map((entry) => entry.table.name),
    ['a.csv'],
  );
  assert.ok(notes.some((note) => note.includes('b.csv')));
});

await checkAsync('a cancelled area picker stops the batch and parses nothing', async () => {
  const host = recordingHost();
  const { batch, parsed } = areaLongBatch(longReader(), {
    async retained() {
      return null;
    },
  });
  const notes = await createAreaLongIngest(host, batch)([drop('a.csv', 'S')]);
  assert.equal(parsed.count, 0);
  assert.equal(host.attached.length, 0);
  assert.deepEqual(notes, []);
});

await checkAsync('the area picker sees the axis it is about to allocate', async () => {
  const host = recordingHost();
  let sawAxisCount;
  const { batch } = areaLongBatch(longReader(), {
    axis: () => ['A1', 'A2', 'A3', 'A4'],
    async retained(union, fileCount, axisCount) {
      sawAxisCount = { union, fileCount, axisCount };
      return ['Load'];
    },
  });
  await createAreaLongIngest(host, batch)([drop('a.csv', 'S'), drop('b.csv', 'S')]);
  // The picker states the size of the coming allocation, so it has to be asked
  // AFTER the scan and with the real numbers.
  assert.deepEqual(sawAxisCount, { union: ['Load', 'LMP'], fileCount: 2, axisCount: 4 });
});

await checkAsync('one long file becomes one table per retained metric', async () => {
  const host = recordingHost();
  const reader = longReader();
  const picked = [];
  const run = createEntityLongIngest(host, {
    reader,
    union: () => ['Load', 'LMP'],
    axis: () => ['1001', '1002'],
    noteTablesChanged() {},
    everything: () => false,
    async pickMetrics(request) {
      picked.push(request);
      return ['Load', 'LMP'];
    },
    async parse(plans, retained, axis, longKind, onProgress, groupOf) {
      onProgress(1, plans.length);
      return {
        cases: plans.map((plan) => [
          { quantity: 'Load', from: plan.file.name },
          { quantity: 'LMP', from: plan.file.name },
        ]),
        ok: plans.map((_, i) => i),
        warnings: [],
        failures: [],
      };
    },
    refresh() {},
  });
  // A first drop has nothing remembered, so the picker is opened -- once, with
  // the entity count and the file count the allocation will actually use.
  const notes = await run([drop('a.csv', 'S')], 'bus', {
    sig: { keys: ['BusID'], entityCol: 3, noun: 'bus' },
  });
  assert.equal(notes.length, 0, notes.join(' / '));
  assert.deepEqual(picked, [
    {
      union: ['Load', 'LMP'],
      noun: 'bus',
      entityCount: 2,
      fileCount: 1,
      preselected: [],
      everything: false,
    },
  ]);
  // Each table lands on its OWN slot, keyed on its own quantity -- the Import
  // Dialog's variant read a wide title line and a long export has none.
  assert.deepEqual(
    host.attached.map((entry) => entry.slot),
    [
      { kind: 'bus', variant: 'Load' },
      { kind: 'bus', variant: 'LMP' },
    ],
  );
});

/** The bus/generator long wiring, with the picker and the parse scripted. */
function entityLongRun(
  host,
  { answers = [['Load']], union = ['Load'], everything = false, declines = false } = {},
) {
  // `everything` is read off `state` rather than captured, so one engine --
  // and so one metric-state map -- can serve a picked drop and then a
  // keep-everything one, which is the pair the order of that check turns on.
  const state = { picked: [], parses: 0, everythingAsked: [], everything };
  const run = createEntityLongIngest(host, {
    reader: longReader(),
    union: () => union,
    axis: () => ['1001', '1002'],
    noteTablesChanged() {},
    everything: () => state.everything,
    async pickMetrics(request) {
      state.picked.push(request.preselected);
      state.everythingAsked.push(request.everything);
      // What the real picker does with `everything`: resolve the union
      // without opening, once the allocation has been priced -- or `null`
      // when that price was declined.
      if (request.everything) return declines ? null : [...request.union];
      return answers[state.picked.length - 1] ?? null;
    },
    async parse(plans, retained, axis, longKind, onProgress) {
      state.parses++;
      state.retained = retained;
      onProgress(1, plans.length);
      return {
        cases: plans.map(() => retained.map((quantity) => ({ quantity }))),
        ok: plans.map((_, i) => i),
        warnings: [],
        failures: [],
      };
    },
    refresh() {},
  });
  return { run, state };
}

const BUS_LONG = { sig: { keys: ['BusID'], entityCol: 3, noun: 'bus' } };

await checkAsync('a cancelled metric picker loads nothing and keeps no metric set', async () => {
  const host = recordingHost();
  const { run, state } = entityLongRun(host, { answers: [null] });
  const notes = await run([drop('a.csv', 'S')], 'bus', BUS_LONG);
  // Falling back to the whole metric set is the allocation this picker exists to
  // prevent -- entities x metrics x 8,760 x 4 B.
  assert.equal(state.parses, 0);
  assert.equal(host.attached.length, 0);
  assert.ok(
    notes.some((note) => note.includes('No bus metric was selected')),
    'and it says so, because an empty picker reads as a drop that did nothing',
  );
});

await checkAsync(
  'a second drop offering nothing new reuses the choice without asking',
  async () => {
    const host = recordingHost();
    const { run, state } = entityLongRun(host, { answers: [['Load']], union: ['Load'] });
    await run([drop('a.csv', 'S')], 'bus', BUS_LONG);
    await run([drop('b.csv', 'S')], 'bus', BUS_LONG);
    assert.deepEqual(state.picked, [[]], 'asked once, on the first drop only');
    assert.equal(state.parses, 2, 'and the second drop still loads');
  },
);

await checkAsync('each kind remembers its own metric choice', async () => {
  const host = recordingHost();
  const { run, state } = entityLongRun(host, { answers: [['Load'], ['Load']] });
  await run([drop('a.csv', 'S')], 'bus', BUS_LONG);
  await run([drop('b.csv', 'S')], 'generator', {
    sig: { keys: ['UnitName'], entityCol: 3, noun: 'generator' },
  });
  // One state across both kinds would have the generator drop measured against
  // the bus drop's answer.
  assert.equal(state.picked.length, 2);
});

// ------------------------------------------- the Import Dialog's other exit
//
// "Load everything" must be checked before `covers`, or an earlier narrow
// choice is reused silently.

await checkAsync('a keep-everything drop keeps the union, through the picker', async () => {
  const host = recordingHost();
  const { run, state } = entityLongRun(host, {
    answers: [],
    union: ['Load', 'LMP'],
    everything: true,
  });
  const notes = await run([drop('a.csv', 'S')], 'bus', BUS_LONG);
  assert.equal(notes.length, 0, notes.join(' / '));
  assert.deepEqual(state.retained, ['Load', 'LMP'], 'everything the files carry was kept');
  // Through the picker and not around it: the picker is what prices a
  // multi-hundred-megabyte allocation, and this is the path with no readout
  // on screen to name the figure.
  assert.deepEqual(state.everythingAsked, [true]);
});

await checkAsync('keeping everything overrides a narrower set already stored', async () => {
  const host = recordingHost();
  const { run, state } = entityLongRun(host, { answers: [['Load']], union: ['Load', 'LMP'] });
  await run([drop('a.csv', 'S')], 'bus', BUS_LONG);
  assert.deepEqual(state.retained, ['Load'], 'the first drop kept one metric');

  state.everything = true;
  await run([drop('b.csv', 'S')], 'bus', BUS_LONG);
  assert.deepEqual(state.everythingAsked, [false, true]);
  assert.deepEqual(
    state.retained,
    ['Load', 'LMP'],
    'the stored set covers this union, so a coverage check made first would have loaded ' +
      'only Load and said nothing',
  );
});

await checkAsync('a declined allocation on a keep-everything drop loads nothing', async () => {
  const host = recordingHost();
  // What the picker resolves when `confirmLargeAllocation` is declined.
  const { run, state } = entityLongRun(host, { union: ['Load', 'LMP'], declines: true });
  state.everything = true;
  const notes = await run([drop('a.csv', 'S')], 'bus', BUS_LONG);
  assert.equal(state.parses, 0);
  assert.equal(host.attached.length, 0);
  assert.ok(notes.some((note) => note.includes('No bus metric was selected')));
});

// ------------------------------------------------------- structured outcome
//
// The root records which files built each table and which files each note is
// about. Attribution is structural: a filename in the note text cannot tell
// two same-named files apart, and several notes name no file.

/** A wide reader that merges plans sharing a group id, as the pool does:
 * one table per group, reported under its first member. */
function mergingWideReader({ failedPlans = [], warnings = [] } = {}) {
  return {
    hasSimd: () => true,
    NO_SIMD_MESSAGE: 'no simd',
    async readCasePlan(file) {
      return { file, header: { entityNames: ['E1', 'E9'] } };
    },
    async ingest(plans, retained, onProgress, groupOf) {
      const firsts = [];
      const seen = new Set();
      groupOf.forEach((group, index) => {
        if (seen.has(group)) return;
        seen.add(group);
        firsts.push(index);
      });
      const ok = firsts.filter((first) =>
        groupOf.every((group, i) => group !== groupOf[first] || !failedPlans.includes(i)),
      );
      return {
        cases: ok.map((i) => ({ name: plans[i].file.name })),
        ok,
        warnings,
        failures: failedPlans.map((i) => ({ index: i, file: plans[i].file.name, message: 'bad' })),
      };
    },
  };
}

await checkAsync('a merged table is attached with every member file behind it', async () => {
  const host = recordingHost();
  const first = drop('h1.csv', 'Study');
  const second = drop('h2.csv', 'Study');
  const other = drop('x.csv', 'Other');
  await wideEngine.createWideIngest(host)(wideBatch(mergingWideReader()), [first, other, second]);
  assert.deepEqual(
    host.attached.map((entry) => entry.sources.map((source) => source.file)),
    [[first.file, second.file], [other.file]],
    'two halves of one year are one table from two files',
  );
  // Counted per FILE, against the batch's retained set: E9 was not kept.
  assert.deepEqual(host.attached[0].sources[0].counts, { of: 'entities', kept: 1, inSource: 2 });
  assert.equal(host.attached[0].sources[0].shape, 'W');
});

await checkAsync('one long file behind several metric slots names itself on each', async () => {
  const host = recordingHost();
  const { run } = entityLongRun(host, { answers: [['Load', 'LMP']], union: ['Load', 'LMP'] });
  const only = drop('long.csv', 'S');
  await run([only], 'bus', BUS_LONG);
  assert.deepEqual(
    host.attached.map((entry) => [entry.slot.variant, entry.sources.map((source) => source.file)]),
    [
      ['Load', [only.file]],
      ['LMP', [only.file]],
    ],
  );
  // A long bus file keeps every entity its rows name.
  assert.deepEqual(host.attached[0].sources[0], {
    file: only.file,
    shape: 'L',
    counts: { of: 'entities', kept: 2, inSource: 2 },
  });
});

await checkAsync('a long Area table carries its merge group as sources', async () => {
  const host = recordingHost();
  const { batch } = areaLongBatch(longReader(), {
    async parse(plans, retained, axis, onProgress, groupOf) {
      // One table for the one group, under its first member.
      assert.deepEqual(groupOf, [0, 0]);
      return { cases: [{ name: 'merged' }], ok: [0], warnings: [], failures: [] };
    },
  });
  const a = drop('a.csv', 'S');
  const b = drop('b.csv', 'S');
  await longEngine.createAreaLongIngest(host, batch)([a, b]);
  assert.deepEqual(
    host.attached[0].sources.map((source) => source.file),
    [a.file, b.file],
  );
  // A long Area file counts METRICS: its picker kept Load of three.
  assert.deepEqual(host.attached[0].sources[0].counts, { of: 'metrics', kept: 1, inSource: 3 });
});

await checkAsync('two same-named files in one drop stay two files in the outcome', async () => {
  const host = recordingHost();
  const left = drop('same.csv', 'One');
  const right = drop('same.csv', 'Two');
  const outcome = await wideEngine.createWideIngest(host)(
    wideBatch(mergingWideReader({ failedPlans: [1] })),
    [left, right],
  );
  assert.equal(outcome.failures.length, 1);
  assert.equal(outcome.failures[0].files[0], right.file, 'the failure is the SECOND file');
  assert.notEqual(outcome.failures[0].files[0], left.file);
  assert.deepEqual(
    host.attached[0].sources.map((source) => source.file),
    [left.file],
  );
});

await checkAsync('warnings carry their member files, or none when batch-level', async () => {
  const host = recordingHost();
  const a = drop('a.csv', 'S');
  const b = drop('b.csv', 'S');
  const outcome = await wideEngine.createWideIngest(host)(
    wideBatch(
      mergingWideReader({
        warnings: [
          { message: 'about the group', plans: [0, 1] },
          { message: 'about the retained set', plans: [] },
        ],
      }),
    ),
    [a, b],
  );
  assert.deepEqual(outcome.warnings, [
    { files: [a.file, b.file], note: 'about the group' },
    { files: [], note: 'about the retained set' },
  ]);
  assert.deepEqual(outcomeNotes(outcome), ['about the group', 'about the retained set']);
});

await checkAsync('a stop is kept apart from a refusal, with the files it stopped', async () => {
  const stopped = drop('a.csv', 'S');
  const outcome = await wideEngine.createWideIngest(recordingHost())(
    wideBatch(wideReader(), {
      async entities() {
        return { stop: ['No bus was selected.'] };
      },
    }),
    [stopped],
  );
  assert.deepEqual(outcome.stop, { files: [stopped.file], notes: ['No bus was selected.'] });
  assert.deepEqual(outcome.failures, []);
  assert.equal(outcome.refusal, undefined);

  // A cancelled Area picker is a stop with no sentence, still distinguishable
  // from a drop that did nothing.
  const { batch } = areaLongBatch(longReader(), {
    async retained() {
      return null;
    },
  });
  const cancelled = drop('b.csv', 'S');
  const area = await longEngine.createAreaLongIngest(recordingHost(), batch)([cancelled]);
  assert.deepEqual(area.stop, { files: [cancelled.file], notes: [] });

  // A cancelled metric picker's sentence is the same note as before; the raw
  // outcome says it was a stop.
  const metric = drop('c.csv', 'S');
  const raw = [];
  const engine = longEngine.createEntityLongIngest(
    {
      setBusy() {},
      caseIdForName: (name) => name,
      attach() {},
    },
    {
      reader: longReader(),
      union: () => ['Load'],
      axis: () => ['1'],
      noteTablesChanged() {},
      everything: () => false,
      async pickMetrics() {
        return null;
      },
      async parse() {
        raw.push('parsed');
        return { cases: [], ok: [], warnings: [], failures: [] };
      },
      refresh() {},
    },
  );
  const entity = await engine([metric], 'bus', BUS_LONG);
  assert.equal(entity.stop.files[0], metric.file);
  assert.match(entity.stop.notes[0], /No bus metric was selected/);
  assert.deepEqual(raw, []);
});

await checkAsync('a thrown batch refuses the files that neither failed nor attached', async () => {
  const unreadable = drop('bad.csv', 'S');
  const good = drop('good.csv', 'S');
  const outcome = await wideEngine.createWideIngest(recordingHost())(
    wideBatch(wideReader({ unreadable: ['bad.csv'] }), {
      async entities() {
        throw new Error('the picker exploded');
      },
    }),
    [unreadable, good],
  );
  assert.deepEqual(
    outcome.failures.map((failure) => failure.files),
    [[unreadable.file]],
  );
  assert.deepEqual(outcome.refusal, { files: [good.file], note: 'the picker exploded' });
});

console.log(`\n${checks} checks passed.`);
