// src/tables/long/block.ts
//
// The long parser's JS side: instantiate, set the block's shape, hand it
// whole rows, lift the row list out. Kept apart from worker.ts because it is
// the riskiest index arithmetic (source column -> output plane), so
// tests/test_ingest_area.mjs drives it directly in Node.

/** block.c's ABI_VERSION; a stale committed binary fails at instantiate. */
export const PARSER_ABI = 9;

import { afterNextNewline, NEWLINE } from '../../ingest';

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
  row_tou_ptr(): number;
  row_year_ptr(): number;
  area_seen_ptr(): number;
  last_rows(): number;
  last_emitted(): number;
  last_unknown_area(): number;
  last_bad_row(): number;
  last_overflow(): number;
  last_out_of_range(): number;
  last_bad_id(): number;
  last_bad_tou(): number;
  last_bad_cell(): number;
  last_ragged(): number;
  set_key_layout(keyCols: number, entityCol: number): number;
  area_table_reset(): void;
  area_table_put(hash: number, idx: number): number;
  parse_block(len: number, firstYear: number, numYears: number): number;
  scan_axis(len: number): number;
  axis_names(): number;
  axis_off_ptr(): number;
  axis_len_ptr(): number;
  axis_rows(): number;
  axis_overflow(): number;
  scan_min_year(): number;
  scan_years(): number;
  scan_year_rows_ptr(): number;
  scan_year_overflow(): number;
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
  /** The earliest and latest year a row's Date names, or NaN for both when
   * no Date reads (the parse refuses those rows with the reason). */
  minYear: number;
  maxYear: number;
  /** `yearRows[k]` rows are dated in year `minYear + k`; a zero inside the
   * span is a year this block skips. Rows with an unreadable Date are not in
   * it. */
  yearRows: number[];
}

