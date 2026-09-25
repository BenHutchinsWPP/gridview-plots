// tests/test_draw.mjs — the buffer a pinned row draws into, per kind.
//
// `src/app/draw.ts` hands every drawn line a reused buffer from a pool, and
// the line's `values` are a VIEW of it. So the pool key is an identity: two
// pins that build the same key share one buffer, the second resolve
// overwrites the first, and the pane shows two lines with the second one's
// numbers under both names. Nothing is thrown and both lines look plausible,
// which is why it is asserted here by value and not left to a reader.
//
// The properties:
//
//   * **Two groups of one slot are two buffers.** A group row's `entity` is
//     its NAME. Bus keyed on `Number(entity)`, which is NaN for every group,
//     so every Bus group pinned from one table drew the last one resolved.
//   * **A group is not the path it is named after.** Interface keyed on the
//     bare name, so a group called `P01` and path `P01` were one buffer.
//   * **The same group under two filters is two buffers.** A narrowed group
//     carries its frozen members, and the pin id already separates it from
//     the unfiltered one; the buffer key has to as well.
//   * **Two metrics of one Area are two buffers.** One Area slot holds every
//     metric, so the slot does not separate them and the quantity must.
//   * **A unit drawn as % of range beside itself in MW is two buffers.**
//   * **An export borrows no drawn buffer.** The hourly download resolves
//     through the same draw into a one-set pool, writes the drawn numbers,
//     and leaves the drawn pool's keys and contents where they were.
//   * **No kind builds a key.** The four above were each one kind's hand-built
//     key forgetting a term; `resolveDraw` now builds it once from the ref, and
//     the text check at the bottom keeps a per-kind resolver from naming one.
//
// Run:  node tests/test_draw.mjs

import assert from 'node:assert/strict';
import './test_loader.mjs';

const { HOURS_PER_YEAR: H } = await import('../src/model/calendar.ts');
const { resolveDraws } = await import('../src/app/draw.ts');
const { createSeriesPool } = await import('../src/series/pool.ts');
const { readFileSync } = await import('node:fs');
const { rowKeyOf } = await import('../src/model/case-model.ts');
const { BUS_GROUP_BY, clearBusGroups, setBusMembership } =
  await import('../src/tables/bus/groups.ts');
const { INTERFACE_GROUP_BY, clearInterfaceGroups, setInterfaceMembership } =
  await import('../src/tables/interface/groups.ts');

function ok(label) {
  console.log(`ok - ${label}`);
}

const NO_FILTERS = {
  months: null,
  daysOfMonth: null,
  hoursOfDay: null,
  daysOfWeek: null,
  seasons: null,
  tou: null,
};

/** One plane per entity, each a constant, so a line's first hour names it. */
function planes(count, levels) {
  const cube = new Float32Array(count * H);
  levels.forEach((level, index) => cube.fill(level, index * H, (index + 1) * H));
  return { cube, presence: new Uint8Array(count).fill(1) };
}

function context(rows) {
  return {
    filters: NO_FILTERS,
    caseLabel: rows.caseLabel ?? (() => 'Winter'),
    areaCases: () => rows.area ?? [],
    interfaceRows: () => rows.interface ?? [],
    busRows: () => rows.bus ?? [],
    generatorRows: () => rows.generator ?? [],
    busNames: () => new Map(),
    busKv: () => null,
    interfaceRange: rows.interfaceRange ?? (() => ({})),
    lines: createSeriesPool(),
  };
}

const row = (slotKey, data) => ({
  key: rowKeyOf('case-1', slotKey),
  caseId: 'case-1',
  slotKey,
  label: 'Winter',
  data,
});

const pin = (ref) => ({ ref, color: '#000', dashed: false });

