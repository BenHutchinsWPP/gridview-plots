// src/main.ts
//
// The composition root: the one place every table kind meets, and the only
// module that holds mutable app state (Case store, frozen query, notes
// channels, buffers). Sequences that do not touch that state live in
// `src/app/` and take what they need as arguments.
//
// Every interaction builds a new frozen query and calls render(), which
// recomputes from the cubes. That is viable because the arithmetic is a filter
// and a sort over typed arrays; the one cost worth knowing is at `sortAsc` in
// `src/kernels.ts`. Buffers are allocated once and reused so render never
// allocates.

import './styles.css';
import { HOURS_PER_YEAR } from './model/calendar';
import {
  allAreas,
  exportGroupings,
  setAxis,
  setGroupings,
  type GroupingSummary,
} from './tables/area/groupings';
// Generator group membership: session-wide beside the area `groupings`, keyed
// on the GeneratorList name column. Restored alongside them below.
import {
  adoptGeneratorGroups,
  exportGeneratorGroups,
  indexForMapping,
  loadGeneratorGroups,
  setGeneratorMembership,
  summarizeGeneratorGroups,
  unresolvedMembershipRows,
  type GeneratorGroupMapping,
  type GeneratorGroupsSummary,
  type SavedGeneratorGroups,
} from './tables/generator/groups';
import { derivedAttribute } from './tables/generator/derived';
// Reference lists: session-wide, beside `groupings`, never a Case slot.
import { parseLookupCsv } from './lookups/parse';
import {
  adoptLookups,
  allLookups,
  attachLookup,
  lookupFor,
  lookupSources,
  mergeNote,
} from './lookups/store';
// Interface limits: an auxiliary file, beside the lookups rather than a kind.
// The scope half comes off the Import Dialog, which is the only auxiliary file
// for which that is true -- see `src/app/import-plan.ts`'s `LimitPlan`.
import { parseLimitsCsv } from './limits/parse';
import { createLimitsStore, LIMITS_ENABLES } from './limits/store';
import { limitLinesFor, rangeLimitsOf, summedLimitLines } from './limits/draw';
import { boundaryLimits } from './tables/interface/limits';
import type { RangeLimits } from './series/range';
import { restoreCaseLimits } from './limits/envelope';
import type { LimitTable } from './limits/types';
import { VARIANT_OF, type LookupTable, type LookupVariant } from './lookups/types';
import { createScratch, hasData } from './tables/area/kernels';
import { createRankMemo } from './kernels';
import {
  hasSimd,
  ingest,
  NO_SIMD_MESSAGE,
  discoverEntities,
  readCasePlan,
  unionEntities,
  unionMetricsOf,
} from './tables/long/pool';
import { AREA_KIND, unionOf } from './tables/area/long';
import { combinesAcrossAreas } from './tables/area/rules';
import { BUS_LONG_KIND } from './tables/bus/long';
import { GENERATOR_LONG_KIND } from './tables/generator/long';
import { combinesAcrossGenerators } from './tables/generator/rules';
import { combinesAcrossBuses } from './tables/bus/rules';
import {
  adoptBusGroups,
  exportBusGroups,
  indexForBusMapping,
  loadBusGroups,
  setBusMembership,
  summarizeBusGroups,
  unresolvedBusMembershipRows,
  type BusGroupMapping,
  type BusGroupsSummary,
  type SavedBusGroups,
} from './tables/bus/groups';
import { showBusGroupEditor, type BusGroupEdit } from './tables/bus/ui/groups';
import { combinesAcrossInterfaces } from './tables/interface/rules';
import {
  INTERFACE_GROUP_BY,
  adoptInterfaceGroups,
  boundaryCoefficients,
  exportInterfaceGroups,
  loadInterfaceGroups,
  setInterfaceMembership,
  summarizeInterfaceGroups,
  type InterfaceGroupMapping,
  type InterfaceGroupsSummary,
  type SavedInterfaceGroups,
} from './tables/interface/groups';
import { showInterfaceGroupEditor, type InterfaceGroupEdit } from './tables/interface/ui/groups';
import {
  downloadBundle,
  isAbort,
  isMissingBundle,
  loadBundle,
  readBundleFile,
  saveBundle,
  warmStorage,
  type RestoredBundle,
} from './storage/store';
import { showLongMetricPicker } from './ui/long-metric-picker';
import { classify, DETECT_PROBE_BYTES } from './detect';
import * as wideArea from './tables/area/wide';
import * as busWide from './tables/bus/wide';
import * as generatorWide from './tables/generator/wide';
import type { BusTable } from './tables/bus/types';
import type { GeneratorTable } from './tables/generator/types';
import * as interfacePool from './tables/interface/pool';
import type { Filters } from './model/types';
import type { AreaQuery, AreaTable, BoxDim } from './tables/area/types';
import {
  byCaseName,
  caseForName,
  caseLabel,
  CaseStore,
  rowsOfKind,
  slotKey,
  slotLabel,
  type RestoredCase,
  type TableKind,
  type TableRow,
  type TableSlotKey,
} from './model/case-model';
import type { EditorApplied } from './ui/membership-editor';
import { reindexCase, sameAxis } from './tables/area/axis';
import {
  seriesCapMessage,
  DEFAULT_SLOTS,
  type CaseSeries,
  type DrawnLimit,
  type SlotType,
} from './ui/charts';
import { showGroupEditor } from './tables/area/ui/groups';
import { showGeneratorGroupEditor, type GeneratorGroupEdit } from './tables/generator/ui/groups';
import { readCsvHeader, showGroupingsMapping } from './ui/groupings-mapping';
import { mountAreaSection, statusSentence } from './tables/area/ui/section';
import { createScratchPool, createSeriesPool } from './series/pool';
import { declareAreaTabs } from './tables/area/ui/browse';
import { areaAnswers } from './tables/area/ui/retarget';
import { busAnswers } from './tables/bus/ui/retarget';
import { generatorAnswers } from './tables/generator/ui/retarget';
import { interfaceAnswers } from './tables/interface/ui/retarget';
import type { InterfaceTable } from './tables/interface/types';
import { showImportDialog } from './ui/import-dialog';
import type { ImportFile, LimitPlan } from './app/import-plan';
import { declareInterfaceTabs } from './tables/interface/ui/browse';
import { declareBusTabs } from './tables/bus/ui/browse';
import { packBusLabels, LABELS_KEY as BUS_LABELS_KEY } from './tables/bus/ui/retain';
import { createRetainGates, GROUPS_ENABLES, KIND_ENABLES, TABLE_KINDS } from './tables/registry';
import {
  createInventory,
  groupsInput,
  LIMITS_COLUMN,
  SHARED_LIMITS_INPUT,
  type InventoryCase,
  type InventoryColumn,
  type SessionRow,
} from './inventory/store';
import { LIST_SCHEMAS, schemaFor } from './lookups/schema';
import { showContentsPanel } from './ui/contents-panel';
import { createChrome, createSectionHost } from './ui/shell';
import { createBrowseDrawer, type HourlyDownload } from './ui/browse-drawer';
import { exportHourly } from './app/hourly-export';
import { openFigureDialog } from './figure/dialog';
import { confirmLargeDownload } from './ui/confirm-allocation';
import {
  caseSwitch,
  percentSwitch,
  retargetCase,
  retargetPercent,
  retargetVariable,
  variableSwitch,
  type CaseChoice,
  type CaseSwitch,
  type KindAnswers,
  type KindRetarget,
  type KindRetargets,
  type PercentSwitch,
  type RetargetRow,
  type VariableSwitch,
} from './ui/browse-retarget';
import { within } from './ui/dom';
import {
  restorePins,
  type BrowseRowRef,
  type CaseNames,
  type SelectionEntry,
} from './ui/browse-model';
import { PREVIEW_COLOR } from './series/model';
import { declareGeneratorTabs } from './tables/generator/ui/browse';
import { createWideIngest, type WideBatch } from './app/ingest-wide';
import { createAreaLongIngest, createEntityLongIngest } from './app/ingest-long';
import { outcomeNotes, type Drop, type IngestHost, type IngestOutcome } from './app/batch';
import { routeDrop, splitPlans, type RoutedFile } from './app/drop-route';
import { createNotesLedger } from './app/notes-ledger';
import { collectBrowseTabs } from './app/browse-tabs';
import { readSessionReference } from './session/reference';
import { computeBoxes, NO_YEAR } from './app/boxes';
import {
  createBrowseScopes,
  filtersLabel,
  identityOf,
  type BrowseKindRow,
} from './app/browse-scope';
import { resolveDraw, resolveDraws, type DrawContext } from './app/draw';
import { saveBlob } from './ui/download';

// ---------------------------------------------------------------- state

/**
 * The one Case list. Everything is keyed by `Case.id`, never a name or
 * filename, so renaming a Case rekeys nothing and two files that share a name
 * are two Cases rather than a silent overwrite.
 */
const caseStore = new CaseStore();
/** The session's interface limits. An INSTANCE the root holds, not a
 * module-level store: see `createLimitsStore`. */
const limitsStore = createLimitsStore();
/** Which file built which table, for the Contents panel. Recorded at the
 * ingest host's attach only; the Case store never records. */
const inventory = createInventory();
/** The open Contents panel, closed when a load starts. */
let contentsPanel: { close(): void } | null = null;
/** Area's slot key. Area has no variant: one Area table per Case (multiple
 * variants per Case is Interface's problem, not this section's). */
const AREA_SLOT: TableSlotKey = { kind: 'area' };

/** One loaded Area table together with the Case that owns it. Derived from
 * the store on every read rather than cached: the store is the single source
 * of truth, and a stale copy is how a removed Case comes back in a chart. */
interface AreaCase {
  id: string;
  /** The Case's name -- a LABEL, never an identity. */
  name: string;
  /** The Case's own colour, fixed when it was made and looked up by id, so a
   * list sorted for display cannot recolour a single line. */
  color: string;
  data: AreaTable;
}

/** Every loaded Area table, by case name as a reader expects to find them.
 * Sorting here is safe because the colour travels ON the case: it was fixed
 * when the case was made and no ordering can reach it. */
function areaCases(): AreaCase[] {
  const byId = new Map(caseStore.listCases().map((entry) => [entry.id, entry] as const));
  const out: AreaCase[] = [];
  for (const { caseId, data } of caseStore.tablesOfKind('area')) {
    const owner = byId.get(caseId);
    if (owner)
      out.push({
        id: owner.id,
        name: caseLabel(owner),
        color: owner.color,
        data: data as AreaTable,
      });
  }
  return out.sort(byCaseName);
}

type AreaRow = TableRow<AreaTable>;

/** One Area table per Case, so the Case's name alone names the row. */
function areaRows(): AreaRow[] {
  return rowsOfKind<AreaTable>(caseStore, 'area', (owner) => caseLabel(owner));
}

/** Every drawn line's buffers, keyed by `src/app/draw.ts` alone. */
const drawLines = createSeriesPool();

/** Reused by every box-plot partition; one box is consumed before the next,
 * so two buffers cover the whole pane no matter how many boxes it draws. */
const boxScratch = createScratch();
/**
 * The notes, by LIFETIME. A channel is rewritten wholesale, so two messages
 * that die at different moments must never share one:
 *
 *   * `blocked` -- a standing fact about this browser. Never cleared.
 *   * `session` -- the last non-drop action (save, restore, group edit). The
 *     next drop clears it.
 *   * the four kinds -- one drop's own account, written by `loadFiles` only.
 *
 * App-wide messages must not ride on a kind channel: every drop rewrites it,
 * which would erase a parser's refusal account.
 */
const notes = createNotesLedger(['blocked', 'session', 'area', 'interface', 'bus', 'generator']);
let busy: string | null = null;
/**
 * What `busy` falls back to instead of clearing while a drop is running.
 * Each ingest engine clears the busy line when its batch ends, but the drop
 * may still have pickers to open. Without the floor the app looks idle
 * between batches and the next picker appears from nowhere.
 */
let busyFloor: string | null = null;
/** The status sentence the last full render computed, which the chrome shows
 * whenever nothing is busy. Held so a chrome-only repaint can show it. */
let idleStatus = '';
let groupingsRev = 0;
/** Moves exactly when the generator group map does, so the drawer's build
 * signature cannot mistake an edited map for the one it already ranked. */
