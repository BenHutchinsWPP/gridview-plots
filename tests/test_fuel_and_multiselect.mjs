// tests/test_fuel_and_multiselect.mjs
//
// Tests for canonical fuel categorization (including separate Pumped Storage),
// semantic fuel palettes, and multi-token text filtering across browse columns.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './test_loader.mjs';

const fuel = await import('../src/tables/generator/fuel.ts');
const { classifyFuel } = fuel;
const { createSelection, filterConstraint, visibleRows } =
  await import('../src/ui/browse-model.ts');

const checks = [];
const ok = (name) => checks.push(name);

// -------------------------------------------------- 1. Fuel Classification
// Pumped Storage precedence before Hydro and Battery Storage
assert.equal(classifyFuel('PSH'), 'Pumped Storage');
assert.equal(classifyFuel('PS'), 'Pumped Storage');
assert.equal(classifyFuel('Pumped Storage'), 'Pumped Storage');
assert.equal(classifyFuel('Pumped Hydro'), 'Pumped Storage');
assert.equal(classifyFuel('Hydro Pump'), 'Pumped Storage');
assert.equal(classifyFuel('Reversible Hydro'), 'Pumped Storage');
assert.equal(classifyFuel('Helms Pump Storage'), 'Pumped Storage');

// Battery Storage
assert.equal(classifyFuel('BESS'), 'Battery Storage');
assert.equal(classifyFuel('Battery'), 'Battery Storage');
assert.equal(classifyFuel('Battery Storage'), 'Battery Storage');
assert.equal(classifyFuel('Storage'), 'Battery Storage');
assert.equal(classifyFuel('Li-Ion'), 'Battery Storage');
assert.equal(classifyFuel('Lithium Ion ES'), 'Battery Storage');
// A FuelType of exactly `MWh` is storage (the model writes the unit there);
// a suffix does not count.
assert.equal(classifyFuel('MWh'), 'Battery Storage');
assert.equal(classifyFuel('mwh'), 'Battery Storage');
assert.equal(classifyFuel('  MWh  '), 'Battery Storage');
assert.equal(classifyFuel('Nat Gas MWh'), 'Natural Gas');
assert.equal(classifyFuel('MW'), 'Other');

// Conventional Hydro
assert.equal(classifyFuel('Hydro'), 'Hydro');
assert.equal(classifyFuel('WAT'), 'Hydro');
assert.equal(classifyFuel('Water'), 'Hydro');
assert.equal(classifyFuel('Run-of-River'), 'Hydro');
assert.equal(classifyFuel('ROR Hydro'), 'Hydro');

// Solar
assert.equal(classifyFuel('Solar'), 'Solar');
assert.equal(classifyFuel('Solar PV'), 'Solar');
assert.equal(classifyFuel('PV'), 'Solar');
assert.equal(classifyFuel('Sun Power'), 'Solar');
assert.equal(classifyFuel('Photovoltaic'), 'Solar');

// Wind
assert.equal(classifyFuel('Wind'), 'Wind');
assert.equal(classifyFuel('WND'), 'Wind');
assert.equal(classifyFuel('WTG'), 'Wind');

// Natural Gas variants
assert.equal(classifyFuel('NatGas'), 'Natural Gas');
assert.equal(classifyFuel('Nat Gas'), 'Natural Gas');
assert.equal(classifyFuel('Natural Gas'), 'Natural Gas');
assert.equal(classifyFuel('Gas'), 'Natural Gas');
assert.equal(classifyFuel('Ng'), 'Natural Gas');
assert.equal(classifyFuel('GAS'), 'Natural Gas');
assert.equal(classifyFuel('Combined Cycle'), 'Natural Gas');
assert.equal(classifyFuel('CC'), 'Natural Gas');
assert.equal(classifyFuel('CT Gas'), 'Natural Gas');
assert.equal(classifyFuel('Steam Gas'), 'Natural Gas');

// Other thermal & renewables
assert.equal(classifyFuel('Nuclear'), 'Nuclear');
assert.equal(classifyFuel('NUC'), 'Nuclear');
assert.equal(classifyFuel('Coal'), 'Coal');
assert.equal(classifyFuel('Lignite Coal'), 'Coal');
assert.equal(classifyFuel('Geothermal'), 'Geothermal');
assert.equal(classifyFuel('GEO'), 'Geothermal');
assert.equal(classifyFuel('Biomass'), 'Biomass');
assert.equal(classifyFuel('Biogas'), 'Biomass');
assert.equal(classifyFuel('Wood Waste'), 'Biomass');
assert.equal(classifyFuel('Diesel'), 'Oil / Distillate');
assert.equal(classifyFuel('FO #2'), 'Oil / Distillate');