{
  const bus = {
    ...planes(3, [10, 20, 50]),
    buses: Int32Array.from([101, 102, 103]),
    names: ['ALDER', 'BIRCH', 'CEDAR'],
    tou: new Uint8Array(H),
    sourceColumns: [101, 102, 103],
    year: 2035,
    quantity: 'Unserved Load (MWh)',
  };
  setBusMembership(
    new Map([
      ['West', [101, 102]],
      ['East', [103]],
    ]),
  );
  const group = (name) => ({
    id: `case-1 | bus | ${BUS_GROUP_BY}=${name}`,
    kind: 'bus',
    caseId: 'case-1',
    slotKey: 'bus',
    entity: name,
    variable: bus.quantity,
    unit: 'MWh',
    axisIndex: -1,
    groupBy: BUS_GROUP_BY,
    groupValue: name,
  });
  const [west, east] = resolveDraws(context({ bus: [row('bus', bus)] }), [
    pin(group('West')),
    pin(group('East')),
  ]);
  assert.notEqual(west.values, east.values, 'two bus groups never share a buffer');
  assert.equal(west.values[0], 30, 'West is 10 + 20, not whichever group resolved last');
  assert.equal(east.values[0], 50);
  ok('two bus groups pinned from one table draw their own numbers');
  // A figure is frozen when exported, so its key counts the members the line
  // summed; the pin's own label cannot (an unfiltered group is live).
  assert.equal(west.facets.figureSubject, `${BUS_GROUP_BY} = West (2 buses)`);
  assert.equal(east.facets.figureSubject, `${BUS_GROUP_BY} = East (1 bus)`);
  assert.ok(!/buses/.test(west.detail), 'the drawn label names no count');
  ok('a bus group’s figure key counts the buses it summed, and its label does not');
  clearBusGroups();
}

{
  const iface = {
    ...planes(2, [100, 7]),
    interfaces: ['P01', 'P02'],
    tou: new Uint8Array(H),
    sourceColumns: ['P01', 'P02'],
    year: 2035,
    quantity: 'Power Flow (MW)',
    unit: 'MW',
  };
  setInterfaceMembership(
    new Map([
      [
        'P01',
        [
          { name: 'P01', direction: 'forward' },
          { name: 'P02', direction: 'forward' },
        ],
      ],
    ]),
  );
  const base = {
    kind: 'interface',
    caseId: 'case-1',
    slotKey: 'interface:Power Flow (MW)',
    variable: iface.quantity,
    unit: 'MW',
    axisIndex: -1,
  };
  const path = { ...base, id: 'path', entity: 'P01' };
  const group = {
    ...base,
    id: 'group',
    entity: 'P01',
    groupBy: INTERFACE_GROUP_BY,
    groupValue: 'P01',
  };
  const narrowed = { ...group, id: 'group-narrowed', members: ['P02'] };
  const [onePath, whole, part] = resolveDraws(context({ interface: [row(base.slotKey, iface)] }), [
    pin(path),
    pin(group),
    pin(narrowed),
  ]);
  assert.equal(onePath.values[0], 100, 'the path is its own plane');
  assert.equal(whole.values[0], 107, 'the group named after it is the sum of both');
  assert.equal(part.values[0], 7, 'and the same group narrowed to P02 is P02 alone');
  assert.equal(new Set([onePath.values, whole.values, part.values]).size, 3);
  ok('an interface group is neither the path it is named after nor itself under a filter');
  assert.equal(whole.facets.figureSubject, 'P01', 'a boundary is its group name alone');
  assert.equal(part.facets.figureSubject, 'P01', 'narrowed too: no count, no column');
  assert.equal(onePath.facets.figureSubject, undefined, 'a path keeps its subject');
  ok('an interface group’s figure key is the name its author gave it');

  // % of range: a path asks for its own limits in its own Case and year; a
  // group asks for each member's, and divides by their sum.
  const asked = [];
  const ranged = context({
    interface: [row(base.slotKey, iface)],
    interfaceRange: (caseId, name, year) => {
      asked.push([caseId, name, year]);
      return { upper: name === 'P01' ? 200 : 14 };
    },
  });
  const [pathPct, groupPct, partPct] = resolveDraws(ranged, [
    pin({ ...path, id: 'path-pct', perUnit: true }),
    pin({ ...group, id: 'group-pct', perUnit: true }),
    pin({ ...narrowed, id: 'narrowed-pct', perUnit: true }),
  ]);
  assert.deepEqual(asked.slice(0, 3), [
    ['case-1', 'P01', 2035],
    ['case-1', 'P01', 2035],
    ['case-1', 'P02', 2035],
  ]);
  assert.equal(pathPct.values[0], 50, '100 over its limit of 200');
  assert.ok(pathPct.detail.endsWith('% of limit'), pathPct.detail);
  assert.ok(Math.abs(groupPct.values[0] - (107 / 214) * 100) < 1e-3, `${groupPct.values[0]}`);
  assert.ok(groupPct.detail.endsWith('% of summed limits'), groupPct.detail);
  assert.equal(partPct.values[0], 50, 'the frozen member alone: 7 over its 14');
  ok('a pinned path draws as a % of its limit, and a group as a % of its summed limits');

  // A member with no limit: the group has none, and says it used its peak.
  const unrated = context({
    interface: [row(base.slotKey, iface)],
    interfaceRange: (_caseId, name) => (name === 'P01' ? { upper: 200 } : {}),
  });
  const [peakPct] = resolveDraws(unrated, [pin({ ...group, id: 'group-peak', perUnit: true })]);
  assert.equal(peakPct.values[0], 100);
  assert.ok(peakPct.detail.endsWith('% of peak'), peakPct.detail);
  ok('a group with an unrated member divides by its peak, and the label says so');
  clearInterfaceGroups();
}

