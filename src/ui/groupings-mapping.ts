// src/ui/groupings-mapping.ts
//
// The column-mapping pane: the one place a groupings CSV is told what it is.
// Every kind's membership file is a key/group CSV, and misdetection costs more
// than asking. It asks:
//
//   * WHICH ENTITY the file groups, confirmed by the user, never settled by
//     the header: a `Name,Grouping` generator file would otherwise load as an
//     area mapping. The caller decides what each answer means.
//   * WHICH COLUMNS are the key and the group (and, for interfaces, the
//     optional DIRECTION column; absent means every member forward).
//
// Each entity keeps its own column pane because its keys differ: generator
// by name or (bus, unit); bus by number or (weak, repeatable) name; interface
// by name only. Rows use the analyst's words ("bus number") and offer the
// file's spellings (`Bus ID`). Nothing changes until Load.

import { stripBOM } from '../ingest';
import { splitCsvLine } from '../lookups/parse';
import { resolveMembershipKey } from '../tables/generator/resolve';
import type { GeneratorGroupMapping } from '../tables/generator/groups';
import { resolveBusMembershipKey } from '../tables/bus/groups';
import type { BusGroupMapping } from '../tables/bus/groups';
import { directionSpellings } from '../tables/interface/groups';
import type { InterfaceGroupMapping } from '../tables/interface/groups';

/** A file's first CSV line as its column list, trimmed and BOM-stripped. */
export function readCsvHeader(text: string): string[] {
  const firstLine = stripBOM(text).split(/\r?\n/, 1)[0] ?? '';
  return splitCsvLine(firstLine).map((cell) => cell.trim());
}

/** The pane's answer: the entity, plus the column mapping where there is a
 * choice. Area has one fixed shape (`Name,Grouping`). */
export type GroupingsMappingChoice =
  | { entity: 'area' }
  | { entity: 'generator'; mapping: GeneratorGroupMapping }
  | { entity: 'bus'; mapping: BusGroupMapping }
  | { entity: 'interface'; mapping: InterfaceGroupMapping };

export interface GroupingsMappingInput {
  /** For the title: which file is being asked about. */
  fileName: string;
  /** The file's own columns, as `readCsvHeader` read them. */
  header: readonly string[];
  /** Whether a GeneratorList is loaded (a bus-number key needs one), so the
   * pane says so up front. */
  hasGeneratorList: boolean;
  /** Whether a BusList is loaded (a bus NAME key needs one). */
  hasBusList?: boolean;
  /** Set when opened from a groups editor: the entity is stated, not asked. */
  entity?: 'generator' | 'bus' | 'interface';
  /** Every entity whose editor writes exactly this header; decides where the
   * entity radio starts. */
  writtenBy?: readonly string[];
}

/** Column spellings each default looks for, first hit wins. A preselection
 * the user confirms, never a verdict. */
const NAME_COLUMN_SPELLINGS = ['Name', 'Generator', 'Generator Name', 'Unit'];
const BUS_COLUMN_SPELLINGS = ['Bus ID', 'Bus Number', 'BusNumber', 'Bus'];
const UNIT_COLUMN_SPELLINGS = ['Unit ID', 'Unit', 'UnitId'];
const GROUP_COLUMN_SPELLINGS = ['Grouping', 'Group', 'Injection Group', 'Group Name'];
const BUS_ID_COLUMN_SPELLINGS = ['BusID', 'Bus ID', 'Bus Number', 'BusNumber', 'Bus'];
const BUS_NAME_COLUMN_SPELLINGS = ['Bus Name', 'BusName', 'Name'];
const INTERFACE_COLUMN_SPELLINGS = ['Interface', 'Interface Name', 'Path', 'Name'];
const DIRECTION_COLUMN_SPELLINGS = ['Direction', 'Sign', 'Orientation', 'Reversed'];

function firstPresent(header: readonly string[], spellings: readonly string[]): string {
  for (const spelling of spellings) {
    if (header.includes(spelling)) return spelling;
  }
  return '';
}

/** Resolve to the user's answers, or `null` when dismissed (the caller says
 * so). */
