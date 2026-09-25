// src/tables/long/signature.ts
//
// The long SHAPE's key-column vocabulary.
//
// A long export has no preamble and no title line, so its KEY COLUMNS are the
// only evidence of kind, and also the layout its metrics start after --
// detection and ingest read the same fact. Each kind owns its own signature
// (`src/tables/bus/long.ts` is the worked example); this module owns only the
// shape of one, so no kind can reach another through it.

/** Where a long export's kind signature starts: `Date, Hour, TOU` hold columns
 * 0-2 in every shape-L header, fixed there by `parser/long/block.c`. What
 * follows differs by KIND. */
export const LONG_KEY_START = 3;

/**
 * A long-shape kind's key columns.
 *
 * The numbers that reach the parser are `keyColsOf()` and `entityCol`. No name
 * from `keys` ever crosses the ABI, and the noun is for messages only -- the
 * shared reader still cannot tell a bus file from an area one (AGENTS.md).
 */
export interface LongSignature {
  /** Key columns after `Date, Hour, TOU`, in source order, matched trimmed. */
  keys: readonly string[];
  /** Absolute source index of the column carrying the row's axis identity. */
  entityCol: number;
  /** Noun for messages: "area", "bus", "unit". Never read as a kind token. */
  noun: string;
}

/** Total key columns for a signature. Source metric `m` is column
 * `keyCols + m`, which is exactly what `set_key_layout()` is told. */
export function keyColsOf(sig: LongSignature): number {
  return LONG_KEY_START + sig.keys.length;
}
