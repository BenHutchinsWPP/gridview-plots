// tests/test_drop_load.mjs — one drop, through `createDropLoad` and a fake host.
//
// The sequence's order is its contract, and none of it is visible from any
// one step: a refused drop clears nothing, a running drop holds the busy line
// from its first byte until a `finally`, the Area account is published before
// the other kinds' batches can throw, limits install after every ingest, and
// the inventory's drop is closed on every exit. The host records every call
// in one list, so each of those is an index comparison. The inventory is the
// real one behind a recorder, so its Log shows what was refused and skipped.
//
// Run: node tests/test_drop_load.mjs

import assert from 'node:assert/strict';
import './test_loader.mjs';

const { createDropLoad, hoursCoveredBySlot } = await import('../src/app/drop-load.ts');
const { createInventory } = await import('../src/inventory/store.ts');
const { classify } = await import('../src/detect.ts');

let passed = 0;
async function check(label, fn) {
  await fn();
  passed++;
  console.log(`ok - ${label}`);
}

const HEADER = [
  "Bus Hourly 'LMP ($/MWh)' Data for Year 2035",
  '',
  '(From the first hour of 1/1/2035 to the last hour of 12/31/2035. Column identifier -- BusName)',
  '',
  ',,BusNumber,90001,90002',
  'Date, Hour, TOU,SAMPLE_BUS_A,SAMPLE_BUS_B',
  '1/1/2035,1,OffPeak,21,22',
].join('\n');
const INTERFACE = [
  "Interface Hourly 'Power Flow (MW)' Data for Year 2035",
  '',
  '(From the first hour of 1/1/2035 to the last hour of 12/31/2035. Column identifier -- Interface Name)',
  '',
  'Date, Hour, TOU,SAMPLE_P01,SAMPLE_P02',
  '1/1/2035,1,OffPeak,100,40',
].join('\n');
const AREA_LONG = [
  'Date, Hour, TOU, Name, Load (MWh), Avg LMP Weighted by Load ($/MWh)',
  '1/1/2035,1,OffPeak,SAMPLE_AREA_1,1000,30',
].join('\n');
const LIMITS = [
  'INTERFACELIMITSCHEDULE_MONTHLY,SYNTHETIC DATA,invented for a test',
  '',
  'Interface Name,Year,Type,Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec',
  'SAMPLE_P01,2035,MAX,500,500,500,500,500,500,500,500,500,500,500,500',
].join('\n');
const BUS_LIST = [
  'BUS_GENERAL,,,',
  'BusID,Name,BaseKV,LoadArea',
  '90001,SAMPLE_BUS_A,230,SAMPLE_AREA_W',
].join('\n');
const GROUPINGS = ['Name,Grouping', 'SAMPLE_AREA_1,SAMPLE_ZONE_N'].join('\n');

const csv = (name, text) => new File([text], name, { type: 'text/csv' });

/** A plan as the Import Dialog leaves one, for table file `index`. */
const plan = (index, kind, shape, caseName, variant) => ({
  file: `f${index}`,
  fileIndex: index,
  caseName,
  caseIsNew: true,
  kind,
  shape,
  ...(variant === undefined ? {} : { variant }),
  slotConflict: false,
  merges: false,
  replacesExisting: false,
});

/**
 * A host that records every call as `name` or `name:detail` in `calls`, over
 * the real inventory. `over` replaces any member.
 */
