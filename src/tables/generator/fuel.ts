// src/tables/generator/fuel.ts
//
// What a generator BURNS, at two depths, from attribute columns that disagree.
// The same fleet arrives as "BIT", "Bituminous Coal" and "NA with Technology =
// Sun", and stacking those as three fuels is wrong with no error. So: a
// spelling table, then a pattern cascade for spellings it has not met, reading
// FuelType, then Technology, then SubType.
//
// The VOCABULARY is the domain owner's list, in
// `data/generator/fuel-groupings.json`, so it changes without a code change.
// The cleaned fuel keeps every distinction it draws; `fuelGroupOf` collapses
// it to five buckets. The broad `classifyFuel` cascade is only the fallback
// for spellings the file has not met.

import groupingsData from '../../../data/generator/fuel-groupings.json' with { type: 'json' };

export const FUEL_CATEGORIES = [
  'Solar',
  'Wind',
  'Battery Storage',
  'Pumped Storage',
  'Hydro',
  'Hydrogen',
  'Natural Gas',
  'Nuclear',
  'Coal',
  'Geothermal',
  'Biomass',
  'Oil / Distillate',
  'Other',
] as const;

export type FuelCategory = (typeof FUEL_CATEGORIES)[number];

const OTHER_COLOR = '#7f8c8d';

// Precedence: Pumped Storage before Hydro and Battery Storage ("Pumped Hydro",
// "PSH"), and Battery Storage before Hydro.
const PUMPED_STORAGE_REGEX =
  /(?:^|[^a-z0-9])(?:psh|ps|ph)(?:$|[^a-z0-9])|pumped|pump\s*storage|hydro\s*pump|reversible/i;
const BATTERY_STORAGE_REGEX =
  /(?:^|[^a-z0-9])(?:bess|es)(?:$|[^a-z0-9])|batter|li-ion|lithium|flywheel|electrochemical|storage/i;
/**
 * A FuelType of exactly `MWh` is a BATTERY STORAGE unit: the model writes the
 * storage quantity's unit instead of a fuel (the domain owner's rule).
 * Anchored to the whole cell: `Nat Gas MWh` is a gas unit.
 */
const STORAGE_UNIT_AS_FUEL_REGEX = /^mwh$/i;
const SOLAR_REGEX = /(?:^|[^a-z0-9])(?:pv)(?:$|[^a-z0-9])|solar|sun|photovoltaic/i;
const WIND_REGEX = /(?:^|[^a-z0-9])(?:wnd|wtg)(?:$|[^a-z0-9])|wind/i;
/** HYDROGEN IS TESTED BEFORE HYDRO: "hydrogen" contains "hydro", and a
 * hydrogen unit stacked as water is silently wrong. */
const HYDROGEN_REGEX = /hydrogen|(?:^|[^a-z0-9])(?:h2)(?:$|[^a-z0-9])/i;
const HYDRO_REGEX = /(?:^|[^a-z0-9])(?:wat|ror)(?:$|[^a-z0-9])|hydro|water|run-of-river|pondage/i;
const GAS_REGEX =
  /(?:^|[^a-z0-9])(?:ng|natgas|cc|ct|gt|ic)(?:$|[^a-z0-9])|gas|natural\s*gas|methane|combined\s*cycle|combustion\s*turbine|steam\s*gas/i;
const NUCLEAR_REGEX = /(?:^|[^a-z0-9])(?:nuc)(?:$|[^a-z0-9])|nuclear|uranium/i;
const COAL_REGEX = /coal|lignite|sub-bit|anthracite|bituminous/i;
const GEOTHERMAL_REGEX = /(?:^|[^a-z0-9])(?:geo)(?:$|[^a-z0-9])|geothermal/i;
const BIOMASS_REGEX = /bio|biomass|biogas|wood|landfill|refuse/i;
const OIL_REGEX =
  /(?:^|[^a-z0-9])(?:fo|df)(?:$|[^a-z0-9])|oil|diesel|distillate|jet\s*fuel|kerosene/i;

