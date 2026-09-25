// src/storage/envelope.ts
//
// The v3 bundle envelope: manifest types, the tagging that lets a typed array
// ride in JSON, and the pure halves of save and load (`buildManifest`,
// `casesFromManifest`). No I/O. It sits below `store.ts` and `legacy.ts` so
// the two do not form an import cycle.
//
// Cubes never enter the JSON: `buildManifest` returns them as views beside the
// manifest, and `store.ts` frames them on disk.
//
// Session-wide state rides at the top level, not on a Case: the area
// `groupings`, the reference lists, and the three group maps. The group maps
// are three fields, not one keyed by kind, because their key types differ and
// interface members carry a direction.
//
// A table's own fields are opaque here; each kind's `serialize`/`deserialize`
// comes from `src/tables/registry.ts`. An unknown kind is skipped with a
// warning on read.
//
// Both the retained and the full source column lists are saved, so an unkept
// column does not look like one the study never had. Presence and TOU bitmaps
// must survive byte-for-byte: a lost presence bit turns absent data into a
// plausible number.

import type { SessionReference } from '../session/reference';
import type { SavedGeneratorGroups } from '../tables/generator/groups';
import type { SavedBusGroups } from '../tables/bus/groups';
import type { SavedInterfaceGroups } from '../tables/interface/groups';
import { serializeLookup } from '../lookups/envelope';
import { saveCaseLimits, serializeLimits, type SavedCaseLimits } from '../limits/envelope';
import type { LimitTable } from '../limits/types';
import { saveInventory, type InventorySnapshot, type SavedInventory } from '../inventory/store';
import type { LookupTable, LookupVariant } from '../lookups/types';
import {
  slotKey,
  type Case,
  type RestoredCase,
  type TableKind,
  type TableSlotKey,
} from '../model/case-model';
import { tableKindEntry, type TableFields } from '../tables/registry';
import { savePins, type SavedPin, type SelectionEntry } from '../ui/browse-model';

/** The v3 envelope's version. Version plus magic is what tells a legacy v1
 * (`GVAP`) or v2 (`GVIP`) file apart. */
export const BUNDLE_VERSION = 3;

/** One table in a case's `tables` map. `kind` is a plain string: another
 * build may have written it, so it is checked against the registry, not
 * assumed. */
export interface ManifestTableV3 {
  kind: string;
  variant?: string;
  cubeBytes: number;
  /** Everything else is that kind's own `serialize()` output. */
  [field: string]: unknown;
}

export interface ManifestCaseV3 {
  id: string;
  name: string;
  /** The Case's display name, on its own entry, so it is by Case index as
   * everything else is. Optional: older bundles show the name. */
  displayName?: string;
  /**
   * Sum of this case's tables' `cubeBytes`. The OPFS worker slices the blob by
   * it and knows nothing of tables, so every writer (legacy migration
   * included) must fill it; `casesFromManifest` refuses a mismatch.
   */
  cubeBytes: number;
  /** Keyed by `slotKey` (src/model/case-model.ts): one Case can hold two
   * tables of one kind under different variants. */
  tables: Record<string, ManifestTableV3>;
}

