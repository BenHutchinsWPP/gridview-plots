// src/lookups/types.ts
//
// Reference lists (BusList, GeneratorList): the network description, not a
// simulation result. Not under src/tables/ because a lookup is not a KIND: no
// cube, no Case slot, no section, and a longer lifecycle (one list serves
// many Cases, outlives the drop it came with, and survives a restore). It
// names the entity axis it joins to but imports no kind.

/** Which entity axis a list describes, and the key its rows are keyed on. */
export type LookupEntity = 'bus' | 'generator';

/** The store's key, one list per variant for the whole session. */
export type LookupVariant = 'buslist' | 'generatorlist';

export const VARIANT_OF: Readonly<Record<LookupEntity, LookupVariant>> = {
  bus: 'buslist',
  generator: 'generatorlist',
};

/** One column, struct-of-arrays. Each arm has its own BLANK: numeric columns
 * use `nulls`, since 0 is a legitimate value (e.g. `BaseKV`). */
export type LookupColumn =
  /** `nulls[i] === 1` means blank. Never spell a blank as 0. */
  | { name: string; kind: 'int'; values: Int32Array; nulls: Uint8Array }
  | { name: string; kind: 'float'; values: Float64Array; nulls: Uint8Array }
  /** 0 = false, 1 = true, 2 = unknown. */
  | { name: string; kind: 'bool'; values: Uint8Array }
  /** Days since 1970-01-01, -1 = blank. */
  | { name: string; kind: 'date'; values: Int32Array }
  /** '' = blank. */
  | { name: string; kind: 'text'; values: string[] }
  /** Low-cardinality text, dictionary-encoded; `codes[i] === -1` is blank.
   * `labels` is SORTED, so drop order never changes the encoding. */
  | { name: string; kind: 'enum'; codes: Int32Array; labels: string[] };

export interface LookupTable {
  readonly entity: LookupEntity;
  readonly rowCount: number;
  /** Struct of arrays, one entry per column, sorted by name so two merges of
   * the same inputs agree byte for byte. */
  readonly columns: readonly LookupColumn[];
  /** Column name -> index, and key -> row. DERIVED, never written: a Map
   * saves as `{}`, and every join would silently resolve to -1. */
  readonly byName: ReadonlyMap<string, number>;
  readonly index: ReadonlyMap<string | number, number>;
  /** Which columns form `index`'s key, for display and diagnostics. */
  readonly keyColumns: readonly string[];
  /** Every file that contributed rows, in merge order. The union's provenance
   * is the only thing standing between a user and a cross-database join, so
   * the UI names every one of them. */
  readonly sources: readonly string[];
}