let generatorGroupsRev = 0;
let busGroupsRev = 0;
let interfaceGroupsRev = 0;
// loadFiles is not reentrant: a second concurrent drop would dispatch over the
// same pool while the first is in flight, and a stale reply could land in the
// wrong case. Refusing guarantees one dispatch per kind at a time.
let loadInFlight = false;
// Which exit the Import Dialog took. Module state because every batch reads
// it at a different moment of one drop; cleared in the same `finally` as
// `loadInFlight`, or the NEXT drop would skip its pickers.
let dropKeepsEverything = false;

function adoptAxis(axis: string[]): void {
  const current = allAreas();
  if (sameAxis(current, axis)) return;
  // ONE reindex per batch, never per file. Map#set on an existing key keeps
  // its position, so Case order and colours do not shuffle.
  for (const entry of areaCases()) {
    caseStore.attachTable(entry.id, AREA_SLOT, reindexCase(entry.data, axis), { replace: true });
  }
  setAxis(axis);
}

let query: AreaQuery = Object.freeze({
  cases: [] as readonly string[],
  filters: Object.freeze({
    months: null,
    daysOfMonth: null,
    hoursOfDay: null,
    daysOfWeek: null,
    seasons: null,
    tou: null,
  }) as Filters,
  boxDim: 'case' as BoxDim,
});

function setQuery(patch: Partial<AreaQuery>): void {
  query = Object.freeze({ ...query, ...patch });
  render();
}

function setFilters(patch: Partial<Filters>): void {
  setQuery({ filters: Object.freeze({ ...query.filters, ...patch }) });
}

// ------------------------------------------------------ interface state

function interfaceRows(): TableRow<InterfaceTable>[] {
  return rowsOfKind<InterfaceTable>(caseStore, 'interface', slotLabel);
}

// ------------------------------------------------------------ bus state

function busRows(): TableRow<BusTable>[] {
  return rowsOfKind<BusTable>(caseStore, 'bus', slotLabel);
}

// The id-to-plane map a bus draw needs is not here: it lives in
// `src/tables/bus/series.ts`, keyed on the table OBJECT in a WeakMap, built
// once per table and gone when the table is with nothing here to delete.

/** Id -> the label to show for it, first loaded table wins. A name is a label
 * and may repeat; the id is the identity, so this map is one-way only. */
function busNames(): Map<number, string> {
  const names = new Map<number, string>();
  for (const row of busRows()) {
    row.data.buses.forEach((id, index) => {
      if (!names.has(id)) names.set(id, row.data.names[index] ?? '');
    });
  }
  return names;
}

/** A bus's BaseKV from the loaded BusList, or null: no list, no row, or a
 * blank. */
function busKv(id: number): number | null {
  const list = lookupFor('buslist');
  const row = list?.index.get(id);
  const column = list?.columns[list.byName.get('BaseKV') ?? -1];
  if (row === undefined || column?.kind !== 'float' || column.nulls[row] === 1) return null;
  return column.values[row];
}

// ------------------------------------------------------ generator state

function generatorRows(): TableRow<GeneratorTable>[] {
  return rowsOfKind<GeneratorTable>(caseStore, 'generator', slotLabel);
}

// ---------------------------------------------------------------- render

/** A case's calendar year, for the box-plot partition: the first table that
 * states one (the Import Dialog keeps one run's tables to one year). */
function yearOfCase(caseId: string): number {
  const owner = caseStore.listCases().find((entry) => entry.id === caseId);
  for (const slot of owner?.tables.values() ?? []) {
    const year = (slot.data as { year?: number } | null)?.year;
    if (typeof year === 'number') return year;
  }
  return NO_YEAR;
}

// ------------------------------------------------------------------- FIND

/** The drawer's selection as the render path reads it. Pins, unpins and
 * previews all end in `render()`: one repaint path for the whole app. */
let browsePinned: readonly SelectionEntry[] = [];
let browsePreview: BrowseRowRef | null = null;

function allBrowseDraws(): { ref: BrowseRowRef; color: string; dashed: boolean }[] {
  const out = browsePinned.map((entry) => ({ ref: entry.ref, color: entry.color, dashed: false }));
  if (browsePreview) {
    out.push({ ref: browsePreview, color: PREVIEW_COLOR, dashed: true });
  }
  return out;
}

/** One path's hourly "% of range" limits in one Case, from the limits store
 * this module holds; a kind receives the numbers, never the store. */
function interfaceRange(caseId: string, interfaceName: string, year: number): RangeLimits {
  return rangeLimitsOf(limitsStore.limitFor(caseId, interfaceName), year);
}

/** Which limits tables are installed, by object: a file replaced under the
 * same name is a different ranking. */
function limitsIdentity(): string {
  const shared = limitsStore.sharedLimits();
  const parts = [shared ? String(identityOf(shared)) : '-'];
  for (const [caseId, table] of limitsStore.caseLimits()) {
    parts.push(`${caseId}#${identityOf(table)}`);
  }
  return parts.join(',');
}

/** A Case's label by id, read from the store at every draw. A Case already
 * gone (a row outliving it) says so rather than showing its id. */
function caseLabelOf(caseId: string): string {
  const owner = caseStore.listCases().find((entry) => entry.id === caseId);
  return owner ? caseLabel(owner) : 'a Case no longer loaded';
}

/** Case names both ways, read from the store at every call, for a frozen
 * filter chosen in another Case. A Case no longer loaded reads as its name. */
const caseNames: CaseNames = {
  nameOf: (caseId) => caseStore.listCases().find((entry) => entry.id === caseId)?.name,
  labelOfName(name) {
    const owner = caseStore.listCases().find((entry) => entry.name === name);
    return owner ? caseLabel(owner) : name;
  },
};

/** What a draw reads from this module's state, through accessors so a removed
 * Case can never come back from a snapshot. */
const drawContext: DrawContext = {
  get filters() {
    return query.filters;
  },
  caseLabel: caseLabelOf,
  caseNames,
  areaCases,
  interfaceRows,
  busRows,
  generatorRows,
  busNames,
  busKv,
  interfaceRange,
  lines: drawLines,
};

/** The drawer's hourly download resolves through the same draw, into ONE
 * buffer set of its own: the drawn pool's keys and contents never move. */
const exportContext: DrawContext = {
  get filters() {
    return query.filters;
  },
  caseLabel: caseLabelOf,
  caseNames,
  areaCases,
  interfaceRows,
  busRows,
  generatorRows,
  busNames,
  busKv,
  interfaceRange,
  lines: createScratchPool(),
};

/** One 8,760-point buffer for every ranked row of every tab. Shared because a
 * tab's rows are ranked one at a time, and reused because allocating per render
 * is how a free interaction acquires a cost. */
const browseScratch = createScratch();
// Every tab's ranking, kept per cube while its mask and rows hold still, so a
// drop ranks only its own rows.
const browseRanks = createRankMemo();
/** The browse drawer's per-kind variable memory and the scoping over it. */
const browse = createBrowseScopes();

/** Tabs that show one variable two ways (entity and groups), each naming the
 * other, so a variable picked on one is what the other shows. */
const PAIRED_TABS: Readonly<Record<string, string>> = {
  area: 'area-groups',
  'area-groups': 'area',
  generator: 'generator-groups',
  'generator-groups': 'generator',
  bus: 'bus-groups',
  'bus-groups': 'bus',
  interface: 'interface-groups',
  'interface-groups': 'interface',
};

/** Tabs that answer for only SOME of their kind's quantities, and the rule.
 * A groups tab can only sum, so a quantity its kind will not combine is left
 * out of its dropdown (and not carried over by the pairing). */
const TAB_OFFERS: Readonly<
  Record<string, (variable: string, holders: readonly BrowseKindRow['data'][]) => boolean>
> = {
  'area-groups': combinesAcrossAreas,
  'generator-groups': combinesAcrossGenerators,
  'bus-groups': combinesAcrossBuses,
  'interface-groups': combinesAcrossInterfaces,
};

/** One kind's switch answers over its loaded tables, with the rule its
 * groups tab offers by, so a switched group pin never lands on a quantity
 * that tab would refuse. */
function retargetOf<D extends BrowseKindRow['data']>(
  kind: string,
  rows: readonly RetargetRow<D>[],
  answers: KindAnswers<D>,
): KindRetarget<D> {
  return {
    ...answers,
    rows,
    combines: (variable, data) => TAB_OFFERS[PAIRED_TABS[kind] ?? '']?.(variable, [data]) ?? true,
  };
}

/** Each kind's answers to the Selected tab's switch, over every loaded table
 * (not the enabled scope: a pin's Case may be switched off). */
function pinRetargets(): KindRetargets {
  return {
    area: retargetOf('area', areaRows(), areaAnswers),
    bus: retargetOf('bus', busRows(), busAnswers),
    generator: retargetOf('generator', generatorRows(), generatorAnswers),
    interface: retargetOf('interface', interfaceRows(), interfaceAnswers),
  };
}

/** Every loaded Case in load order, as the Case switch offers it. */
function caseChoices(): CaseChoice[] {
  return caseStore
    .listCases()
    .map((entry) => ({ id: entry.id, name: entry.name, label: caseLabel(entry) }));
}

/** The Selected tab's switches, held while the pins and every table they
 * could move to hold still: the drawer asks on every draw, and a group's
 * answer can scan a whole axis. */
let selectedSwitches:
  | {
      pins: readonly SelectionEntry[];
      key: string;
      variable: VariableSwitch;
      percent: PercentSwitch;
      case: CaseSwitch;
    }
  | undefined;

function switchesFor(signature: string) {
  const tables = [...areaRows(), ...busRows(), ...generatorRows(), ...interfaceRows()]
    .map((row) => identityOf(row.data))
    .join(',');
  // Labels too: a rename in Contents relabels the Case options.
  const cases = caseChoices();
  const named = cases.map((entry) => `${entry.id}=${entry.label}`).join(',');
  const key = `${signature}\u0001${tables}\u0001${named}`;
  if (selectedSwitches?.pins !== browsePinned || selectedSwitches.key !== key) {
    const refs = browsePinned.map((entry) => entry.ref);
    const kinds = pinRetargets();
    selectedSwitches = {
      pins: browsePinned,
      key,
      variable: variableSwitch(refs, kinds),
      percent: percentSwitch(refs, kinds),
      case: caseSwitch(refs, kinds, cases),
    };
  }
  return selectedSwitches;
}

function renderBrowse(): void {
  const scopedCases = new Map(
    caseStore
      .listCases()
      .map((entry) => [entry.id, { name: entry.name, label: caseLabel(entry) }] as const),
  );
  // Every tab is scoped by the same loaded cases and the same hour filter, so
  // a number in the drawer means the same thing whichever tab it is under.
  const scope = <T extends BrowseKindRow>(rows: readonly T[], kind: string, pairedWith?: string) =>
    browse.scope(rows, kind, query.cases, query.filters, scopedCases, pairedWith, TAB_OFFERS[kind]);
  const area = scope(areaRows(), 'area');
  const areaGroups = scope(areaRows(), 'area-groups', 'area');
  const generator = scope(generatorRows(), 'generator');
  const generatorGroups = scope(generatorRows(), 'generator-groups', 'generator');
  const bus = scope(busRows(), 'bus');
  const busGroups = scope(busRows(), 'bus-groups', 'bus');
  const iface = scope(interfaceRows(), 'interface');
  const ifaceGroups = scope(interfaceRows(), 'interface-groups', 'interface');

  // Bar order: each kind's entity tab then its groups tab, each declared in
  // its own directory. EVERY tab is declared, loaded or not: empty ones are
  // hidden but stay in the signature, since a kind losing its last table
  // changes what a rebuild produces.
  const declared = [
    ...declareAreaTabs(area, areaGroups, browseScratch, browseRanks),
    ...declareGeneratorTabs(
      generator,
      generatorGroups,
      lookupFor('generatorlist'),
      browseScratch,
      browseRanks,
    ),
    ...declareBusTabs(bus, busGroups, lookupFor('buslist'), browseScratch, browseRanks),
    ...declareInterfaceTabs(iface, ifaceGroups, browseScratch, browseRanks, interfaceRange),
  ];

  // The dropdown lists the ACTIVE tab's quantities (a tab can vanish with its
  // last table). The second argument names every app-wide input a rebuild
  // reads; a missing term leaves a stale ranking.
  const collected = collectBrowseTabs(
    declared,
    {
      // The list OBJECTS, not their file names: a second GeneratorList.csv
      // merges new rows under a source name the list already carries, so the
      // names hold still while every build that joins on the list changes.
      lookups: [...allLookups()]
        .map(([variant, list]) => `${variant}#${identityOf(list)}`)
        .join(','),
      groupingsRev,
      generatorGroupsRev,
      busGroupsRev,
      interfaceGroupsRev,
      // The Interface tab's "% of range" divides by these.
      limits: limitsIdentity(),
    },
    browseDrawer.activeTabId(),
  );

  browseDrawer.render({
    tabs: collected.tabs,
    signature: collected.signature,
    variables: collected.shown?.variables ?? [],
    variable: collected.shown?.variable ?? '',
    hourFilter: filtersLabel(query.filters),
    caseLabel: caseLabelOf,
    selectedVariable: () => switchesFor(collected.signature).variable,
    selectedPercent: () => switchesFor(collected.signature).percent,
    selectedCase: () => switchesFor(collected.signature).case,
    caseNames,
  });
}

