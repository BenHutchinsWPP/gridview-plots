// src/app/group-kinds.ts
//
// Generator, Bus and Interface group editing, each stated as a `GroupKind`
// for `./group-editing.ts`: what the kind's membership is keyed by, what its
// universe is, and what a loaded map is worth saying about it. The membership
// lives in each kind's `groups.ts`; the root owns each kind's revision and
// hands in `bump`, the loaded rows and the reference lists as accessors, read
// fresh on every call because a replaced list changes the key set wholesale.

import type { LookupTable, LookupVariant } from '../lookups/types';
import type { TableRow } from '../model/case-model';
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
} from '../tables/bus/groups';
import type { BusTable } from '../tables/bus/types';
import { showBusGroupEditor } from '../tables/bus/ui/groups';
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
} from '../tables/generator/groups';
import type { GeneratorTable } from '../tables/generator/types';
import { showGeneratorGroupEditor } from '../tables/generator/ui/groups';
import {
  adoptInterfaceGroups,
  exportInterfaceGroups,
  loadInterfaceGroups,
  setInterfaceMembership,
  summarizeInterfaceGroups,
  type InterfaceGroupMapping,
  type InterfaceGroupsSummary,
  type SavedInterfaceGroups,
} from '../tables/interface/groups';
import type { InterfaceTable } from '../tables/interface/types';
import { showInterfaceGroupEditor } from '../tables/interface/ui/groups';
import { groupEditing, type GroupedKind, type GroupEditingHost } from './group-editing';

/** What the three kinds' group editing reads from the root. */
export interface GroupSource {
  generatorRows(): TableRow<GeneratorTable>[];
  busRows(): TableRow<BusTable>[];
  interfaceRows(): TableRow<InterfaceTable>[];
  lookupFor(variant: LookupVariant): LookupTable | undefined;
  /** Move a kind's revision, so the drawer rebuilds its groups tab. */
  bump: Readonly<Record<GroupedKind, () => void>>;
}

