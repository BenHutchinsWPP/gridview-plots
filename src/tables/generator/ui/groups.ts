// src/tables/generator/ui/groups.ts
//
// What the shared membership editor (`src/ui/membership-editor.ts`) needs to
// edit GENERATOR groups; the editor takes these as parameters rather than
// branching on kind.
//
//   * Units cannot be added or removed here; names come from GeneratorList or
//     a loaded export. Unknown names from a bigger study's file are flagged,
//     and unresolved (bus, unit) rows ride along untouched (`extraReadout`).
//   * Rows show and search bus number and unit ID, which is how an analyst
//     identifies a unit.
//   * The candidate column can be narrowed to units with or without data,
//     since most listed units do not run in a given case.
//   * A CSV loaded here becomes the IN-PROGRESS membership; nothing moves
//     until Apply (Area's load closes the editor, hence `onLoadCsv` is a hook).

import { readCsvHeader, showGroupingsMapping } from '../../../ui/groupings-mapping';
import {
  showMembershipEditor,
  type CandidateSubset,
  type EditorApplied,
} from '../../../ui/membership-editor';
import { cellValue } from '../../../lookups/merge';
import { lookupFor } from '../../../lookups/store';
import type { LookupTable } from '../../../lookups/types';
import { BUS_ID_COLUMN, UNIT_ID_COLUMN } from '../resolve';
import {
  editorCsvShape,
  generatorGroupNames,
  indexForMapping,
  planGeneratorGroups,
  unitsInGroup,
  unresolvedMembershipRows,
  type UnitIdentifiers,
  type UnresolvedPairRow,
} from '../groups';

export interface GeneratorGroupEditorInput {
  /** Unit names with data in a loaded case. Empty before any case loads,
   * which switches the "no data" flag off. */
  present: ReadonlySet<string>;
  /** Every offerable unit name: GeneratorList's plus every loaded axis. */
  universe: readonly string[];
  /** GeneratorList's names, or undefined with no list ("unchecked", not
   * "not in GeneratorList"). */
  listed: ReadonlySet<string> | undefined;
  /**
   * The units the Generator tab's filters keep: a SNAPSHOT that narrows the
   * candidate column only. `open` is true when opened from that tab's action
   * (the set is why the editor is open); from the groups tab it waits in the
   * dropdown instead.
   */
  fromBrowse?: { units: ReadonlySet<string>; open: boolean };
}

/** The editor's answer on Apply: the membership, plus the unresolved (bus,
 * unit) rows that ride along. */
export interface GeneratorGroupEdit {
  members: ReadonlyMap<string, readonly string[]>;
  unresolved: readonly UnresolvedPairRow[];
}

/**
 * Unit name -> its bus number and unit ID, for every name a loaded
 * GeneratorList claims. Built once per editor (the list is thousands of rows),
 * and used for both the displayed detail and the saved columns, so they
 * agree. Unlisted names get no entry and are flagged by `problem()`.
 */
function identifiersFrom(list: LookupTable | undefined): Map<string, UnitIdentifiers> {
  const out = new Map<string, UnitIdentifiers>();
  if (list === undefined) return out;
  const bus = list.columns[list.byName.get(BUS_ID_COLUMN) ?? -1];
  const unit = list.columns[list.byName.get(UNIT_ID_COLUMN) ?? -1];
  if (bus === undefined && unit === undefined) return out;
  for (const [key, row] of list.index) {
    // Each half stands alone: keep what a partial list has.
    const busValue = bus === undefined ? null : cellValue(bus, row);
    const unitValue = unit === undefined ? null : cellValue(unit, row);
    const cells = {
      bus: busValue === null ? '' : String(busValue),
      unit: unitValue === null ? '' : String(unitValue),
    };
    if (cells.bus !== '' || cells.unit !== '') out.set(String(key), cells);
  }
  return out;
}

/** `bus 41234 · unit 1`, or '' for an unlisted unit. */
function identifierDetail(cells: UnitIdentifiers | undefined): string {
  if (cells === undefined) return '';
  const parts: string[] = [];
  if (cells.bus !== '') parts.push(`bus ${cells.bus}`);
  if (cells.unit !== '') parts.push(`unit ${cells.unit}`);
  return parts.join(' · ');
}