function render(): void {
  // Only pins are drawn, so the Selected tab lists every line on screen.
  const draws = allBrowseDraws();
  const capped =
    draws.length > 0
      ? seriesCapMessage(draws.length, [{ label: 'pinned row(s)', count: draws.length }])
      : null;
  let series: CaseSeries[] = [];
  // Resolved even when empty, and swept when capped: a render that draws
  // nothing frees every line buffer.
  if (!capped) series = resolveDraws(drawContext, draws);
  else drawLines.sweep();

  // Every note of this render, built AFTER the series: warnings such as
  // Area's plain-mean fallback arise while series resolve.
  const batchNotes = [...notes.all(), ...series.flatMap((entry) => entry.warnings)];
  if (capped) batchNotes.unshift(capped);
  sections.sync(caseStore.listCases().length > 0, batchNotes);

  charts.render({
    boxDim: query.boxDim,
    limits: limitLines(series),
    series,
    boxes: computeBoxes(series, query.boxDim, yearOfCase, boxScratch),
    refusal: capped ?? undefined,
    hasCases: caseStore.listCases().length > 0,
  });

  shell.render(query);

  renderBrowse();

  let keptHours = 0;
  for (const s of series) {
    keptHours = Math.max(keptHours, s.n);
  }
  idleStatus = statusSentence(query, series.length === 0 ? HOURS_PER_YEAR : keptHours);
  renderChrome();
}

/**
 * The status line, the busy bar and the memory readout, and nothing else.
 * A parse reports progress once per block, and a full `render()` per report
 * would repaint panes and drawer rows on the thread that is also filling the
 * cube. Progress changes only this, so progress repaints only this.
 */
function renderChrome(): void {
  const totalBytes = caseStore.listCases().reduce((total, c) => {
    let bytes = 0;
    for (const [, slot] of c.tables) {
      const cube = (slot.data as { cube?: Float32Array })?.cube;
      if (cube) bytes += cube.byteLength;
    }
    return total + bytes;
  }, 0);
  chrome.render({
    status: busy ?? idleStatus,
    busy: busy !== null,
    bytes: totalBytes,
    cases: caseStore.listCases().length,
    files: inventory.fileCount(caseStore.listCases().map((entry) => entry.id)),
  });
}

/** A kind as a column or row heading. */
function kindLabel(kind: string): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** Every registered kind is a column, loaded or not: a blank column shows
 * both what a Case lacks and what the app can take. Limits come last, and a
 * Case with none of its own reads `shared` when the shared file serves it. */
function contentsColumns(): InventoryColumn[] {
  return [
    ...TABLE_KINDS.map((kind) => ({
      kind,
      label: kindLabel(kind),
      enables: KIND_ENABLES[kind],
    })),
    {
      kind: LIMITS_COLUMN,
      label: 'Limits',
      enables: LIMITS_ENABLES,
      fallback: { input: SHARED_LIMITS_INPUT, label: 'shared' },
    },
  ];
}

/** The inputs that serve every Case, one strip row each, blank or not. */
function contentsSessionRows(): SessionRow[] {
  return [
    ...LIST_SCHEMAS.map((schema) => ({
      input: VARIANT_OF[schema.entity],
      label: schema.label,
      enables: schema.enables,
    })),
    { input: SHARED_LIMITS_INPUT, label: 'Limits (shared)', enables: LIMITS_ENABLES },
    ...TABLE_KINDS.map((kind) => ({
      input: groupsInput(kind),
      label: `${kindLabel(kind)} groups`,
      enables: GROUPS_ENABLES[kind],
    })),
  ];
}

/** The pivot's rows, in the order every Case list uses. */
function contentsCases(): InventoryCase[] {
  return caseStore
    .listCases()
    .slice()
    .sort(byCaseName)
    .map((entry) => ({
      id: entry.id,
      name: caseLabel(entry),
      ...(caseLabel(entry) === entry.name ? {} : { original: entry.name }),
      color: entry.color,
    }));
}

function openContents(): void {
  closeContents();
  contentsPanel = showContentsPanel({
    strip: () => inventory.strip(contentsSessionRows()),
    pivot: () => inventory.pivot(contentsCases(), contentsColumns()),
    detail: (recordId) => inventory.detail(recordId),
    log: () =>
      inventory.log({
        cases: caseStore.listCases().map((entry) => ({ id: entry.id, name: caseLabel(entry) })),
        columns: contentsColumns(),
        rows: contentsSessionRows(),
      }),
    tsv: () => inventory.tsv(contentsCases(), contentsColumns(), contentsSessionRows()),
    renameCase: (caseId, text) => {
      try {
        caseStore.setDisplayName(caseId, text);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      render();
      return undefined;
    },
    about: () => inventory.about(),
    setAbout: (text) => inventory.setAbout(text),
    loading: () => loadInFlight || busy !== null,
  });
}

/** Close the Contents panel if it is open. Called when a load starts, so the
 * panel never shows a study half-way through changing. */
function closeContents(): void {
  contentsPanel?.close();
  contentsPanel = null;
}

// ---------------------------------------------------------------- ingest

const fileInput = document.createElement('input');
fileInput.id = 'file-input';
fileInput.type = 'file';
fileInput.accept = '.csv,text/csv,.gvmb,.gvap,.gvip';
fileInput.multiple = true;
fileInput.style.display = 'none';
document.body.appendChild(fileInput);
fileInput.addEventListener('change', () => {
  const files = Array.from(fileInput.files ?? []);
  fileInput.value = '';
  if (files.length > 0) void loadFiles(files);
});

// The Load button. A saved bundle goes through the same routing a dropped file does,
// so restoring is one code path however the file arrives.
const bundleInput = document.createElement('input');
bundleInput.type = 'file';
bundleInput.accept = '.gvmb,.gvap,.gvip';
bundleInput.style.display = 'none';
document.body.appendChild(bundleInput);
bundleInput.addEventListener('change', () => {
  const files = Array.from(bundleInput.files ?? []);
  bundleInput.value = '';
  if (files.length > 0) void loadFiles(files);
});

/** A message is progress and repaints the chrome; `null` ends an operation,
 * whose results the rest of the app has not drawn yet, and repaints it all. */
function setBusy(message: string | null): void {
  busy = message ?? busyFloor;
  if (message !== null) renderChrome();
  else render();
}

/** Raise or drop the floor, and repaint against it. Both callers sit between
 * batches, where nothing more specific is on the line; `null` ends the drop's
 * hold on it and the chrome goes back to its status sentence. */
function setBusyFloor(message: string | null): void {
  busyFloor = message;
  setBusy(null);
}

/** A frame for the busy line to paint in. A hidden tab pauses animation
 * frames, so a timer stands in for one. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
    setTimeout(resolve, 100);
  });
}

/** Set while an hourly file is written, so a drop waits for it. */
let exportInFlight = false;

/**
 * Write the hourly file a drawer tab showed. Busy for the whole write, so
 * nothing can remove a Case under it, and it ends on a chrome repaint only:
 * the export resolves into its own buffers and the chart has nothing to
 * redraw.
 */
async function downloadHourly(download: HourlyDownload): Promise<void> {
  if (busy !== null || exportInFlight) return;
  exportInFlight = true;
  try {
    const parts = await exportHourly(
      {
        resolve: (ref) => resolveDraw(exportContext, { ref, color: '#000000', dashed: false }),
        caseLabel: caseLabelOf,
        caseNames,
        progress: (message) => setBusy(message),
        nextFrame,
        confirm: confirmLargeDownload,
      },
      download,
    );
    if (parts === null) return;
    saveBlob(
      new Blob(parts, { type: 'text/csv' }),
      `browse-${download.tabId}-hourly-${download.layout}.csv`,
    );
  } catch (error) {
    notes.set('session', [
      `Hourly download failed: ${error instanceof Error ? error.message : String(error)}`,
    ]);
    render();
  } finally {
    exportInFlight = false;
    busy = busyFloor;
    renderChrome();
  }
}

/** Group membership is many-to-many and may name areas this build does not
 * have, so what a mapping actually covers is worth stating rather than
 * leaving to be discovered as an empty chart. */
function groupingNotes(summary: GroupingSummary, lead: string): string[] {
  const messages = [
    `${lead}: ${summary.groups} groups covering ${summary.mapped} of ${allAreas().length} areas.`,
  ];
  if (summary.offAxis.length > 0) {
    messages.push(
      `${summary.offAxis.length} name(s) in the mapping are not areas in this build and ` +
        `cannot be plotted: ${summary.offAxis.join(', ')}.`,
    );
  }
  if (summary.unmapped.length > 0) {
    messages.push(`In no group: ${summary.unmapped.join(', ')}.`);
  }
  return messages;
}

/** Axis areas that carry data in at least one loaded case, for the editor's
 * "listed but not in the data" flag. */
function presentAreas(): Set<string> {
  const present = new Set<string>();
  for (const { data } of areaCases()) {
    data.areas.forEach((area, areaIndex) => {
      if (present.has(area)) return;
      for (let metric = 0; metric < data.metrics.length; metric++) {
        if (hasData(data, areaIndex, metric)) {
          present.add(area);
          return;
        }
      }
    });
  }
  return present;
}

/**
 * Apply an area `Groupings.csv`, RETURNING its account rather than publishing
 * it. A drop and the group editor give it different lifetimes, and a batch
 * account written later in the same drop would otherwise overwrite it.
 */
function applyGroupings(csv: string): string[] {
  const summary = setGroupings(csv);
  const account = groupingNotes(summary, 'Groupings updated');
  groupingsRev++;
  render();
  return account;
}

/**
 * The Case a dialog-assigned name points at: the existing one with that name
 * or display name (`caseForName`), or a new one. The user was shown per file whether the name was new or
 * existing, so looking it up again is what lands an Area and an Interface
 * export of one run on ONE Case.
 */
function caseIdForName(name: string): string {
  const existing = caseForName(caseStore.listCases(), name);
  return (existing ?? caseStore.createCase(name)).id;
}

/**
 * How many of the year's hours each of a Case's occupied slots covers, for
 * the Import Dialog's replace warning. Reads `hoursPresent` structurally, so a
 * new kind gets the warning by carrying the field. `null` means unknown (an
 * older bundle), and the dialog then says nothing about coverage.
 */
function hoursCoveredBySlot(entry: {
  tables: Map<string, { data: unknown }>;
}): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [slot, table] of entry.tables) {
    const hours = (table.data as { hoursPresent?: Uint8Array } | null)?.hoursPresent;
    if (!(hours instanceof Uint8Array) || hours.length !== HOURS_PER_YEAR) {
      out[slot] = null;
      continue;
    }
    let covered = 0;
    for (let h = 0; h < HOURS_PER_YEAR; h++) covered += hours[h] ? 1 : 0;
    out[slot] = covered;
  }
  return out;
}

