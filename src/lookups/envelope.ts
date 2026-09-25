// src/lookups/envelope.ts
//
// A LookupTable's half of the v3 save envelope.
//
// The two hazards this file exists to defeat:
//
//   1. `byName` and `index` are `Map`s, and `JSON.stringify(new Map())` is
//      `{}`. A Map that reached the envelope would come back EMPTY, every join
//      would resolve to -1, and every grouped plot would collapse into the
//      "(no attribute)" bucket -- silently, which is this codebase's stated
//      worst failure. So both are DERIVED HERE at deserialize and are never
//      written. That rule is also in the type's own doc comment, because a
//      reader reaching for `index` needs it before they reach this file.
//   2. Typed arrays are not JSON. `Int32Array` stringifies to an object with
//      30,000 numeric keys and comes back as a plain object. storage.ts's
//      `@bytes` tag now carries any `ArrayBufferView` with its element type,
//      which is what this module relies on -- see the comment at `BYTES_TAG`.
//
// Everything here is plain data in and plain data out. No DOM, no OPFS: the
// I/O is storage.ts's, and this module can be driven whole from Node.

import { schemaFor } from './schema';
import type { LookupColumn, LookupEntity, LookupTable } from './types';

/** What the manifest carries per variant: the columns, and nothing derivable
 * from them. */
export interface SerializedLookup {
  entity: LookupEntity;
  rowCount: number;
  keyColumns: string[];
  sources: string[];
  columns: LookupColumn[];
}

export function serializeLookup(table: LookupTable): SerializedLookup {
  return {
    entity: table.entity,
    rowCount: table.rowCount,
    keyColumns: [...table.keyColumns],
    sources: [...table.sources],
    columns: table.columns.map((column) => ({ ...column })),
    // byName and index are absent ON PURPOSE. See the header.
  };
}

/** The length of a column, whichever arm it is. */
function lengthOf(column: LookupColumn): number {
  return column.kind === 'enum' ? column.codes.length : column.values.length;
}

/**
 * The inverse, with the guard the cube-size and presence-length checks are the
 * precedent for: a column that came back the wrong length is refused by name
 * rather than joined against and quietly answering -1.
 */
export function deserializeLookup(raw: unknown): LookupTable {
  const entry = raw as SerializedLookup;
  if (!entry || typeof entry !== 'object' || !Array.isArray(entry.columns)) {
    throw new Error('saved lookup is not a column set');
  }
  if (entry.entity !== 'bus' && entry.entity !== 'generator') {
    throw new Error(
      `saved lookup names entity "${String(entry.entity)}", which is not a list this build reads`,
    );
  }
  for (const column of entry.columns) {
    const length = lengthOf(column);
    if (length !== entry.rowCount) {
      throw new Error(
        `saved ${entry.entity} lookup column "${column.name}" is ${length} values, expected ` +
          `${entry.rowCount} (one per row)`,
      );
    }
    if (
      (column.kind === 'int' || column.kind === 'float') &&
      column.nulls.length !== entry.rowCount
    ) {
      throw new Error(
        `saved ${entry.entity} lookup column "${column.name}" has ${column.nulls.length} null ` +
          `flags for ${entry.rowCount} rows; the two are written together and must come back the ` +
          `same length`,
      );
    }
  }

  const keyColumn = entry.keyColumns[0] ?? schemaFor(entry.entity).keyColumn;
  const byName = new Map(entry.columns.map((column, index) => [column.name, index]));
  const keyAt = byName.get(keyColumn);
  if (keyAt === undefined) {
    throw new Error(`saved ${entry.entity} lookup has no "${keyColumn}" column to key its rows on`);
  }

  // Derived, never read off the file. The key's TYPE follows the column's, so
  // a restored int key is a number and matches the same join a freshly parsed
  // one does -- an int key restored as a string matches nothing, with no error.
  const key = entry.columns[keyAt];
  const index = new Map<string | number, number>();
  for (let row = 0; row < entry.rowCount; row++) {
    switch (key.kind) {
      case 'int':
      case 'float':
        if (key.nulls[row] !== 1) index.set(key.values[row], row);
        break;
      case 'text':
        if (key.values[row] !== '') index.set(key.values[row], row);
        break;
      case 'enum':
        if (key.codes[row] !== -1) index.set(key.labels[key.codes[row]], row);
        break;
      default:
        throw new Error(
          `saved ${entry.entity} lookup keys on "${keyColumn}", a ${key.kind} column`,
        );
    }
  }

  return {
    entity: entry.entity,
    rowCount: entry.rowCount,
    columns: entry.columns,
    byName,
    index,
    keyColumns: [keyColumn],
    sources: [...(entry.sources ?? [])],
  };
}
