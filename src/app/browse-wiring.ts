// src/app/browse-wiring.ts
//
// The browse drawer's side of the root: which tabs are declared from which
// rows, the handlers its clicks land in, and the Selected tab's switches. The
// drawer is global chrome spanning every kind, so this is the one place the
// kinds' tab declarations, retarget answers and group editors meet.
//
// The pins, the render, the ranking buffers and the per-kind variable memory
// are the root's, handed in; this holds only the Selected tab's answers for
// one pin set, a cache rebuilt whenever the pins or the tables move.

import type { RankMemo } from '../kernels';
import type { LookupTable, LookupVariant } from '../lookups/types';
import type { RangeLimits } from '../series/range';
import type { AreaQuery } from '../tables/area/types';
import { combinesAcrossAreas } from '../tables/area/rules';
import { declareAreaTabs } from '../tables/area/ui/browse';
import { areaAnswers } from '../tables/area/ui/retarget';
import { combinesAcrossBuses } from '../tables/bus/rules';
import { declareBusTabs } from '../tables/bus/ui/browse';
import { busAnswers } from '../tables/bus/ui/retarget';
import { derivedAttribute } from '../tables/generator/derived';
import { combinesAcrossGenerators } from '../tables/generator/rules';
import { declareGeneratorTabs } from '../tables/generator/ui/browse';
import { generatorAnswers } from '../tables/generator/ui/retarget';
import { combinesAcrossInterfaces } from '../tables/interface/rules';
import { declareInterfaceTabs } from '../tables/interface/ui/browse';
import { interfaceAnswers } from '../tables/interface/ui/retarget';
import type { BrowseRowRef, SelectionEntry } from '../ui/browse-model';
import type {
  BrowseDrawer,
  BrowseDrawerHandlers,
  HourlyDownload,
  SwitchAnswers,
} from '../ui/browse-drawer';
import {
  caseSwitch,
  percentSwitch,
  retargetCase,
  retargetPercent,
  retargetPin,
  retargetVariable,
  variableSwitch,
  type CaseSwitch,
  type KindAnswers,
  type KindRetarget,
  type KindRetargets,
  type PercentSwitch,
  type RetargetRow,
  type VariableSwitch,
} from '../ui/browse-retarget';
import { identityOf, type BrowseKindRow, type BrowseScopes } from './browse-scope';
import type { CaseViews } from './case-views';
import type { GroupedKind, GroupEditing } from './group-editing';

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

export interface BrowseWiringHost {
  views: CaseViews;
  /** The drawer's per-kind variable memory and the scoping over it. */
  browse: BrowseScopes;
  /** One buffer for every ranked row of every tab, cut to each table's
   * plane (or outgrown by a longer one, see `fitScratch`). */
  scratch: Float32Array;
  /** Every tab's ranking, kept per cube while its mask and rows hold still. */
  ranks: RankMemo;
  query(): AreaQuery;
  lookupFor(variant: LookupVariant): LookupTable | undefined;
  interfaceRange(
    caseId: string,
    interfaceName: string,
    year: number,
    numYears: number,
  ): RangeLimits;
  /** The drawer these handlers are wired into, created after them. */
  drawer(): BrowseDrawer;
  /** The pins as the render path reads them. */
  pinned(): readonly SelectionEntry[];
  /** The drawer's pins or preview moved; the root keeps them and renders. */
  select(pinned: readonly SelectionEntry[], preview: BrowseRowRef | null): void;
  render(): void;
  downloadHourly(download: HourlyDownload): void;
  editors: Readonly<
    Record<GroupedKind, Pick<GroupEditing<unknown, unknown>, 'addShown' | 'editFromTab'>>
  >;
  /** Area's editor, whose groupings are the root's own. */
  editAreaGroups(): void;
}