// Fallbacks
assert.equal(classifyFuel(''), 'Other');
assert.equal(classifyFuel(null), 'Other');
assert.equal(classifyFuel(undefined), 'Other');
assert.equal(classifyFuel('Unknown Exotic'), 'Other');

ok('classifyFuel maps raw model strings to canonical categories with Pumped Storage isolated');

// ------------------------------------------ 2b. Cleaned fuel and fuel group
//
// `reader` is the app's real column-reader call.
const { CLEAN_FUELS, FUEL_GROUPS, cleanFuel, fuelGroupOf } = fuel;
// The vocabulary is DATA. This is the file the domain owner edits, and the
// assertion that this suite is testing what the app actually loads.
const groupings = JSON.parse(
  readFileSync(new URL('../data/generator/fuel-groupings.json', import.meta.url), 'utf8'),
);
const declared = groupings.fuels.map((entry) => entry.clean);
assert.deepEqual(CLEAN_FUELS.slice(0, declared.length), declared);
assert.deepEqual(CLEAN_FUELS.slice(declared.length), ['Unlisted', 'Unknown', 'Unrecognised']);
{
  const seen = new Set();
  for (const entry of groupings.fuels) {
    for (const spelling of entry.spellings) {
      assert.equal(spelling, spelling.trim().toLowerCase(), `"${spelling}" is normalised`);
      assert.equal(seen.has(spelling), false, `"${spelling}" is claimed once`);
      seen.add(spelling);
      // Every spelling in the file resolves to its own entry: a spelling the
      // pattern cascade would catch FIRST is a line that does nothing.
      assert.equal(
        cleanFuel(() => spelling),
        entry.clean,
        `"${spelling}" resolves to its entry`,
      );
    }
  }
}
const reader = (row) => (column) => row[column] ?? '';
const cleanOf = (row) => cleanFuel(reader(row));
const groupOf = (row) => fuelGroupOf(cleanFuel(reader(row)));

// The mapping sheet's own spellings, under standard names.
assert.equal(cleanOf({ FuelType: 'BIT' }), 'Bituminous Coal');
assert.equal(cleanOf({ FuelType: 'SUB' }), 'Coal');
assert.equal(cleanOf({ FuelType: 'RC' }), 'Coal');
assert.equal(cleanOf({ FuelType: 'BLQ' }), 'Black Liquor');
assert.equal(cleanOf({ FuelType: 'OBG' }), 'Biomass');
assert.equal(cleanOf({ FuelType: 'DFO' }), 'Distillate Fuel Oil');
assert.equal(cleanOf({ FuelType: 'LFG' }), 'Landfill Gas');
assert.equal(cleanOf({ FuelType: 'WH' }), 'Waste Heat');
assert.equal(cleanOf({ FuelType: 'WT' }), 'Wind');
assert.equal(cleanOf({ FuelType: 'PV-NT' }), 'Solar');
assert.equal(cleanOf({ FuelType: 'HY' }), 'Hydro');
assert.equal(cleanOf({ FuelType: 'MWH' }), 'Battery Storage');
assert.equal(cleanOf({ FuelType: 'Electricity' }), 'Battery Storage');
// The domain owner's own renamings: Sun is Solar and Water is Hydro here.
assert.equal(cleanOf({ FuelType: 'Sun' }), 'Solar');
assert.equal(cleanOf({ FuelType: 'Water' }), 'Hydro');
// WDS is corrected from the domain owner's Water to Biomass (wood solids).
// If the sheet is right after all, this and fuel-groupings.json change
// together.
assert.equal(cleanOf({ FuelType: 'WDS' }), 'Biomass');
// Hydrogen is its own fuel and is NOT water. `hydro` is a substring rule, so
// this is the one that goes wrong silently if the order in fuel.ts slips.
assert.equal(cleanOf({ FuelType: 'Hydrogen' }), 'Hydrogen');
assert.equal(cleanOf({ FuelType: 'H2' }), 'Hydrogen');
assert.equal(classifyFuel('Hydrogen'), 'Hydrogen');
assert.equal(classifyFuel('H2'), 'Hydrogen');
assert.equal(classifyFuel('Hydro'), 'Hydro');
// The EIA short codes the fleet is actually written in, which the broad
// classifier never knew.
assert.equal(cleanOf({ FuelType: 'LIG' }), 'Coal');
assert.equal(cleanOf({ FuelType: 'RFO' }), 'Residual Fuel Oil');
assert.equal(cleanOf({ FuelType: 'MSW' }), 'Biomass');
assert.equal(cleanOf({ FuelType: 'PC' }), 'Petroleum Coke');
assert.equal(cleanOf({ FuelType: 'LNG' }), 'Natural Gas');