{
  // One Area slot, two metrics of one area: plane (area 0, metric m).
  const area = {
    ...planes(2, [300, 120]),
    areas: ['SAMPLE_NORTH'],
    metrics: ['Generation (MWh)', 'Load (MWh)'],
    presence: new Uint8Array(2).fill(1),
    tou: new Uint8Array(H),
    sourceColumns: [],
    year: 2035,
  };
  const owner = { id: 'case-1', name: 'Winter', color: '#000', data: area };
  const metric = (variable) => ({
    id: `case-1 | area  | SAMPLE_NORTH | ${variable}`,
    kind: 'area',
    caseId: 'case-1',
    slotKey: 'area ',
    entity: 'SAMPLE_NORTH',
    variable,
    unit: 'MWh',
    axisIndex: 0,
  });
  const [gen, load] = resolveDraws(context({ area: [owner] }), [
    pin(metric('Generation (MWh)')),
    pin(metric('Load (MWh)')),
  ]);
  assert.notEqual(gen.values, load.values, 'two metrics of one area never share a buffer');
  assert.equal(gen.values[0], 300);
  assert.equal(load.values[0], 120);
  ok('two metrics of one area pinned from one slot draw their own numbers');
}

{
  const gen = {
    ...planes(1, [40]),
    generators: ['SAMPLE_UNIT_1'],
    tou: new Uint8Array(H),
    sourceColumns: ['SAMPLE_UNIT_1'],
    year: 2035,
    quantity: 'Generation (MW)',
  };
  const slotKey = 'generator Generation (MW)';
  const unit = (perUnit) => ({
    id: `case-1 | ${slotKey} | SAMPLE_UNIT_1${perUnit ? ' | p.u.' : ''}`,
    kind: 'generator',
    caseId: 'case-1',
    slotKey,
    entity: 'SAMPLE_UNIT_1',
    variable: gen.quantity,
    unit: 'MW',
    axisIndex: 0,
    ...(perUnit ? { perUnit: true } : {}),
  });
  const [absolute, perUnit] = resolveDraws(context({ generator: [row(slotKey, gen)] }), [
    pin(unit(false)),
    pin(unit(true)),
  ]);
  assert.notEqual(absolute.values, perUnit.values, 'MW and % of range never share a buffer');
  assert.equal(absolute.values[0], 40, 'the MW line is the unit in MW');
  assert.equal(perUnit.values[0], 100, 'and the % of range line is it over its own peak');
  assert.equal(perUnit.unit, '%');
  assert.ok(perUnit.detail.endsWith('% of peak'), perUnit.detail);
  ok('one generator drawn as % of range beside itself in MW draws two series, named by divisor');
}