export interface ManifestV3 {
  version: number;
  cases: ManifestCaseV3[];
  /** The area -> grouping mapping in effect, as a Groupings.csv. Optional:
   * older bundles load it as `null`. */
  groupings?: string;
  /** Reference lists (BusList, GeneratorList) by variant. Optional. */
  lookups?: Record<string, unknown>;
  /** Pinned rows, each against its Case's INDEX in `cases` (see `SavedPin`). */
  pins?: readonly SavedPin[];
  /** Read only, never written: older bundles' pins, carrying each Case's id
   * in this manifest. `restoreBundle` converts them to `pins`. */
  selections?: readonly SelectionEntry[];
  layout?: readonly string[];
  /** The drawer's dragged height in pixels; absent on a detent. Optional. */
  drawerHeight?: number;
  /** Generator group map, by GeneratorList name, with its column mapping. */
  generatorGroups?: SavedGeneratorGroups;
  /** Bus group map, by BusList id, with its column mapping. */
  busGroups?: SavedBusGroups;
  /** Interface group map: member paths each with its direction (without it,
   * the sum would be wrong), plus the column mapping. */
  interfaceGroups?: SavedInterfaceGroups;
  /**
   * Interface limits: the shared table, and in `byCase` those pinned to a Case
   * by its INDEX in `cases` (see `SavedCaseLimits`), never by an id or an
   * editable name. `cases` is read only: older bundles' per-Case tables keyed
   * by manifest id. `restoreBundle` reads both into one form.
   */
  limits?: { shared?: unknown; byCase?: SavedCaseLimits[]; cases?: Record<string, unknown> };
  /** The Contents panel's inventory: which file built what, the Log and the
   * About note, every Case by its INDEX in `cases` (see `SavedInventory`).
   * Optional: older bundles carry none. */
  inventory?: SavedInventory;
}

// Keys the envelope owns. A kind's `serialize()` must not return one, or it
// would overwrite the entry's kind, variant or byte count.
const RESERVED_FIELDS = ['kind', 'variant', 'cubeBytes'];

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Bitmaps are the only non-JSON values a serializer returns. Encoding them
// here keeps base64 out of every kind and the two directions symmetric.
export const BYTES_TAG = '@bytes';
/**
 * The element type of a `@bytes` value, for lookup columns. They cannot ride
 * in the binary section, which is sliced per CASE, and they are small. A tag
 * with no `@type` is a `Uint8Array`, so older bitmaps decode unchanged.
 */
const TYPE_TAG = '@type';

const VIEW_TYPES = {
  Uint8Array,
  Int32Array,
  Float32Array,
  Float64Array,
} as const;

function encodeValue(value: unknown): unknown {
  if (ArrayBuffer.isView(value)) {
    const name = value.constructor.name;
    if (!(name in VIEW_TYPES)) {
      throw new Error(
        `cannot save a ${name}: the envelope encodes ${Object.keys(VIEW_TYPES).join(', ')}`,
      );
    }
    const bytes = new Uint8Array(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength);
    return name === 'Uint8Array'
      ? { [BYTES_TAG]: toBase64(bytes) }
      : { [BYTES_TAG]: toBase64(bytes), [TYPE_TAG]: name };
  }
  if (Array.isArray(value)) return value.map(encodeValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [name, inner] of Object.entries(value as Record<string, unknown>)) {
      out[name] = encodeValue(inner);
    }
    return out;
  }
  return value;
}

export function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (BYTES_TAG in record) {
      const bytes = fromBase64(record[BYTES_TAG] as string);
      const name = (record[TYPE_TAG] as string | undefined) ?? 'Uint8Array';
      const view = VIEW_TYPES[name as keyof typeof VIEW_TYPES];
      if (!view) throw new Error(`saved bundle carries a "${name}" value this build cannot read`);
      // A wrong length is caught by the caller, which names the field.
      return new view(bytes.buffer as ArrayBuffer, 0, bytes.byteLength / view.BYTES_PER_ELEMENT);
    }
    const out: Record<string, unknown> = {};
    for (const [name, inner] of Object.entries(record)) out[name] = decodeValue(inner);
    return out;
  }
  return value;
}

function encodeFields(fields: TableFields): Record<string, unknown> {
  return encodeValue(fields) as Record<string, unknown>;
}

function decodeFields(fields: Record<string, unknown>): TableFields {
  return decodeValue(fields) as TableFields;
}

/** A table entry's kind-specific fields: everything the envelope does not own. */
function fieldsOf(table: ManifestTableV3): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(table)) {
    if (!RESERVED_FIELDS.includes(name)) out[name] = value;
  }
  return out;
}

function cubeBytesOf(cube: Float32Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(cube.buffer as ArrayBuffer, cube.byteOffset, cube.byteLength);
}

/**
 * Everything a bundle carries besides the Cases, all optional. Defaults are
 * the EMPTY session, never a live read: the caller states what to save, and
 * `readSessionReference()` is how it says "whatever is loaded".
 */