async function loadFiles(files: File[]): Promise<void> {
  // Refuse a concurrent call rather than let two live dispatch() calls race
  // over the same worker pool (see loadInFlight's comment above).
  if (loadInFlight) {
    const refusal = 'A load is already running — drop these files again once it finishes.';
    inventory.logRefused(files, refusal);
    notes.set('session', [refusal]);
    render();
    return;
  }
  if (exportInFlight) {
    const refusal = 'A download is being written — drop these files again once it finishes.';
    inventory.logRefused(files, refusal);
    notes.set('session', [refusal]);
    render();
    return;
  }
  loadInFlight = true;
  closeContents();
  // Everything this drop accepts is logged as one `loaded` when it ends,
  // carrying the notes that name no file.
  inventory.beginDrop();
  // This drop supersedes the last non-drop message. Cleared here, not on the
  // refusal above, which superseded nothing.
  notes.set('session', []);
  const plural = files.length === 1 ? '' : 's';
  setBusyFloor(`Reading ${files.length} dropped file${plural}…`);
  try {
    // Every table file in drop order with the detector's verdict. Which Case
    // and slot each lands on is the Import Dialog's answer, not this loop's.
    const classified: RoutedFile<{ file: File; classified: ImportFile }>[] = [];
    for (const file of files) {
      const headBytes = new Uint8Array(await file.slice(0, DETECT_PROBE_BYTES).arrayBuffer());
      const detected = classify(headBytes, file.name);
      classified.push({
        name: file.name,
        // The verdict travels with the file; its quantity (possibly undefined)
        // separates two tables of one kind on one Case.
        item: { file, classified: { name: file.name, detected } },
        verdict: detected,
      });
    }
    // WHERE each file goes is `routeDrop`, which is total over the verdict
    // union and tested on its own. What follows is the half that cannot be:
    // every auxiliary step awaits, and each writes session state.
    const route = routeDrop(classified);
    const tableFiles = route.tables.map((entry) => entry.item);
    /** Every interface limit file the drop carries. Kept apart from
     *  `tableFiles` all the way through, because it is not a table and the
     *  planner answers a different question about it. */
    const limitFiles = route.limits.map((entry) => entry.item);
    /** Messages from the routing stage itself, ahead of either ingest. */
    const routed: string[] = [];
    for (const step of route.auxiliary) {
      switch (step.action) {
        case 'message':
          routed.push(step.text);
          inventory.logRefused([step.item.file], step.text);
          break;
        case 'bundle':
          // Accumulated, not written to `notes`: the ingest notes below would
          // overwrite the restore's account, including a refusal.
          routed.push(...(await restoreBundleFile(step.item.file)));
          break;
        case 'groupings': {
          // A name-keyed generator membership file and an area Groupings.csv
          // look the same, so the pane asks rather than guessing. A cancelled
          // pane changes nothing and says so.
          const file = step.item.file;
          const text = await file.text();
          const choice = await showGroupingsMapping({
            fileName: file.name,
            header: readCsvHeader(text),
            writtenBy: step.item.classified.detected.writtenBy,
            hasGeneratorList: lookupFor('generatorlist') !== undefined,
            hasBusList: lookupFor('buslist') !== undefined,
          });
          if (choice === null) {
            routed.push(`${file.name}: groupings load cancelled — nothing was changed.`);
            inventory.logSkipped([file], 'the groupings mapping was cancelled');
            break;
          }
          try {
            let said: string[];
            if (choice.entity === 'area') {
              said = applyGroupings(text);
            } else if (choice.entity === 'bus') {
              said = loadBusGroupsFile(text, choice.mapping, file.name);
            } else if (choice.entity === 'interface') {
              said = loadInterfaceGroupsFile(text, choice.mapping, file.name);
            } else {
              said = loadGeneratorGroupsFile(text, choice.mapping, file.name);
            }
            routed.push(...said);
            // After the load, which throws on a file it refuses.
            inventory.recordSessionInput(
              groupsInput(choice.entity),
              [file],
              `${kindLabel(choice.entity)} groups`,
            );
            for (const note of said) inventory.noteFiles([file], note);
          } catch (error) {
            const refusal = `${file.name}: ${error instanceof Error ? error.message : String(error)}`;
            routed.push(refusal);
            inventory.logRefused([file], refusal);
          }
          break;
        }
        case 'lookup': {
          const file = step.item.file;
          try {
            const parsed = parseLookupCsv(await file.text(), file.name);
            const merged = attachLookup(parsed.rows);
            const said = [...parsed.warnings, mergeNote(file.name, merged)];
            routed.push(...said);
            // A list MERGES a second file into the first, so the row lists
            // every file that went into it. A key read twice keeps its first
            // row, so the file loaded only in part.
            const schema = schemaFor(parsed.rows.entity);
            const dropped = parsed.duplicates + merged.alreadyKnown;
            inventory.recordSessionInput(VARIANT_OF[schema.entity], [file], schema.label, {
              merge: true,
              ...(dropped === 0
                ? {}
                : {
                    partial:
                      `${dropped.toLocaleString()} row(s) with a key already read were ` +
                      `dropped; the first copy of each was kept`,
                  }),
            });
            for (const note of said) inventory.noteFiles([file], note);
          } catch (error) {
            const refusal = `${file.name}: ${error instanceof Error ? error.message : String(error)}`;
            routed.push(refusal);
            inventory.logRefused([file], refusal);
          }
          break;
        }
        default: {
          const unhandled: never = step;
          throw new Error(`unapplied auxiliary step: ${JSON.stringify(unhandled)}`);
        }
      }
    }
    if (tableFiles.length === 0 && limitFiles.length === 0) {
      // Nothing to ingest. A bundle restore has already written its own
      // notes; anything the routing stage said still has to be shown.
      if (routed.length > 0) {
        notes.set('area', routed);
        render();
      }
      return;
    }

    // The Import Dialog is the ONLY place that decides which file joins which
    // Case and slot. It runs once for the whole drop, before any ingest.
    // Groupings and bundles are applied above and never reach it.
    const decision = await showImportDialog(
      tableFiles.map((entry) => entry.classified),
      caseStore
        .listCases()
        .slice()
        .sort(byCaseName)
        .map((entry) => ({
          name: entry.name,
          ...(entry.displayName ? { displayName: entry.displayName } : {}),
          occupiedSlots: [...entry.tables.keys()],
          slotHours: hoursCoveredBySlot(entry),
        })),
      limitFiles.map((entry) => entry.classified),
    );
    if (!decision) {
      // Cancelled: nothing is ingested. A half-applied batch is exactly the
      // surprise this dialog exists to remove.
      inventory.logSkipped(
        [...tableFiles, ...limitFiles].map((entry) => entry.file),
        'the Import dialog was cancelled',
      );
      notes.set('area', [
        ...routed,
        `Import cancelled — none of the ${tableFiles.length + limitFiles.length} dropped file(s) ` +
          `were loaded.`,
      ]);
      render();
      return;
    }

    // Past the dialog the drop is a run of batches, each of which may open a
    // picker. The floor keeps the app looking busy between them.
    // A file taken out with × is the user's choice, not a refusal.
    const planned = new Set(decision.plans.map((plan, index) => plan.fileIndex ?? index));
    const plannedLimits = new Set(decision.limits.map((plan) => plan.fileIndex));
    inventory.logSkipped(
      [
        ...tableFiles.filter((_, index) => !planned.has(index)),
        ...limitFiles.filter((_, index) => !plannedLimits.has(index)),
      ].map((entry) => entry.file),
      'removed in the Import dialog',
    );
    dropKeepsEverything = decision.everything;
    const fileCount = decision.plans.length + decision.limits.length;
    setBusyFloor(
      dropKeepsEverything
        ? `Loading ${fileCount} file(s), keeping everything they carry…`
        : `Loading ${fileCount} file(s)… you may be asked what to keep.`,
    );

    // Plans pair with `tableFiles` by INDEX (`plan.fileIndex`), never by
    // filename: one drop may carry two files of the same name. `plan.kind` is
    // the FINAL kind, including a corrected misdetection. Each (kind, shape)
    // gets its own batch because each picker's answer is its own, and neither
    // reader can take the other's plans.
    const plans = decision.plans;
    const split = splitPlans(
      plans.map((plan, index) => {
        const file = tableFiles[plan.fileIndex ?? index].file;
        return {
          name: file.name,
          kind: plan.kind,
          shape: plan.shape,
          // Area carries NO variant: `groupByCase` keys on `caseName \0 variant`,
          // so a variant would split the two halves of one year into two
          // tables that both attach at `AREA_SLOT`, the second silently
          // replacing the first.
          drop:
            plan.kind === 'area'
              ? { file, caseName: plan.caseName }
              : { file, caseName: plan.caseName, variant: plan.variant },
        };
      }),
    );
    routed.push(...split.bugs);
    for (const bug of split.bugs) inventory.noteDrop(bug);
    // One array each, never a shared empty one: an engine that sorted its
    // batch in place would otherwise sort every other kind's too.
    const areaDrops: Drop[] = split.long.get('area') ?? [];
    const wideAreaDrops: Drop[] = split.wide.get('area') ?? [];
    const interfaceDrops: Drop[] = split.wide.get('interface') ?? [];
    const busDrops: Drop[] = split.wide.get('bus') ?? [];
    const generatorDrops: Drop[] = split.wide.get('generator') ?? [];
    const longBusDrops: Drop[] = split.long.get('bus') ?? [];
    const longGeneratorDrops: Drop[] = split.long.get('generator') ?? [];

    // Each kind ingests its own batch, and one failing does not skip another.
    // Each kind's channel is rewritten once per drop, even when the drop
    // carried none of that kind, so no note outlives the drop it describes.
    // `routed` is app-wide and rides with the area channel.
    // An engine runs only for a kind the drop carried; its structured
    // outcome is rendered here into the notes the user reads.
    const run = async (drops: readonly Drop[], go: () => Promise<IngestOutcome>) => {
      if (drops.length === 0) return [];
      const outcome = await go();
      inventory.recordOutcome(outcome);
      return outcomeNotes(outcome);
    };
    const areaNotes = [
      ...routed,
      ...(await run(areaDrops, () => ingestAreaFiles(areaDrops))),
      // After the long batch, never interleaved: both widen the Area axis,
      // and each batch reindexes loaded cubes once.
      ...(await run(wideAreaDrops, () => runWideBatch(wideAreaBatch, wideAreaDrops))),
    ];
    // Published BEFORE the other kinds' batches: they render and can throw,
    // and this drop's account must not be lost or left showing the last one's.
    notes.set('area', areaNotes);
    notes.set(
      'interface',
      await run(interfaceDrops, () => runWideBatch(interfaceBatch, interfaceDrops)),
    );
    notes.set('bus', [
      ...(await run(busDrops, () => runWideBatch(busBatch, busDrops))),
      ...(await run(longBusDrops, () => ingestLongFiles(longBusDrops, 'bus', BUS_LONG_KIND))),
    ]);
    notes.set('generator', [
      ...(await run(generatorDrops, () => runWideBatch(generatorBatch, generatorDrops))),
      ...(await run(longGeneratorDrops, () =>
        ingestLongFiles(longGeneratorDrops, 'generator', GENERATOR_LONG_KIND),
      )),
    ]);
    // AFTER every ingest: a pinned limits file resolves its Case by NAME, and
    // that Case may have just been created. Its notes republish the area
    // account, which stays correct either way.
    if (limitFiles.length > 0) {
      const limitNotes = await applyLimitDrops(
        decision.limits.map((plan) => ({ file: limitFiles[plan.fileIndex].file, plan })),
      );
      notes.set('area', [...areaNotes, ...limitNotes]);
    }
    setQueryCases();
    if (caseStore.listCases().length > 0 && browseDrawer.detent() === 'closed') {
      browseDrawer.setDetent('half');
    }
    render();
  } catch (error) {
    // Whatever the drop had not reached is refused by name, so no file of it
    // goes unaccounted in the Log.
    const refusal =
      `The load stopped: ${error instanceof Error ? error.message : String(error)}. ` +
      'Files it had not reached were not loaded.';
    inventory.logRefused(inventory.unaccounted(files), refusal);
    notes.set('session', [refusal]);
  } finally {
    inventory.endDrop();
    loadInFlight = false;
    dropKeepsEverything = false;
    setBusyFloor(null);
  }
}

/**
 * The dashed limit lines for what is on screen, built from the DRAWN series:
 * no line, no limit, and the colour is the line's own. A path carries its
 * published limits; a boundary its members' summed in its directions.
 */
function limitLines(series: readonly CaseSeries[]): DrawnLimit[] {
  return series.flatMap((entry) =>
    limitLinesOf(entry).map((limit) => (entry.dashed ? { ...limit, preview: true } : limit)),
  );
}

function limitLinesOf(entry: CaseSeries): DrawnLimit[] {
  const spec = entry.spec;
  if (spec === undefined || spec.source.kind !== 'interface') return [];
  if (!('entity' in spec.subject)) {
    if (spec.subject.groupBy !== INTERFACE_GROUP_BY) return [];
    const { caseId } = spec;
    const row = interfaceRows().find(
      (candidate) =>
        candidate.caseId === caseId && candidate.data.quantity === spec.source.quantity,
    );
    if (!row) return [];
    const year = yearOfCase(caseId);
    const limits = boundaryLimits(
      row.data,
      boundaryCoefficients(spec.subject.value, spec.subject.members),
      (member) => interfaceRange(caseId, member, year),
    );
    return summedLimitLines(limits, {
      label: entry.name,
      color: entry.color,
      unit: entry.unit,
      values: entry.values,
    });
  }
  return limitLinesFor(limitsStore, {
    caseId: spec.caseId,
    interfaceName: String(spec.subject.entity),
    label: entry.name,
    color: entry.color,
    unit: entry.unit,
    year: yearOfCase(spec.caseId),
    values: entry.values,
  });
}

