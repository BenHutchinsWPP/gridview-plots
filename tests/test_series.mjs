// tests/test_series.mjs — what a ticked row MEANS, and what draws it:
//
//   * A spec is data, and its id separates subjects that spell the same text.
//   * The map dispatches only; a kind with no resolver refuses BY NAME.
//   * Refusals and warnings from `buildSeries` survive into the resolver.
//   * A subject a kind cannot honour is refused, never approximated.
//   * Masked hours are gaps, not zeros, and no NaN reaches a statistic.

import assert from 'node:assert/strict';
import './test_loader.mjs';

const { HOURS_PER_YEAR } = await import('../src/model/calendar.ts');
const {
  PREVIEW_COLOR,
  createSeriesBuffers,
  resolveSeries,
  specFromRow,
  specId,
  checkStackOverlap,
  stackOrder,
} = await import('../src/series/model.ts');
const { resolveGeneratorSeries } = await import('../src/tables/generator/series.ts');
const { resolveBusSeries } = await import('../src/tables/bus/series.ts');
const { BUS_GROUP_BY, clearBusGroups, setBusMembership } =
  await import('../src/tables/bus/groups.ts');
const { GENERATOR_GROUP_BY, clearGeneratorGroups, setGeneratorMembership } =
  await import('../src/tables/generator/groups.ts');
const { derivedAttribute } = await import('../src/tables/generator/derived.ts');
const { bucketLabelFor } = await import('../src/lookups/reduce.ts');
const { resolveAreaSeries } = await import('../src/tables/area/series.ts');
const { setGroupings } = await import('../src/tables/area/groupings.ts');
const { resolveInterfaceSeries } = await import('../src/tables/interface/series.ts');
const { rangeLimitsOf } = await import('../src/limits/draw.ts');
const { INTERFACE_GROUP_BY, clearInterfaceGroups, setInterfaceMembership } =
  await import('../src/tables/interface/groups.ts');
const { attachLookup, clearLookups } = await import('../src/lookups/store.ts');
const { buildLookup, parseLookupCsv } = await import('../src/lookups/parse.ts');