/** One parsed block as a ROW LIST: each row carries its own placement. */
export interface BlockPayload {
  /** Rows placed; unplaceable rows are refused before a payload exists. */
  rows: number;
  /** Non-blank rows, placed or not. */
  scanned: number;
  planes: number;
  /** values[row * planes + p] for active plane p. */
  values: Float32Array;
  rowEntity: Uint16Array;
  /** Each row's year, as an offset from the Case's `firstYear`. */
  rowYear: Uint8Array;
  /** Each row's hour within its year's 8,784-hour slot. */
  rowHour: Uint16Array;
  /** Each row's TOU code from the file, 0 = OffPeak, 1 = OnPeak. Per row, so
   * `blitBlock` is the one place two rows' TOU for an hour are compared. */
  rowTou: Uint8Array;
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
    rowYear: new Uint8Array(0),
    rowHour: new Uint16Array(0),
    rowTou: new Uint8Array(0),
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

/** Read one block's identity column and each Date's year only: distinct
 * names, the non-blank row count and the rows per year. Skips metric fields
 * whole, so it costs about a quarter of a parse. */
export function scanAxis(
  parser: ParserExports,
  bytes: Uint8Array,
  from: number,
  to: number,
): AxisScan {
  if (to - from <= 0) return { names: [], rows: 0, minYear: NaN, maxYear: NaN, yearRows: [] };

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

  const yearOverflow = parser.scan_year_overflow();
  if (yearOverflow > 0) {
    throw new Error(
      `This block's dates span more than 256 years (${yearOverflow} row(s) past them). A Case ` +
        `spans at most 256 years, so the load is refused.`,
    );
  }
  const years = parser.scan_years();
  const minYear = years > 0 ? parser.scan_min_year() : NaN;
  const yearRows = Array.from(
    new Uint32Array(parser.memory.buffer, parser.scan_year_rows_ptr(), years),
  );

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

  return { names, rows, minYear, maxYear: minYear + years - 1, yearRows };
}

/**
 * Parse `bytes[from, to)` (a row boundary to just after a `\n`) into a row
 * list of the retained planes. `maxRows` is the scan's exact count; an
 * overflow is refused, never truncated. Any row order parses the same. The
 * Case spans `numYears` years from `firstYear`; a row dated outside them is
 * refused.
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
  firstYear: number,
  numYears: number,
): BlockPayload {
  const planes = activePlanes.length;
  if (to - from <= 0 || maxRows === 0) return emptyPayload(entityCount, planes);

  // The arena is laid out for THIS block: read WASM memory only after this.
  if (!parser.configure(entityCount, planes, maxRows, sourceMetricCount)) {
    // A block of rows carrying every field always fits (BLOCK_TARGET_BYTES is
    // held to that), so only rows short of their fields reach here.
    throw new Error(
      `A block of ${maxRows.toLocaleString()} rows x ${planes} retained column(s) does not fit ` +
        `the ${parser.arena_bytes()} B parser arena. Rows carrying every header field always ` +
        `fit, so this block's rows are shorter than the header; retaining fewer columns ` +
        `lets it load.`,
    );
  }

  // Rebuilt per block: one pool interleaves blocks from every case, and two
  // cases may order the same columns differently.
  const planeOf = new Int32Array(parser.memory.buffer, parser.plane_of_ptr(), sourceMetricCount);
  planeOf.fill(-1);
  for (let p = 0; p < planes; p++) planeOf[activePlanes[p]] = p;

  const scanned = parser.parse_block(loadInbuf(parser, bytes, from, to), firstYear, numYears);
  refuseCounted(parser, maxRows, firstYear, numYears);

  const rows = parser.last_emitted();
  if (rows === 0) return emptyPayload(entityCount, planes);

  return {
    rows,
    scanned,
    planes,
    values: new Float32Array(parser.memory.buffer, parser.values_ptr(), rows * planes).slice(),
    rowEntity: new Uint16Array(parser.memory.buffer, parser.row_area_ptr(), rows).slice(),
    rowYear: new Uint8Array(parser.memory.buffer, parser.row_year_ptr(), rows).slice(),
    rowHour: new Uint16Array(parser.memory.buffer, parser.row_hour_ptr(), rows).slice(),
    rowTou: new Uint8Array(parser.memory.buffer, parser.row_tou_ptr(), rows).slice(),
    entitySeen: new Uint8Array(parser.memory.buffer, parser.area_seen_ptr(), entityCount).slice(),
  };
}

/**
 * Refuse the block if parse_block counted anything it could not read. Each
 * row is counted against one refusal, in the order C checks them, so the
 * first message here names the first thing wrong with the file.
 */
function refuseCounted(
  parser: ParserExports,
  maxRows: number,
  firstYear: number,
  numYears: number,
): void {
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
      `${bad} row(s) carry a Date or Hour this parser could not read (expected M/D/YYYY, a ` +
        `day that exists in its month, and an hour-ending 1-24), or end before the entity ` +
        `column. Those rows would be dropped silently, so the load is refused.`,
    );
  }
  const outOfRange = parser.last_out_of_range();
  if (outOfRange > 0) {
    const years = numYears > 1 ? `${firstYear}-${firstYear + numYears - 1}` : `${firstYear}`;
    throw new Error(
      `${outOfRange} row(s) are dated outside ${years}, which this Case covers. A row from ` +
        `another year has no place in the Case, so the load is refused rather than folding ` +
        `it onto another year's hours.`,
    );
  }
  const badId = parser.last_bad_id();
  if (badId > 0) {
    throw new Error(
      `${badId} row(s) carry an empty or quoted entity field. Every row needs the name the ` +
        `entity axis is read from, and this reader splits on every comma, so a quoted field ` +
        `is not read as one. Re-export without quotes.`,
    );
  }
  const unknown = parser.last_unknown_area();
  if (unknown > 0) {
    throw new Error(
      `${unknown} row(s) carry an entity name that is not on the entity axis. The axis is read ` +
        `from every row, so this should be unreachable; the load is refused rather than ` +
        `dropping them.`,
    );
  }
  const badTou = parser.last_bad_tou();
  if (badTou > 0) {
    throw new Error(
      `${badTou} row(s) carry a TOU other than OnPeak or OffPeak (blank, quoted, or a third ` +
        `label). TOU is read from the file, never assumed, so the load is refused.`,
    );
  }
  const ragged = parser.last_ragged();
  if (ragged > 0) {
    throw new Error(
      `${ragged} row(s) carry more fields than the header. A quoted field holding a comma ` +
        `looks like this: it moves every later value into the next column. Re-export without ` +
        `commas inside fields.`,
    );
  }
  const badCell = parser.last_bad_cell();
  if (badCell > 0) {
    throw new Error(
      `${badCell} value cell(s) are neither blank nor a number (for example N/A or #VALUE!). ` +
        `Reading them as blank would hide them, so the load is refused. Blank the cells or ` +
        `re-export them as numbers.`,
    );
  }
}
