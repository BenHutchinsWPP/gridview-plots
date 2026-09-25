// src/tables/long/block.ts
//
// The long parser's JS side: instantiate, set the block's shape, hand it
// whole rows, lift the row list out. Kept apart from worker.ts because it is
// the riskiest index arithmetic (source column -> output plane), so
// tests/test_ingest_area.mjs drives it directly in Node.

/** block.c's ABI_VERSION; a stale committed binary fails at instantiate. */
export const PARSER_ABI = 7;

import { afterNextNewline, NEWLINE } from '../../ingest';
import { HOURS_PER_YEAR } from '../../model/calendar';

// Re-exported for the ingest tests, which reach it through this module.
export { afterNextNewline };

export interface ParserExports {
  memory: WebAssembly.Memory;
  abi_version(): number;
  inbuf_ptr(): number;
  inbuf_size(): number;
  arena_bytes(): number;
  configure(numAreas: number, numPlanes: number, maxRows: number, sourceMetrics: number): number;
  plane_of_ptr(): number;
  values_ptr(): number;
  row_area_ptr(): number;
  row_hour_ptr(): number;
  tou_ptr(): number;
  area_seen_ptr(): number;
  last_rows(): number;
  last_emitted(): number;
  last_unknown_area(): number;
  last_bad_row(): number;
  last_overflow(): number;
  set_key_layout(keyCols: number, entityCol: number): number;
  area_table_reset(): void;
  area_table_put(hash: number, idx: number): number;
  parse_block(len: number): number;
  scan_axis(len: number): number;
  axis_names(): number;
  axis_off_ptr(): number;
  axis_len_ptr(): number;
  axis_rows(): number;
  axis_overflow(): number;
}

/** Where a long export's key columns end and metrics begin: numbers only, so
 * the module can tell where metrics start but never which kind it reads. */
export interface KeyLayout {
  /** Total key columns. Source metric `m` is column `keyCols + m`. */
  keyCols: number;
  /** The column whose value is the row's axis identity. */
  entityCol: number;
}

export const AREA_KEY_LAYOUT: KeyLayout = { keyCols: 4, entityCol: 3 };

export interface AxisScan {
  /** Distinct trimmed area names in this block, in first-seen order. */
  names: string[];
  /** Non-blank rows: the exact `maxRows` for a parse of these bytes. */
  rows: number;
}

/** One parsed block as a ROW LIST: each row carries its own placement. */
export interface BlockPayload {
  /** Rows placed; Feb 29 and unplaceable rows are excluded. */
  rows: number;
  /** Non-blank rows, placed or not. */
  scanned: number;
  planes: number;
  /** values[row * planes + p] for active plane p. */
  values: Float32Array;
  rowEntity: Uint16Array;
  rowHour: Uint16Array;
  /** Per-hour TOU code from the file; 0xFF = uncovered. */
  tou: Uint8Array;
  /** 1 = this area had at least one row in the block. */
  entitySeen: Uint8Array;
}

/** A block that contributed nothing, freshly allocated: transferred buffers
 * detach, so a shared constant would break the second empty block. */
function emptyPayload(entityCount: number, planes: number): BlockPayload {
  return {
    rows: 0,
    scanned: 0,
    planes,
    values: new Float32Array(0),
    rowEntity: new Uint16Array(0),
    rowHour: new Uint16Array(0),
    tou: new Uint8Array(0),
    entitySeen: new Uint8Array(entityCount),
  };
}

/** Instantiate the parser (one per worker: no SharedArrayBuffer on GitHub
 * Pages), set its key layout, and optionally load an axis. The pool refills
 * the axis in place when it changes (`useAxis`). */
export async function instantiateParser(
  module: WebAssembly.Module,
  hashes?: Uint32Array,
  layout: KeyLayout = AREA_KEY_LAYOUT,
): Promise<ParserExports> {
  const instance = await WebAssembly.instantiate(module, {});
  const parser = instance.exports as unknown as ParserExports;
  if (parser.abi_version?.() !== PARSER_ABI) {
    throw new Error(
      `block.wasm reports ABI ${parser.abi_version?.()} but this module expects ` +
        `${PARSER_ABI}. Rebuild parser/long/block.wasm with parser/long/build.sh and commit it.`,
    );
  }
  setKeyLayout(parser, layout);
  parser.area_table_reset();
  if (hashes) loadEntityAxis(parser, hashes);
  return parser;
}

/**
 * Point the module at a kind's key layout, per batch, since one pool serves
 * every kind. Must run before any read: at the default layout a six-key
 * export would parse as an area file with two garbage metric planes.
 */
export function setKeyLayout(parser: ParserExports, layout: KeyLayout): void {
  if (!parser.set_key_layout(layout.keyCols, layout.entityCol)) {
    throw new Error(
      `block.wasm refuses a key layout of ${layout.keyCols} key columns with the identity ` +
        `at column ${layout.entityCol}. Date, Hour and TOU hold columns 0-2, so the identity ` +
        `must be at 3 or later and the metrics must start after it.`,
    );
  }
}

/** Fill the module's entity hash table once the scan has found the axis. */
export function loadEntityAxis(parser: ParserExports, hashes: Uint32Array): void {
  parser.area_table_reset();
  for (let i = 0; i < hashes.length; i++) {
    if (!parser.area_table_put(hashes[i], i)) {
      throw new Error(
        `block.wasm's area table is full at ${hashes.length} areas. Raise AREA_TABLE in ` +
          `parser/long/block.c and rebuild.`,
      );
    }
  }
}