const HOURS = HOURS_PER_YEAR;
let checks = 0;
function ok(label) {
  checks++;
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

/** A GeneratorTable, one plane per generator. `absent` names the ones whose
 * plane stays NaN with presence 0 — a file that did not carry the unit. */
function makeCase({
  generators,
  fill = (i, h) => i * 1000 + h,
  absent = [],
  sourceColumns = generators,
  quantity = 'Generation (MWh)',
  year = 2035,
} = {}) {
  const cube = new Float32Array(generators.length * HOURS).fill(NaN);
  const presence = new Uint8Array(generators.length);
  generators.forEach((name, index) => {
    if (absent.includes(name)) return;
    presence[index] = 1;
    for (let hour = 0; hour < HOURS; hour++) cube[index * HOURS + hour] = fill(index, hour);
  });
  return { cube, generators, presence, tou: new Uint8Array(HOURS), sourceColumns, year, quantity };
}

const RESOLVERS = { generator: resolveGeneratorSeries };

function options(overrides = {}) {
  return {
    name: 'Winter 2035',
    detail: 'Winter 2035 · G1 PV',
    tableLabel: 'Winter 2035 · Generation (MWh)',
    color: '#1f77b4',
    ...overrides,
  };
}

function draw(data, subject, { filters = NO_FILTERS, spec = {}, opts = {} } = {}) {
  const full = {
    caseId: 'case-1',
    source: { kind: 'generator', quantity: data.quantity },
    subject,
    ...spec,
  };
  return resolveSeries(RESOLVERS, full, data, filters, createSeriesBuffers(), options(opts));
}

// ------------------------------------------------------------------ the spec

{
  const base = {
    caseId: 'case-1',
    source: { kind: 'generator', quantity: 'Generation (MWh)' },
    subject: { entity: 'G1 PV' },
  };
  const other = { ...base, caseId: 'case-2' };
  assert.notEqual(specId(base), specId(other), 'the case is part of the identity');

  // Two cases can hold the same generator under two quantities, and they are
  // two different lines with two different y scales.
  const cost = { ...base, source: { kind: 'generator', quantity: 'Fuel Cost ($)' } };
  assert.notEqual(specId(base), specId(cost), 'the slot is part of the identity');

  // A grouped subject that spells the same text as an entity is NOT the same
  // series: one is a unit, the other is a fleet.
  const grouped = { ...base, subject: { groupBy: 'FuelType', value: 'G1 PV' } };
  assert.notEqual(specId(base), specId(grouped), 'a group never collides with an entity');

  assert.notEqual(specId(base), specId({ ...base, perUnit: true }), 'per-unit is its own line');
  assert.equal(specId(base), specId({ ...base }), 'the same spec is the same id');
  ok('a spec is identified by case, slot, subject and per-unit, and nothing else');

  const spec = specFromRow({
    caseId: 'case-9',
    kind: 'generator',
    variable: 'Generation (MWh)',
    entity: 'G2 WT',
  });
  assert.deepEqual(spec, {
    caseId: 'case-9',
    source: { kind: 'generator', quantity: 'Generation (MWh)' },
    subject: { entity: 'G2 WT' },
  });
  ok('a browse row becomes a spec with no cube, no closure and no DOM in it');
}

// -------------------------------------------------------------- the dispatch

{
  const data = makeCase({ generators: ['G1 PV'] });
  const entry = resolveSeries(
    {},
    { caseId: 'case-1', source: { kind: 'bus', quantity: 'LMP ($/MWh)' }, subject: { entity: 7 } },
    data,
    NO_FILTERS,
    createSeriesBuffers(),
    options(),
  );
  assert.equal(entry.values, null, 'an unregistered kind draws nothing');
  assert.match(entry.refusal, /bus series cannot be drawn/, 'and says which kind, by name');
  assert.equal(entry.n, 0);
  assert.ok(Number.isNaN(entry.stats.mean), 'a refusal has no statistics, not zeroed ones');
  ok('a kind with no resolver refuses by name rather than throwing or drawing nothing');
}

// ----------------------------------------------------------- what it draws

{
  const data = makeCase({ generators: ['G1 PV', 'G2 WT'] });
  const entry = draw(data, { entity: 'G2 WT' });

  assert.equal(entry.unit, 'MWh', "the unit comes from the file's own title quantity");
  assert.equal(entry.quantity, 'Generation (MWh)');
  assert.equal(entry.n, HOURS, 'with no filters every hour is kept');
  assert.equal(entry.values[0], 1000, 'the stored plane IS the series in this build');
  assert.equal(entry.values[HOURS - 1], 1000 + HOURS - 1);
  assert.equal(entry.stats.min, 1000);
  assert.equal(entry.stats.max, 1000 + HOURS - 1);
  assert.equal(entry.color, '#1f77b4');
  assert.equal(entry.dashed, undefined, 'a pinned line is solid');
  ok("an entity subject draws its plane with this kind's own unit and statistics");
}

{
  // A preview is grey AND dashed: grey alone is a colour an analyst can
  // mistake for a tenth series.
  const data = makeCase({ generators: ['G1 PV'] });
  const entry = draw(data, { entity: 'G1 PV' }, { opts: { color: PREVIEW_COLOR, dashed: true } });
  assert.equal(entry.dashed, true, 'the flag reaches the chart');
  assert.equal(entry.color, PREVIEW_COLOR);
  assert.ok(!PREVIEW_COLOR.startsWith('#1f77b4'), 'and it is not a palette colour');
  ok('the click-preview carries its own colour and its dash through the resolver');
}

{
  // January only. The kept values are compacted; the DRAWN copy keeps gaps,
  // or the time pane would join hour 743 to hour 8,016 with a straight line
  // across a year that was never plotted.
  const data = makeCase({ generators: ['G1 PV'] });
  const entry = draw(
    data,
    { entity: 'G1 PV' },
    { filters: { ...NO_FILTERS, months: new Set([1]) } },
  );
  assert.equal(entry.n, 31 * 24, 'only January’s hours are kept');
  assert.ok(Number.isNaN(entry.values[31 * 24]), 'a filtered-out hour is a gap, not a zero');
  assert.ok(!Number.isNaN(entry.values[0]), 'a kept hour is drawn');
  for (let i = 0; i < entry.n; i++) {
    assert.ok(!Number.isNaN(entry.sorted[i]), 'no NaN reaches a statistic');
  }
  assert.equal(entry.stats.n, 31 * 24, 'the statistics see the kept hours only');
  ok('the hour filters blank the drawn copy and compact the counted one');
}

{
  const data = makeCase({ generators: ['G1 PV'], fill: () => 0 });
  const entry = draw(data, { entity: 'G1 PV' });
  assert.equal(entry.allZero, true, 'zero all year is data, and the pane says so itself');
  ok('an all-zero plane is reported as data rather than as a load error');
}

// ------------------------------------------------------------- the refusals

{
  const data = makeCase({ generators: ['G1 PV', 'G3 BA'], absent: ['G3 BA'] });

  const absent = draw(data, { entity: 'G3 BA' });
  assert.equal(absent.values, null, 'an absent plane refuses, never a NaN series');
  assert.match(absent.refusal, /has no data for "G3 BA"/);
  assert.match(absent.refusal, /Generation \(MWh\)/, 'and names the TABLE, not the legend label');
  assert.equal(absent.unit, 'MWh', 'a refusal still knows its unit, so the pane can say so');

  const never = draw(data, { entity: 'G9 XX' });
  assert.match(never.refusal, /does not carry "G9 XX"/, 'never carried is its own message');

  const dropped = makeCase({
    generators: ['G1 PV'],
    sourceColumns: ['G1 PV', 'G4 CT'],
  });
  const unretained = draw(dropped, { entity: 'G4 CT' });
  assert.match(unretained.refusal, /was not retained at load/, 'and so is carried-but-dropped');
  ok('every refusal `buildSeries` writes survives the move into the resolver');
}

const GEN_COLUMNS = ['Name', 'Bus ID', 'Area Name', 'FuelType', 'PSSEMaxCap(MW)', 'PSSEMinCap(MW)'];
function makeGenList(rows) {
  return [
    `GENERATORLIST${','.repeat(GEN_COLUMNS.length - 1)}`,
    GEN_COLUMNS.join(','),
    ...rows,
  ].join('\n');
}

{
  // Intensive generator quantities refuse to combine
  const lmpData = makeCase({ generators: ['G1 PV'], quantity: 'LMP ($/MWh)', unit: '$/MWh' });
  const lmpGrouped = draw(lmpData, { groupBy: 'FuelType', value: 'Solar' });
  assert.equal(lmpGrouped.values, null);
  assert.match(lmpGrouped.refusal, /\$\/MWh/);
  ok('an intensive generator quantity refuses to combine across generators');

  // Extensive generator quantity needs GeneratorList
  clearLookups();
  const genData = makeCase({ generators: ['G1 PV'] });
  const unlistedGroup = draw(genData, { groupBy: 'FuelType', value: 'Solar' });
  assert.equal(unlistedGroup.values, null);
  assert.match(unlistedGroup.refusal, /GeneratorList/);
  ok('grouping generators refuses when GeneratorList is not loaded');

  // Extensive generator quantity sums across matching generators
  attachLookup(
    parseLookupCsv(
      makeGenList([
        'G1 PV,101,AREA_AV,Solar,100,0',
        'G2 PV,102,AREA_AV,Solar,50,-25',
        'BATT,103,AREA_AV,Battery,20,-20',
      ]),
      'GeneratorList.csv',
    ).rows,
  );
  const solarCase = makeCase({
    generators: ['G1 PV', 'G2 PV'],
    fill: (i, h) => (i + 1) * 10,
  });
  const solarGroup = draw(solarCase, { groupBy: 'FuelType', value: 'Solar' });
  assert.equal(solarGroup.n, HOURS);
  // G1 PV is 10, G2 PV is 20 -> sum is 30
  assert.equal(solarGroup.values[0], 30);
  assert.equal(solarGroup.stats.mean, 30);
  ok('generators combine by summing extensive quantities across matching lookup rows');

  const noMatch = draw(solarCase, { groupBy: 'FuelType', value: 'Nuclear' });
  assert.equal(noMatch.values, null);
  assert.match(noMatch.refusal, /No generators/);
  ok('a group with no matching generators refuses clearly');

  // % of range: a unit with a listed max cap divides by it.
  const puGen = draw(solarCase, { entity: 'G1 PV' }, { spec: { perUnit: true } });
  assert.equal(puGen.unit, '%');
  assert.ok(Math.abs(puGen.values[0] - 10) < 1e-4);
  assert.equal(puGen.rangeLabel, '% of limit');
  ok('% of range divides positive generation by PSSEMaxCap');

  // Negative generation (pumping/charging) divides by a negative min cap.
  const batCase = makeCase({
    generators: ['BATT'],
    fill: () => -10,
  });
  const puBat = draw(batCase, { entity: 'BATT' }, { spec: { perUnit: true } });
  assert.equal(puBat.unit, '%');
  assert.equal(puBat.values[0], -50); // -abs(-10 / -20)
  assert.equal(puBat.rangeLabel, '% of limit');
  ok('% of range divides charging/pumping by -abs(val / PSSEMinCap)');

  // No cap in GeneratorList: the series' own peak, said by the label rather
  // than a warning on every line.
  const noCapCase = makeCase({
    generators: ['UNLISTED'],
    fill: () => 50,
  });
  const puFallback = draw(noCapCase, { entity: 'UNLISTED' }, { spec: { perUnit: true } });
  assert.equal(puFallback.unit, '%');
  assert.equal(puFallback.values[0], 100); // 50 / 50
  assert.equal(puFallback.rangeLabel, '% of peak');
  assert.deepEqual(puFallback.warnings, []);
  ok('% of range falls back to the series peak when no cap is listed, and the label says so');

  // Grouped with an absent generator (presence === 0)
  // G1 PV (100 MW), G2 PV (50 MW) both Solar. G2 PV is absent (presence 0).
  // Total capacity should be 100 MW, NOT 150 MW!
  const groupPresenceCase = makeCase({
    generators: ['G1 PV', 'G2 PV'],
    absent: ['G2 PV'],
    fill: () => 50, // G1 PV outputs 50 MW
  });
  const puGroup = draw(
    groupPresenceCase,
    { groupBy: 'FuelType', value: 'Solar' },
    { spec: { perUnit: true } },
  );
  assert.equal(puGroup.unit, '%');
  // 50 MW / 100 MW (if presence were ignored, it would be 50 / 150)
  assert.equal(puGroup.values[0], 50);
  ok('a grouped % of range line ignores the capacity of absent generators (presence === 0)');

  // A non-power quantity is not refused: caps are MW, so it divides by its peak.
  const puNonPower = draw(lmpData, { entity: 'G1 PV' }, { spec: { perUnit: true } });
  assert.equal(puNonPower.refusal, undefined);
  assert.equal(puNonPower.unit, '%');
  assert.equal(puNonPower.rangeLabel, '% of peak');
  assert.equal(Math.max(...puNonPower.values.filter((v) => !Number.isNaN(v))), 100);
  ok('a non-power generator quantity divides by its own peak, never by a MW cap');

  // A group summing a unit with no max cap: its output is in the numerator
  // but not the capacity, so the line can pass 100%, and says so.
  setGeneratorMembership(new Map([['Mixed', ['G1 PV', 'UNLISTED']]]));
  const mixedCase = makeCase({ generators: ['G1 PV', 'UNLISTED'], fill: () => 80 });
  const mixed = draw(
    mixedCase,
    { groupBy: GENERATOR_GROUP_BY, value: 'Mixed' },
    { spec: { perUnit: true } },
  );
  assert.equal(mixed.values[0], 160, '160 MW over G1 PV’s 100');
  assert.equal(mixed.warnings.length, 1, mixed.warnings.join(' | '));
  assert.match(mixed.warnings[0], /^1 summed unit has no PSSEMaxCap\(MW\) above 0/);
  assert.match(mixed.warnings[0], /\(UNLISTED\).*the line can read over 100%/);
  ok('a group line summing a capless unit warns that it can read over 100%');

  // Without GeneratorList, the group's power is refused, as the tab refuses it.
  clearLookups();
  const unlisted = draw(
    mixedCase,
    { groupBy: GENERATOR_GROUP_BY, value: 'Mixed' },
    { spec: { perUnit: true } },
  );
  assert.equal(unlisted.values, null);
  assert.match(unlisted.refusal, /summed PSSEMaxCap\(MW\).*GENERATORLIST/);
  const unit = draw(mixedCase, { entity: 'G1 PV' }, { spec: { perUnit: true } });
  assert.equal(unit.rangeLabel, '% of peak', 'one unit still falls back to its peak');
  ok('a group line’s power as % of range needs GeneratorList, as on the Generator Groups tab');
  clearGeneratorGroups();
}

// ---------------------------------------------------------- the bus resolver
//
// Only Bus's own: its subject is an ID, and its two refusals are settled
// differently from Generator's (one never is).

/** A BusTable, one plane per bus id. `absent` names ids whose plane stays NaN
 * with presence 0 -- a file that did not carry the bus. */
function makeBusCase({
  buses = [10001, 10002],
  names = ['WILLOWBEND', 'WILLOWBEND'],
  fill = (i, h) => i * 100 + h,
  absent = [],
  sourceColumns = buses,
  quantity = 'LMP ($/MWh)',
  year = 2035,
} = {}) {
  const cube = new Float32Array(buses.length * HOURS).fill(NaN);
  const presence = new Uint8Array(buses.length);
  buses.forEach((id, index) => {
    if (absent.includes(id)) return;
    presence[index] = 1;
    for (let hour = 0; hour < HOURS; hour++) cube[index * HOURS + hour] = fill(index, hour);
  });
  return {
    cube,
    buses: Int32Array.from(buses),
    names: [...names],
    presence,
    tou: new Uint8Array(HOURS),
    sourceColumns: [...sourceColumns],
    year,
    quantity,
  };
}

function drawBus(data, subject, { filters = NO_FILTERS, spec = {} } = {}) {
  return resolveSeries(
    { bus: resolveBusSeries },
    {
      caseId: 'case-1',
      source: { kind: 'bus', quantity: data.quantity },
      subject,
      ...spec,
    },
    data,
    filters,
    createSeriesBuffers(),
    options({
      detail: 'Winter 2035 · WILLOWBEND (10002)',
      tableLabel: 'Winter 2035 · LMP ($/MWh)',
    }),
  );
}

{
  const data = makeBusCase();
  const entry = drawBus(data, { entity: 10002 });
  assert.equal(entry.unit, '$/MWh', "the unit comes from the file's own title quantity");
  assert.equal(entry.n, HOURS);
  assert.equal(entry.values[0], 100, 'the id picked the SECOND plane, not the first');
  ok('a bus subject is resolved through the id, and the id is the axis');

  // The two buses share a name. If anything here looked names up, both specs
  // would resolve to one plane and one of the two lines would be a copy.
  const first = drawBus(data, { entity: 10001 });
  assert.equal(first.values[0], 0);
  assert.notEqual(first.values[0], entry.values[0]);
  ok('two buses sharing a name resolve to two different planes');

  const january = drawBus(
    data,
    { entity: 10001 },
    { filters: { ...NO_FILTERS, months: new Set([1]) } },
  );
  assert.equal(january.n, 31 * 24, 'only January’s hours are kept');
  assert.ok(Number.isNaN(january.values[31 * 24]), 'a filtered-out hour is a gap, not a zero');
  ok('the hour filters blank the drawn copy and compact the counted one, as for every kind');
}

{
  const data = makeBusCase({
    buses: [10001, 10003],
    names: ['WILLOWBEND', 'ALDER'],
    absent: [10003],
  });
  const absent = drawBus(data, { entity: 10003 });
  assert.equal(absent.values, null, 'an absent plane refuses, never a NaN series');
  assert.match(absent.refusal, /no data for ALDER \(10003\)/, 'naming the bus as name (id)');
  assert.equal(absent.unit, '$/MWh', 'a refusal still knows its unit, so the pane can say so');

  const never = drawBus(data, { entity: 19999 });
  assert.match(never.refusal, /does not carry bus 19999/, 'never carried is its own message');

  const dropped = makeBusCase({
    buses: [10001],
    names: ['WILLOWBEND'],
    sourceColumns: [10001, 10007],
  });
  const unretained = drawBus(dropped, { entity: 10007 });
  assert.match(unretained.refusal, /was not retained at load/, 'and so is carried-but-dropped');
  ok('every refusal Bus’s buildSeries writes survives the move into the resolver');
}

{
  // Buses combine on the terms src/tables/bus/rules.ts states, and the
  // default fixture's LMP is the case that still does not: it is INTENSIVE,
  // and the weight that would make a regional price is in another table.
  const data = makeBusCase();
  const grouped = drawBus(data, { groupBy: 'LoadArea', value: 'AREA_AV' });
  assert.equal(grouped.values, null, 'an intensive quantity is not summed over buses');
  assert.match(grouped.refusal, /\$\/MWh/, 'and the refusal names the UNIT');
  assert.match(grouped.refusal, /weighting column/, 'and what it would need');
  assert.ok(!/never combined/.test(grouped.refusal), 'never the kind');
  ok('a grouped bus subject refuses an intensive quantity by class, not by kind');

  // …and an extensive one sums. No BusList is loaded in this process, so the
  // attribute join refuses by naming the file, while a user-authored group
  // needs no list at all and is the arm that draws.
  const load = makeBusCase({ quantity: 'Unserved Load (MWh)', fill: (i) => (i + 1) * 10 });
  const noList = drawBus(load, { groupBy: 'LoadArea', value: 'AREA_AV' });
  assert.equal(noList.values, null, 'an attribute group-by is a join');
  assert.match(noList.refusal, /BusList\.csv to be loaded/, 'and it names the file to drop');

  setBusMembership(new Map([['West', [10001, 10002]]]));
  const summed = drawBus(load, { groupBy: BUS_GROUP_BY, value: 'West' });
  assert.ok(summed.values, 'a user-authored bus group draws');
  assert.equal(summed.values[0], 30, '10 + 20, summed plane by plane');
  assert.equal(summed.unit, 'MWh');

  // % of range on the group: the peak of the SUM (hour 0 is 30 + 60 = 90),
  // not either member's, and taken before the January filter drops it.
  const spiky = makeBusCase({
    quantity: 'Unserved Load (MWh)',
    fill: (i, h) => (h === 0 ? (i + 1) * 30 : (i + 1) * 10),
  });
  const groupPct = drawBus(
    spiky,
    { groupBy: BUS_GROUP_BY, value: 'West' },
    { spec: { perUnit: true }, filters: { ...NO_FILTERS, months: new Set([2]) } },
  );
  assert.equal(groupPct.unit, '%');
  assert.equal(groupPct.rangeLabel, '% of peak');
  assert.ok(Math.abs(groupPct.stats.max - (30 / 90) * 100) < 1e-4, 'Feb over the unfiltered peak');
  ok('a grouped bus line as % of range divides the sum by its own unfiltered peak');

  const missing = drawBus(load, { groupBy: BUS_GROUP_BY, value: 'Nowhere' });
  assert.equal(missing.values, null);
  assert.match(missing.refusal, /No bus of group "Nowhere"/);
  ok('an extensive quantity sums across a bus group, and an empty group refuses by name');
  clearBusGroups();

  // An LMP as % of range: no limit, so the peak; a negative hour divides by
  // the trough.
  const lmp = makeBusCase({ fill: (_i, h) => (h === 0 ? -20 : h === 1 ? 80 : 40) });
  const lmpPct = drawBus(lmp, { entity: 10001 }, { spec: { perUnit: true } });
  assert.equal(lmpPct.refusal, undefined, 'a $/MWh is normalized, not refused');
  assert.equal(lmpPct.values[0], -100, 'the negative hour over the trough');
  assert.equal(lmpPct.values[1], 100);
  assert.equal(lmpPct.values[2], 50);
  assert.equal(lmpPct.rangeLabel, '% of peak');
  ok('a bus LMP as % of range divides by its own peak, and a negative hour by its trough');

  const named = drawBus(data, { entity: 'WILLOWBEND' });
  assert.equal(named.values, null, 'a name is not an identity here');
  assert.match(named.refusal, /is not a bus number/);
  ok('a bus spec that carries a name refuses rather than guessing which bus was meant');
}

// --------------------------------------------------------- the area resolver
//
// Single entities and group-by over the defined groupings.

function makeAreaCase({
  areas = ['AREA_AV', 'AREA_NV'],
  metrics = ['Load (MWh)', 'Avg LMP Weighted by Load'],
  fill = (a, m, h) => (a * 10 + m) * 100 + h,
  absent = [],
  sourceColumns = ['Name', 'Date', 'Hour', ...metrics],
  year = 2035,
} = {}) {
  const cube = new Float32Array(areas.length * metrics.length * HOURS).fill(NaN);
  const presence = new Uint8Array(areas.length * metrics.length);
  for (let a = 0; a < areas.length; a++) {
    for (let m = 0; m < metrics.length; m++) {
      const idx = a * metrics.length + m;
      const isAbsent = absent.some(([ar, me]) => ar === areas[a] && me === metrics[m]);
      if (isAbsent) continue;
      presence[idx] = 1;
      for (let hour = 0; hour < HOURS; hour++) {
        cube[idx * HOURS + hour] = fill(a, m, hour);
      }
    }
  }
  return {
    cube,
    areas: [...areas],
    metrics: [...metrics],
    presence,
    tou: new Uint8Array(HOURS),
    sourceColumns: [...sourceColumns],
    year,
  };
}

function drawArea(
  data,
  subject,
  { metric = 'Load (MWh)', filters = NO_FILTERS, spec = {}, opts = {} } = {},
) {
  return resolveSeries(
    { area: resolveAreaSeries },
    {
      caseId: 'case-1',
      source: { kind: 'area', quantity: metric },
      subject,
      ...spec,
    },
    data,
    filters,
    createSeriesBuffers(),
    options({
      detail: `Winter 2035 · AREA_AV · ${metric}`,
      tableLabel: `Winter 2035 · ${metric}`,
      ...opts,
    }),
  );
}

{
  const data = makeAreaCase();
  const entry = drawArea(data, { entity: 'AREA_AV' });
  assert.equal(entry.unit, 'MWh', 'the unit comes from aggregation rules');
  assert.equal(entry.quantity, 'Load (MWh)');
  assert.equal(entry.n, HOURS);
  assert.equal(entry.values[0], 0);
  assert.equal(entry.values[HOURS - 1], HOURS - 1);
  assert.equal(entry.stats.min, 0);
  assert.equal(entry.stats.max, HOURS - 1);
  ok("an area entity subject draws its plane with this kind's own unit and statistics");

  const preview = drawArea(
    data,
    { entity: 'AREA_AV' },
    { opts: { color: PREVIEW_COLOR, dashed: true } },
  );
  assert.equal(preview.dashed, true);
  assert.equal(preview.color, PREVIEW_COLOR);
  ok('the click-preview carries its own colour and dash for Area');

  const january = drawArea(
    data,
    { entity: 'AREA_AV' },
    { filters: { ...NO_FILTERS, months: new Set([1]) } },
  );
  assert.equal(january.n, 31 * 24);
  assert.ok(Number.isNaN(january.values[31 * 24]));
  ok('the hour filters blank the drawn copy and compact the counted one for Area');
}

{
  // Grouping resolution for Area
  setGroupings('Name,Grouping\nAREA_AV,Northwest\nAREA_NV,Northwest');
  const data = makeAreaCase({ fill: (a, m, h) => (a + 1) * 10 });
  const entry = drawArea(data, { groupBy: 'grouping', value: 'Northwest' });
  assert.equal(entry.n, HOURS);
  // AREA_AV is 10, AREA_NV is 20 -> sum is 30 for extensive metric
  assert.equal(entry.values[0], 30);
  ok('a grouped subject resolves through groupings for Area');

  const unsupported = drawArea(data, { groupBy: 'FuelType', value: 'Solar' });
  assert.equal(unsupported.values, null);
  assert.match(unsupported.refusal, /not supported/);
  ok('an unsupported area grouping refuses with a clear message');

  // % of range: an area has no limit, so each line is over its own peak, and
  // a grouping after it is combined.
  const peaked = makeAreaCase({ fill: (a, _m, h) => (h === 0 ? (a + 1) * 40 : (a + 1) * 10) });
  const areaPct = drawArea(peaked, { entity: 'AREA_AV' }, { spec: { perUnit: true } });
  assert.equal(areaPct.unit, '%');
  assert.equal(areaPct.values[0], 100);
  assert.equal(areaPct.values[1], 25);
  assert.equal(areaPct.rangeLabel, '% of peak');
  const groupPct = drawArea(
    peaked,
    { groupBy: 'grouping', value: 'Northwest' },
    { spec: { perUnit: true }, filters: { ...NO_FILTERS, months: new Set([2]) } },
  );
  // Hour 0 sums to 40 + 80 = 120; a February hour to 10 + 20 = 30.
  assert.equal(groupPct.stats.max, 25, 'the sum over its unfiltered peak');
  assert.equal(groupPct.rangeLabel, '% of peak');
  ok('an Area line as % of range divides by its own unfiltered peak, a grouping after it sums');
}

{
  const data = makeAreaCase({ absent: [['AREA_AV', 'Load (MWh)']] });
  const absent = drawArea(data, { entity: 'AREA_AV' });
  assert.equal(absent.values, null);
  assert.match(absent.refusal, /has no data for "Load \(MWh\)"/);
  ok('an absent plane produces buildSeries refusal for Area');
}

// ---------------------------------------------------- the interface resolver
//
// Only an authored BOUNDARY combines, as a SIGNED sum; an unknown `groupBy`
// and per-unit are refused.

function makeInterfaceCase({
  interfaces = ['P01', 'P02'],
  fill = (i, h) => (i + 1) * 1000 + h,
  absent = [],
  sourceColumns = interfaces,
  quantity = 'Power Flow (MW)',
  unit = 'MW',
  year = 2035,
} = {}) {
  const cube = new Float32Array(interfaces.length * HOURS).fill(NaN);
  const presence = new Uint8Array(interfaces.length);
  interfaces.forEach((name, index) => {
    if (absent.includes(name)) return;
    presence[index] = 1;
    for (let hour = 0; hour < HOURS; hour++) cube[index * HOURS + hour] = fill(index, hour);
  });
  return {
    cube,
    interfaces: [...interfaces],
    presence,
    tou: new Uint8Array(HOURS),
    sourceColumns: [...sourceColumns],
    year,
    quantity,
    unit,
  };
}

function drawInterface(data, subject, { filters = NO_FILTERS, spec = {}, opts = {} } = {}) {
  return resolveSeries(
    { interface: resolveInterfaceSeries },
    {
      caseId: 'case-1',
      source: { kind: 'interface', quantity: data.quantity },
      subject,
      ...spec,
    },
    data,
    filters,
    createSeriesBuffers(),
    options({
      detail: `Winter 2035 · ${subject.entity ?? ''} · ${data.quantity}`,
      tableLabel: 'Winter 2035',
      ...opts,
    }),
  );
}

{
  const data = makeInterfaceCase();
  const entry = drawInterface(data, { entity: 'P01' });
  assert.equal(entry.unit, 'MW');
  assert.equal(entry.quantity, 'Power Flow (MW)');
  assert.equal(entry.n, HOURS);
  assert.equal(entry.values[0], 1000);
  assert.equal(entry.values[HOURS - 1], 1000 + HOURS - 1);
  assert.equal(entry.stats.min, 1000);
  assert.equal(entry.stats.max, 1000 + HOURS - 1);
  ok("an interface entity subject draws its plane with this kind's own unit and statistics");

  const preview = drawInterface(
    data,
    { entity: 'P01' },
    { opts: { color: PREVIEW_COLOR, dashed: true } },
  );
  assert.equal(preview.dashed, true);
  assert.equal(preview.color, PREVIEW_COLOR);
  ok('the click-preview carries its own colour and dash for Interface');

  const january = drawInterface(
    data,
    { entity: 'P01' },
    { filters: { ...NO_FILTERS, months: new Set([1]) } },
  );
  assert.equal(january.n, 31 * 24);
  assert.ok(Number.isNaN(january.values[31 * 24]));
  ok('the hour filters blank the drawn copy and compact the counted one for Interface');
}

{
  const data = makeInterfaceCase();
  // An arbitrary bucket is still refused: it has no direction to sum by.
  const arbitrary = drawInterface(data, { groupBy: 'grouping', value: 'Northwest' });
  assert.equal(arbitrary.values, null);
  assert.match(arbitrary.refusal, /not a boundary/);
  assert.ok(!/never combined/.test(arbitrary.refusal), 'the refusal never names the kind');
  ok('a groupBy this kind does not recognise refuses rather than summing paths flat');
}

{
  // % of range for Interface: each hour over its own MONTH's limit, handed in
  // as numbers (`options.rangeOf`). 2035 hours: January 0-743, February
  // 744-1415, March from 1416.
  const FEB = 744;
  const MAR = 1416;
  const data = makeInterfaceCase({
    fill: (_i, h) => (h === 0 ? -500 : h === 1 ? 2500 : 1000),
  });
  const months = (value, over = {}) =>
    Float32Array.from({ length: 12 }, (_, m) => (m in over ? over[m] : value));
  const pct = (limit, subject = { entity: 'P01' }, over = data) =>
    drawInterface(over, subject, {
      spec: { perUnit: true },
      opts: { rangeOf: () => rangeLimitsOf(limit, 2035) },
    });

  const flat = pct({ min: months(-1000), max: months(5000) });
  assert.equal(flat.unit, '%');
  assert.equal(flat.values[0], -50, '−500 over MIN −1000');
  assert.equal(flat.values[1], 50, '2500 over MAX 5000');
  assert.equal(flat.rangeLabel, '% of limit');
  ok('an interface as % of range divides by MIN below zero and MAX above');

  const february = pct({ min: months(-1000), max: months(5000, { 1: 4000 }) });
  assert.equal(february.values[FEB], 25, "a February hour over February's 4000");
  assert.equal(february.values[2], 20, 'a January hour still over 5000');
  ok('each hour divides by its own month’s limit');

  const sentinel = pct({ min: months(-1000), max: months(5000, { 2: NaN }) });
  assert.equal(sentinel.values[MAR], 40, 'a March hour with no MAX: 1000 over the peak 2500');
  assert.equal(sentinel.values[FEB], 20, 'February keeps its limit');
  assert.equal(sentinel.rangeLabel, '% of limit, else peak (+) / limit (−)');
  ok('a month with no limit falls back to the peak for that month only, and the label says so');

  const unlimited = pct(undefined);
  assert.equal(unlimited.values[1], 100);
  assert.equal(unlimited.rangeLabel, '% of peak');
  ok('a path with no limit row divides by its peak for the whole year');

  const mixed = pct({ max: months(5000) });
  assert.equal(mixed.values[0], -100, 'no MIN: −500 over the trough');
  assert.equal(mixed.rangeLabel, '% of limit (+) / peak (−)');
  ok('a path limited on one side names each side’s divisor');

  const priced = makeInterfaceCase({
    quantity: 'Congestion Cost ($)',
    unit: '$',
    fill: (_i, h) => (h === 1 ? 2500 : 1000),
  });
  const cost = pct({ max: months(5000) }, { entity: 'P01' }, priced);
  assert.equal(cost.values[1], 100, 'a $ series is not divided by a MW limit');
  assert.equal(cost.rangeLabel, '% of peak');
  ok('only an MW/MWh interface quantity is divided by its limit');

  setInterfaceMembership(
    new Map([
      [
        'Pair',
        [
          { name: 'P01', direction: 'forward' },
          { name: 'P02', direction: 'forward' },
        ],
      ],
    ]),
  );
  const group = pct({ max: months(5000) }, { groupBy: INTERFACE_GROUP_BY, value: 'Pair' });
  assert.equal(group.rangeLabel, '% of summed limits (+) / peak (−)');
  assert.equal(group.values[1], 50, '2 × 2500 over the summed MAX 2 × 5000');
  assert.equal(group.values[0], -100, 'no MIN on either member: −1000 over the trough');
  ok('an interface group as % of range divides by its members’ summed limits');
  clearInterfaceGroups();
}

{
  // ------------------------------------------- the signed boundary
  //
  // P01 is measured one way and P02 the other, so the boundary is P01 - P02
  // (P01 = 10, P02 = 40).
  const flat = makeInterfaceCase({ fill: (i) => (i + 1) * 10 + i * 20 });
  assert.equal(flat.cube[0], 10);
  assert.equal(flat.cube[HOURS], 40);

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
        'Both Forward',
        [
          { name: 'P01', direction: 'forward' },
          { name: 'P02', direction: 'forward' },
        ],
      ],
    ]),
  );

  const signed = drawInterface(flat, { groupBy: INTERFACE_GROUP_BY, value: 'West Boundary' });
  assert.ok(signed.values, 'a hand-authored boundary draws');
  assert.equal(signed.values[0], -30, '10 + (-1 x 40)');
  assert.equal(signed.stats.mean, -30);
  assert.equal(signed.unit, 'MW');

  const plain = drawInterface(flat, { groupBy: INTERFACE_GROUP_BY, value: 'Both Forward' });
  assert.equal(plain.values[0], 50, 'and the same two paths unreversed are 10 + 40');
  ok('a member’s direction is a multiplier: reversing one turns the sum into a difference');

  // A frozen member set freezes WHICH paths, never their direction. Pinned
  // over P02 alone, the row still counts P02 reversed.
  const frozen = drawInterface(flat, {
    groupBy: INTERFACE_GROUP_BY,
    value: 'West Boundary',
    members: ['P02'],
  });
  assert.equal(frozen.values[0], -40, 'the frozen member keeps the direction the map gives it');
  ok('a frozen member set narrows the membership and reads the directions from the map');

  const missing = drawInterface(flat, { groupBy: INTERFACE_GROUP_BY, value: 'Nowhere' });
  assert.equal(missing.values, null);
  assert.match(missing.refusal, /No path of group "Nowhere"/);
  ok('a group no loaded case carries refuses by name');

  // A direction is a statement about a FLOW. On a quantity that has none a
  // reversed member subtracts, and the series SAYS so rather than dropping
  // the sign or the member.
  const cost = makeInterfaceCase({
    fill: (i) => (i + 1) * 10 + i * 20,
    quantity: 'Congestion Cost ($)',
    unit: '$',
  });
  const costed = drawInterface(cost, { groupBy: INTERFACE_GROUP_BY, value: 'West Boundary' });
  assert.equal(costed.values[0], -30, 'the direction is applied as written');
  assert.ok(
    costed.warnings.some((w) => /not directional/.test(w) && /subtract/.test(w)),
    'and the warning says what is happening',
  );
  ok('a reversed member on a non-directional quantity subtracts, and the series says so');

  // An intensive quantity refuses the whole boundary, by class.
  const intensive = makeInterfaceCase({ quantity: 'Shadow Price ($/MWh)', unit: '$/MWh' });
  const refused = drawInterface(intensive, {
    groupBy: INTERFACE_GROUP_BY,
    value: 'West Boundary',
  });
  assert.equal(refused.values, null);
  assert.match(refused.refusal, /\$\/MWh/);
  ok('an intensive quantity refuses a boundary by class, as the other kinds do');

  clearInterfaceGroups();
}