export function createGroupKinds(source: GroupSource, host: GroupEditingHost) {
  function generatorListNames(): string[] | undefined {
    const list = source.lookupFor('generatorlist');
    return list === undefined ? undefined : Array.from(list.index.keys(), String);
  }

  function generatorUnitsWithData(): Set<string> {
    const present = new Set<string>();
    for (const { data } of source.generatorRows()) {
      data.generators.forEach((name, index) => {
        if (data.presence[index] === 1) present.add(name);
      });
    }
    return present;
  }

  function generatorUniverse(): string[] {
    const names = new Set<string>(generatorListNames() ?? []);
    for (const { data } of source.generatorRows())
      data.generators.forEach((name) => names.add(name));
    return [...names];
  }

  function generatorGroupNotes(summary: GeneratorGroupsSummary, lead: string): string[] {
    const list = source.lookupFor('generatorlist');
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

  /** Generator membership is by unit name; the kept-unresolved rows ride along
   * with an edit. */
  const generatorEditing = groupEditing(
    {
      kind: 'generator',
      nouns: {
        tab: 'Generator',
        member: 'unit',
        members: 'units',
        counted: 'unit(s)',
        keyedBy: 'name',
      },
      keyOf: String,
      edit: (from) => {
        const listed = generatorListNames();
        return showGeneratorGroupEditor({
          present: generatorUnitsWithData(),
          universe: generatorUniverse(),
          listed: listed === undefined ? undefined : new Set(listed),
          fromBrowse: from && { units: from.members, open: from.open },
        });
      },
      load: (text, mapping: GeneratorGroupMapping) =>
        loadGeneratorGroups(
          text,
          mapping,
          indexForMapping(source.lookupFor('generatorlist'), mapping),
        ).summary,
      set: (edit) => setGeneratorMembership(edit.members, edit.unresolved),
      summarize: () => summarizeGeneratorGroups(generatorListNames()),
      notes: generatorGroupNotes,
      exported: exportGeneratorGroups,
      adopt: (saved: SavedGeneratorGroups) => adoptGeneratorGroups(saved),
      bump: source.bump.generator,
    },
    host,
  );

  function busListIds(): number[] | undefined {
    const list = source.lookupFor('buslist');
    return list === undefined
      ? undefined
      : Array.from(list.index.keys(), Number).filter(Number.isInteger);
  }

  function busesWithData(): Set<number> {
    const present = new Set<number>();
    for (const { data } of source.busRows()) {
      data.buses.forEach((id, index) => {
        if (data.presence[index] === 1) present.add(id);
      });
    }
    return present;
  }

  function busUniverse(): number[] {
    const ids = new Set<number>(busListIds() ?? []);
    for (const { data } of source.busRows()) data.buses.forEach((id) => ids.add(id));
    return [...ids];
  }

  function busGroupNotes(summary: BusGroupsSummary, lead: string): string[] {
    const list = source.lookupFor('buslist');
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

  /** Bus membership is by bus number; a row naming a bus no BusList resolves
   * rides along with an edit. */
  const busEditing = groupEditing(
    {
      kind: 'bus',
      nouns: {
        tab: 'Bus',
        member: 'bus',
        members: 'buses',
        counted: 'bus(es)',
        keyedBy: 'bus number',
      },
      keyOf: (entity) => {
        const id = Number(entity);
        return Number.isInteger(id) ? id : undefined;
      },
      edit: (from) => {
        const listed = busListIds();
        return showBusGroupEditor({
          present: busesWithData(),
          universe: busUniverse(),
          listed: listed === undefined ? undefined : new Set(listed),
          fromBrowse: from && { buses: from.members, open: from.open },
        });
      },
      load: (text, mapping: BusGroupMapping) =>
        loadBusGroups(text, mapping, indexForBusMapping(source.lookupFor('buslist'))).summary,
      set: (edit) => setBusMembership(edit.members, edit.unresolved),
      summarize: () => summarizeBusGroups(busListIds()),
      notes: busGroupNotes,
      exported: exportBusGroups,
      adopt: (saved: SavedBusGroups) => adoptBusGroups(saved),
      bump: source.bump.bus,
    },
    host,
  );

  function interfaceUniverse(): string[] {
    const names = new Set<string>();
    for (const { data } of source.interfaceRows())
      for (const name of data.interfaces) names.add(name);
    return [...names];
  }

  function interfacesWithData(): Set<string> {
    const present = new Set<string>();
    for (const { data } of source.interfaceRows()) {
      data.interfaces.forEach((name, index) => {
        if (data.presence[index] === 1) present.add(name);
      });
    }
    return present;
  }

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

  /** Interface membership is by path name, with a direction per member. There
   * is no list file, so the loaded axes are the whole universe. */
  const interfaceEditing = groupEditing(
    {
      kind: 'interface',
      nouns: {
        tab: 'Interface',
        member: 'path',
        members: 'paths',
        counted: 'path(s)',
        keyedBy: 'name',
      },
      keyOf: String,
      edit: (from) =>
        showInterfaceGroupEditor({
          present: interfacesWithData(),
          universe: interfaceUniverse(),
          fromBrowse: from && { names: from.members, open: from.open },
        }),
      load: (text, mapping: InterfaceGroupMapping) =>
        loadInterfaceGroups(text, mapping, interfaceUniverse()).summary,
      set: (edit) => setInterfaceMembership(edit.members),
      summarize: () => summarizeInterfaceGroups(interfaceUniverse()),
      notes: interfaceGroupNotes,
      exported: exportInterfaceGroups,
      adopt: (saved: SavedInterfaceGroups) => adoptInterfaceGroups(saved),
      bump: source.bump.interface,
    },
    host,
  );

  return { generator: generatorEditing, bus: busEditing, interface: interfaceEditing };
}