/** Resolve to the edited membership and its source, or to null on cancel. */
export function showGeneratorGroupEditor(
  input: GeneratorGroupEditorInput,
): Promise<EditorApplied<GeneratorGroupEdit> | null> {
  // Sorted for finding a unit by eye; the map keeps the file's order.
  const axis = [...new Set(input.universe)].sort((a, b) => a.localeCompare(b));
  const offerable = new Set(axis);

  const initial = new Map<string, readonly string[]>();
  for (const name of generatorGroupNames()) initial.set(name, unitsInGroup(name));

  // Rows no loaded list claims: not editable membership, returned untouched.
  let kept: UnresolvedPairRow[] = unresolvedMembershipRows().map((row) => ({ ...row }));

  const identifiers = identifiersFrom(lookupFor('generatorlist'));

  /** The saved file's shape, recomputed whenever `kept` changes: a list that
   * claims a unit, or any kept row, earns the id columns (and makes
   * `keptRow` safe to call). */
  let shape = editorCsvShape(identifiers.size > 0 || kept.length > 0);

  // With-data / without-data subsets, offered only once a case is loaded,
  // the same condition `problem()` uses for its "no data" flag.
  const subsets: CandidateSubset[] =
    input.present.size === 0
      ? []
      : [
          { label: 'With data in the loaded cases', keep: (unit) => input.present.has(unit) },
          { label: 'No data in the loaded cases', keep: (unit) => !input.present.has(unit) },
        ];

  // First, and the column opens on it: it is why the editor is on screen. A
  // hand-filtered set can straddle both halves, so it is a separate entry.
  const fromBrowse = input.fromBrowse;
  if (fromBrowse !== undefined) {
    const units = fromBrowse.units;
    subsets.unshift({
      label: `From the Generator tab (${units.size} unit(s))`,
      keep: (unit) => units.has(unit),
      open: fromBrowse.open,
    });
  }

  return showMembershipEditor<GeneratorGroupEdit>({
    title: 'Edit generator groups',
    subtitle:
      fromBrowse?.open === true
        ? `${fromBrowse.units.size} unit(s) from the Generator tab are on the right. Choose or ` +
          `create a group, then “Add all shown” — or switch the dropdown back to every unit. ` +
          `Nothing moves until you apply.`
        : `${axis.length} unit name(s) to offer. A unit can belong to any number of groups — ` +
          `drag it across, or double-click it. Units are stored by their GeneratorList Name, ` +
          `and the filter box also matches a bus number or unit ID. A saved CSV carries the ` +
          `bus number and unit ID beside each name, so it can be re-keyed on that pair against ` +
          `another study's list.`,
    noun: { one: 'unit', many: 'units' },
    candidatesHead: 'Units in this study',
    candidateDragType: 'x-from/unit',
    axis,
    initial,
    confirmLabel: 'Apply groups',
    downloadName: 'GeneratorGroups.csv',
    csvHeader: () => shape.columns.join(','),
    /** An unlisted unit still writes its row: the membership IS the name. */
    csvCells: (unit, group) => shape.row(unit, identifiers.get(unit), group),
    /** Unresolved (bus, unit) rows, written with a blank Name so the fleet
     * does not shrink on save; reload keyed on the pair recovers them. Keyed
     * on Name they are refused row by row, and counted. */
    csvExtraRows: () => kept.map((row) => shape.keptRow(row.busId, row.unitId, row.group)),
    requireGroups: true,
    /** Why a member cannot be plotted, or null. Three distinct problems with
     * three fixes, checked in order. */
    problem(unit) {
      if (input.listed !== undefined && !input.listed.has(unit)) return 'not in GeneratorList';
      if (!offerable.has(unit)) return 'not in the loaded data';
      if (input.present.size > 0 && !input.present.has(unit)) return 'no data in the loaded cases';
      return null;
    },
    detail: (unit) => identifierDetail(identifiers.get(unit)),
    candidateSubsets: subsets,
    extraReadout: () =>
      kept.length > 0
        ? ` · ${kept.length} row(s) name a bus number and unit ID no GeneratorList ` +
          'claims; they ride along'
        : '',
    /** Ask the mapping, resolve, and REPLACE the in-progress membership. A
     * refusal names the file and changes nothing. */
    async onLoadCsv(text, api, file) {
      const mapping = await showGroupingsMapping({
        fileName: file.name,
        header: readCsvHeader(text),
        hasGeneratorList: lookupFor('generatorlist') !== undefined,
        entity: 'generator',
      });
      if (mapping === null || mapping.entity !== 'generator') return;
      try {
        const plan = planGeneratorGroups(
          text,
          mapping.mapping,
          indexForMapping(lookupFor('generatorlist'), mapping.mapping),
        );
        api.replace(plan.members);
        kept = plan.kept.map((row) => ({ ...row }));
        shape = editorCsvShape(identifiers.size > 0 || kept.length > 0);
      } catch (error) {
        api.complain(error instanceof Error ? error.message : String(error));
      }
      api.repaint();
    },
    result: (model) => ({ members: model.snapshot(), unresolved: kept }),
  });
}