export function classifyFuel(raw: string | number | null | undefined): FuelCategory {
  if (raw === null || raw === undefined) return 'Other';
  const str = String(raw).trim();
  if (!str) return 'Other';

  if (PUMPED_STORAGE_REGEX.test(str)) return 'Pumped Storage';
  if (BATTERY_STORAGE_REGEX.test(str) || STORAGE_UNIT_AS_FUEL_REGEX.test(str))
    return 'Battery Storage';
  if (SOLAR_REGEX.test(str)) return 'Solar';
  if (WIND_REGEX.test(str)) return 'Wind';
  if (GEOTHERMAL_REGEX.test(str)) return 'Geothermal';
  if (BIOMASS_REGEX.test(str)) return 'Biomass';
  if (HYDROGEN_REGEX.test(str)) return 'Hydrogen';
  if (HYDRO_REGEX.test(str)) return 'Hydro';
  if (NUCLEAR_REGEX.test(str)) return 'Nuclear';
  if (COAL_REGEX.test(str)) return 'Coal';
  if (OIL_REGEX.test(str)) return 'Oil / Distillate';
  if (GAS_REGEX.test(str)) return 'Natural Gas';

  return 'Other';
}

// ---------------------------------------------------------------- cleaned fuel
//
// The broad categories above are coarse enough to stack a dispatch chart and
// too coarse to check an export against. The cleaned vocabulary keeps the
// domain owner's distinctions: bituminous apart from other coal, landfill gas
// apart from biomass, black liquor and petroleum coke as themselves.
//
// `Unknown`, `Unlisted` and `Unrecognised` are not fuels and not in the data
// file: they are three different things the file can fail to say, with three
// different remedies, and must not collapse into "Other".
const UNKNOWN_FUELS = ['Unlisted', 'Unknown', 'Unrecognised'] as const;

interface FuelEntry {
  readonly clean: string;
  readonly group: string;
  readonly color: string;
  readonly spellings: readonly string[];
  readonly note?: string;
}

const FUEL_DATA = groupingsData as { fuels: readonly FuelEntry[] };

// ------------------------------------------------------------- fuel groups
//
// The five buckets a fleet is read in. Pumped Storage is STORAGE, never
// Hydro: its generation returns energy bought back, and summing it into Hydro
// double-counts water that never fell. Nuclear, geothermal, hydrogen and waste
// heat are THERMAL: the bucket is how energy reaches the turbine.
const REAL_GROUPS = ['Solar', 'Wind', 'Hydro', 'Storage', 'Thermal'] as const;

export const FUEL_GROUPS = [...REAL_GROUPS, ...UNKNOWN_FUELS] as const;

export type FuelGroup = (typeof FUEL_GROUPS)[number];

/** Every cleaned fuel the data file declares, then the three unknown states,
 * so a grouped tab seeds every row it can show. */
export const CLEAN_FUELS: readonly string[] = [
  ...FUEL_DATA.fuels.map((entry) => entry.clean),
  ...UNKNOWN_FUELS,
];

const CLEAN_BY_SPELLING = new Map<string, string>();
const GROUP_BY_CLEAN = new Map<string, FuelGroup>();
const COLOR_BY_CLEAN = new Map<string, string>();

for (const entry of FUEL_DATA.fuels) {
  // Refuse loudly at load: a duplicate spelling or an unknown group would
  // silently reclassify units.
  if (!(REAL_GROUPS as readonly string[]).includes(entry.group)) {
    throw new Error(
      `fuel-groupings.json: "${entry.clean}" is in group "${entry.group}", which is not one of ` +
        REAL_GROUPS.join(', '),
    );
  }
  GROUP_BY_CLEAN.set(entry.clean, entry.group as FuelGroup);
  COLOR_BY_CLEAN.set(entry.clean, entry.color);
  for (const spelling of entry.spellings) {
    const held = CLEAN_BY_SPELLING.get(spelling);
    if (held !== undefined && held !== entry.clean) {
      throw new Error(
        `fuel-groupings.json: the spelling "${spelling}" is claimed by both "${held}" and ` +
          `"${entry.clean}"`,
      );
    }
    CLEAN_BY_SPELLING.set(spelling, entry.clean);
  }
}
for (const state of UNKNOWN_FUELS) {
  GROUP_BY_CLEAN.set(state, state);
  COLOR_BY_CLEAN.set(state, OTHER_COLOR);
}

/** The cleaned name each broad category falls back to for an unlisted
 * spelling. `Other` has none, which makes it Unrecognised. */
