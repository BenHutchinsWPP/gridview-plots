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
import {
  allAreas,
  exportGroupings,
  setAxis,
  setGroupings,
  type GroupingSummary,
} from './tables/area/groupings';
// Reference lists: session-wide, beside `groupings`, never a Case slot.
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
import { createLimitsStore } from './limits/store';
import { createScratch, hasData } from './tables/area/kernels';
import * as longPool from './tables/long/pool';
import type { GroupEditingHost } from './app/group-editing';
import {
  downloadBundle,
  isMissingBundle,
  loadBundle,
  readBundleFile,
  saveBundle,
  warmStorage,
  type RestoredBundle,
} from './storage/store';
import { showLongMetricPicker } from './ui/long-metric-picker';
import * as wideArea from './tables/area/wide';
import * as busWide from './tables/bus/wide';
import * as generatorWide from './tables/generator/wide';
import * as interfacePool from './tables/interface/pool';
import type { Filters } from './model/types';
import { BOX_DIMS, type AreaQuery, type BoxDim } from './tables/area/types';
import { caseForName, CaseStore, type TableKind } from './model/case-model';
import type { EditorApplied } from './ui/membership-editor';
import { reindexCase, sameAxis } from './tables/area/axis';
import { seriesCapMessage, type SlotType } from './ui/charts';
import { showGroupEditor } from './tables/area/ui/groups';
import { readCsvHeader, showGroupingsMapping } from './ui/groupings-mapping';
import { mountSection } from './ui/section';
import { createScratchPool, createSeriesPool } from './series/pool';
import { showImportDialog } from './ui/import-dialog';
import { createRetainGates } from './tables/registry';
import { createInventory, groupsInput } from './inventory/store';
import { showContentsPanel } from './ui/contents-panel';
import { createChrome, createSectionHost } from './ui/shell';
import { createBrowseDrawer, type HourlyDownload } from './ui/browse-drawer';
import { exportHourly } from './app/hourly-export';
import { openFigureDialog } from './figure/dialog';
import { confirmLargeDownload } from './ui/confirm-allocation';
import { within } from './ui/dom';
import {
  restorePins,
  type BrowseRowRef,
  type PinLine,
  type SelectionEntry,
} from './ui/browse-model';
import { PREVIEW_COLOR } from './series/model';
import type { IngestHost } from './app/batch';
import { AREA_SLOT, createIngestKinds } from './app/ingest-kinds';
import { createDropLoad } from './app/drop-load';
import { createNotesLedger } from './app/notes-ledger';
import { readSessionReference } from './session/reference';
import { createBrowseScopes, filtersLabel } from './app/browse-scope';
import { createRankMemo } from './kernels';
import { resolveDraw } from './app/draw';
import {
  computeFrame,
  datesCleared,
  drawContextOf,
  lineSourceOf,
  type DrawSource,
} from './app/render-frame';
import { saveBlob } from './ui/download';
import { createCaseViews } from './app/case-views';
import { createLimitLines } from './app/limit-lines';
import { createContents, kindLabel } from './app/contents';
import { createGroupKinds } from './app/group-kinds';
import { createSaveRestore } from './app/save-restore';
import { createBrowseWiring } from './app/browse-wiring';

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

/** Every read of the store the rest of the app makes. */
const views = createCaseViews(caseStore);
const { areaCases, interfaceRows, busRows, generatorRows } = views;

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
 *   * the four kinds -- one drop's own account, written by `dropLoad` only.
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
    dates: null,
    hoursOfDay: null,
    daysOfWeek: null,
    seasons: null,
    tou: null,
  }) as Filters,
  boxDims: Object.freeze(['case', 'case', 'case', 'case']) as readonly BoxDim[],
});

function setQuery(patch: Partial<AreaQuery>): void {
  query = Object.freeze({ ...query, ...patch });
  render();
}