export function showGroupingsMapping(
  input: GroupingsMappingInput,
): Promise<GroupingsMappingChoice | null> {
  return new Promise((resolve) => {
    const header = input.header;
    const askEntity = input.entity === undefined;

    // Where the entity radio starts: the sole writer of this header if there
    // is one (so an editor's saved file reloads in one click), else Areas for
    // `Name,Grouping`. Load reads whatever the radio says.
    const soleWriter = input.writtenBy?.length === 1 ? input.writtenBy[0] : undefined;
    let entity: 'area' | 'generator' | 'bus' | 'interface' = !askEntity
      ? (input.entity ?? 'generator')
      : soleWriter === 'area' ||
          soleWriter === 'generator' ||
          soleWriter === 'bus' ||
          soleWriter === 'interface'
        ? soleWriter
        : header.includes('Name') && header.includes('Grouping')
          ? 'area'
          : 'generator';

    const groupColumn =
      firstPresent(header, GROUP_COLUMN_SPELLINGS) || header[header.length - 1] || '';
    const nameColumn =
      firstPresent(header, NAME_COLUMN_SPELLINGS) ||
      header.find((column) => column !== groupColumn) ||
      '';
    const busColumn = firstPresent(header, BUS_COLUMN_SPELLINGS);
    const unitColumn = firstPresent(header, UNIT_COLUMN_SPELLINGS);
    // The key form follows which defaults landed: both pair halves mean a
    // pair, anything else a name.
    let keyForm: 'name' | 'bus-unit' =
      busColumn !== '' && unitColumn !== '' && nameColumn === '' ? 'bus-unit' : 'name';

    const busIdColumn = firstPresent(header, BUS_ID_COLUMN_SPELLINGS);
    const busNameColumn = firstPresent(header, BUS_NAME_COLUMN_SPELLINGS);
    // Default to the id key whenever the file has one (the name is weak); a
    // name-only file opens on the name form.
    let busKeyForm: 'id' | 'name' = busIdColumn !== '' || busNameColumn === '' ? 'id' : 'name';

    const fallback = header.find((column) => column !== groupColumn) || '';
    const interfaceColumn = firstPresent(header, INTERFACE_COLUMN_SPELLINGS);
    const directionColumn = firstPresent(header, DIRECTION_COLUMN_SPELLINGS);
    // Starts on whether the file has a likely direction column. Cells are
    // never inferred from; no column means every member forward.
    let hasDirection = directionColumn !== '';

    const selected = {
      name: nameColumn,
      bus: busColumn || fallback,
      unit: unitColumn || fallback,
      busId: busIdColumn || fallback,
      busName: busNameColumn || fallback,
      iface: interfaceColumn || fallback,
      direction: directionColumn || fallback,
      group: groupColumn,
    };

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const modal = document.createElement('div');
    modal.className = 'modal';
    backdrop.appendChild(modal);

    const title = document.createElement('h2');
    title.textContent = `Load “${input.fileName}”`;
    modal.appendChild(title);

    const subtitle = document.createElement('p');
    subtitle.className = 'modal-subtitle';
    subtitle.textContent =
      'Area, generator, bus and interface groupings are all key/group CSV files. A header ' +
      'only one group editor writes starts on that entity; Name,Grouping is written for both ' +
      'areas and generators, and a header no editor wrote could be any of them. A file loaded ' +
      'as the wrong entity would group the wrong things without a word, so this pane asks ' +
      'rather than guessing. The column mapping is the only free choice here; everything ' +
      'after it is worked out from the file.';
    modal.appendChild(subtitle);

    /** One radio row. `name` keeps the two radio groups separate. */
    function radioRow(
      group: HTMLElement,
      name: string,
      value: string,
      text: string,
      hint: string,
    ): HTMLInputElement {
      const row = document.createElement('label');
      row.className = 'modal-row';
      const box = document.createElement('input');
      box.type = 'radio';
      box.name = name;
      box.value = value;
      row.appendChild(box);
      const label = document.createElement('span');
      label.className = 'modal-row-name';
      label.textContent = text;
      row.appendChild(label);
      row.title = hint;
      group.appendChild(row);
      return box;
    }

    const entityGroup = document.createElement('div');
    entityGroup.className = 'mapping-group';
    const generatorRadio = radioRow(
      entityGroup,
      'mapping-entity',
      'generator',
      'Generators — named sets of units (“injection groups”)',
      'Membership is stored as GeneratorList names.',
    );
    const busRadio = radioRow(
      entityGroup,
      'mapping-entity',
      'bus',
      'Buses — named sets of buses',
      'Membership is stored as bus numbers.',
    );
    const interfaceRadio = radioRow(
      entityGroup,
      'mapping-entity',
      'interface',
      'Interfaces — a boundary built from paths, each with a direction',
      'Each member counts forward or reversed.',
    );
    const areaRadio = radioRow(
      entityGroup,
      'mapping-entity',
      'area',
      'Areas — the Area Groups mapping (columns Name,Grouping)',
      'The fixed Groupings.csv shape; no column mapping to choose.',
    );
    entityGroup.addEventListener('change', (event) => {
      const value = (event.target as HTMLInputElement).value;
      entity = value === 'area' || value === 'bus' || value === 'interface' ? value : 'generator';
      paint();
    });
    if (!askEntity) {
      entityGroup.replaceChildren();
      const fixed = document.createElement('p');
      fixed.className = 'modal-subtitle';
      const noun =
        entity === 'bus' ? 'buses' : entity === 'interface' ? 'interfaces' : 'generators';
      fixed.textContent = `This file groups ${noun}.`;
      entityGroup.appendChild(fixed);
    }

    const mappingColumn = document.createElement('div');
    mappingColumn.className = 'mapping-column';

    const vocab = document.createElement('p');
    vocab.className = 'modal-subtitle';
    vocab.textContent =
      'Analysts say “bus number”; GeneratorList’s column is “Bus ID”. Pick this file’s own ' +
      'column by the spelling it carries — the pane maps it, the resolver normalises it.';
    mappingColumn.appendChild(vocab);

    const keyGroup = document.createElement('div');
    keyGroup.className = 'mapping-group';
    const nameKeyRadio = radioRow(
      keyGroup,
      'mapping-key',
      'name',
      'By generator name — one column',
      'The GeneratorList Name, the app’s own key.',
    );
    const pairKeyRadio = radioRow(
      keyGroup,
      'mapping-key',
      'bus-unit',
      'By bus number and unit ID — two columns',
      input.hasGeneratorList
        ? 'Resolved against the loaded GeneratorList.'
        : 'Needs GeneratorList.csv, which is not loaded.',
    );
    mappingColumn.appendChild(keyGroup);
    keyGroup.addEventListener('change', (event) => {
      const value = (event.target as HTMLInputElement).value;
      keyForm = value === 'bus-unit' ? 'bus-unit' : 'name';
      paint();
    });

    const busColumnPane = document.createElement('div');
    busColumnPane.className = 'mapping-column';

    const busVocab = document.createElement('p');
    busVocab.className = 'modal-subtitle';
    busVocab.textContent =
      'A bus NAME may legitimately repeat — two buses called WILLOWBEND are two different ' +
      'buses — so membership is stored as bus numbers. A name-keyed file is resolved through ' +
      'BusList, and a name two rows carry is kept and flagged rather than guessed at.';
    busColumnPane.appendChild(busVocab);

    const busKeyGroup = document.createElement('div');
    busKeyGroup.className = 'mapping-group';
    const busIdKeyRadio = radioRow(
      busKeyGroup,
      'mapping-bus-key',
      'id',
      'By bus number — one column',
      'The BusID, the app’s own key. Needs no list.',
    );
    const busNameKeyRadio = radioRow(
      busKeyGroup,
      'mapping-bus-key',
      'name',
      'By bus name — one column',
      input.hasBusList === true
        ? 'Resolved through the loaded BusList; an ambiguous name is kept and flagged.'
        : 'Needs BusList.csv, which is not loaded.',
    );
    busColumnPane.appendChild(busKeyGroup);
    busKeyGroup.addEventListener('change', (event) => {
      const value = (event.target as HTMLInputElement).value;
      busKeyForm = value === 'name' ? 'name' : 'id';
      paint();
    });

    const interfaceColumnPane = document.createElement('div');
    interfaceColumnPane.className = 'mapping-column';

    const interfaceVocab = document.createElement('p');
    interfaceVocab.className = 'modal-subtitle';
    const spellings = directionSpellings();
    interfaceVocab.textContent =
      'A monitored interface carries a direction: a path exported A→B and one exported ' +
      'B→A are the same physics with opposite signs, so a group says which way each ' +
      `member counts. Write ${spellings.forward.slice(0, 3).join(', ')} or ` +
      `${spellings.reversed.slice(0, 3).join(', ')}; a blank cell is forward.`;
    interfaceColumnPane.appendChild(interfaceVocab);

    const directionGroup = document.createElement('div');
    directionGroup.className = 'mapping-group';
    const hasDirectionRadio = radioRow(
      directionGroup,
      'mapping-direction',
      'column',
      'A column says which way each member counts',
      'Read per row from the column below.',
    );
    const noDirectionRadio = radioRow(
      directionGroup,
      'mapping-direction',
      'none',
      'No direction column — every member counts forward',
      'The file as the export measures it. Reverse members in the editor afterwards.',
    );
    interfaceColumnPane.appendChild(directionGroup);
    directionGroup.addEventListener('change', (event) => {
      hasDirection = (event.target as HTMLInputElement).value === 'column';
      paint();
    });

    /** A label + column select that writes `selected` itself, so nothing reads
     * a stale column. */
    function selectRow(
      labelText: string,
      key: keyof typeof selected,
      host: HTMLElement = mappingColumn,
    ): HTMLElement {
      const row = document.createElement('div');
      row.className = 'mapping-row';
      const label = document.createElement('span');
      label.className = 'mapping-row-label';
      label.textContent = labelText;
      const select = document.createElement('select');
      select.className = 'modal-filter';
      for (const column of header) {
        const option = document.createElement('option');
        option.value = column;
        option.textContent = column;
        select.appendChild(option);
      }
      select.value = selected[key];
      select.addEventListener('change', () => {
        selected[key] = select.value;
        paint();
      });
      row.append(label, select);
      host.appendChild(row);
      return row;
    }

    const nameRow = selectRow('Generator name column', 'name');
    const busRow = selectRow('Bus number column', 'bus');
    const unitRow = selectRow('Unit ID column', 'unit');
    selectRow('Group column', 'group');

    const busIdRow = selectRow('Bus number column', 'busId', busColumnPane);
    const busNameRow = selectRow('Bus name column', 'busName', busColumnPane);
    // Its own group select: a shared row would write the hidden pane's key.
    const busGroupRow = selectRow('Group column', 'group', busColumnPane);

    const ifaceNameRow = selectRow('Interface name column', 'iface', interfaceColumnPane);
    const ifaceDirectionRow = selectRow('Direction column', 'direction', interfaceColumnPane);
    selectRow('Group column', 'group', interfaceColumnPane);

    const readout = document.createElement('p');
    readout.className = 'modal-readout';

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = 'Cancel';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'btn btn-primary';
    confirm.textContent = 'Load';
    actions.append(cancel, confirm);

    modal.append(entityGroup, mappingColumn, busColumnPane, interfaceColumnPane, readout, actions);

    function chosenInterfaceMapping(): InterfaceGroupMapping {
      return {
        nameColumn: selected.iface,
        groupColumn: selected.group,
        ...(hasDirection ? { directionColumn: selected.direction } : {}),
      };
    }

    function chosenBusMapping(): BusGroupMapping {
      return busKeyForm === 'id'
        ? { key: { by: 'id', idColumn: selected.busId }, groupColumn: selected.group }
        : { key: { by: 'name', nameColumn: selected.busName }, groupColumn: selected.group };
    }

    function chosenMapping(): GeneratorGroupMapping {
      return keyForm === 'name'
        ? { key: { by: 'name', nameColumn: selected.name }, groupColumn: selected.group }
        : {
            key: { by: 'bus-unit', busColumn: selected.bus, unitColumn: selected.unit },
            groupColumn: selected.group,
          };
    }

    /** What stops this mapping loading, or null. Pair reasons are the
     * resolver's own wording. */
    function refusal(): string | null {
      if (entity === 'interface') {
        const columns = [
          selected.iface,
          selected.group,
          ...(hasDirection ? [selected.direction] : []),
        ];
        if (new Set(columns).size !== columns.length) {
          return 'Two roles name the same column — each role needs its own.';
        }
        return null;
      }
      if (entity === 'bus') {
        const key = busKeyForm === 'id' ? selected.busId : selected.busName;
        if (key === selected.group) {
          return 'Two roles name the same column — each role needs its own.';
        }
        if (busKeyForm === 'name' && input.hasBusList !== true) {
          const refused = resolveBusMembershipKey(undefined, { by: 'name', name: 'x' });
          return refused.status === 'refused' ? refused.reason : null;
        }
        return null;
      }
      if (entity !== 'generator') return null;
      const columns = [
        selected.group,
        ...(keyForm === 'name' ? [selected.name] : [selected.bus, selected.unit]),
      ];
      if (new Set(columns).size !== columns.length) {
        return 'Two roles name the same column — each role needs its own.';
      }
      if (keyForm === 'bus-unit' && !input.hasGeneratorList) {
        const refused = resolveMembershipKey(undefined, { by: 'bus-unit', busId: '', unitId: '' });
        return refused.status === 'refused' ? refused.reason : null;
      }
      return null;
    }

    function paint(): void {
      if (askEntity) {
        areaRadio.checked = entity === 'area';
        generatorRadio.checked = entity === 'generator';
        busRadio.checked = entity === 'bus';
        interfaceRadio.checked = entity === 'interface';
      }
      nameKeyRadio.checked = keyForm === 'name';
      pairKeyRadio.checked = keyForm === 'bus-unit';
      busIdKeyRadio.checked = busKeyForm === 'id';
      busNameKeyRadio.checked = busKeyForm === 'name';

      mappingColumn.hidden = entity !== 'generator';
      nameRow.hidden = keyForm !== 'name';
      busRow.hidden = keyForm !== 'bus-unit';
      unitRow.hidden = keyForm !== 'bus-unit';

      busColumnPane.hidden = entity !== 'bus';
      busIdRow.hidden = busKeyForm !== 'id';
      busNameRow.hidden = busKeyForm !== 'name';
      busGroupRow.hidden = false;

      interfaceColumnPane.hidden = entity !== 'interface';
      hasDirectionRadio.checked = hasDirection;
      noDirectionRadio.checked = !hasDirection;
      ifaceNameRow.hidden = false;
      ifaceDirectionRow.hidden = !hasDirection;

      const why = refusal();
      confirm.disabled = entity !== 'area' && why !== null;
      if (entity === 'area') {
        readout.textContent = 'Loading as the Area Groups mapping — Name,Grouping.';
      } else if (why !== null) {
        readout.textContent = why;
      } else if (entity === 'interface') {
        readout.textContent = hasDirection
          ? `Interfaces from “${selected.iface}”, directions from “${selected.direction}”, ` +
            `groups from “${selected.group}”.`
          : `Interfaces from “${selected.iface}”, groups from “${selected.group}”. Every ` +
            `member counts forward — reverse them in the editor.`;
      } else if (entity === 'bus') {
        readout.textContent =
          busKeyForm === 'id'
            ? `Bus numbers from “${selected.busId}”, groups from “${selected.group}”.`
            : `Bus names from “${selected.busName}”, groups from “${selected.group}”.`;
      } else if (keyForm === 'name') {
        readout.textContent = `Unit names from “${selected.name}”, groups from “${selected.group}”.`;
      } else {
        readout.textContent =
          `Bus numbers from “${selected.bus}”, unit IDs from “${selected.unit}”, ` +
          `groups from “${selected.group}”.`;
      }
    }

    function close(result: GroupingsMappingChoice | null): void {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }

    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') close(null);
    }

    cancel.addEventListener('click', () => close(null));
    confirm.addEventListener('click', () => {
      if (entity === 'area') close({ entity: 'area' });
      else if (refusal() !== null) return;
      else if (entity === 'bus') close({ entity: 'bus', mapping: chosenBusMapping() });
      else if (entity === 'interface')
        close({ entity: 'interface', mapping: chosenInterfaceMapping() });
      else close({ entity: 'generator', mapping: chosenMapping() });
    });
    document.addEventListener('keydown', onKey);

    paint();
    document.body.appendChild(backdrop);
  });
}