// FuelType is primary; Technology and SubType answer for the units it leaves
// blank. `NA` is blank, which is the case the sample export actually has.
assert.equal(cleanOf({ FuelType: 'NA', Technology: 'Sun' }), 'Solar');
assert.equal(cleanOf({ FuelType: '', Technology: '', SubType: 'PV-Tracking' }), 'Solar');
assert.equal(cleanOf({ FuelType: 'NG', Technology: 'Water' }), 'Natural Gas');
// THREE WAYS TO NOT KNOW, each with its own fix. Every fuel column saying
// `(unlisted)` is what proves the generator (not a column) is missing.
assert.equal(
  cleanFuel(() => '(unlisted)'),
  'Unlisted',
);
// One column saying it proves nothing: a list with FuelType and no Technology
// column reports `(unlisted)` for Technology on every unit it holds.
assert.equal(cleanOf({ FuelType: 'BIT', Technology: '(unlisted)' }), 'Bituminous Coal');
assert.equal(cleanOf({ FuelType: '(blank)', Technology: '(unlisted)' }), 'Unknown');
assert.equal(cleanOf({ FuelType: '(blank)' }), 'Unknown');
assert.equal(cleanOf({ FuelType: 'NA', Technology: '', SubType: '' }), 'Unknown');
assert.equal(cleanOf({}), 'Unknown');
assert.equal(cleanOf({ FuelType: 'Unobtainium' }), 'Unrecognised');
assert.equal(fuelGroupOf('Unrecognised'), 'Unrecognised');
assert.equal(fuelGroupOf('Unlisted'), 'Unlisted');

// Pumped storage wins over the primary column, from any of its markers.
assert.equal(cleanOf({ FuelType: 'HY', SubType: 'PumpedStorage' }), 'Pumped Storage');
assert.equal(cleanOf({ FuelType: 'Water', Technology: 'PS-Hydro' }), 'Pumped Storage');
assert.equal(
  cleanOf({ FuelType: 'HY', Name: 'Lake Hodges Pumped Storage Unit 2 PS' }),
  'Pumped Storage',
);
// A NAME is held to the stronger marker: two letters between spaces in a unit
// name are as likely to be a site's initials as a technology.
assert.equal(cleanOf({ FuelType: 'HY', Name: 'Priest Rapids PS 2' }), 'Hydro');
// And a name is never read for a FUEL. A plant called Sunbright is not solar.
assert.equal(cleanOf({ FuelType: '', Name: 'Sunbright Coal 3' }), 'Unknown');

// The five buckets, plus the Unknown that says the file named no fuel.
assert.equal(groupOf({ FuelType: 'PV' }), 'Solar');
assert.equal(groupOf({ FuelType: 'WT' }), 'Wind');
assert.equal(groupOf({ FuelType: 'HY' }), 'Hydro');
assert.equal(groupOf({ FuelType: 'BA' }), 'Storage');
assert.equal(groupOf({ FuelType: 'BIT' }), 'Thermal');
assert.equal(groupOf({ FuelType: 'Nuclear' }), 'Thermal');
assert.equal(groupOf({ FuelType: 'Geo' }), 'Thermal');
assert.equal(groupOf({ FuelType: 'NA' }), 'Unknown');
assert.equal(groupOf({ FuelType: 'Hydrogen' }), 'Thermal');
// Pumped storage is STORAGE and never Hydro -- the split the fleet's owner
// asked for, and the reason the two columns are not one.
assert.equal(groupOf({ FuelType: 'HY', SubType: 'PumpedStorage' }), 'Storage');

// Every cleaned fuel has a group, and every group is reachable: a category
// with no bucket would drop units out of the simple column with nothing said.
const reached = new Set(CLEAN_FUELS.map((clean) => fuelGroupOf(clean)));
assert.deepEqual([...reached].sort(), [...FUEL_GROUPS].sort());

ok('cleanFuel reads FuelType then Technology then SubType, with pumped storage decided first');