export interface BundleContents extends Partial<SessionReference> {
  /** The session's browse drawer selections. */
  readonly selections?: readonly SelectionEntry[];
  readonly layout?: readonly string[];
  /** The drawer's dragged height in pixels; null when it sits on a detent. */
  readonly drawerHeight?: number | null;
  /** The session's inventory, keyed by live Case id; written by index. */
  readonly inventory?: InventorySnapshot;
}

/**
 * Build the v3 manifest and its cube chunks in write order: one `Uint8Array`
 * per TABLE, cases in order, tables in slot order. Chunks are views on the
 * live cubes, streamed one at a time so the study is never copied in memory.
 */
export function buildManifest(
  cases: readonly Case[],
  contents: BundleContents = {},
): { manifest: ManifestV3; cubes: Uint8Array<ArrayBuffer>[] } {
  const {
    groupings = null,
    lookups = new Map<LookupVariant, LookupTable>(),
    generatorGroups = null,
    busGroups = null,
    interfaceGroups = null,
    limits = { shared: undefined, cases: new Map<string, LimitTable>() },
    selections = [],
    layout = ['time', 'duration', 'box', 'stacked'],
    drawerHeight = null,
    inventory,
  } = contents;
  const manifestCases: ManifestCaseV3[] = [];
  const cubes: Uint8Array<ArrayBuffer>[] = [];

  for (const entry of cases) {
    const tables: Record<string, ManifestTableV3> = {};
    let caseBytes = 0;

    for (const [slot, table] of entry.tables) {
      const registered = tableKindEntry(table.key.kind);
      if (!registered) {
        // Saving an unregistered kind is a wiring bug, not a compatibility
        // question.
        throw new Error(
          `case "${entry.name}": no serializer is registered for table kind "${table.key.kind}"`,
        );
      }
      const serialized = registered.serialize(table.data);
      const fields = encodeFields(serialized.fields);
      for (const reserved of RESERVED_FIELDS) {
        if (reserved in fields) {
          throw new Error(
            `table kind "${table.key.kind}" serialized a reserved field "${reserved}"`,
          );
        }
      }

      const bytes = cubeBytesOf(serialized.cube);
      cubes.push(bytes);
      caseBytes += bytes.byteLength;
      tables[slot] = {
        ...fields,
        kind: table.key.kind,
        ...(table.key.variant === undefined ? {} : { variant: table.key.variant }),
        cubeBytes: bytes.byteLength,
      };
    }

    manifestCases.push({
      id: entry.id,
      name: entry.name,
      ...(entry.displayName ? { displayName: entry.displayName } : {}),
      cubeBytes: caseBytes,
      tables,
    });
  }

  const manifest: ManifestV3 = { version: BUNDLE_VERSION, cases: manifestCases };
  if (groupings !== null) manifest.groupings = groupings;
  if (lookups.size > 0) {
    // Typed-array columns use the `@bytes` tag. `byName` and `index` are Maps
    // (JSON `{}`), so they are rebuilt on read, not written.
    const encoded: Record<string, unknown> = {};
    for (const [variant, table] of lookups) encoded[variant] = encodeValue(serializeLookup(table));
    manifest.lookups = encoded;
  }
  const pins = savePins(
    selections,
    manifestCases.map((entry) => entry.id),
  );
  if (pins.length > 0) {
    manifest.pins = pins;
  }
  if (layout.length > 0) {
    manifest.layout = layout;
  }
  if (drawerHeight !== null) {
    manifest.drawerHeight = drawerHeight;
  }
  if (generatorGroups !== null) {
    manifest.generatorGroups = generatorGroups;
  }
  if (busGroups !== null) {
    manifest.busGroups = busGroups;
  }
  if (interfaceGroups !== null) {
    manifest.interfaceGroups = interfaceGroups;
  }
  // Plain JSON: limits are kilobytes (see `limits/envelope.ts`).
  const byCase = saveCaseLimits(
    limits.cases,
    manifestCases.map((entry) => entry.id),
  );
  if (limits.shared !== undefined || byCase.length > 0) {
    const written: NonNullable<ManifestV3['limits']> = {};
    if (limits.shared !== undefined) written.shared = serializeLimits(limits.shared);
    if (byCase.length > 0) written.byCase = byCase;
    manifest.limits = written;
  }
  if (inventory !== undefined) {
    manifest.inventory = saveInventory(
      inventory,
      manifestCases.map((entry) => entry.id),
    );
  }
  return { manifest, cubes };
}