function fakeHost(over = {}) {
  const calls = [];
  const said = new Map();
  const real = createInventory(() => 0);
  const inventory = {};
  for (const name of [
    'beginDrop',
    'endDrop',
    'logRefused',
    'logSkipped',
    'noteFiles',
    'noteDrop',
    'recordOutcome',
    'recordSessionInput',
    'recordCaseFile',
    'unaccounted',
  ]) {
    inventory[name] = (...args) => {
      calls.push(`inventory.${name}`);
      return real[name](...args);
    };
  }
  const cases = [];
  const host = {
    inventory,
    say(channel, lines) {
      calls.push(`say:${channel}`);
      said.set(channel, [...lines]);
    },
    render: () => calls.push('render'),
    setBusyFloor: (message) => calls.push(`floor:${message}`),
    downloadRunning: () => false,
    closeContents: () => calls.push('closeContents'),
    listCases: () => cases,
    restoreBundle: async (file) => {
      calls.push('restoreBundle');
      return [`Restored 1 case(s) from ${file.name}.`];
    },
    askGroupings: async () => {
      calls.push('askGroupings');
      return { entity: 'area' };
    },
    loadGroupings: (choice, _text, fileName) => {
      calls.push(`loadGroupings:${choice.entity}`);
      return [`${fileName}: groupings updated`];
    },
    kindLabel: (kind) => kind.charAt(0).toUpperCase() + kind.slice(1),
    attachLookup: (_rows, fileName) => {
      calls.push('attachLookup');
      return { alreadyKnown: 0, note: `${fileName}: 1 row(s) added` };
    },
    askImport: async () => {
      calls.push('askImport');
      return null;
    },
    ingest: async (kind, shape, drops) => {
      calls.push(`ingest:${kind}:${shape}`);
      return { failures: [], warnings: [{ files: [], note: `${kind} ${shape} ${drops.length}` }] };
    },
    setSharedLimits: () => {
      calls.push('setSharedLimits');
      return null;
    },
    setCaseLimits: () => {
      calls.push('setCaseLimits');
      return null;
    },
    limitMatchNotes: () => [],
    refreshCases: () => calls.push('refreshCases'),
    revealDrawer: () => calls.push('revealDrawer'),
    ...over,
  };
  const logOf = () => real.log({ cases: [], rows: [], columns: [] });
  return { host, calls, said, cases, logOf };
}

const at = (calls, entry) => {
  const index = calls.indexOf(entry);
  assert.ok(index >= 0, `expected a call ${entry} in ${calls.join(', ')}`);
  return index;
};

await check('a drop holds the busy line from the first byte to a finally', async () => {
  const { host, calls, said } = fakeHost();
  const drop = createDropLoad(host);
  await drop.load([csv('a.csv', HEADER)]);
  assert.deepEqual(said.get('session'), [], 'a drop that runs supersedes the last message');
  // Contents closes first, then the drop opens, clears the last non-drop
  // message, and raises the floor.
  assert.deepEqual(calls.slice(0, 4), [
    'closeContents',
    'inventory.beginDrop',
    'say:session',
    'floor:Reading 1 dropped file…',
  ]);
  // Cancelled at the dialog, it still ends in the finally's order.
  assert.deepEqual(calls.slice(-2), ['inventory.endDrop', 'floor:null']);
  assert.equal(drop.running(), false);
});