function setFilters(patch: Partial<Filters>): void {
  setQuery({ filters: Object.freeze({ ...query.filters, ...patch }) });
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

// ------------------------------------------------------------------- FIND

/** The drawer's selection as the render path reads it. Pins, unpins and
 * previews all end in `render()`: one repaint path for the whole app. */
let browsePinned: readonly SelectionEntry[] = [];
let browsePreview: BrowseRowRef | null = null;

/** Each pin's line as the last render resolved it, by row id. */
let browsePinLines = new Map<string, PinLine>();

function allBrowseDraws(): { ref: BrowseRowRef; color: string; dashed: boolean }[] {
  const out = browsePinned.map((entry) => ({ ref: entry.ref, color: entry.color, dashed: false }));
  if (browsePreview) {
    out.push({ ref: browsePreview, color: PREVIEW_COLOR, dashed: true });
  }
  return out;
}

/** The limits drawn and said, read against the store this module holds. */
const drawnLimits = createLimitLines({
  limits: limitsStore,
  interfaceRows,
  yearOfCase: views.yearOfCase,
});

/** What a draw reads from this module's state, through accessors so a removed
 * Case can never come back from a snapshot. */
const drawSource: DrawSource = {
  caseLabel: views.caseLabel,
  caseNames: views.caseNames,
  areaCases,
  interfaceRows,
  busRows,
  generatorRows,
  busNames: views.busNames,
  busKv,
  interfaceRange: drawnLimits.interfaceRange,
};
const drawnSource = lineSourceOf(drawContextOf(drawSource, () => query.filters, drawLines));

/** A year overview's lines: the drawn set again, dates cleared, into buffers
 * of its own so the drawn lines' contents never move. */
const overviewLines = createSeriesPool();
const overviewSource = lineSourceOf(
  drawContextOf(
    drawSource,
    datesCleared(() => query.filters),
    overviewLines,
  ),
);

/** The drawer's hourly download resolves through the same draw, into ONE
 * buffer set of its own: the drawn pool's keys and contents never move. */
const exportContext = drawContextOf(drawSource, () => query.filters, createScratchPool());

/** Compute the render as a frame (`src/app/render-frame.ts`), then paint it.
 * The frame fixes what is computed in which order; this fixes the paint order,
 * and `settle` must follow the charts, which are what ask for the whole year. */
function render(): void {
  const hasCases = caseStore.listCases().length > 0;
  const frame = computeFrame({
    query,
    cap: (lines) => seriesCapMessage(lines, [{ label: 'pinned row(s)', count: lines }]),
    draws: allBrowseDraws(),
    pinnedIds: browsePinned.map((entry) => entry.ref.id),
    notes: notes.all(),
    hasCases,
    drawn: drawnSource,
    overview: overviewSource,
    limitLines: drawnLimits.limitLines,
    yearOfCase: views.yearOfCase,
    boxScratch,
    declareTabs: browseWiring.declareTabs,
    freshness: {
      lookups: allLookups(),
      groupingsRev,
      generatorGroupsRev,
      busGroupsRev,
      interfaceGroupsRev,
      limits: { shared: limitsStore.sharedLimits(), cases: limitsStore.caseLimits() },
    },
    activeTabId: browseDrawer.activeTabId(),
  });
  browsePinLines = frame.pinLines;

  sections.sync(hasCases, frame.notes);
  charts.render(frame.charts);
  frame.settle();
  shell.render(query, views.loadedYears());

  const { browse: drawer } = frame;
  browseDrawer.render({
    ...drawer,
    caseLabel: views.caseLabel,
    selectedVariable: () => browseWiring.switches(drawer.signature).variable,
    selectedPercent: () => browseWiring.switches(drawer.signature).percent,
    selectedCase: () => browseWiring.switches(drawer.signature).case,
    selectedRow: (rowId) => browseWiring.switches(drawer.signature).row(rowId),
    caseNames: views.caseNames,
    pinLine: (rowId) => browsePinLines.get(rowId),
  });

  idleStatus = frame.status;
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

/** The Contents panel, over the inventory and the store. */
const contents = createContents({
  inventory,
  cases: caseStore,
  render: () => render(),
  loading: () => dropLoad.running() || busy !== null,
  show: showContentsPanel,
});

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
  if (files.length > 0) void dropLoad.load(files);
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
  if (files.length > 0) void dropLoad.load(files);
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
        caseLabel: views.caseLabel,
        caseNames: views.caseNames,
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

/** One retain gate per kind, built once. Not on a section: which columns a
 * drop keeps must not depend on what is on screen. */
const retainGates = createRetainGates();

/** Every (kind, shape) batch a drop runs, through the host above. */
const ingestKinds = createIngestKinds({
  attach: ingestHost,
  cases: caseStore,
  retainGates,
  keepsEverything: () => dropLoad.keepsEverything(),
  areaAxis: allAreas,
  adoptAxis,
  refresh: () => setQueryCases(),
  pickMetrics: showLongMetricPicker,
  readers: {
    long: longPool,
    area: wideArea,
    bus: busWide,
    generator: generatorWide,
    interface: interfacePool,
  },
});

/**
 * Every loaded Case is drawn; which Cases a reader looks at is the drawer's
 * Case column. This runs after EVERY ingest of every kind (each batch's
 * `refresh`): a Case missing from `query.cases` has its rows dropped by the
 * drawer's scoping with nothing on screen to bring them back.
 */
function setQueryCases(): void {
  setQuery({ cases: caseStore.listCases().map((entry) => entry.id) });
}

/** A drop, from its first byte to its last table: the sequence is
 * `src/app/drop-load.ts`, and this is everything it reaches through. */
const dropLoad = createDropLoad({
  inventory,
  say: (channel, lines) => notes.set(channel, lines),
  render,
  setBusyFloor,
  downloadRunning: () => exportInFlight,
  closeContents: contents.close,
  listCases: () => caseStore.listCases(),
  restoreBundle: (file) => saveRestore.restoreBundleFile(file),
  askGroupings: (file, text, writtenBy) =>
    showGroupingsMapping({
      fileName: file.name,
      header: readCsvHeader(text),
      writtenBy,
      hasGeneratorList: lookupFor('generatorlist') !== undefined,
      hasBusList: lookupFor('buslist') !== undefined,
    }),
  loadGroupings(choice, text, fileName) {
    switch (choice.entity) {
      case 'area':
        return applyGroupings(text);
      case 'bus':
        return busEditing.loadFile(text, choice.mapping, fileName);
      case 'interface':
        return interfaceEditing.loadFile(text, choice.mapping, fileName);
      case 'generator':
        return generatorEditing.loadFile(text, choice.mapping, fileName);
    }
  },
  kindLabel,
  attachLookup(rows, fileName) {
    const merged = attachLookup(rows);
    return { alreadyKnown: merged.alreadyKnown, note: mergeNote(fileName, merged) };
  },
  askImport: showImportDialog,
  ingest: ingestKinds.ingest,
  setSharedLimits: (table) => limitsStore.setSharedLimits(table),
  setCaseLimits: (caseId, table) => limitsStore.setCaseLimits(caseId, table),
  limitMatchNotes: drawnLimits.limitMatchNotes,
  refreshCases: setQueryCases,
  revealDrawer() {
    if (browseDrawer.detent() === 'closed') browseDrawer.setDetent('half');
  },
});

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

/** What every kind's group editing does to app state. */
const groupHost: GroupEditingHost = {
  say: (lines) => notes.set('session', lines),
  render: () => render(),
  recordEditor: recordEditorGroups,
};

/** Generator, Bus and Interface group editing, each kind's revision here. */
const groupKinds = createGroupKinds(
  {
    generatorRows,
    busRows,
    interfaceRows,
    lookupFor,
    bump: {
      generator: () => generatorGroupsRev++,
      bus: () => busGroupsRev++,
      interface: () => interfaceGroupsRev++,
    },
  },
  groupHost,
);
const generatorEditing = groupKinds.generator;
const busEditing = groupKinds.bus;
const interfaceEditing = groupKinds.interface;

/** Save and both restore paths, through the state this module holds. */
const saveRestore = createSaveRestore({
  cases: caseStore,
  limits: limitsStore,
  inventory,
  storage: { downloadBundle, saveBundle, readBundleFile, loadBundle },
  say: (channel, lines) => notes.set(channel, lines),
  setBusy,
  render: () => render(),
  closeContents: contents.close,
  dropCaseBuffers(caseId) {
    drawLines.dropCase(caseId);
    overviewLines.dropCase(caseId);
  },
  contents: () => ({
    ...readSessionReference(limitsStore),
    selections: browseDrawer.selection(),
    layout: charts.layout(),
    boxDims: query.boxDims,
    intervals: charts.intervals(),
    drawerHeight: browseDrawer.heightPx(),
    inventory: inventory.snapshot(),
  }),
  restoreView,
  adoptGroups: (loaded, named, taken) => {
    // Each kind is `taken` as it lands, so a later kind that throws leaves
    // the earlier kinds' rows naming the maps now in effect.
    const said = adoptGroupings(loaded.groupings, named.inline, taken);
    said.push(...generatorEditing.adoptSaved(loaded.generatorGroups, named.start));
    if (loaded.generatorGroups !== null) taken.add(groupsInput('generator'));
    said.push(...busEditing.adoptSaved(loaded.busGroups, named.start));
    if (loaded.busGroups !== null) taken.add(groupsInput('bus'));
    said.push(...interfaceEditing.adoptSaved(loaded.interfaceGroups, named.start));
    if (loaded.interfaceGroups !== null) taken.add(groupsInput('interface'));
    return said;
  },
  adoptLookups,
  lookupSources,
});

/**
 * A restored bundle's view, onto the Cases it made: the saved area axis (from
 * the first restored Area table, which its cubes are indexed by), the Case
 * selection, the pins, the panes and the drawer's height.
 */
function restoreView(loaded: RestoredBundle, made: readonly { id: string }[]): void {
  const firstArea = areaCases()[0];
  if (firstArea) setAxis(firstArea.data.areas);
  render();
  setQueryCases();
  browseDrawer.setSelection(restorePins(loaded.pins, made));
  if (loaded.layout) charts.setLayout(loaded.layout as SlotType[]);
  charts.setIntervals(loaded.intervals);
  // A bundle with no box cut starts every pane by Case, as does a name this
  // build does not know.
  const boxDims = loaded.boxDims;
  query = Object.freeze({
    ...query,
    boxDims: Object.freeze(
      [0, 1, 2, 3].map((i) => {
        const dim = boxDims?.[i] as BoxDim | undefined;
        return dim !== undefined && BOX_DIMS.includes(dim) ? dim : 'case';
      }),
    ),
  });
  if (typeof loaded.drawerHeight === 'number') {
    browseDrawer.restoreHeight(loaded.drawerHeight);
  }
}

/** The browse drawer's tabs, handlers and Selected-tab switches. */
const browseWiring = createBrowseWiring({
  views,
  browse: createBrowseScopes(),
  // Shared because a tab's rows are ranked one at a time, and reused because
  // allocating per render is how a free interaction acquires a cost.
  scratch: createScratch(),
  // Kept so a drop ranks only its own rows.
  ranks: createRankMemo(),
  query: () => query,
  lookupFor,
  interfaceRange: drawnLimits.interfaceRange,
  drawer: () => browseDrawer,
  pinned: () => browsePinned,
  select(pinned, preview) {
    browsePinned = pinned;
    browsePreview = preview;
    render();
  },
  render: () => render(),
  downloadHourly(download) {
    void downloadHourly(download);
  },
  editors: groupKinds,
  editAreaGroups() {
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
});

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
const statusBar = document.getElementById('status-bar');
if (!statusBar) throw new Error('index.html is missing #status-bar');
const sections = createSectionHost(sectionHost, sectionTemplate, statusBar);

const sectionRoot = sections.add('area', 'Area');
const section = mountSection(sectionRoot, {
  // The one entity axis the box plot cuts by: Area's.
  entityDim: 'area',
  onBoxDimChange: (pane, dim) =>
    setQuery({
      boxDims: Object.freeze(query.boxDims.map((was, i) => (i === pane ? (dim as BoxDim) : was))),
    }),
  onFiltersChange: setFilters,
  onDatesChange: (dates) => setFilters({ dates }),
  // A time pane showing the whole year shows no dates filter, and its
  // caption must not claim one.
  onFigure: (capture, shown) =>
    openFigureDialog({
      capture,
      hourFilter: filtersLabel(shown.wholeYear ? { ...query.filters, dates: null } : query.filters),
    }),
});
const shell = section.rail;
const charts = section.charts;

/** The browse drawer: global chrome spanning every kind, so it keeps its ids
 * and main.ts resolves it. */
const browseHost = document.getElementById('browse-drawer');
if (!browseHost) throw new Error('index.html is missing #browse-drawer');
const browseDrawer = createBrowseDrawer(
  browseHost,
  browseWiring.handlers,
  within(sectionRoot, '[data-el="slicer-pane"]'),
);

/** The global chrome, wired ONCE for the whole app. */
const chrome = createChrome(appChrome, {
  onFiles(files) {
    void dropLoad.load(files);
  },
  onAddCases() {
    fileInput.click();
  },
  onSave: saveRestore.saveAll,
  onContents: contents.open,
  onLoad() {
    // Try the origin-private cache first. "Nothing saved here yet" is normal on
    // another machine and falls through to a file picker. Anything else (a
    // stale version, a corrupt blob) means a bundle IS there and this build
    // will not read it: say so, and skip the picker.
    void saveRestore.loadAll().catch((error: unknown) => {
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
if (!longPool.hasSimd()) {
  notes.set('blocked', [longPool.NO_SIMD_MESSAGE]);
} else {
  // The area parse pool cannot warm yet (its workers hash the area axis, which
  // no file has supplied); storage and interface pools can.
  warmStorage();
  interfacePool.warmPool();
}

render();