/**
 * The inverse: a v3 manifest plus ONE `ArrayBuffer` per case back into
 * `Case`s. Per case because the OPFS worker slices by case and cannot see
 * tables; a single-table case's view is zero-copy. A table of an unknown kind
 * is SKIPPED with a warning and the rest still loads.
 */
export function casesFromManifest(
  manifest: ManifestV3,
  cubes: readonly ArrayBuffer[],
): { cases: RestoredCase[]; warnings: string[] } {
  if (manifest.version > BUNDLE_VERSION) {
    throw new Error(
      `Saved bundle is version ${manifest.version}; this build reads version ` +
        `${BUNDLE_VERSION}. Upgrade the app to open it.`,
    );
  }
  if (manifest.version !== BUNDLE_VERSION) {
    // v1/v2 manifests are migrated before reaching here, so any other
    // version is one this build does not know: refuse it by name.
    throw new Error(
      `Saved bundle is version ${manifest.version}; this build reads version ${BUNDLE_VERSION}.`,
    );
  }

  const warnings: string[] = [];
  const cases: RestoredCase[] = [];

  manifest.cases.forEach((entry, index) => {
    const buffer = cubes[index];
    if (!buffer) {
      throw new Error(`Saved bundle is missing the cube bytes for case "${entry.name}".`);
    }
    if (buffer.byteLength !== entry.cubeBytes) {
      throw new Error(
        `Saved cube block for case "${entry.name}" is ${buffer.byteLength} bytes, ` +
          `expected ${entry.cubeBytes}.`,
      );
    }

    const tables = new Map<string, { key: TableSlotKey; data: unknown }>();
    let offset = 0;

    for (const [slot, table] of Object.entries(entry.tables)) {
      const start = offset;
      offset += table.cubeBytes;

      const registered = tableKindEntry(table.kind);
      if (!registered) {
        warnings.push(
          `Case "${entry.name}": dropped its "${table.kind}" table (slot "${slot}") — this ` +
            `build has no reader for that table kind, and saving again will not carry it.`,
        );
        continue;
      }

      // The registry lookup above is the narrowing.
      const kind = table.kind as TableKind;
      const key: TableSlotKey =
        table.variant === undefined ? { kind } : { kind, variant: table.variant };
      const cube = sliceCube(buffer, start, table.cubeBytes);
      let data: unknown;
      try {
        data = registered.deserialize(decodeFields(fieldsOf(table)), cube);
      } catch (error) {
        throw new Error(
          `Case "${entry.name}", slot "${slot}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // Keyed by the slot key recomputed from (kind, variant), so a key
      // another build spelled differently still matches this build's lookups.
      tables.set(slotKey(key), { key, data });
    }

    if (offset !== entry.cubeBytes) {
      throw new Error(
        `Saved bundle's case "${entry.name}" claims ${entry.cubeBytes} cube bytes but its ` +
          `tables account for ${offset}.`,
      );
    }
    const displayName =
      typeof entry.displayName === 'string' && entry.displayName.trim() !== ''
        ? { displayName: entry.displayName }
        : {};
    cases.push({ id: entry.id, name: entry.name, ...displayName, tables });
  });

  return { cases, warnings };
}

/** A table's slice of its case's cube block; no copy for a single table. */
function sliceCube(buffer: ArrayBuffer, offset: number, bytes: number): ArrayBuffer {
  return offset === 0 && bytes === buffer.byteLength
    ? buffer
    : buffer.slice(offset, offset + bytes);
}
