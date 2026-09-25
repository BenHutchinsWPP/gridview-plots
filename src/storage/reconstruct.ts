// src/storage/reconstruct.ts
//
// A Contents inventory for a bundle saved before it carried one (a legacy
// migration included), rebuilt from what the bundle holds, so an old bundle
// fills the panel rather than showing it blank.
//
// It states only what the bundle can vouch for. Filenames it never kept are
// `null` ("not recorded"), never guessed: a reference list's own `sources`
// and a limits table's `source` are real filenames, a table's is not. Every
// record is flagged `reconstructed`, and the next save writes it as an
// ordinary one; the old bundle file is never rewritten.
//
// Tables come from the MANIFEST, unknown kinds included, so a table this build
// dropped reconciles to `dropped at restore` like any other. Session inputs
// come from what the restore read, so a list it dropped is simply absent.

import {
  groupsInput,
  LIMITS_COLUMN,
  SHARED_LIMITS_INPUT,
  type FileRecord,
  type SavedInventory,
} from '../inventory/store';
import type { LimitTable } from '../limits/types';
import { schemaFor } from '../lookups/schema';
import type { LookupTable, LookupVariant } from '../lookups/types';
import { slotKey, type RestoredCase, type TableSlotKey } from '../model/case-model';
import { GROUPS_FIELDS, tableCounts, TABLE_KINDS } from '../tables/registry';
import type { ManifestV3 } from './envelope';

/** What `restoreBundle` read besides the Cases, as reconstruction needs it. */
export interface ReadSession {
  lookups: ReadonlyMap<LookupVariant, LookupTable>;
  limits: { shared?: LimitTable; byIndex: ReadonlyMap<number, LimitTable> };
}

/** A kind as its groups row names it: `Bus groups`. */
function groupsLabel(kind: string): string {
  return `${kind.charAt(0).toUpperCase()}${kind.slice(1)} groups`;
}

/** A saved group map that groups nothing. The area mapping is saved as CSV on
 * every save, a bare header when none was loaded, so its presence alone says
 * nothing about a file. */
function mapsNothing(saved: unknown): boolean {
  return saved === undefined || (typeof saved === 'string' && saved.trim().split('\n').length < 2);
}

export function reconstructInventory(
  manifest: ManifestV3,
  cases: readonly RestoredCase[],
  read: ReadSession,
): SavedInventory {
  const records: FileRecord[] = [];
  const add = (fields: Partial<FileRecord>): string => {
    const id = `r${records.length + 1}`;
    records.push({
      id,
      name: null,
      size: null,
      lastModified: null,
      loadedAt: null,
      kind: null,
      shape: null,
      variants: [],
      counts: null,
      notes: [],
      ...fields,
      reconstructed: true,
    });
    return id;
  };

  const slots: SavedInventory['slots'] = [];
  manifest.cases.forEach((entry, index) => {
    for (const table of Object.values(entry.tables)) {
      const slot =
        table.variant === undefined
          ? { kind: table.kind }
          : { kind: table.kind, variant: table.variant };
      const restored = cases[index]?.tables.get(slotKey(slot as TableSlotKey));
      const id = add({
        kind: table.kind,
        variants: table.variant === undefined || table.variant === '' ? [] : [table.variant],
        counts: restored === undefined ? null : tableCounts(table.kind, restored.data),
      });
      slots.push({ case: index, slot, records: [id] });
    }
  });
  for (const [index, table] of read.limits.byIndex) {
    slots.push({
      case: index,
      slot: { kind: LIMITS_COLUMN },
      records: [add({ name: table.source, kind: 'Limits' })],
    });
  }

  const session: SavedInventory['session'] = [];
  for (const [variant, table] of read.lookups) {
    const label = schemaFor(table.entity).label;
    // A list saved before it kept its sources still came from some file.
    const names = table.sources.length > 0 ? table.sources : [null];
    session.push({
      input: variant,
      records: names.map((name) => add({ name, kind: label })),
      editedInApp: false,
    });
  }
  if (read.limits.shared !== undefined) {
    session.push({
      input: SHARED_LIMITS_INPUT,
      records: [add({ name: read.limits.shared.source, kind: 'Limits' })],
      editedInApp: false,
    });
  }
  const fields = manifest as unknown as Record<string, unknown>;
  for (const kind of TABLE_KINDS) {
    if (mapsNothing(fields[GROUPS_FIELDS[kind]])) continue;
    session.push({
      input: groupsInput(kind),
      records: [add({ kind: groupsLabel(kind) })],
      editedInApp: false,
    });
  }

  return { records, slots, session, log: [], about: '' };
}