const CLEAN_FROM_CATEGORY: Readonly<Record<FuelCategory, string | null>> = {
  Solar: 'Solar',
  Wind: 'Wind',
  'Battery Storage': 'Battery Storage',
  'Pumped Storage': 'Pumped Storage',
  Hydro: 'Hydro',
  Hydrogen: 'Hydrogen',
  'Natural Gas': 'Natural Gas',
  Nuclear: 'Nuclear',
  Coal: 'Coal',
  Geothermal: 'Geothermal',
  Biomass: 'Biomass',
  'Oil / Distillate': 'Distillate Fuel Oil',
  Other: null,
};
for (const [category, clean] of Object.entries(CLEAN_FROM_CATEGORY)) {
  if (clean !== null && !GROUP_BY_CLEAN.has(clean)) {
    throw new Error(
      `the ${category} fallback names "${clean}", which fuel-groupings.json does not declare`,
    );
  }
}

/**
 * Spellings that mean "this cell says nothing" (`NA`, `(blank)` from the
 * join...), so the fallback to the next column runs. `(unlisted)` is not
 * here: it means no list row at all, which gets its own answer.
 */
const SAYS_NOTHING = new Set(['', 'na', 'n/a', 'none', 'null', 'unknown', '(blank)', '-', '--']);

const UNLISTED = '(unlisted)';

function normalise(raw: string | number | null | undefined): string {
  if (raw === null || raw === undefined) return '';
  const str = String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
  return SAYS_NOTHING.has(str) ? '' : str;
}

/** A pumped marker strong enough for a free-text unit NAME, where a bare `PS`
 * could be a site's initials: it must say `pumped`, `pump storage` or `PSH`. */
const PUMPED_IN_NAME_REGEX =
  /pumped|pump\s*storage|hydro\s*pump|(?:^|[^a-z0-9])psh(?:$|[^a-z0-9])/i;

/** The columns a cleaned fuel is read from, in order. */
const FUEL_ATTRIBUTE_COLUMNS = ['FuelType', 'Technology', 'SubType'] as const;

/**
 * The cleaned fuel for one generator, through a column reader (so this file
 * needs no join and loads in Node).
 *
 * PUMPED STORAGE IS DECIDED FIRST: a pumped unit's FuelType reads like any
 * hydro unit's, and that is the mistake this column exists to stop. A unit
 * NAME is read only for the pumped marker, never a fuel (a plant called
 * Sunbright is not solar).
 *
 * THREE WAYS TO NOT KNOW, never merged:
 *   * `Unlisted` -- no GeneratorList row. Fix the list.
 *   * `Unknown` -- every fuel column is empty. Fix the export.
 *   * `Unrecognised` -- a fuel was named that nothing claims. Fix
 *     `data/generator/fuel-groupings.json`.
 */
export function cleanFuel(read: (column: string) => string | number | null | undefined): string {
  // Only `(unlisted)` in EVERY column means no row: the join also returns it
  // for a column the list lacks.
  let unlistedColumns = 0;
  let named = false;

  for (const column of FUEL_ATTRIBUTE_COLUMNS) {
    const value = normalise(read(column));
    if (value === UNLISTED) unlistedColumns++;
    if (!value || value === UNLISTED) continue;
    if (PUMPED_STORAGE_REGEX.test(value)) return 'Pumped Storage';
  }
  const name = normalise(read('Name'));
  if (name && name !== UNLISTED && PUMPED_IN_NAME_REGEX.test(name)) return 'Pumped Storage';

  for (const column of FUEL_ATTRIBUTE_COLUMNS) {
    const value = normalise(read(column));
    if (!value || value === UNLISTED) continue;
    named = true;
    const mapped = CLEAN_BY_SPELLING.get(value);
    if (mapped) return mapped;
    const guessed = CLEAN_FROM_CATEGORY[classifyFuel(value)];
    if (guessed !== null) return guessed;
  }
  if (unlistedColumns === FUEL_ATTRIBUTE_COLUMNS.length) return 'Unlisted';
  return named ? 'Unrecognised' : 'Unknown';
}

export function fuelGroupOf(clean: string): FuelGroup {
  return GROUP_BY_CLEAN.get(clean) ?? 'Unrecognised';
}

export function cleanFuelColor(clean: string): string | undefined {
  return COLOR_BY_CLEAN.get(clean);
}

export function fuelGroupColor(group: string): string | undefined {
  return FUEL_GROUP_COLORS[group as FuelGroup];
}

const FUEL_GROUP_COLORS: Readonly<Record<FuelGroup, string>> = {
  Solar: '#f1c40f',
  Wind: '#16a085',
  Hydro: '#2980b9',
  Storage: '#8e44ad',
  Thermal: '#e67e22',
  Unlisted: OTHER_COLOR,
  Unknown: OTHER_COLOR,
  Unrecognised: OTHER_COLOR,
};