{
  // Refusal for absent plane vs not retained
  const data = makeInterfaceCase({ absent: ['P02'] });
  const absent = drawInterface(data, { entity: 'P02' });
  assert.equal(absent.values, null);
  assert.match(absent.refusal, /has no data/);
  ok('an absent plane produces buildSeries refusal for Interface');

  const narrow = makeInterfaceCase({
    interfaces: ['P01'],
    sourceColumns: ['P01', 'P02'],
  });
  const notRetained = drawInterface(narrow, { entity: 'P02' });
  assert.equal(notRetained.values, null);
  assert.match(notRetained.refusal, /was not retained at load/);
  ok('an unretained interface produces buildSeries refusal for Interface');
}

// ------------------------------------------------------------- stack overlap check
{
  const genCsv = [
    'GENERATORLIST,,,,,',
    'Note!!!,,,,,,',
    'Name,Bus ID,Area Name,FuelType,PSSEMaxCap(MW),PSSEMinCap(MW)',
    'GEN_A,101,North,Solar,100,0',
    'GEN_B,102,South,Wind,50,0',
  ].join('\n');
  const busCsv = [
    'BUS_GENERAL,,,,,,,,,,,',
    'BusID,Name,BaseKV,Type,VM,VA,Latitude,Longitude,Monitored,LoadArea,PSSEArea,PSSEZone',
    '101,BUS_A,230,1,1.02,0,44.5,-121.5,TRUE,North,A1,Z1',
    '102,BUS_B,230,1,1.02,0,44.5,-121.5,TRUE,South,A1,Z1',
  ].join('\n');
  const lookups = new Map([
    ['generatorlist', buildLookup(parseLookupCsv(genCsv, 'GeneratorList.csv').rows)],
    ['buslist', buildLookup(parseLookupCsv(busCsv, 'BusList.csv').rows)],
  ]);

  const northArea = {
    name: 'Base Case · North · Generation (MWh)',
    unit: 'MWh',
    spec: {
      caseId: 'case-1',
      source: { kind: 'area', quantity: 'Generation (MWh)' },
      subject: { entity: 'North' },
    },
  };
  const southArea = {
    name: 'Base Case · South · Generation (MWh)',
    unit: 'MWh',
    spec: {
      caseId: 'case-1',
      source: { kind: 'area', quantity: 'Generation (MWh)' },
      subject: { entity: 'South' },
    },
  };
  const genA = {
    name: 'Base Case · GEN_A · Generation (MWh)',
    unit: 'MWh',
    spec: {
      caseId: 'case-1',
      source: { kind: 'generator', quantity: 'Generation (MWh)' },
      subject: { entity: 'GEN_A' },
    },
  };
  const genB = {
    name: 'Base Case · GEN_B · Generation (MWh)',
    unit: 'MWh',
    spec: {
      caseId: 'case-1',
      source: { kind: 'generator', quantity: 'Generation (MWh)' },
      subject: { entity: 'GEN_B' },
    },
  };
  const busA = {
    name: 'Base Case · 101 · Generation (MWh)',
    unit: 'MWh',
    spec: {
      caseId: 'case-1',
      source: { kind: 'bus', quantity: 'Generation (MWh)' },
      subject: { entity: '101' },
    },
  };
  const busB = {
    name: 'Base Case · 102 · Generation (MWh)',
    unit: 'MWh',
    spec: {
      caseId: 'case-1',
      source: { kind: 'bus', quantity: 'Generation (MWh)' },
      subject: { entity: '102' },
    },
  };

  // 1. Disjoint series
  assert.equal(checkStackOverlap([northArea, southArea], lookups), null);
  assert.equal(checkStackOverlap([genA, genB], lookups), null);
  assert.equal(checkStackOverlap([northArea, genB], lookups), null);
  assert.equal(checkStackOverlap([northArea, busB], lookups), null);
  ok('checkStackOverlap returns null for disjoint series');

  // 2. Duplicate series
  assert.equal(
    checkStackOverlap([genA, genA], lookups),
    'Base Case · GEN_A · Generation (MWh) is selected twice; a stack would count it twice',
  );
  ok('checkStackOverlap flags duplicate series in same case');

  // 3. Area contains Generator
  assert.equal(
    checkStackOverlap([northArea, genA], lookups),
    'North (area) contains GEN_A; a stack would count it twice',
  );
  ok('checkStackOverlap flags area containing generator');

  // 4. Area contains Bus
  assert.equal(
    checkStackOverlap([northArea, busA], lookups),
    'North (area) contains 101; a stack would count it twice',
  );
  ok('checkStackOverlap flags area containing bus');

  // 4b. Area contains a GROUPED bus. Buses combine now, so a bus group is a
  // set of buses and the area over it double-counts exactly as the area over
  // one bus does. Bucketed by PSSEZone, which holds both fixture buses.
  const busZone = {
    name: 'Base Case · Z1 · Generation (MWh)',
    unit: 'MWh',
    spec: {
      caseId: 'case-1',
      source: { kind: 'bus', quantity: 'Generation (MWh)' },
      subject: { groupBy: 'PSSEZone', value: 'Z1' },
    },
  };
  assert.match(checkStackOverlap([northArea, busZone], lookups), /contains bus 101 in group "Z1"/);
  // A frozen member set narrows it the same way the sums do: with 101 kept
  // out of the pin, the North area no longer contains anything drawn.
  const busZoneFrozen = {
    ...busZone,
    spec: { ...busZone.spec, subject: { groupBy: 'PSSEZone', value: 'Z1', members: [102] } },
  };
  assert.equal(checkStackOverlap([northArea, busZoneFrozen], lookups), null);
  assert.match(
    checkStackOverlap([southArea, busZoneFrozen], lookups),
    /contains bus 102 in group "Z1"/,
  );
  ok('checkStackOverlap flags an area containing a grouped bus, and follows a frozen member set');

  // 5. Area and Gen/Bus in different cases
  const genAOtherCase = {
    ...genA,
    spec: { ...genA.spec, caseId: 'case-2' },
  };
  const busAOtherCase = {
    ...busA,
    spec: { ...busA.spec, caseId: 'case-2' },
  };
  assert.equal(checkStackOverlap([northArea, genAOtherCase], lookups), null);
  assert.equal(checkStackOverlap([northArea, busAOtherCase], lookups), null);
  ok('checkStackOverlap allows area and contained generator/bus across different cases');

  // 6. Area contains generator through Grouped Generator series
  const genGroupSolar = {
    name: 'Base Case · Solar · Generation (MWh)',
    unit: 'MWh',
    spec: {
      caseId: 'case-1',
      source: { kind: 'generator', quantity: 'Generation (MWh)' },
      subject: { groupBy: 'FuelType', value: 'Solar' },
    },
  };
  // GEN_A is Solar and is in North area!
  assert.equal(
    checkStackOverlap([northArea, genGroupSolar], lookups),
    'North (area) contains GEN_A in group "Solar"; a stack would count it twice',
  );
  ok('checkStackOverlap flags area containing generator from grouped generator series');

  // 7. Grouped Area contains Generator
  // Set groupings: Zone 1 -> North
  setGroupings('Name,Grouping\nNorth,Zone 1\n');
  const zoneArea = {
    name: 'Base Case · Zone 1 · Generation (MWh)',
    unit: 'MWh',
    spec: {
      caseId: 'case-1',
      source: { kind: 'area', quantity: 'Generation (MWh)' },
      subject: { groupBy: 'grouping', value: 'Zone 1' },
    },
  };
  assert.equal(
    checkStackOverlap([zoneArea, genA], lookups),
    'Zone 1 (area) contains GEN_A; a stack would count it twice',
  );
  ok('checkStackOverlap flags grouped area containing generator');

  // 8. A frozen member set narrows overlap both ways, so legal stacks are not
  // refused.
  const solarWithoutA = {
    ...genGroupSolar,
    spec: {
      ...genGroupSolar.spec,
      subject: { ...genGroupSolar.spec.subject, members: ['GEN_B'] },
    },
  };
  assert.equal(checkStackOverlap([northArea, solarWithoutA], lookups), null);
  const solarWithA = {
    ...genGroupSolar,
    spec: {
      ...genGroupSolar.spec,
      subject: { ...genGroupSolar.spec.subject, members: ['GEN_A'] },
    },
  };
  assert.equal(
    checkStackOverlap([northArea, solarWithA], lookups),
    'North (area) contains GEN_A in group "Solar"; a stack would count it twice',
  );
  const zoneWithoutNorth = {
    ...zoneArea,
    spec: {
      ...zoneArea.spec,
      subject: { ...zoneArea.spec.subject, members: ['South'] },
    },
  };
  assert.equal(checkStackOverlap([zoneWithoutNorth, genA], lookups), null);
  ok(
    'the overlap test follows a frozen member set: a unit kept out of the pin cannot double-count',
  );

  // 9. Groups no list column answers for (injection group, bus group, derived
  // fuel): overlap learns their members from what the RESOLVER summed, so
  // they are built through the real resolvers.
  attachLookup(parseLookupCsv(genCsv, 'GeneratorList.csv').rows);
  attachLookup(parseLookupCsv(busCsv, 'BusList.csv').rows);
  const fleet = makeCase({ generators: ['GEN_A', 'GEN_B'] });
  const genSeries = (subject) => ({
    ...draw(fleet, subject),
    name: `Base Case · ${subject.value}`,
  });
  setGeneratorMembership(new Map([['Northern', ['GEN_A']]]));
  const injection = genSeries({ groupBy: GENERATOR_GROUP_BY, value: 'Northern' });
  assert.deepEqual(injection.summed, ['GEN_A'], 'the resolver hands on what it summed');
  assert.equal(
    checkStackOverlap([northArea, injection], lookups),
    'North (area) contains GEN_A in group "Northern"; a stack would count it twice',
  );
  assert.equal(checkStackOverlap([southArea, injection], lookups), null);
  const injectionFrozen = genSeries({
    groupBy: GENERATOR_GROUP_BY,
    value: 'Northern',
    members: ['GEN_B'],
  });
  assert.equal(checkStackOverlap([northArea, injectionFrozen], lookups), null);
  assert.match(checkStackOverlap([southArea, injectionFrozen], lookups), /contains GEN_B/);
  clearGeneratorGroups();

  const fuel = derivedAttribute('Fuel Type (Cleaned)');
  const genList = buildLookup(parseLookupCsv(genCsv, 'GeneratorList.csv').rows);
  const solarClean = fuel.labelOf((column) => bucketLabelFor('GEN_A', genList, column));
  const cleaned = genSeries({ groupBy: 'Fuel Type (Cleaned)', value: solarClean });
  assert.match(checkStackOverlap([northArea, cleaned], lookups), /contains GEN_A in group/);

  const busLoad = makeBusCase({ buses: [101, 102], quantity: 'Load (MWh)' });
  const busSeries = (subject) => ({
    ...drawBus(busLoad, subject),
    name: `Base Case · ${subject.value}`,
  });
  setBusMembership(new Map([['Northern', [101]]]));
  const busGroup = busSeries({ groupBy: BUS_GROUP_BY, value: 'Northern' });
  assert.equal(
    checkStackOverlap([northArea, busGroup], lookups),
    'North (area) contains bus 101 in group "Northern"; a stack would count it twice',
  );
  assert.equal(checkStackOverlap([southArea, busGroup], lookups), null);
  const busGroupFrozen = busSeries({ groupBy: BUS_GROUP_BY, value: 'Northern', members: [102] });
  assert.equal(checkStackOverlap([northArea, busGroupFrozen], lookups), null);
  assert.match(checkStackOverlap([southArea, busGroupFrozen], lookups), /contains bus 102/);
  clearBusGroups();
  clearLookups();
  ok(
    'an area over a user-authored generator or bus group, or a derived fuel, inside it is refused',
  );
}