{
  // The shape, not only the values: the key is built in ONE place. A per-kind
  // resolver that names a key again is how the next kind forgets a term.
  const source = readFileSync(new URL('../src/app/draw.ts', import.meta.url), 'utf8');
  const calls = [...source.matchAll(/\.for\(/g)];
  assert.equal(calls.length, 1, 'draw.ts asks a pool for a buffer exactly once');
  const resolverBodies = source
    .split(/\nfunction resolve(?:Area|Interface|Bus|Generator)Draw/)
    .slice(1);
  assert.equal(resolverBodies.length, 4, 'the four kind resolvers are where this test looks');
  for (const body of resolverBodies) {
    assert.doesNotMatch(body.split('\n}\n')[0], /\.for\(|groupSubject|bufferKey/);
  }
  ok('no per-kind resolver builds or asks for its own buffer');
}

{
  // The pool holds only what the last resolve drew: cycling pins through
  // variables would otherwise keep one buffer set per step until the Case goes.
  const lines = createSeriesPool();
  const first = lines.for('a');
  lines.for('b');
  lines.sweep();
  assert.equal(lines.for('a'), first, 'a key asked for since the last sweep is kept');
  lines.sweep();
  lines.sweep();
  assert.notEqual(lines.for('a'), first, 'a key not asked for is dropped at the sweep');

  const ctx = context({});
  const stale = ctx.lines.for('stale');
  resolveDraws(ctx, []); // the render that drew it
  resolveDraws(ctx, []); // the render that did not
  assert.notEqual(ctx.lines.for('stale'), stale, 'resolving an empty set frees every buffer');
  ok('the line pool holds only what the last resolve drew');
}

{
  // The legend reads a frozen filter the way the Selected tab does: with what
  // it was chosen on, once the pin no longer shows that.
  const { setGroupings } = await import('../src/lookups/groupings.ts');
  setGroupings('Name,Grouping\nAREA_AV,North\nAREA_NV,North');
  const metrics = ['Load (MWh)', 'Generation (MWh)'];
  const data = {
    cube: new Float32Array(2 * 2 * H).fill(1),
    areas: ['AREA_AV', 'AREA_NV'],
    metrics,
    presence: new Uint8Array(4).fill(1),
    tou: new Uint8Array(H),
    sourceColumns: ['Name', ...metrics],
    year: 2035,
  };
  const ref = {
    id: 'north',
    kind: 'area',
    caseId: 'case-1',
    slotKey: 'area',
    entity: 'North',
    variable: 'Generation (MWh)',
    unit: 'MWh',
    axisIndex: -1,
    groupBy: 'Group',
    groupValue: 'North',
    members: ['AREA_AV', 'AREA_NV'],
    filterContext: [
      {
        key: 'stat.max',
        label: 'Max',
        constraint: '≥ 500',
        chosenOn: { variable: 'Load (MWh)', unit: 'MWh' },
      },
    ],
  };
  const [line] = resolveDraws(
    context({ area: [{ id: 'case-1', name: 'Winter', color: '#000', data }] }),
    [pin(ref)],
  );
  assert.match(line.detail, /Max ≥ 500 \(chosen on Load \(MWh\)\)/, line.detail);
  ok('the legend names what a switched pin’s filter was chosen on');
  assert.equal(line.facets.figureSubject, 'Group = North (2 areas)');
  ok('an area group’s figure key counts the areas it combined');
}

{
  // The hourly download resolves through the same draw into a pool of its
  // own. What it writes is the drawn line, hour for hour (a "% of range"
  // line as its ratio), and the drawn pool keeps its keys and contents.
  const { resolveDraw } = await import('../src/app/draw.ts');
  const { createScratchPool } = await import('../src/series/pool.ts');
  const { exportHourly } = await import('../src/app/hourly-export.ts');

  /** One plane per entity, varying by hour so a copy error shows. */
  const varying = (count, levels) => {
    const cube = new Float32Array(count * H);
    levels.forEach((level, index) => {
      for (let hour = 0; hour < H; hour++) cube[index * H + hour] = level + (hour % 24) * 1.25;
    });
    return { cube, presence: new Uint8Array(count).fill(1) };
  };
  const area = {
    ...varying(2, [300, 120]),
    areas: ['SAMPLE_NORTH'],
    metrics: ['Generation (MWh)', 'Load (MWh)'],
    presence: new Uint8Array(2).fill(1),
    tou: new Uint8Array(H),
    sourceColumns: [],
    year: 2035,
  };
  const bus = {
    ...varying(2, [10, -20]),
    buses: Int32Array.from([101, 102]),
    names: ['ALDER', 'BIRCH'],
    tou: new Uint8Array(H),
    sourceColumns: [101, 102],
    year: 2035,
    quantity: 'Unserved Load (MWh)',
  };
  const iface = {
    ...varying(1, [-40]),
    interfaces: ['P01'],
    tou: new Uint8Array(H),
    sourceColumns: ['P01'],
    year: 2035,
    quantity: 'Power Flow (MW)',
    unit: 'MW',
  };
  const gen = {
    ...varying(1, [40]),
    generators: ['SAMPLE_UNIT_1'],
    tou: new Uint8Array(H),
    sourceColumns: ['SAMPLE_UNIT_1'],
    year: 2035,
    quantity: 'Generation (MW)',
  };
  const ctx = context({
    area: [{ id: 'case-1', name: 'Winter', color: '#000', data: area }],
    bus: [row('bus', bus)],
    interface: [row('interface:Power Flow (MW)', iface)],
    generator: [row('generator Generation (MW)', gen)],
    interfaceRange: () => ({ upper: 100, lower: -80 }),
  });
  const base = { caseId: 'case-1' };
  const refs = [
    {
      ...base,
      kind: 'area',
      slotKey: 'area ',
      entity: 'SAMPLE_NORTH',
      variable: 'Load (MWh)',
      unit: 'MWh',
      axisIndex: 0,
    },
    {
      ...base,
      kind: 'bus',
      slotKey: 'bus',
      entity: 102,
      variable: bus.quantity,
      unit: 'MWh',
      axisIndex: 1,
    },
    {
      ...base,
      kind: 'interface',
      slotKey: 'interface:Power Flow (MW)',
      entity: 'P01',
      variable: iface.quantity,
      unit: 'MW',
      axisIndex: 0,
    },
    {
      ...base,
      kind: 'generator',
      slotKey: 'generator Generation (MW)',
      entity: 'SAMPLE_UNIT_1',
      variable: gen.quantity,
      unit: 'MW',
      axisIndex: 0,
    },
  ].flatMap((ref) => [
    { ...ref, id: `${ref.kind}` },
    { ...ref, id: `${ref.kind} | p.u.`, perUnit: true },
  ]);
  // A month filter, so masked hours are in play.
  ctx.filters = { ...NO_FILTERS, months: new Set([1]) };
  const drawn = resolveDraws(
    ctx,
    refs.map((ref) => pin(ref)),
  );
  const held = drawn.map((line) => line.values);
  const copies = drawn.map((line) => line.values.slice());

  const exportCtx = { ...ctx, lines: createScratchPool() };
  const parts = await exportHourly(
    {
      resolve: (ref) => resolveDraw(exportCtx, pin(ref)),
      progress: () => {},
      nextFrame: async () => {},
      confirm: async () => true,
    },
    { layout: 'long', refs, descriptor: [], notes: [] },
  );
  const lines = parts.join('').split('\n');
  const rows = lines.slice(lines.indexOf('Series,Month,Day,HE,HourOfYear,Value') + 1, -1);
  assert.equal(rows.length, refs.length * H);
  refs.forEach((ref, i) => {
    const values = drawn[i].values;
    assert.equal(drawn[i].unit, ref.perUnit ? '%' : ref.unit);
    for (let hour = 0; hour < H; hour++) {
      const cell = rows[i * H + hour].split(',').at(-1);
      if (Number.isNaN(values[hour])) {
        assert.equal(cell, '', `${ref.id} hour ${hour} is masked`);
      } else if (ref.perUnit) {
        const expected = values[hour] / 100;
        assert.ok(
          Math.abs(Number(cell) - expected) <= 1e-7 * Math.max(1, Math.abs(expected)),
          `${ref.id} hour ${hour}: ${cell} vs ${expected}`,
        );
      } else {
        assert.equal(Math.fround(Number(cell)), values[hour], `${ref.id} hour ${hour}`);
      }
    }
    assert.ok(values.some((value) => Number.isNaN(value)) && values.some((v) => !Number.isNaN(v)));
  });
  ok('an exported series is the drawn one for all four kinds, and its ratio in % of range');

  drawn.forEach((line, i) => assert.deepEqual(line.values, copies[i]));
  const again = resolveDraws(
    ctx,
    refs.map((ref) => pin(ref)),
  );
  again.forEach((line, i) => assert.equal(line.values, held[i], `${refs[i].id} kept its buffer`));
  ok('an export leaves the drawn pool’s keys and contents as they were');
}