export function createBrowseWiring(host: BrowseWiringHost) {
  const { views, browse, scratch: browseScratch, ranks: browseRanks } = host;

  /** Each kind's answers to the Selected tab's switch, over every loaded
   * table (not the enabled scope: a pin's Case may be switched off). */
  function pinRetargets(): KindRetargets {
    return {
      area: retargetOf('area', views.areaRows(), areaAnswers),
      bus: retargetOf('bus', views.busRows(), busAnswers),
      generator: retargetOf('generator', views.generatorRows(), generatorAnswers),
      interface: retargetOf('interface', views.interfaceRows(), interfaceAnswers),
    };
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
        /** One pin's own switches, by row id, filled as its row paints. */
        row(rowId: string): SwitchAnswers;
      }
    | undefined;

  function switchesFor(signature: string) {
    const pinned = host.pinned();
    const tables = [
      ...views.areaRows(),
      ...views.busRows(),
      ...views.generatorRows(),
      ...views.interfaceRows(),
    ]
      .map((row) => identityOf(row.data))
      .join(',');
    // Labels too: a rename in Contents relabels the Case options.
    const cases = views.caseChoices();
    const named = cases.map((entry) => `${entry.id}=${entry.label}`).join(',');
    const key = `${signature}\u0001${tables}\u0001${named}`;
    if (selectedSwitches?.pins !== pinned || selectedSwitches.key !== key) {
      const refs = pinned.map((entry) => entry.ref);
      const kinds = pinRetargets();
      const rows = new Map<string, SwitchAnswers>();
      selectedSwitches = {
        pins: pinned,
        key,
        variable: variableSwitch(refs, kinds),
        percent: percentSwitch(refs, kinds),
        case: caseSwitch(refs, kinds, cases),
        row(rowId) {
          let held = rows.get(rowId);
          if (!held) {
            const one = refs.filter((ref) => ref.id === rowId);
            held = {
              case: caseSwitch(one, kinds, cases),
              variable: variableSwitch(one, kinds),
              percent: percentSwitch(one, kinds),
            };
            rows.set(rowId, held);
          }
          return held;
        },
      };
    }
    return selectedSwitches;
  }

  /** Every browse tab, loaded or not, each declared in its own kind's
   * directory. Every tab is scoped by the same loaded cases and the same hour
   * filter, so a number in the drawer means the same thing whichever tab it
   * is under. */
  function declareBrowseTabs() {
    const { cases, filters } = host.query();
    const scopedCases = new Map(
      views
        .caseChoices()
        .map((entry) => [entry.id, { name: entry.name, label: entry.label }] as const),
    );
    const scope = <T extends BrowseKindRow>(
      rows: readonly T[],
      kind: string,
      pairedWith?: string,
    ) => browse.scope(rows, kind, cases, filters, scopedCases, pairedWith, TAB_OFFERS[kind]);
    const area = scope(views.areaRows(), 'area');
    const areaGroups = scope(views.areaRows(), 'area-groups', 'area');
    const generator = scope(views.generatorRows(), 'generator');
    const generatorGroups = scope(views.generatorRows(), 'generator-groups', 'generator');
    const bus = scope(views.busRows(), 'bus');
    const busGroups = scope(views.busRows(), 'bus-groups', 'bus');
    const iface = scope(views.interfaceRows(), 'interface');
    const ifaceGroups = scope(views.interfaceRows(), 'interface-groups', 'interface');

    // Bar order: each kind's entity tab then its groups tab. Empty tabs are
    // hidden but stay in the signature, since a kind losing its last table
    // changes what a rebuild produces.
    return [
      ...declareAreaTabs(area, areaGroups, browseScratch, browseRanks),
      ...declareGeneratorTabs(
        generator,
        generatorGroups,
        host.lookupFor('generatorlist'),
        browseScratch,
        browseRanks,
      ),
      ...declareBusTabs(bus, busGroups, host.lookupFor('buslist'), browseScratch, browseRanks),
      ...declareInterfaceTabs(iface, ifaceGroups, browseScratch, browseRanks, host.interfaceRange),
    ];
  }

  const handlers: BrowseDrawerHandlers = {
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
      // resolves it into a line.
      host.select(pinned, preview);
    },
    onVariableChange(variable) {
      // A view control: re-list and re-rank, never clear the selection (pins
      // span variables). It moves the ACTIVE kind's variable and its paired
      // groups tab's, nothing else.
      const active = host.drawer().activeTabId();
      browse.set(active, variable);
      const paired = PAIRED_TABS[active];
      // A paired tab that cannot offer this quantity keeps its own, rather
      // than silently falling back to its first quantity.
      if (paired !== undefined && browse.offered(paired, variable)) {
        browse.set(paired, variable);
      }
      host.render();
    },
    onDownloadHourly(download) {
      host.downloadHourly(download);
    },
    onAction(tabId, actionId, shown) {
      const { editors } = host;
      if (actionId === 'add-shown-to-group') {
        // Routed by the tab it was clicked on, never by the rows: two kinds
        // offer this button and a row's `kind` is the only other thing that
        // could say which, which would make an empty table unroutable.
        if (tabId === 'bus') editors.bus.addShown(shown);
        else if (tabId === 'interface') editors.interface.addShown(shown);
        else editors.generator.addShown(shown);
        return;
      }
      if (actionId !== 'edit-groups') return;
      // The filtering happened on the ENTITY tab, so ask the drawer for that
      // tab's survivors. Undefined adds no dropdown entry.
      if (tabId === 'generator-groups') {
        editors.generator.editFromTab(host.drawer().filteredRows('generator'));
        return;
      }
      if (tabId === 'bus-groups') {
        editors.bus.editFromTab(host.drawer().filteredRows('bus'));
        return;
      }
      if (tabId === 'interface-groups') {
        editors.interface.editFromTab(host.drawer().filteredRows('interface'));
        return;
      }
      host.editAreaGroups();
    },
    onSelectedVariableChange(variable) {
      const browseDrawer = host.drawer();
      const next = retargetVariable(browseDrawer.selection(), variable, pinRetargets());
      // Each pinned kind's tabs follow where their scope offers it, so the
      // next tick matches the pins. An entity tab's id is its kind's name.
      // Set before the pins land: that is the one render.
      for (const kind of new Set(next.map((entry) => entry.ref.kind))) {
        for (const tab of [kind, PAIRED_TABS[kind]]) {
          if (tab !== undefined && browse.offered(tab, variable)) browse.set(tab, variable);
        }
      }
      browseDrawer.replacePins(next, true);
    },
    onSelectedRowChange(rowId, field, value) {
      // One pin, through the same rules as the Switch all row given only
      // itself. The drawer's modes and the kind tabs stay put: they answer to
      // the whole selection.
      const browseDrawer = host.drawer();
      const kinds = pinRetargets();
      const move =
        field === 'case'
          ? (one: readonly SelectionEntry[]) => retargetCase(one, value, views.caseChoices(), kinds)
          : field === 'variable'
            ? (one: readonly SelectionEntry[]) => retargetVariable(one, value, kinds)
            : (one: readonly SelectionEntry[]) => retargetPercent(one, value === 'pct', kinds);
      browseDrawer.replacePins(
        retargetPin(browseDrawer.selection(), rowId, move),
        field !== 'case',
      );
    },
    onSelectedCaseChange(caseId) {
      const browseDrawer = host.drawer();
      browseDrawer.replacePins(
        retargetCase(browseDrawer.selection(), caseId, views.caseChoices(), pinRetargets()),
        false,
      );
    },
    onSelectedPercent(on) {
      // The drawer's mode follows before the pins land, so the next tick
      // matches them in one render.
      const browseDrawer = host.drawer();
      browseDrawer.setPerUnit(on);
      browseDrawer.replacePins(retargetPercent(browseDrawer.selection(), on, pinRetargets()), true);
    },
    onTabChange() {
      // The variable dropdown belongs to the kind on screen, so a tab switch
      // is a re-render like any other view change. It moves no selection.
      host.render();
    },
    onPerUnitChange() {
      host.render();
    },
  };

  return {
    handlers,
    declareTabs: declareBrowseTabs,
    /** The Selected tab's switches for the drawer's current build. */
    switches: switchesFor,
  };
}