console.log(`\n${checks} checks passed.`);

// ------------------------------------------------------- the stacking order
//
// Largest total at the bottom (tested here: the pane cannot load in Node).
{
  const series = (name, values) => ({
    name,
    values: Float32Array.from(values),
    unit: 'MWh',
    color: '#000',
  });
  const small = series('small', [1, 1, 1]);
  const big = series('big', [10, 10, 10]);
  const middle = series('middle', [5, 5, 5]);

  assert.deepEqual(
    stackOrder([small, big, middle]).map((s) => s.name),
    ['big', 'middle', 'small'],
  );
  // The caller's own order is never disturbed: it is the legend, the colours
  // and what the user ticked.
  assert.deepEqual(
    [small, big, middle].map((s) => s.name),
    ['small', 'big', 'middle'],
  );

  // TOTAL, not peak. A spiky series that adds up to less sits ABOVE a flat
  // one that adds up to more, so the picture agrees with the numbers beside
  // it.
  const spiky = series('spiky', [0, 0, 9]);
  const flat = series('flat', [4, 4, 4]);
  assert.deepEqual(
    stackOrder([spiky, flat]).map((s) => s.name),
    ['flat', 'spiky'],
  );

  // A filtered hour is skipped rather than poisoning the total, so a series
  // is ranked on what it actually contributes to the stack.
  const filtered = series('filtered', [Number.NaN, 8, Number.NaN]);
  assert.deepEqual(
    stackOrder([small, filtered]).map((s) => s.name),
    ['filtered', 'small'],
  );

  // Equal totals keep the selection order -- stable, so two cases of one
  // fleet stack alike instead of swapping bands on a rounding difference.
  const tieA = series('tie-a', [2, 2]);
  const tieB = series('tie-b', [2, 2]);
  assert.deepEqual(
    stackOrder([tieB, tieA]).map((s) => s.name),
    ['tie-b', 'tie-a'],
  );

  // A refused series carries no values and ranks last rather than throwing.
  assert.deepEqual(
    stackOrder([{ name: 'refused', values: null, unit: 'MWh' }, small]).map((s) => s.name),
    ['small', 'refused'],
  );

  ok('stackOrder puts the largest total on the bottom, by total and stably');
}