/**
 * Install a drop's limits files at the dialog's scope. A pinned file resolves
 * its Case by NAME, never `caseIdForName` (which would create an empty Case
 * for a run that failed to load); an unknown name is refused. Every file says
 * how many on-screen interfaces it matched: a whole file matching nothing
 * must be visible here, since an unmatched path is silent on the chart.
 */
async function applyLimitDrops(
  drops: readonly { file: File; plan: LimitPlan }[],
): Promise<string[]> {
  const out: string[] = [];
  for (const { file, plan } of drops) {
    let table: LimitTable;
    let warnings: string[];
    try {
      const parsed = parseLimitsCsv(await file.text(), file.name);
      out.push(...parsed.warnings);
      warnings = parsed.warnings;
      table = parsed.table;
    } catch (error) {
      const refusal = `${file.name}: ${error instanceof Error ? error.message : String(error)}`;
      out.push(refusal);
      inventory.logRefused([file], refusal);
      continue;
    }
    const paths = table.byInterface.size;
    // Bound once: narrowing a union through a property access does not survive
    // the calls between the test and the use.
    const scope = plan.scope;
    if (scope.kind === 'all') {
      const replaced = limitsStore.setSharedLimits(table);
      // A second shared file replaces the first, as the store does.
      inventory.recordSessionInput(SHARED_LIMITS_INPUT, [file], 'Limits');
      const said =
        `${file.name}: ${paths.toLocaleString()} path limit(s), shared by every Case that has ` +
        `none of its own.` +
        (replaced === null ? '' : ` This REPLACED the shared limits from ${replaced}.`);
      out.push(said);
      for (const note of [...warnings, said]) inventory.noteFiles([file], note);
      for (const entry of caseStore.listCases()) {
        const matches = limitMatchNotes(entry.id, caseLabel(entry));
        out.push(...matches);
        for (const note of matches) inventory.noteDrop(note);
      }
      continue;
    }
    const target = caseForName(caseStore.listCases(), scope.caseName);
    if (target === undefined) {
      const refusal =
        `${file.name}: assigned to Case "${scope.caseName}", which is not loaded — the ` +
        `limits were NOT applied. Its export may have been refused; load them together.`;
      out.push(refusal);
      inventory.logRefused([file], refusal);
      continue;
    }
    const replaced = limitsStore.setCaseLimits(target.id, table);
    inventory.recordCaseFile(target.id, LIMITS_COLUMN, file, 'Limits');
    const said =
      `${file.name}: ${paths.toLocaleString()} path limit(s) for Case "${caseLabel(target)}" only.` +
      (replaced === null ? '' : ` This REPLACED that Case's limits from ${replaced}.`);
    out.push(said);
    for (const note of [...warnings, said]) inventory.noteFiles([file], note);
    const matches = limitMatchNotes(target.id, caseLabel(target));
    out.push(...matches);
    for (const note of matches) inventory.noteDrop(note);
  }
  return out;
}

/** How many of one Case's monitored interfaces the limits that apply to it
 *  actually name. Silent when everything matched: a complete answer needs no
 *  sentence, and a note per Case per drop would bury the ones that matter. */
function limitMatchNotes(caseId: string, caseName: string): string[] {
  const names = new Set<string>();
  for (const row of interfaceRows()) {
    if (row.caseId !== caseId) continue;
    for (const name of row.data.interfaces) names.add(name);
  }
  if (names.size === 0) return [];
  const report = limitsStore.matchReport(caseId, [...names]);
  if (report === null || report.matched === report.total) return [];
  return [
    `Case "${caseName}": ${report.matched.toLocaleString()} of ${report.total.toLocaleString()} ` +
      `monitored interface(s) were found in ${report.source}` +
      (report.matched === 0
        ? ` — no limits will be drawn for this Case. The path names in the limits file do not ` +
          `match the ones in its export.`
        : `; the rest will draw no limit.`),
  ];
}

/** The host both ingest engines attach through: the progress line, Case
 * naming, and table attachment, recorded with the files behind the table. */
const ingestHost: IngestHost = {
  setBusy,
  caseIdForName,
  attach(caseId, slot, table, sources) {
    caseStore.attachTable(caseId, slot, table, { replace: true });
    inventory.recordTable(caseId, slot, sources);
  },
};

/**
 * The LONG Area batch. Area's own decisions: its metric union includes
 * calculated columns, its axis is the app-wide area axis, and committing on a
 * widened axis reindexes every loaded cube.
 */
const ingestAreaFiles = createAreaLongIngest(ingestHost, {
  reader: { hasSimd, NO_SIMD_MESSAGE, readCasePlan, discoverEntities },
  sig: AREA_KIND.sig,
  union: (plans) => unionOf(plans),
  axis: (plans) => unionEntities(plans, allAreas()),
  retained: (union, fileCount, axisCount) =>
    // Gated on the AREA kind's own retained set -- never a case count, never
    // `areaCases()[0]`, both of which count the other kinds' Cases too.
    retainGates.area.resolveRetained(caseStore, {
      union,
      fileCount,
      axisCount,
      coverage: new Map(),
      everything: dropKeepsEverything,
    }),
  parse: (plans, retained, axis, onProgress, groupOf) =>
    ingest(plans, retained, axis, AREA_KIND, onProgress, groupOf),
  adoptAxis,
  slot: AREA_SLOT,
  refresh: setQueryCases,
});

/** The LONG bus and generator batch: the `LongKind` passed in is the only
 * kind-specific input. */
const ingestLongFiles = createEntityLongIngest(ingestHost, {
  reader: { hasSimd, NO_SIMD_MESSAGE, readCasePlan, discoverEntities },
  // `unionMetricsOf`, not `unionOf`: the calculated columns are built by
  // `applyDerived`, which only Area's finalizer calls.
  union: (plans) => unionMetricsOf(plans),
  // No base axis. The area axis is Area's, and a bus id union merged into it
  // would put buses on the area picker and reindex every loaded area cube.
  axis: (plans) => unionEntities(plans),
  noteTablesChanged: (state) => state.noteTablesChanged(caseStore),
  pickMetrics: showLongMetricPicker,
  everything: () => dropKeepsEverything,
  parse: (plans, retained, axis, longKind, onProgress, groupOf) =>
    ingest(plans, retained, axis, longKind, onProgress, groupOf),
  refresh: setQueryCases,
});

/**
 * The four WIDE batches: one sequence in `src/app/ingest-wide.ts`, plus what
 * each kind decides (its entity set and its slot). A kind needing a new step
 * gets a hook on `WideBatch`, never a copy or a flag the engine branches on.
 */
const runWideBatch = createWideIngest(ingestHost);

/**
 * The WIDE Area batch: same `AreaTable` and area axis as `ingestAreaFiles`,
 * different parser. No axis scan (the areas are the header) and no metric
 * picker (a wide file carries one metric); the entity set is the area axis.
 */
const wideAreaBatch: WideBatch<AreaTable, Drop> = {
  reader: wideArea,
  noun: 'area',
  plural: 'areas',
  async entities(plans) {
    // ONCE, over the surviving plans plus the loaded axis: the same union rule
    // as the long path, from the header instead of a scan.
    return {
      entities: wideArea.unionOf(plans).reduce<string[]>((union, area) => {
        const name = area.trim();
        if (name && !union.includes(name)) union.push(name);
        return union;
      }, allAreas().slice()),
    };
  },
  // ONCE: every already-loaded cube, long or wide, is rebuilt on the widened
  // axis. The engine skips it when nothing committed.
  adopt: adoptAxis,
  // One Case holds one Area table, so a second wide Area file aimed at the
  // same Case is a slot collision the Import Dialog blocks before it gets here.
  slot: () => AREA_SLOT,
  refresh: setQueryCases,
};

/**
 * The bus batch: Interface's shape, plus two things of its own.
 *
 *   * **The picker opens with nothing ticked**: a full-width bus case is one
 *     Float32Array of hundreds of megabytes.
 *   * **A widening drop reopens the picker**, ticked with what is loaded; the
 *     retained set is sticky only over buses the user was shown. No realloc:
 *     each `BusTable` has its own axis and cube.
 */
const busBatch: WideBatch<BusTable, Drop> = {
  reader: busWide,
  noun: 'bus',
  plural: 'buses',
  async entities(plans) {
    const coverage = busWide.coverageOf(plans);
    // The id -> name map the picker labels its rows with, carried on the
    // coverage map under a key no bus id can collide with (ids are integers).
    coverage.set(BUS_LABELS_KEY, packBusLabels(busWide.labelsOf(plans)));
    const retained = await retainGates.bus.resolveRetained(caseStore, {
      union: busWide.unionOf(plans),
      fileCount: plans.length,
      axisCount: 0,
      coverage,
      everything: dropKeepsEverything,
    });
    // Cancelled: say so. This picker opens empty, so a silent stop would read
    // as a drop that did nothing at all. Confirmed with nothing ticked: stop
    // without a sentence, because the user has just said it.
    if (retained === null) {
      return {
        stop: [
          'No bus was selected, so no bus table was loaded. Drop the file(s) again to choose.',
        ],
      };
    }
    return retained.length === 0 ? { stop: [] } : { entities: retained };
  },
  slot: (drop) => ({ kind: 'bus', variant: drop.variant }),
  refresh: setQueryCases,
};

/**
 * The generator batch: the bus batch with a name axis (the picker opens
 * empty; a full-width case is ~170 MB). No id row or labels map: generator
 * names are unique, and a duplicate header is refused at ingest.
 */
const generatorBatch: WideBatch<GeneratorTable, Drop> = {
  reader: generatorWide,
  noun: 'generator',
  plural: 'generators',
  async entities(plans) {
    const retained = await retainGates.generator.resolveRetained(caseStore, {
      union: generatorWide.unionOf(plans),
      fileCount: plans.length,
      axisCount: 0,
      coverage: generatorWide.coverageOf(plans),
      everything: dropKeepsEverything,
    });
    if (retained === null) {
      return {
        stop: [
          'No generator was selected, so no generator table was loaded. Drop the file(s) ' +
            'again to choose.',
        ],
      };
    }
    return retained.length === 0 ? { stop: [] } : { entities: retained };
  },
  slot: (drop) => ({ kind: 'generator', variant: drop.variant }),
  refresh: setQueryCases,
};

/**
 * The Interface batch: no axis pass, no shared axis, no reindex. An empty
 * selection is passed to the reader, which refuses it by name: the picker
 * opens with everything ticked, so emptying it is worth a sentence.
 */
const interfaceBatch: WideBatch<InterfaceTable, Drop> = {
  reader: interfacePool,
  noun: 'interface',
  plural: 'interfaces',
  async entities(plans) {
    // The union of every dropped header, so a path only one file monitors can
    // still be picked.
    const retained = await retainGates.interface.resolveRetained(caseStore, {
      union: interfacePool.unionOf(plans),
      fileCount: plans.length,
      axisCount: 0,
      coverage: interfacePool.coverageOf(plans),
      everything: dropKeepsEverything,
    });
    // A path nobody was offered reopens the picker, so a path missing from
    // `retained` is one the user was shown and unticked.
    return retained === null ? { stop: [] } : { entities: retained };
  },
  slot: (drop) => ({ kind: 'interface', variant: drop.variant }),
  refresh: setQueryCases,
};

/**
 * Every loaded Case is drawn; which Cases a reader looks at is the drawer's
 * Case column. This runs after EVERY ingest of every kind (each batch's
 * `refresh`): a Case missing from `query.cases` has its rows dropped by the
 * drawer's scoping with nothing on screen to bring them back.
 */
function setQueryCases(): void {
  setQuery({ cases: caseStore.listCases().map((entry) => entry.id) });
}