await check('a drop refused while one runs clears nothing and is logged refused', async () => {
  let answer;
  const { host, calls, said, logOf } = fakeHost({
    askImport: () => new Promise((resolve) => (answer = resolve)),
  });
  const drop = createDropLoad(host);
  const first = drop.load([csv('a.csv', HEADER)]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(drop.running(), true);
  const before = calls.length;
  const late = csv('late.csv', HEADER);
  await drop.load([late]);
  const refusal = 'A load is already running — drop these files again once it finishes.';
  assert.deepEqual(calls.slice(before), ['inventory.logRefused', 'say:session', 'render']);
  assert.deepEqual(said.get('session'), [refusal]);
  answer(null);
  await first;
  assert.equal(drop.running(), false);
  assert.ok(logOf().some((line) => line.event === 'refused' && line.reason === refusal));
});

await check('a drop waits for a download being written', async () => {
  const { host, calls, said } = fakeHost({ downloadRunning: () => true });
  await createDropLoad(host).load([csv('a.csv', HEADER)]);
  assert.deepEqual(calls, ['inventory.logRefused', 'say:session', 'render']);
  assert.deepEqual(said.get('session'), [
    'A download is being written — drop these files again once it finishes.',
  ]);
});

await check('an unreadable file is refused by the detector’s own reason', async () => {
  const { host, calls, said, logOf } = fakeHost();
  const file = csv('junk.csv', 'not an export');
  await createDropLoad(host).load([file]);
  const reason = classify(new TextEncoder().encode('not an export'), 'junk.csv').reason;
  assert.ok(reason, 'the detector gives a reason');
  assert.deepEqual(said.get('area'), [reason]);
  assert.ok(!calls.includes('askImport'), 'nothing to import opens no dialog');
  assert.ok(at(calls, 'say:area') < at(calls, 'inventory.endDrop'));
  assert.deepEqual(
    logOf().map((line) => [line.event, line.reason]),
    [['refused', reason]],
  );
});

await check('a cancelled Import dialog loads nothing and says so', async () => {
  const { host, calls, said, logOf } = fakeHost();
  await createDropLoad(host).load([csv('a.csv', HEADER), csv('b.csv', LIMITS)]);
  assert.deepEqual(said.get('area'), [
    'Import cancelled — none of the 2 dropped file(s) were loaded.',
  ]);
  assert.ok(!calls.some((call) => call.startsWith('ingest')));
  assert.deepEqual(
    logOf().map((line) => [line.event, line.reason, line.files.length]),
    [['skipped', 'the Import dialog was cancelled', 2]],
  );
});

await check('batches run in (kind, shape) order and Area is published first', async () => {
  let everythingDuringIngest = null;
  const files = [
    csv('bus.csv', HEADER),
    csv('area.csv', AREA_LONG),
    csv('iface.csv', INTERFACE),
    csv('area-wide.csv', HEADER),
  ];
  const holder = {};
  const { host, calls, said } = fakeHost({
    askImport: async (tables, cases, limits) => {
      calls.push('askImport');
      assert.equal(tables.length, 4);
      assert.deepEqual(cases, []);
      assert.deepEqual(limits, []);
      return {
        plans: [
          plan(0, 'bus', 'W', 'A', 'LMP'),
          plan(1, 'area', 'L', 'A', 'ignored'),
          plan(2, 'interface', 'W', 'A', 'Flow'),
          plan(3, 'area', 'W', 'A'),
        ],
        limits: [],
        everything: true,
      };
    },
    ingest: async (kind, shape, drops) => {
      calls.push(`ingest:${kind}:${shape}`);
      everythingDuringIngest = holder.drop.keepsEverything();
      if (kind === 'area') {
        // Area carries no variant: two halves of a year are one table.
        assert.deepEqual(Object.keys(drops[0]).sort(), ['caseName', 'file']);
      } else {
        assert.equal(drops[0].variant, kind === 'bus' ? 'LMP' : 'Flow');
      }
      return { failures: [], warnings: [{ files: [], note: `${kind} ${shape}` }] };
    },
  });
  holder.drop = createDropLoad(host);
  await holder.drop.load(files);
  assert.equal(everythingDuringIngest, true, "the batches read the dialog's exit");
  assert.equal(holder.drop.keepsEverything(), false, 'and it ends with the drop');
  at(calls, 'floor:Loading 4 file(s), keeping everything they carry…');
  const order = calls.filter((call) => call.startsWith('ingest') || call.startsWith('say:'));
  assert.deepEqual(order, [
    'say:session',
    'ingest:area:L',
    'ingest:area:W',
    'say:area',
    'ingest:interface:W',
    'say:interface',
    'ingest:bus:W',
    'say:bus',
    'say:generator',
  ]);
  assert.deepEqual(said.get('area'), ['area L', 'area W']);
  assert.deepEqual(said.get('generator'), [], 'a kind the drop carried none of is cleared');
  const tail = calls.slice(at(calls, 'say:generator'));
  assert.deepEqual(tail.slice(1, 4), ['refreshCases', 'render', 'inventory.endDrop']);
});

await check('the drawer opens once a Case is loaded', async () => {
  const { host, calls, cases } = fakeHost({
    askImport: async () => ({ plans: [plan(0, 'bus', 'W', 'A')], limits: [], everything: false }),
    ingest: async () => {
      cases.push({ id: 'c1', name: 'A', tables: new Map() });
      return { failures: [], warnings: [] };
    },
  });
  await createDropLoad(host).load([csv('bus.csv', HEADER)]);
  at(calls, 'floor:Loading 1 file(s)… you may be asked what to keep.');
  assert.ok(at(calls, 'refreshCases') < at(calls, 'revealDrawer'));
  assert.ok(at(calls, 'revealDrawer') < calls.lastIndexOf('render'));
});

await check('a throw keeps the Area account and refuses what it had not reached', async () => {
  const { host, calls, said, logOf } = fakeHost({
    askImport: async () => ({
      plans: [plan(0, 'area', 'L', 'A'), plan(1, 'bus', 'W', 'A')],
      limits: [],
      everything: false,
    }),
    ingest: async (kind) => {
      if (kind === 'bus') throw new Error('boom');
      return { failures: [], warnings: [{ files: [], note: 'area fine' }] };
    },
  });
  const drop = createDropLoad(host);
  await drop.load([csv('area.csv', AREA_LONG), csv('bus.csv', HEADER)]);
  assert.deepEqual(said.get('area'), ['area fine'], 'published before the batch that threw');
  const refusal = 'The load stopped: boom. Files it had not reached were not loaded.';
  assert.deepEqual(said.get('session'), [refusal]);
  assert.deepEqual(calls.slice(-2), ['inventory.endDrop', 'floor:null']);
  assert.equal(drop.running(), false);
  const refused = logOf().filter((line) => line.event === 'refused');
  assert.deepEqual(
    refused.map((line) => [line.reason, line.files.map((file) => file.name)]),
    [[refusal, ['area.csv', 'bus.csv']]],
  );
});

await check(
  'limits install after every ingest, by Case name, and refuse an unknown one',
  async () => {
    const { host, calls, said, cases, logOf } = fakeHost({
      askImport: async (_tables, _cases, limits) => {
        assert.equal(limits.length, 2);
        return {
          plans: [plan(0, 'interface', 'W', 'Summer')],
          limits: [
            { file: 'own.csv', fileIndex: 0, scope: { kind: 'case', caseName: 'Summer' } },
            { file: 'lost.csv', fileIndex: 1, scope: { kind: 'case', caseName: 'Winter' } },
          ],
          everything: false,
        };
      },
      ingest: async () => {
        calls.push('ingest');
        // The Case the pinned limits name exists only once its export loads.
        cases.push({ id: 'c1', name: 'Summer', tables: new Map() });
        return { failures: [], warnings: [{ files: [], note: 'iface' }] };
      },
    });
    await createDropLoad(host).load([
      csv('iface.csv', INTERFACE),
      csv('own.csv', LIMITS),
      csv('lost.csv', LIMITS),
    ]);
    assert.ok(at(calls, 'ingest') < at(calls, 'setCaseLimits'));
    assert.equal(calls.filter((call) => call === 'setCaseLimits').length, 1);
    assert.deepEqual(said.get('interface'), ['iface']);
    // The limits notes republish the Area account, which rides first.
    assert.deepEqual(said.get('area'), [
      'own.csv: 1 path limit(s) for Case "Summer" only.',
      'lost.csv: assigned to Case "Winter", which is not loaded — the limits were NOT applied. ' +
        'Its export may have been refused; load them together.',
    ]);
    assert.ok(
      logOf().some((line) => line.event === 'refused' && line.files[0].name === 'lost.csv'),
      'the unapplied limits file is logged refused',
    );
  },
);

await check('auxiliary files apply in drop order ahead of any table', async () => {
  const { host, calls, said } = fakeHost();
  await createDropLoad(host).load([
    csv('groups.csv', GROUPINGS),
    csv('study.gvmb', 'GVMB\u0000\u0000\u0000\u0000'),
    csv('SAMPLE_BusList.csv', BUS_LIST),
  ]);
  const order = calls.filter((call) =>
    ['askGroupings', 'loadGroupings:area', 'restoreBundle', 'attachLookup'].includes(call),
  );
  assert.deepEqual(order, ['askGroupings', 'loadGroupings:area', 'restoreBundle', 'attachLookup']);
  const area = said.get('area');
  assert.deepEqual(area.slice(0, 2), [
    'groups.csv: groupings updated',
    'Restored 1 case(s) from study.gvmb.',
  ]);
  // The list's parse warnings, then the merge's own note.
  assert.match(area[2], /^SAMPLE_BusList\.csv: .*absent and read as blank/);
  assert.equal(area.at(-1), 'SAMPLE_BusList.csv: 1 row(s) added');
  assert.equal(
    calls.filter((call) => call === 'inventory.recordSessionInput').length,
    2,
    'the groupings file and the list each fill a session row',
  );
  assert.ok(!calls.includes('askImport'), 'no table, no dialog');
});

await check('a cancelled groupings question changes nothing and is logged skipped', async () => {
  const { host, calls, said, logOf } = fakeHost({ askGroupings: async () => null });
  await createDropLoad(host).load([csv('groups.csv', GROUPINGS)]);
  assert.ok(!calls.some((call) => call.startsWith('loadGroupings')));
  assert.deepEqual(said.get('area'), [
    'groups.csv: groupings load cancelled — nothing was changed.',
  ]);
  assert.deepEqual(
    logOf().map((line) => [line.event, line.reason]),
    [['skipped', 'the groupings mapping was cancelled']],
  );
});

await check('a groupings file the kind refuses is logged refused, never recorded', async () => {
  const { host, calls, said, logOf } = fakeHost({
    loadGroupings: () => {
      throw new Error('no Grouping column');
    },
  });
  await createDropLoad(host).load([csv('groups.csv', GROUPINGS)]);
  assert.deepEqual(said.get('area'), ['groups.csv: no Grouping column']);
  assert.ok(!calls.includes('inventory.recordSessionInput'));
  assert.deepEqual(
    logOf().map((line) => line.event),
    ['refused'],
  );
});

await check('the sequence reaches app state only through its host', async () => {
  const { readFileSync } = await import('node:fs');
  const code = readFileSync(new URL('../src/app/drop-load.ts', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
    .join('\n');
  // Value imports only: a type import is erased and holds nothing.
  const values = [...code.matchAll(/^import (?!type )[^;]*? from '([^']+)'/gms)].map(
    (match) => match[1],
  );
  assert.deepEqual(
    values.filter((path) =>
      /main|\/ui\/|lookups\/store|limits\/store|groupings|storage/.test(path),
    ),
    [],
    'the drop imports no store, dialog or DOM module',
  );
  assert.doesNotMatch(code, /caseStore|attachTable|document\.|getElementById/);
  // The root states the host and routes every drop through it.
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(main, /const dropLoad = createDropLoad\(\{/);
  assert.match(main, /downloadRunning: \(\) => exportInFlight,/);
  assert.equal(main.split('void dropLoad.load(files)').length - 1, 3, 'drop, Add and Load');
});

await check('a slot counts its real hours, against its own year, for the replace warning', () => {
  const SLOT = 8784;
  const FEB29 = 59 * 24;
  // Every real hour of a non-leap year: its phantom Feb 29 is never a gap.
  const nonLeap = new Uint8Array(SLOT).fill(1);
  nonLeap.fill(0, FEB29, FEB29 + 24);
  // A leap year missing its real Feb 29.
  const leap = new Uint8Array(SLOT).fill(1);
  leap.fill(0, FEB29, FEB29 + 24);
  const coverage = hoursCoveredBySlot({
    tables: new Map([
      ['a', { data: { hoursPresent: nonLeap, firstYear: 2035, numYears: 1 } }],
      ['b', { data: { hoursPresent: leap, firstYear: 2036, numYears: 1 } }],
      ['c', { data: { hoursPresent: new Uint8Array(8760).fill(1), firstYear: 2035, numYears: 1 } }],
      ['d', { data: { hoursPresent: nonLeap } }],
      [
        'e',
        { data: { hoursPresent: new Uint8Array(2 * SLOT).fill(1), firstYear: 2035, numYears: 2 } },
      ],
    ]),
  });
  assert.deepEqual(coverage.a, { covers: 8760, of: 8760 });
  assert.deepEqual(coverage.b, { covers: 8760, of: 8784 });
  assert.equal(coverage.c, null, 'not a slot: unknown');
  assert.equal(coverage.d, null, 'no year: unknown');
  assert.deepEqual(
    coverage.e,
    { covers: 8760 + 8784, of: 8760 + 8784 },
    'a span counts every year',
  );
});

console.log(`\n${passed} drop-load checks passed.`);