// ------------------------------------------------- 2c. The derived registry
//
// All fuel columns resolve through one registry, by label AND by key.
const derived = await import('../src/tables/generator/derived.ts');
const { GENERATOR_DERIVED, derivedAttribute } = derived;
assert.deepEqual(
  GENERATOR_DERIVED.map((attribute) => attribute.label),
  ['Fuel Type (Cleaned)', 'Fuel Group'],
);
// The retired broad column resolves to its successor, so a view saved against
// it opens rather than silently dropping its grouping.
for (const retired of ['Fuel Category', 'fuelCategory', 'FuelCategory']) {
  assert.equal(derivedAttribute(retired)?.key, 'fuelClean', `${retired} resolves to its successor`);
}
for (const attribute of GENERATOR_DERIVED) {
  assert.equal(
    derivedAttribute(attribute.label),
    attribute,
    `${attribute.label} resolves by label`,
  );
  assert.equal(derivedAttribute(attribute.key), attribute, `${attribute.label} resolves by key`);
  // Every value a grouped tab seeds its rows with has a colour, or a line
  // appears in the drawer with no swatch and the chart picks one at random.
  for (const value of attribute.values) {
    assert.ok(attribute.color(value), `${attribute.label} has a colour for ${value}`);
  }
  // The registry's own reader path, end to end.
  assert.ok(attribute.values.includes(attribute.labelOf(() => '')));
}
assert.equal(derivedAttribute('Area Name'), undefined);
assert.equal(
  GENERATOR_DERIVED[0].labelOf(reader({ FuelType: 'NA', Technology: 'PS-Hydro' })),
  'Pumped Storage',
);
assert.equal(GENERATOR_DERIVED[1].labelOf(reader({ FuelType: 'BIT' })), 'Thermal');

ok('the derived fuel attributes resolve by label and by key, and every value carries a colour');

// -------------------------------------------------- 3. Multi-token text filtering
const testRows = [
  { caseId: 'c1', slotKey: 's1', entity: 'G1', area: 'AREA_CA-AREA_PG' },
  { caseId: 'c1', slotKey: 's1', entity: 'G2', area: 'AREA_CA-AREA_SC' },
  { caseId: 'c1', slotKey: 's1', entity: 'G3', area: 'AREA_CA-SDGE' },
  { caseId: 'c1', slotKey: 's1', entity: 'G4', area: 'LADWP' },
  { caseId: 'c1', slotKey: 's1', entity: 'G5', area: 'AREA_PA' },
  { caseId: 'c1', slotKey: 's1', entity: 'G6', area: 'AREA_NV' },
  { caseId: 'c1', slotKey: 's1', entity: 'G7', area: 'SMUD' },
];

const mockTab = {
  id: 'test',
  label: 'Test Tab',
  rows: testRows,
  columns: [
    {
      key: 'entity',
      label: 'Unit',
      kind: 'text',
      computed: false,
      value: (r) => testRows[r].entity,
    },
    { key: 'area', label: 'Area', kind: 'text', computed: false, value: (r) => testRows[r].area },
  ],
  notes: [],
};

// Single filter
const singleView = {
  sort: null,
  filters: new Map([['area', { kind: 'text', text: 'AREA_PG' }]]),
};
const singleResult = visibleRows(mockTab, singleView);
assert.equal(singleResult.length, 1);
assert.equal(testRows[singleResult[0]].area, 'AREA_CA-AREA_PG');

// Comma-separated multi-select (e.g. 3 areas)
const multiView = {
  sort: null,
  filters: new Map([['area', { kind: 'text', text: 'AREA_PG, AREA_SC, LADWP' }]]),
};
const multiResult = visibleRows(mockTab, multiView);
assert.equal(multiResult.length, 3);
const matchedAreas = [...multiResult].map((r) => testRows[r].area).sort();
assert.deepEqual(matchedAreas, ['AREA_CA-AREA_PG', 'AREA_CA-AREA_SC', 'LADWP']);

// Constraint text formatting
assert.equal(filterConstraint({ kind: 'text', text: 'AREA_PG' }), 'contains AREA_PG');
assert.equal(
  filterConstraint({ kind: 'text', text: 'AREA_PG, AREA_SC, SDGE' }),
  'contains any of (AREA_PG, AREA_SC, SDGE)',
);

ok('multi-token text filtering matches across comma and newline separated tokens');