/**
 * Replace every loaded Case with a bundle's, with every table. Non-destructive
 * by construction:
 *
 *   1. It runs only after the read SUCCEEDED.
 *   2. A bundle with no readable TABLE is refused, store untouched (unknown
 *      kinds still yield Cases, so a Case count is the wrong test).
 *   3. New Cases are built FIRST and old ones removed only once every table
 *      attached; a throw rolls the new ones back.
 *
 * Returns the Cases made in bundle order (`made[i]` is from the i-th case,
 * which saved pins and per-Case limits index), or null when nothing was
 * replaced.
 */
function adoptRestoredCases(
  restored: readonly RestoredCase[],
): { made: { id: string; name: string }[] } | null {
  const tableCount = restored.reduce((total, entry) => total + entry.tables.size, 0);
  if (tableCount === 0) return null;

  const previous = caseStore.listCases().map((entry) => entry.id);
  const made: { id: string; name: string }[] = [];
  try {
    for (const entry of restored) {
      const created = caseStore.createCase(entry.name);
      made.push({ id: created.id, name: created.name });
      // Every slot the bundle held, at the key it held it under -- the Area
      // table and both Interface quantities of one Case all land back on
      // ONE Case, which is the whole point of the v3 envelope.
      for (const table of entry.tables.values()) {
        caseStore.attachTable(created.id, table.key, table.data);
      }
    }
  } catch (error) {
    for (const { id } of made) caseStore.removeCase(id);
    throw error;
  }
  // The replacement is complete. Per-case limits go with their old Cases, or
  // they would sit on ids the store no longer has.
  for (const id of previous) {
    caseStore.removeCase(id);
    limitsStore.dropCaseLimits(id);
  }
  // Every drawn line's buffers are keyed by Case id, and a restore hands out
  // fresh ids, so nothing here can be reused by anything restored.
  for (const id of previous) drawLines.dropCase(id);
  // Each kind channel is a drop's account of Cases that are gone now, and
  // neither caller republishes all four: Load… writes only `session`, and a
  // drop carrying nothing but a bundle writes only `area`.
  notes.set('area', []);
  notes.set('interface', []);
  notes.set('bus', []);
  notes.set('generator', []);
  return { made };
}

/**
 * The display names a bundle saved on its Cases, onto the Cases the restore
 * made (`made[i]` is from `restored[i]`). Run after `adoptRestoredCases` has
 * removed the old Cases, whose names would otherwise refuse them. A name the
 * store refuses (a bundle naming two Cases alike) is left off and said.
 */