/** Copy a block into the input window, terminating an unterminated last row.
 * Returns the length to read. */
function loadInbuf(parser: ParserExports, bytes: Uint8Array, from: number, to: number): number {
  const inbufPtr = parser.inbuf_ptr();
  const inbufSize = parser.inbuf_size();
  const length = to - from;
  if (length + 1 > inbufSize) {
    throw new Error(`Block of ${length} B exceeds the ${inbufSize} B WASM input window.`);
  }
  const memory = new Uint8Array(parser.memory.buffer);
  memory.set(bytes.subarray(from, to), inbufPtr);
  let padded = length;
  if (memory[inbufPtr + padded - 1] !== NEWLINE) memory[inbufPtr + padded++] = NEWLINE;
  return padded;
}

/** Read one block's identity column only: distinct names and the non-blank
 * row count. Skips metric fields whole, so it costs about a quarter of a
 * parse. */
export function scanAxis(
  parser: ParserExports,
  bytes: Uint8Array,
  from: number,
  to: number,
): AxisScan {
  if (to - from <= 0) return { names: [], rows: 0 };

  const padded = loadInbuf(parser, bytes, from, to);
  const rows = parser.scan_axis(padded);

  const overflow = parser.axis_overflow();
  if (overflow > 0) {
    throw new Error(
      `This export carries more distinct area names than the parser can hold. The area axis is ` +
        `read from the Name column, so a file whose Name column is not an area code produces ` +
        `one "area" per row.`,
    );
  }

  const count = parser.axis_names();
  const inbufPtr = parser.inbuf_ptr();
  const offsets = new Uint32Array(parser.memory.buffer, parser.axis_off_ptr(), count);
  const lengths = new Uint32Array(parser.memory.buffer, parser.axis_len_ptr(), count);
  const memory = new Uint8Array(parser.memory.buffer);
  const decoder = new TextDecoder();
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const at = inbufPtr + offsets[i];
    names.push(decoder.decode(memory.subarray(at, at + lengths[i])));
  }

  return { names, rows };
}

/**
 * Parse `bytes[from, to)` (a row boundary to just after a `\n`) into a row
 * list of the retained planes. `maxRows` is the scan's exact count; an
 * overflow is refused, never truncated. Any row order parses the same.
 */
export function parseBytes(
  parser: ParserExports,
  bytes: Uint8Array,
  from: number,
  to: number,
  activePlanes: Int32Array,
  entityCount: number,
  sourceMetricCount: number,
  maxRows: number,
): BlockPayload {
  const planes = activePlanes.length;
  if (to - from <= 0 || maxRows === 0) return emptyPayload(entityCount, planes);

  // The arena is laid out for THIS block: read WASM memory only after this.
  if (!parser.configure(entityCount, planes, maxRows, sourceMetricCount)) {
    throw new Error(
      `A block of ${maxRows.toLocaleString()} rows x ${planes} retained column(s) does not fit ` +
        `the ${parser.arena_bytes()} B parser arena. Retain fewer columns, or lower ` +
        `BLOCK_TARGET_BYTES so blocks hold fewer rows.`,
    );
  }

  // Rebuilt per block: one pool interleaves blocks from every case, and two
  // cases may order the same columns differently.
  const planeOf = new Int32Array(parser.memory.buffer, parser.plane_of_ptr(), sourceMetricCount);
  planeOf.fill(-1);
  for (let p = 0; p < planes; p++) planeOf[activePlanes[p]] = p;

  const scanned = parser.parse_block(loadInbuf(parser, bytes, from, to));

  const overflow = parser.last_overflow();
  if (overflow > 0) {
    throw new Error(
      `${overflow} row(s) past the ${maxRows.toLocaleString()} the axis scan counted for this ` +
        `block. Both passes must see the same bytes.`,
    );
  }
  const bad = parser.last_bad_row();
  if (bad > 0) {
    throw new Error(
      `${bad} row(s) carry a Date or Hour this parser could not read (expected M/D/YYYY and ` +
        `an hour-ending 1-24), or end before the name column. Those rows would be dropped ` +
        `silently, so the load is refused.`,
    );
  }
  const unknown = parser.last_unknown_area();
  if (unknown > 0) {
    throw new Error(
      `${unknown} row(s) carry an area name that is not on the area axis. The axis is read from ` +
        `the Name column of every row, so this should be unreachable; the load is refused ` +
        `rather than dropping them.`,
    );
  }

  const rows = parser.last_emitted();
  if (rows === 0) return emptyPayload(entityCount, planes);

  return {
    rows,
    scanned,
    planes,
    values: new Float32Array(parser.memory.buffer, parser.values_ptr(), rows * planes).slice(),
    rowEntity: new Uint16Array(parser.memory.buffer, parser.row_area_ptr(), rows).slice(),
    rowHour: new Uint16Array(parser.memory.buffer, parser.row_hour_ptr(), rows).slice(),
    tou: new Uint8Array(parser.memory.buffer, parser.tou_ptr(), HOURS_PER_YEAR).slice(),
    entitySeen: new Uint8Array(parser.memory.buffer, parser.area_seen_ptr(), entityCount).slice(),
  };
}