// A tick is exact: the name it names and no name that merely starts with it,
// and a comma inside a name does not split it.
{
  const rows = [
    { caseId: 'c1', slotKey: 's1', entity: 'SAMPLE_DAM' },
    { caseId: 'c1', slotKey: 's1', entity: 'SAMPLE_DAM: Pump 1' },
    { caseId: 'c1', slotKey: 's1', entity: 'SAMPLE_DAM: Pump 2' },
    { caseId: 'c1', slotKey: 's1', entity: 'SAMPLE_PLANT, UNIT 1' },
    { caseId: 'c1', slotKey: 's1', entity: 'SAMPLE_PLANT' },
  ];
  const tab = {
    id: 'exact',
    label: 'Exact',
    rows,
    columns: [
      { key: 'name', label: 'Name', kind: 'text', computed: false, value: (r) => rows[r].entity },
    ],
    notes: [],
  };
  const kept = (filter) =>
    [...visibleRows(tab, { sort: null, filters: new Map([['name', filter]]) })].map(
      (r) => rows[r].entity,
    );
  assert.deepEqual(kept({ kind: 'text', text: 'SAMPLE_DAM' }), [
    'SAMPLE_DAM',
    'SAMPLE_DAM: Pump 1',
    'SAMPLE_DAM: Pump 2',
  ]);
  assert.deepEqual(kept({ kind: 'values', values: ['SAMPLE_DAM'] }), ['SAMPLE_DAM']);
  assert.deepEqual(kept({ kind: 'values', values: ['SAMPLE_PLANT, UNIT 1'] }), [
    'SAMPLE_PLANT, UNIT 1',
  ]);
  assert.deepEqual(kept({ kind: 'values', values: ['sample_dam'] }), []);
  assert.equal(filterConstraint({ kind: 'values', values: ['SAMPLE_DAM'] }), 'is SAMPLE_DAM');
  assert.equal(
    filterConstraint({ kind: 'values', values: ['SAMPLE_DAM', 'SAMPLE_PLANT'] }),
    'is any of (SAMPLE_DAM, SAMPLE_PLANT)',
  );
  ok('a ticked value filter keeps exactly the ticked names');
}

// -------------------------------------------------- 4. Selection with semantic colors
// The resolver main.ts installs, verbatim in shape: every derived attribute
// carries its own palette, and a retired name reaches its successor's.
const selection = createSelection(undefined, (ref) =>
  ref.groupBy ? derivedAttribute(ref.groupBy)?.color(ref.groupValue ?? ref.entity) : undefined,
);

const solarRef = {
  id: 'c1 | s1 | Fuel Type (Cleaned)=Solar',
  kind: 'generator',
  caseId: 'c1',
  caseName: 'Base',
  slotKey: 'gen',
  entity: 'Solar',
  variable: 'Generation',
  unit: 'MW',
  axisIndex: -1,
  groupBy: 'Fuel Type (Cleaned)',
  groupValue: 'Solar',
};

const pumpedRef = {
  id: 'c1 | s1 | Fuel Type (Cleaned)=Pumped Storage',
  kind: 'generator',
  caseId: 'c1',
  caseName: 'Base',
  slotKey: 'gen',
  entity: 'Pumped Storage',
  variable: 'Generation',
  unit: 'MW',
  axisIndex: -1,
  groupBy: 'Fuel Type (Cleaned)',
  groupValue: 'Pumped Storage',
};

const gasRef = {
  id: 'c1 | s1 | Fuel Category=Natural Gas',
  kind: 'generator',
  caseId: 'c1',
  caseName: 'Base',
  slotKey: 'gen',
  entity: 'Natural Gas',
  variable: 'Generation',
  unit: 'MW',
  axisIndex: -1,
  groupBy: 'Fuel Category',
  groupValue: 'Natural Gas',
};

selection.pin(solarRef);
selection.pin(pumpedRef);
selection.pin(gasRef);

assert.equal(selection.colorOf(solarRef.id), '#f1c40f', 'Solar receives gold color');
assert.equal(
  selection.colorOf(pumpedRef.id),
  '#3f51b5',
  'Pumped Storage receives deep indigo color',
);
// gasRef names the RETIRED column, as an older saved view does. It is
// coloured by its successor column, not by the palette's next free colour.
assert.equal(gasRef.groupBy, 'Fuel Category');
assert.equal(selection.colorOf(gasRef.id), '#e67e22', 'Natural Gas receives flame orange color');

ok('a pinned group is coloured by its attribute, including one saved against the retired name');

for (const c of checks) {
  console.log(`ok - ${c}`);
}