function adoptRestoredDisplayNames(
  restored: readonly RestoredCase[],
  made: readonly { id: string }[],
): string[] {
  const said: string[] = [];
  restored.forEach((entry, index) => {
    const target = made[index];
    if (entry.displayName === undefined || target === undefined) return;
    try {
      caseStore.setDisplayName(target.id, entry.displayName);
    } catch (error) {
      said.push(
        `Case "${entry.name}" is shown by its name: its saved display name ` +
          `"${entry.displayName}" was refused. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
  return said;
}

/** Adopt the restored study: the saved area axis (from the first restored
 * Area table, which its cubes are indexed by), then the selection. */
function adoptRestoredView(): void {
  const firstArea = areaCases()[0];
  if (firstArea) setAxis(firstArea.data.areas);
  render();
  setQueryCases();
}

/**
 * Save every loaded Case with every table it owns: `caseStore.listCases()`,
 * never `areaCases()`, which would drop every non-Area table. The guard counts
 * TABLES, not Cases, because an empty Case has no data to save.
 */
async function saveAll(): Promise<void> {
  const loaded = caseStore.listCases();
  const tableCount = loaded.reduce((total, entry) => total + entry.tables.size, 0);
  if (tableCount === 0) {
    notes.set('session', ['Nothing to save yet — drop a CSV export first.']);
    render();
    return;
  }
  try {
    setBusy('Saving…');
    // Two destinations: the .gvmb file the user keeps, and origin-private
    // storage for an instant Load on this machine. The file goes first because
    // its dialog can be cancelled. Read once so the two cannot disagree.
    const contents = {
      ...readSessionReference(limitsStore),
      selections: browseDrawer.selection(),
      layout: sessionLayout,
      drawerHeight: browseDrawer.heightPx(),
      inventory: inventory.snapshot(),
    };
    const filename = await downloadBundle(
      loaded,
      (done, total) => setBusy(`Writing case ${done} of ${total}…`),
      contents,
    );
    await saveBundle(
      loaded,
      (done, total) => setBusy(`Saving case ${done} of ${total}…`),
      contents,
    );
    notes.set('session', [
      `Saved ${loaded.length} case(s) (${tableCount} table(s)) to ${filename}, and to this ` +
        `browser's origin-private storage for the Load button. Drop the .gvmb file back in to ` +
        `restore it anywhere.`,
    ]);
  } catch (error) {
    notes.set(
      'session',
      isAbort(error)
        ? ['Save cancelled.']
        : [`Save failed: ${error instanceof Error ? error.message : String(error)}`],
    );
  } finally {
    setBusy(null);
  }
}

/**
 * Restore the reference lists a bundle carried. A bundle carrying none leaves
 * the session's lists alone: that is an older study, not an instruction to
 * forget them.
 */
function adoptRestoredLookups(lookups: Map<LookupVariant, LookupTable>, source: string): string[] {
  if (lookups.size === 0) return [];
  adoptLookups(lookups);
  return [
    `${source} carried ${[...lookups.values()]
      .map((table) => `${table.rowCount.toLocaleString()} ${table.entity} row(s)`)
      .join(' and ')}, from ${lookupSources().join(' + ')}.`,
  ];
}

/**
 * Restore the interface limits a bundle carried onto the Cases the restore
 * made (`made` in bundle order). BOTH restore paths must call this. A bundle
 * carrying none leaves the session's limits alone, as `adoptRestoredLookups`
 * does.
 */
function adoptRestoredLimits(
  limits: RestoredBundle['limits'],
  made: readonly { id: string }[],
  source: string,
): string[] {
  if (limits.shared === undefined && limits.byIndex.size === 0) return [];
  const remapped = restoreCaseLimits(limits.byIndex, made);
  const orphaned = limits.dropped + limits.byIndex.size - remapped.length;
  limitsStore.adoptLimits(limits.shared, remapped);
  const parts: string[] = [];
  if (limits.shared !== undefined) {
    parts.push(`shared limits from ${limits.shared.source}`);
  }
  if (remapped.length > 0) {
    parts.push(`limits pinned to ${remapped.length} case(s)`);
  }
  return [
    `${source} carried ${parts.join(' and ')}.` +
      (orphaned > 0
        ? ` ${orphaned} case-specific limit table(s) named a Case the bundle no longer carries ` +
          `and were dropped.`
        : ''),
  ];
}

/** Adopt a bundle's grouping mapping: its numbers were built under it, so it
 * wins, and the change is announced. */
function adoptGroupings(csv: string | null, source: string, taken: Set<string>): string[] {
  if (csv === null) {
    return [`${source} predates saved groupings — the mapping now loaded was left alone.`];
  }
  if (csv === exportGroupings()) {
    taken.add(groupsInput('area'));
    return [];
  }
  try {
    const summaryNotes = groupingNotes(setGroupings(csv), `Groupings came from ${source}`);
    taken.add(groupsInput('area'));
    // The drawer holds built tabs until the signature moves; a restored
    // mapping IS a moved one, and the rev is what says so.
    groupingsRev++;
    return summaryNotes;
  } catch (error) {
    return [`${source}: ${error instanceof Error ? error.message : String(error)}`];
  }
}

/** The loaded GeneratorList's own names, or undefined with no list loaded:
 * the key set generator membership is judged against, taken fresh on every
 * call because a replaced list changes it wholesale. */
function generatorListNames(): string[] | undefined {
  const list = lookupFor('generatorlist');
  return list === undefined ? undefined : Array.from(list.index.keys(), String);
}

/** Unit names that carry data in at least one loaded generator table, for the
 * editor's "offered but no data" flag. Presence, not the axis alone: a unit
 * the export lists and never carried is offered and flagged, not hidden. */
function generatorUnitsWithData(): Set<string> {
  const present = new Set<string>();
  for (const { data } of generatorRows()) {
    data.generators.forEach((name, index) => {
      if (data.presence[index] === 1) present.add(name);
    });
  }
  return present;
}

/** Every unit name the group editor may offer: the loaded list's names plus
 * every name on any loaded table's axis -- the join the Generator tab's own
 * rows are, minus the stats. */
function generatorUniverse(): string[] {
  const names = new Set<string>(generatorListNames() ?? []);
  for (const { data } of generatorRows()) data.generators.forEach((name) => names.add(name));
  return [...names];
}

/** Load a generator membership CSV through an explicit mapping, returning
 * notes for the drop's `routed` channel. */
function loadGeneratorGroupsFile(
  text: string,
  mapping: GeneratorGroupMapping,
  lead: string,
): string[] {
  const load = loadGeneratorGroups(
    text,
    mapping,
    indexForMapping(lookupFor('generatorlist'), mapping),
  );
  generatorGroupsRev++;
  return generatorGroupNotes(load.summary, `${lead}: generator groups loaded`);
}

/** Commit the editor's answer: membership as names, with the kept-unresolved
 * rows riding along. */
function applyGeneratorMembership(edit: GeneratorGroupEdit): void {
  setGeneratorMembership(edit.members, edit.unresolved);
  generatorGroupsRev++;
  notes.set(
    'session',
    generatorGroupNotes(summarizeGeneratorGroups(generatorListNames()), 'Generator groups updated'),
  );
  render();
}

/**
 * A groups editor's Apply, after the membership is adopted: a file loaded in
 * the editor becomes the kind's groups row, flagged when it was edited before
 * Apply. With no file, an edit still flags whatever row stands, since that
 * file no longer says what grouping is in effect. A cancel never gets here.
 */
function recordEditorGroups(kind: TableKind, applied: EditorApplied<unknown>): void {
  if (applied.source !== null) {
    inventory.recordSessionInput(
      groupsInput(kind),
      [applied.source.file],
      `${kindLabel(kind)} groups`,
      {
        editedInApp: applied.source.editedInApp,
      },
    );
  } else if (applied.changed) {
    inventory.markEdited(groupsInput(kind));
  }
}

function openGeneratorGroupEditor(fromBrowse?: {
  units: ReadonlySet<string>;
  open: boolean;
}): void {
  const listed = generatorListNames();
  void showGeneratorGroupEditor({
    present: generatorUnitsWithData(),
    universe: generatorUniverse(),
    listed: listed === undefined ? undefined : new Set(listed),
    fromBrowse,
  }).then((edit) => {
    if (edit === null) return;
    try {
      applyGeneratorMembership(edit.value);
      recordEditorGroups('generator', edit);
    } catch (error) {
      notes.set('session', [error instanceof Error ? error.message : String(error)]);
      render();
    }
  });
}

/**
 * The unit names in a run of Generator tab rows, or undefined when there are
 * none. Rows are per (case, slot, entity), so the set is the union and the
 * caller states both counts when they differ. Grouped rows (buckets, not
 * units) are dropped. Undefined (nothing to offer) differs from an empty set
 * (a narrowing that keeps nothing).
 */
function generatorTabUnits(
  rows: readonly BrowseRowRef[] | undefined,
  open: boolean,
): { units: ReadonlySet<string>; open: boolean } | undefined {
  if (rows === undefined) return undefined;
  const units = new Set<string>();
  for (const ref of rows) {
    if (ref.groupBy !== undefined) continue;
    units.add(String(ref.entity));
  }
  return units.size === 0 ? undefined : { units, open };
}

/** Open the group editor over the units the Generator tab shows: filtering
 * the table is a better picker than a modal's name list. Only NAMES cross, and
 * the editor still applies or cancels as a whole. */
function openGroupEditorFromBrowse(shown: readonly BrowseRowRef[]): void {
  const from = generatorTabUnits(shown, true);
  if (from === undefined) {
    notes.set('session', [
      'Nothing to add: the Generator tab is showing no rows, so its filters keep no units.',
    ]);
    render();
    return;
  }
  if (from.units.size !== shown.length) {
    notes.set('session', [
      `Generator groups: ${shown.length.toLocaleString()} shown row(s) are ` +
        `${from.units.size.toLocaleString()} distinct unit(s) — membership is by name, so a ` +
        `unit in several cases is one member.`,
    ]);
    render();
  }
  openGeneratorGroupEditor(from);
}

/** The BusList's own ids, or undefined when no list is loaded -- the
 * difference the editor draws between "not in BusList" and "unchecked". */
function busListIds(): number[] | undefined {
  const list = lookupFor('buslist');
  return list === undefined
    ? undefined
    : Array.from(list.index.keys(), Number).filter(Number.isInteger);
}

/** Bus ids that carry data in at least one loaded bus table, for the editor's
 * "offered but no data" flag. Presence, not the axis alone. */
function busesWithData(): Set<number> {
  const present = new Set<number>();
  for (const { data } of busRows()) {
    data.buses.forEach((id, index) => {
      if (data.presence[index] === 1) present.add(id);
    });
  }
  return present;
}

/** Every bus id the group editor may offer: the loaded list's ids plus every
 * id on any loaded table's axis -- the join the Bus tab's own rows are, minus
 * the stats. */
function busUniverse(): number[] {
  const ids = new Set<number>(busListIds() ?? []);
  for (const { data } of busRows()) data.buses.forEach((id) => ids.add(id));
  return [...ids];
}

/** Load a bus membership CSV through an explicit mapping. Notes come back
 * rather than being written, exactly as the generator loader's do. */
function loadBusGroupsFile(text: string, mapping: BusGroupMapping, lead: string): string[] {
  const load = loadBusGroups(text, mapping, indexForBusMapping(lookupFor('buslist')));
  busGroupsRev++;
  return busGroupNotes(load.summary, `${lead}: bus groups loaded`);
}

/** Commit the editor's answer: membership as ids, with the kept-unresolved
 * name rows riding along. */
function applyBusMembership(edit: BusGroupEdit): void {
  setBusMembership(edit.members, edit.unresolved);
  busGroupsRev++;
  notes.set('session', busGroupNotes(summarizeBusGroups(busListIds()), 'Bus groups updated'));
  render();
}

function openBusGroupEditor(fromBrowse?: { buses: ReadonlySet<number>; open: boolean }): void {
  const listed = busListIds();
  void showBusGroupEditor({
    present: busesWithData(),
    universe: busUniverse(),
    listed: listed === undefined ? undefined : new Set(listed),
    fromBrowse,
  }).then((edit) => {
    if (edit === null) return;
    try {
      applyBusMembership(edit.value);
      recordEditorGroups('bus', edit);
    } catch (error) {
      notes.set('session', [error instanceof Error ? error.message : String(error)]);
      render();
    }
  });
}

/** The bus ids in a run of Bus tab rows, by the rules of `generatorTabUnits`. */
function busTabIds(
  rows: readonly BrowseRowRef[] | undefined,
  open: boolean,
): { buses: ReadonlySet<number>; open: boolean } | undefined {
  if (rows === undefined) return undefined;
  const buses = new Set<number>();
  for (const ref of rows) {
    if (ref.groupBy !== undefined) continue;
    const id = Number(ref.entity);
    if (Number.isInteger(id)) buses.add(id);
  }
  return buses.size === 0 ? undefined : { buses, open };
}

/** Every interface name on any loaded table's axis -- the only universe this
 * kind has, since there is no list file to widen it with. */
function interfaceUniverse(): string[] {
  const names = new Set<string>();
  for (const { data } of interfaceRows()) for (const name of data.interfaces) names.add(name);
  return [...names];
}

/** Interface names that carry data in at least one loaded table, for the
 * editor's "offered but no data" flag. Presence, not the axis alone. */
function interfacesWithData(): Set<string> {
  const present = new Set<string>();
  for (const { data } of interfaceRows()) {
    data.interfaces.forEach((name, index) => {
      if (data.presence[index] === 1) present.add(name);
    });
  }
  return present;
}

/** Load an interface membership CSV through an explicit mapping. Notes come
 * back rather than being written, exactly as the other two loaders' do. */
function loadInterfaceGroupsFile(
  text: string,
  mapping: InterfaceGroupMapping,
  lead: string,
): string[] {
  const load = loadInterfaceGroups(text, mapping, interfaceUniverse());
  interfaceGroupsRev++;
  return interfaceGroupNotes(load.summary, `${lead}: interface groups loaded`);
}

/** Commit the editor's answer: membership with a direction per member. */
function applyInterfaceMembership(edit: InterfaceGroupEdit): void {
  setInterfaceMembership(edit.members);
  interfaceGroupsRev++;
  notes.set(
    'session',
    interfaceGroupNotes(summarizeInterfaceGroups(interfaceUniverse()), 'Interface groups updated'),
  );
  render();
}

function openInterfaceGroupEditor(fromBrowse?: {
  names: ReadonlySet<string>;
  open: boolean;
}): void {
  void showInterfaceGroupEditor({
    present: interfacesWithData(),
    universe: interfaceUniverse(),
    fromBrowse,
  }).then((edit) => {
    if (edit === null) return;
    try {
      applyInterfaceMembership(edit.value);
      recordEditorGroups('interface', edit);
    } catch (error) {
      notes.set('session', [error instanceof Error ? error.message : String(error)]);
      render();
    }
  });
}

/** The interface names carried by a run of Interface tab rows, or undefined
 * when there are none to offer. The generator twin's two honesty rules apply
 * unchanged. */
function interfaceTabNames(
  rows: readonly BrowseRowRef[] | undefined,
  open: boolean,
): { names: ReadonlySet<string>; open: boolean } | undefined {
  if (rows === undefined) return undefined;
  const names = new Set<string>();
  for (const ref of rows) {
    if (ref.groupBy !== undefined) continue;
    names.add(String(ref.entity));
  }
  return names.size === 0 ? undefined : { names, open };
}

/** Open the interface group editor over the paths the Interface tab is
 * showing -- the twin of `openGroupEditorFromBrowse`. */
function openInterfaceEditorFromBrowse(shown: readonly BrowseRowRef[]): void {
  const from = interfaceTabNames(shown, true);
  if (from === undefined) {
    notes.set('session', [
      'Nothing to add: the Interface tab is showing no rows, so its filters keep no paths.',
    ]);
    render();
    return;
  }
  if (from.names.size !== shown.length) {
    notes.set('session', [
      `Interface groups: ${shown.length.toLocaleString()} shown row(s) are ` +
        `${from.names.size.toLocaleString()} distinct path(s) — membership is by name, so a ` +
        `path in several cases is one member.`,
    ]);
    render();
  }
  openInterfaceGroupEditor(from);
}

/** What the loaded interface membership covers, and how much of it is counted
 * backwards -- the figure no other kind's notes have, and the one a boundary
 * cannot be read without. */
function interfaceGroupNotes(summary: InterfaceGroupsSummary, lead: string): string[] {
  const messages = [
    `${lead}: ${summary.groups} group(s) naming ${summary.mapped} of the loaded path(s), ` +
      `${summary.reversed} of them counted reversed.`,
  ];
  if (summary.offAxis.length > 0) {
    messages.push(
      `${summary.offAxis.length} path(s) in the groups are monitored by no loaded case and ` +
        `cannot be plotted: ${summary.offAxis.slice(0, 20).join(', ')}` +
        `${summary.offAxis.length > 20 ? ', …' : ''}.`,
    );
  }
  return messages;
}

/** Take on the interface group membership a bundle was saved under. A bundle
 * carrying none leaves the session's map alone. */
function adoptSavedInterfaceGroups(saved: SavedInterfaceGroups | null, source: string): string[] {
  if (saved === null) {
    return [`${source} carried no interface group membership — the map now loaded was left alone.`];
  }
  if (JSON.stringify(exportInterfaceGroups()) === JSON.stringify(saved)) return [];
  adoptInterfaceGroups(saved);
  interfaceGroupsRev++;
  return interfaceGroupNotes(
    summarizeInterfaceGroups(interfaceUniverse()),
    `Interface groups came from ${source}`,
  );
}

/** What the loaded bus membership covers. No figure here is a bus count: a
 * bus in several groups counts once per group. */
function busGroupNotes(summary: BusGroupsSummary, lead: string): string[] {
  const list = lookupFor('buslist');
  const messages = [
    list === undefined
      ? `${lead}: ${summary.groups} group(s); no BusList is loaded, so which of their buses ` +
        `this study carries is unchecked.`
      : `${lead}: ${summary.groups} group(s) naming ${summary.mapped} of the ` +
        `${list.rowCount.toLocaleString()} bus(es) in BusList.csv.`,
  ];
  if (summary.offList.length > 0) {
    messages.push(
      `${summary.offList.length} bus number(s) in the groups are carried by no loaded BusList ` +
        `and cannot be plotted: ${summary.offList.slice(0, 20).join(', ')}` +
        `${summary.offList.length > 20 ? ', …' : ''}.`,
    );
  }
  const kept = unresolvedBusMembershipRows();
  if (kept.length > 0) {
    messages.push(
      `${kept.length} row(s) name a bus no loaded BusList resolves to one id; they are kept ` +
        `and flagged, not dropped.`,
    );
  }
  return messages;
}

/** Take on the bus group membership a bundle was saved under. A bundle
 * carrying none leaves the session's map alone; that is a study saved with no
 * map, not an instruction to forget one. */
function adoptSavedBusGroups(saved: SavedBusGroups | null, source: string): string[] {
  if (saved === null) {
    return [`${source} carried no bus group membership — the map now loaded was left alone.`];
  }
  if (JSON.stringify(exportBusGroups()) === JSON.stringify(saved)) return [];
  adoptBusGroups(saved);
  busGroupsRev++;
  return busGroupNotes(summarizeBusGroups(busListIds()), `Bus groups came from ${source}`);
}

/** Open the bus group editor over the buses the Bus tab shows. */
function openBusEditorFromBrowse(shown: readonly BrowseRowRef[]): void {
  const from = busTabIds(shown, true);
  if (from === undefined) {
    notes.set('session', [
      'Nothing to add: the Bus tab is showing no rows, so its filters keep no buses.',
    ]);
    render();
    return;
  }
  if (from.buses.size !== shown.length) {
    notes.set('session', [
      `Bus groups: ${shown.length.toLocaleString()} shown row(s) are ` +
        `${from.buses.size.toLocaleString()} distinct bus(es) — membership is by bus number, ` +
        `so a bus in several cases is one member.`,
    ]);
    render();
  }
  openBusGroupEditor(from);
}

/** What the membership covers, stated. No figure is a fleet size: a unit in
 * several groups counts once per group. */
function generatorGroupNotes(summary: GeneratorGroupsSummary, lead: string): string[] {
  const list = lookupFor('generatorlist');
  const messages = [
    list === undefined
      ? `${lead}: ${summary.groups} group(s); no GeneratorList is loaded, so which of their units ` +
        `this study carries is unchecked.`
      : `${lead}: ${summary.groups} group(s) naming ${summary.mapped} of the ` +
        `${list.rowCount.toLocaleString()} generator(s) in GeneratorList.csv.`,
  ];
  if (summary.offList.length > 0) {
    messages.push(
      `${summary.offList.length} name(s) in the groups are carried by no loaded GeneratorList ` +
        `and cannot be plotted: ${summary.offList.join(', ')}.`,
    );
  }
  const kept = unresolvedMembershipRows();
  if (kept.length > 0) {
    messages.push(
      `${kept.length} row(s) name a bus number and unit ID no loaded GeneratorList carries; ` +
        `they are kept and flagged, not dropped.`,
    );
  }
  return messages;
}

/** Adopt a bundle's generator group map; one carrying none leaves the
 * session's map alone. */
function adoptSavedGeneratorGroups(saved: SavedGeneratorGroups | null, source: string): string[] {
  if (saved === null) {
    return [`${source} carried no generator group membership — the map now loaded was left alone.`];
  }
  if (JSON.stringify(exportGeneratorGroups()) === JSON.stringify(saved)) return [];
  adoptGeneratorGroups(saved);
  generatorGroupsRev++;
  return generatorGroupNotes(
    summarizeGeneratorGroups(generatorListNames()),
    `Generator groups came from ${source}`,
  );
}

/** Where Load… reads a bundle from, as the Contents Log names it. */
const OPFS_SOURCE = 'origin-private storage';

/**
 * Take up a restored bundle's inventory, once every table and session input
 * has been adopted: the pivot and Log become the bundle's, and whatever it
 * listed that the restore did not take up is logged `dropped at restore`.
 * BOTH restore paths must call this, after the other `adopt*` calls.
 *
 * `taken` holds the inputs whose adoption can fail on its own (the area
 * groupings); the rest follow their stores' rules, read off `loaded`: a
 * carried list or group map is always adopted, and any limits block replaces
 * the shared limits, even with none.
 */
function adoptRestoredInventory(
  loaded: RestoredBundle,
  made: readonly { id: string }[],
  source: File | string,
  taken: ReadonlySet<string>,
): void {
  const adopted = new Set(taken);
  for (const variant of loaded.lookups.keys()) adopted.add(variant);
  if (loaded.generatorGroups !== null) adopted.add(groupsInput('generator'));
  if (loaded.busGroups !== null) adopted.add(groupsInput('bus'));
  if (loaded.interfaceGroups !== null) adopted.add(groupsInput('interface'));
  if (loaded.limits.shared !== undefined || loaded.limits.byIndex.size > 0) {
    adopted.add(SHARED_LIMITS_INPUT);
  }
  const caseLimits = limitsStore.caseLimits();
  inventory.restore(loaded.inventory, {
    made,
    present: (caseId, slot) =>
      slot.kind === LIMITS_COLUMN
        ? caseLimits.has(caseId)
        : (caseStore
            .listCases()
            .find((entry) => entry.id === caseId)
            ?.tables.has(slotKey(slot as TableSlotKey)) ?? false),
    adopted,
    source,
  });
}

/**
 * Everything a restore adopts once `adoptRestoredCases` has made its Cases,
 * for both restore paths: display names before the view repaints, and the
 * inventory last, since it reconciles against every other input's adoption.
 * `named` is the bundle as a note names it mid-sentence and at its start.
 * Returns the notes.
 */
function adoptRestoredSession(
  loaded: RestoredBundle,
  made: readonly { id: string; name: string }[],
  source: File | string,
  named: { inline: string; start: string },
): string[] {
  const displayNotes = adoptRestoredDisplayNames(loaded.restoredCases, made);
  adoptRestoredView();
  browseDrawer.setSelection(restorePins(loaded.pins, made));
  if (loaded.layout && loaded.layout.length === 4) {
    syncLayoutToCharts(loaded.layout as SlotType[]);
  }
  if (typeof loaded.drawerHeight === 'number') {
    browseDrawer.restoreHeight(loaded.drawerHeight);
  }
  const taken = new Set<string>();
  const said = [
    ...displayNotes,
    ...adoptGroupings(loaded.groupings, named.inline, taken),
    ...adoptSavedGeneratorGroups(loaded.generatorGroups, named.start),
    ...adoptSavedBusGroups(loaded.busGroups, named.start),
    ...adoptSavedInterfaceGroups(loaded.interfaceGroups, named.start),
    ...adoptRestoredLookups(loaded.lookups, named.start),
    ...adoptRestoredLimits(loaded.limits, made, named.start),
  ];
  adoptRestoredInventory(loaded, made, source, taken);
  return said;
}

/**
 * Restore a dropped .gvmb (or a legacy .gvap/.gvip). Returns its notes rather
 * than writing them, so table files in the same drop cannot overwrite the
 * restore's account.
 */
async function restoreBundleFile(file: File): Promise<string[]> {
  try {
    setBusy(`Restoring ${file.name}…`);
    const loaded = await readBundleFile(file);
    // Dropped-kind and migration notices are the only account of what the
    // bundle lost, so they show whether or not the restore was taken up.
    const adopted = adoptRestoredCases(loaded.restoredCases);
    if (!adopted) {
      const refusal =
        `${file.name} carried no table this build can read — the loaded study was left as it ` +
        `was, nothing was replaced.`;
      inventory.logRefused([file], refusal);
      return [refusal, ...loaded.warnings];
    }
    return [
      `Restored ${loaded.restoredCases.length} case(s) from ${file.name}.`,
      ...loaded.warnings,
      ...adoptRestoredSession(loaded, adopted.made, file, { inline: file.name, start: file.name }),
    ];
  } catch (error) {
    // Nothing was removed: every failure above happens either inside
    // `readBundleFile` (before the store is touched at all) or inside
    // `adoptRestoredCases`, which rolls its own partial work back.
    const refusal = `${file.name}: ${error instanceof Error ? error.message : String(error)}`;
    inventory.logRefused([file], refusal);
    return [refusal];
  } finally {
    setBusy(null);
  }
}

/** Restore this browser's origin-private cache. Rejects when there is none
 * (normal on another machine), and the caller falls back to a file. */
async function loadAll(): Promise<void> {
  closeContents();
  try {
    setBusy('Loading…');
    let loaded: RestoredBundle;
    let adopted: ReturnType<typeof adoptRestoredCases>;
    try {
      loaded = await loadBundle();
      adopted = adoptRestoredCases(loaded.restoredCases);
    } catch (error) {
      // "Nothing saved here" is not a refusal: the caller falls through to a
      // file picker. Anything else is a bundle this build turned away.
      if (!isMissingBundle(error)) {
        inventory.logRefusedSource(
          OPFS_SOURCE,
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    }
    if (!adopted) {
      const refusal =
        'The saved bundle carried no table this build can read — the loaded study was left as ' +
        'it was, nothing was replaced.';
      inventory.logRefusedSource(OPFS_SOURCE, refusal);
      notes.set('session', [refusal, ...loaded.warnings]);
      render();
      return;
    }
    notes.set('session', [
      `Loaded ${loaded.restoredCases.length} case(s) from origin-private storage.`,
      ...loaded.warnings,
      ...adoptRestoredSession(loaded, adopted.made, OPFS_SOURCE, {
        inline: 'the saved bundle',
        start: 'The saved bundle',
      }),
    ]);
    render();
  } finally {
    setBusy(null);
  }
}

// ---------------------------------------------------------------- wiring

/** The section host and template. Only main.ts resolves global ids
 * (`tests/test_dom_contract.mjs`); everything else is handed a root. */
const sectionHost = document.getElementById('sections');
const sectionTemplate = document.getElementById('section-template');
if (!sectionHost || !(sectionTemplate instanceof HTMLTemplateElement)) {
  throw new Error('index.html is missing #sections or #section-template');
}

const appChrome = document.getElementById('app-root');
if (!appChrome) throw new Error('index.html is missing #app-root');

/** Mounted ONCE; `sections.sync` only shows and hides it, so the focused pane
 * and filter chips survive the table count passing through zero. */
const sections = createSectionHost(sectionHost, sectionTemplate);

/** One retain gate per kind, built once. Not on a section: which columns a
 * drop keeps must not depend on what is on screen. */
const retainGates = createRetainGates();

let sessionLayout: SlotType[] = [...DEFAULT_SLOTS];

function syncLayoutToCharts(layout: readonly SlotType[]): void {
  sessionLayout = [...layout];
  if (typeof areaSection !== 'undefined' && areaSection.charts) {
    areaSection.charts.setLayout(sessionLayout);
  }
}

function handleLayoutChange(layout: readonly SlotType[]): void {
  syncLayoutToCharts(layout);
}

const areaRoot = sections.add('area', 'Area');
const areaSection = mountAreaSection(areaRoot, {
  initialLayout: sessionLayout,
  onLayoutChange: handleLayoutChange,
  onBoxDimChange: (dim) => setQuery({ boxDim: dim }),
  onFiltersChange: setFilters,
  onFigure: (capture) => openFigureDialog({ capture, hourFilter: filtersLabel(query.filters) }),
});
const shell = areaSection.rail;
const charts = areaSection.charts;

/** The browse drawer: global chrome spanning every kind, so it keeps its ids
 * and main.ts resolves it. */
const browseHost = document.getElementById('browse-drawer');
if (!browseHost) throw new Error('index.html is missing #browse-drawer');
const browseDrawer = createBrowseDrawer(
  browseHost,
  {
    resolveColor(ref) {
      if (ref.kind === 'generator' && ref.groupBy) {
        // Every derived attribute carries its own palette, so no branch is
        // needed here.
        return derivedAttribute(ref.groupBy)?.color(String(ref.groupValue ?? ref.entity));
      }
      return undefined;
    },
    onSelectionChange(pinned, preview) {
      // A pinned row is a `SeriesSpec`, and the kind that owns the axis
      // resolves it into a line. The drawn set is still drawn into that kind's
      // section panes.
      browsePinned = pinned;
      browsePreview = preview;
      render();
    },
    onVariableChange(variable) {
      // A view control: re-list and re-rank, never clear the selection (pins
      // span variables). It moves the ACTIVE kind's variable and its paired
      // groups tab's, nothing else.
      const active = browseDrawer.activeTabId();
      browse.set(active, variable);
      const paired = PAIRED_TABS[active];
      // A paired tab that cannot offer this quantity keeps its own, rather than
      // silently falling back to its first quantity.
      if (paired !== undefined && browse.offered(paired, variable)) {
        browse.set(paired, variable);
      }
      render();
    },
    onDownloadHourly(download) {
      void downloadHourly(download);
    },
    onAction(tabId, actionId, shown) {
      if (actionId === 'add-shown-to-group') {
        // Routed by the tab it was clicked on, never by the rows: two kinds
        // offer this button and a row's `kind` is the only other thing that
        // could say which, which would make an empty table unroutable.
        if (tabId === 'bus') openBusEditorFromBrowse(shown);
        else if (tabId === 'interface') openInterfaceEditorFromBrowse(shown);
        else openGroupEditorFromBrowse(shown);
        return;
      }
      if (actionId !== 'edit-groups') return;
      if (tabId === 'generator-groups') {
        // The filtering happened on the ENTITY tab, so ask the drawer for that
        // tab's survivors. Undefined adds no dropdown entry.
        openGeneratorGroupEditor(generatorTabUnits(browseDrawer.filteredRows('generator'), false));
        return;
      }
      if (tabId === 'bus-groups') {
        openBusGroupEditor(busTabIds(browseDrawer.filteredRows('bus'), false));
        return;
      }
      if (tabId === 'interface-groups') {
        openInterfaceGroupEditor(interfaceTabNames(browseDrawer.filteredRows('interface'), false));
        return;
      }
      void showGroupEditor({ present: presentAreas() }).then((csv) => {
        if (csv === null) return;
        try {
          notes.set('session', applyGroupings(csv.value));
          recordEditorGroups('area', csv);
        } catch (error) {
          notes.set('session', [error instanceof Error ? error.message : String(error)]);
        }
        render();
      });
    },
    onSelectedVariableChange(variable) {
      const next = retargetVariable(browseDrawer.selection(), variable, pinRetargets());
      // The kind's tabs follow where their scope offers it, so the next tick
      // matches the pins. An entity tab's id is its kind's name. Set before the
      // pins land: that is the one render.
      const kind = next[0]?.ref.kind;
      for (const tab of kind === undefined ? [] : [kind, PAIRED_TABS[kind]]) {
        if (tab !== undefined && browse.offered(tab, variable)) browse.set(tab, variable);
      }
      browseDrawer.replacePins(next);
    },
    onSelectedCaseChange(caseId) {
      browseDrawer.replacePins(
        retargetCase(browseDrawer.selection(), caseId, caseChoices(), pinRetargets()),
      );
    },
    onSelectedPercent(on) {
      // The drawer's mode follows before the pins land, so the next tick
      // matches them in one render.
      browseDrawer.setPerUnit(on);
      browseDrawer.replacePins(retargetPercent(browseDrawer.selection(), on, pinRetargets()));
    },
    onTabChange() {
      // The variable dropdown belongs to the kind on screen, so a tab switch is
      // a re-render like any other view change. It moves no selection.
      render();
    },
    onPerUnitChange() {
      render();
    },
  },
  within(areaRoot, '[data-el="slicer-pane"]'),
);

/** The global chrome, wired ONCE for the whole app. */
const chrome = createChrome(appChrome, {
  onFiles(files) {
    void loadFiles(files);
  },
  onAddCases() {
    fileInput.click();
  },
  onSave: saveAll,
  onContents: openContents,
  onLoad() {
    // Try the origin-private cache first. "Nothing saved here yet" is normal on
    // another machine and falls through to a file picker. Anything else (a
    // stale version, a corrupt blob) means a bundle IS there and this build
    // will not read it: say so, and skip the picker.
    void loadAll().catch((error: unknown) => {
      if (isMissingBundle(error)) {
        bundleInput.click();
        return;
      }
      notes.set('session', [error instanceof Error ? error.message : String(error)]);
      render();
    });
  },
});

// Refuse without SIMD rather than carry a second parser that would also have
// to be verified bit-exact.
if (!hasSimd()) {
  notes.set('blocked', [NO_SIMD_MESSAGE]);
} else {
  // The area parse pool cannot warm yet (its workers hash the area axis, which
  // no file has supplied); storage and interface pools can.
  warmStorage();
  interfacePool.warmPool();
}

render();
