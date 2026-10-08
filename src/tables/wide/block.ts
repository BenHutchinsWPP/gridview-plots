// src/tables/wide/block.ts
//
// The wide parser's JS side: instantiate, hand it a block of whole rows, lift
// the active planes out of the slab. Kept apart from worker.ts because this
// is the riskiest index arithmetic in the build (a row stride the MODULE
// reports), so tests/test_ingest_interface.mjs drives it directly in Node.

import { KEY_COLS } from './header';

/** block.c's ABI_VERSION. */
export const PARSER_ABI = 5;

/**
 * What a parser build is fixed at: two byte budgets, read from the module.
 * Nothing about width: blocks are cut in bytes, so rows-per-block and width
 * are inversely related and the slab needs about the same room at any width.
 * Only the ABI says what the slab MEANS, so only the ABI is checked strictly.
 */
export interface ParserBudget {
  /** block.c's `ARENA_BYTES`: the scratch one block's output is laid out in. */
  arenaBytes: number;
  /** block.c's `BLOCK_BYTES`: the input window one block is copied into. */
  inbufBytes: number;
  /** block.c's `ABI_VERSION`, already checked against PARSER_ABI. */
  abi: number;
}

/** The shape one block's slab is configured to: a runtime split of the arena,
 * exactly as wide as the file's header. */
export interface SlabLayout {
  metrics: number;
  /** Rows one block may carry at that width. */
  rows: number;
}

/** Arena bytes per row at `metrics` planes (floats + u16 hour + u8 year +
 * u8 TOU); mirrors configure() in block.c. */
function rowCost(metrics: number): number {
  return metrics * 4 + 4;
}

/** Rows the arena holds at `metrics` planes, or 0. Blocks are sized from this,
 * never a constant, so a different arena needs no other change. */
export function maxRowsAt(budget: ParserBudget, metrics: number): number {
  if (!(metrics > 0)) return 0;
  return Math.floor(budget.arenaBytes / rowCost(metrics));
}

/** An instantiated parser and the budgets it reported. */
export interface Parser {
  exports: ParserExports;
  budget: ParserBudget;
}

/**
 * Marker on the slab overflow error. Workers post only `error.message`, so
 * this string is how the retry recognises the one failure it can fix. Never
 * localise or reword it.
 */
export const OVERFLOW_MARKER = 'block-slab-overflow';

/** True for the overflow error above, wherever it has been stringified. */
export function isOverflowError(message: string): boolean {
  return message.includes(OVERFLOW_MARKER);
}

import { afterNextNewline, NEWLINE } from '../../ingest';

// Re-exported for worker.ts and the ingest tests.
export { afterNextNewline, NEWLINE };

export interface ParserExports {
  memory: WebAssembly.Memory;
  inbuf_ptr(): number;
  inbuf_size(): number;
  slab_ptr(): number;
  row_hour_ptr(): number;
  row_year_ptr(): number;
  row_tou_ptr(): number;
  arena_bytes(): number;
  /** The layout currently configured; 0 before the first `configure`. */
  slab_rows(): number;
  slab_metrics(): number;
  abi_version(): number;
  last_rows(): number;
  last_overflow(): number;
  last_wide_field(): number;
  last_bad_row(): number;
  last_out_of_range(): number;
  last_bad_tou(): number;
  last_bad_cell(): number;
  /** Lay the arena out as `numMetrics x maxRows`. Returns 0 if it will not
   * fit, and leaves the regions null so a parse writes nothing. */
  configure(numMetrics: number, maxRows: number): number;
  slab_fill_nan(rows: number): void;
  parse_block(len: number, firstYear: number, numYears: number): number;
}

/** One parsed block as a ROW LIST: row `r` holds the values at
 * (`rowYear[r]`, `rowHour[r]`), in byte order, which means nothing. */
export interface BlockPayload {
  /** Valid rows emitted; refused rows are counted and refused apart. */
  rows: number;
  /** data[p * rows + r], plane-major so one entity is a contiguous copy. */
  data: Float32Array;
  /** Each row's year, as an offset from the Case's `firstYear`. Length `rows`. */
  rowYear: Uint8Array;
  /** Hour within its year's 8,784-hour slot each row lands on. Length `rows`. */
  rowHour: Uint16Array;
  /** Per-row TOU code from the file. Length `rows`. */
  rowTou: Uint8Array;
}

/** A block that contributed nothing, freshly allocated every time (see
 * src/tables/long/block.ts). */
function emptyPayload(): BlockPayload {
  return {
    rows: 0,
    data: new Float32Array(0),
    rowYear: new Uint8Array(0),
    rowHour: new Uint16Array(0),
    rowTou: new Uint8Array(0),
  };
}

/**
 * Instantiate the parser and read its budgets; every worker needs its own
 * instance (no SharedArrayBuffer on GitHub Pages). The ABI is CHECKED, the
 * budgets READ: any arena can be driven within its budget, but a slab that
 * MEANS something else cannot be driven correctly at any size.
 */
export async function instantiateParser(module: WebAssembly.Module): Promise<Parser> {
  const instance = await WebAssembly.instantiate(module, {});
  const exports = instance.exports as unknown as ParserExports;
  // A stale block.wasm must fail HERE, before a block is parsed: an older
  // slab layout gives wrong numbers, not an error.
  if (typeof exports.abi_version !== 'function' || exports.abi_version() !== PARSER_ABI) {
    const found = typeof exports.abi_version === 'function' ? exports.abi_version() : 'none';
    throw new Error(
      `block.wasm reports ABI ${found}, but this build speaks ABI ${PARSER_ABI}. ` +
        `Rebuild the parser: parser/wide/build.sh.`,
    );
  }
  const budget: ParserBudget = {
    arenaBytes: exports.arena_bytes(),
    inbufBytes: exports.inbuf_size(),
    abi: exports.abi_version(),
  };
  // A zero budget would surface much later as "file too wide"; refuse now.
  if (!(budget.arenaBytes > 0) || !(budget.inbufBytes > 0)) {
    throw new Error(
      `block.wasm reports arena_bytes()=${budget.arenaBytes}, ` +
        `inbuf_size()=${budget.inbufBytes}. Both must be positive; this binary ` +
        `cannot be driven.`,
    );
  }
  return { exports, budget };
}

/**
 * Parse `bytes[from, to)` (a row boundary to just after a `\n`) and lift
 * `activePlanes`. Every row carries its own hour, so blocks and rows may come
 * in any order. The Case spans `numYears` years from `firstYear`; a row
 * dated outside them is refused.
 */
export function parseBytes(
  parser: Parser,
  layout: SlabLayout,
  bytes: Uint8Array,
  from: number,
  to: number,
  activePlanes: Int32Array,
  firstYear: number,
  numYears: number,
): BlockPayload {
  const length = to - from;
  if (length <= 0) return emptyPayload();

  const { exports } = parser;
  const { metrics: slabMetrics, rows: slabRows } = layout;

  // Configured in the same call that parses, so every stride below is the
  // shape just asked for and no block can inherit a stale one. It is cheap.
  if (!exports.configure(slabMetrics, slabRows)) {
    throw new Error(
      `The parser's ${parser.budget.arenaBytes} B arena cannot hold a ` +
        `${slabMetrics} x ${slabRows} slab (${slabRows * rowCost(slabMetrics)} B ` +
        `needed). Cut smaller blocks or build the parser with a larger ARENA_MIB.`,
    );
  }

  const inbufPtr = exports.inbuf_ptr();
  const inbufSize = exports.inbuf_size();
  if (length + 1 > inbufSize) {
    throw new Error(`Block of ${length} B exceeds the ${inbufSize} B WASM input window.`);
  }

  const memory = new Uint8Array(exports.memory.buffer);
  memory.set(bytes.subarray(from, to), inbufPtr);
  let padded = length;
  // parse_block emits a row at its terminator; add one so the last row counts.
  if (memory[inbufPtr + padded - 1] !== NEWLINE) memory[inbufPtr + padded++] = NEWLINE;

  // Clear the whole configured slab: a stale float from the previous block
  // would be a plausible wrong number.
  exports.slab_fill_nan(slabRows);
  const rows = exports.parse_block(padded, firstYear, numYears);

  // Counters are read before the empty-block shortcut: a block whose every
  // row was refused has the most to report.
  const wide = exports.last_wide_field();
  if (wide > 0) {
    throw new Error(
      `${wide} field(s) sit past column ${slabMetrics + KEY_COLS}, but this file's header ` +
        `declared ${slabMetrics} entity columns. Rows carrying more fields than the ` +
        `header would be dropped silently, so the load is refused instead.`,
    );
  }
  const bad = exports.last_bad_row();
  if (bad > 0) {
    throw new Error(
      `${bad} row(s) carry a Date or Hour this parser could not read (expected M/D/YYYY and ` +
        `an hour-ending 1-24). Those rows would be dropped silently, so the load is refused.`,
    );
  }
  const outOfRange = exports.last_out_of_range();
  if (outOfRange > 0) {
    const years = numYears > 1 ? `${firstYear}-${firstYear + numYears - 1}` : `${firstYear}`;
    throw new Error(
      `${outOfRange} row(s) are dated outside ${years}, which this Case covers. A row from ` +
        `another year has no place in the Case, so the load is refused rather than folding ` +
        `it onto another year's hours.`,
    );
  }
  const badTou = exports.last_bad_tou();
  if (badTou > 0) {
    throw new Error(
      `${badTou} row(s) carry a TOU other than OnPeak or OffPeak (blank, quoted, or a third ` +
        `label). TOU is read from the file, never assumed, so the load is refused.`,
    );
  }
  const badCell = exports.last_bad_cell();
  if (badCell > 0) {
    throw new Error(
      `${badCell} value cell(s) are neither blank nor a number (for example N/A or #VALUE!). ` +
        `Reading them as blank would hide them, so the load is refused. Blank the cells or ` +
        `re-export them as numbers.`,
    );
  }
  const overflow = exports.last_overflow();
  if (overflow > 0) {
    throw new Error(
      `${OVERFLOW_MARKER}: ${overflow} row(s) past the ${slabRows}-row block slab — this ` +
        `block held more rows than its byte length predicted.`,
    );
  }

  if (rows === 0) return emptyPayload();

  // Plane-major on both sides, so each entity is one contiguous copy.
  const slab = new Float32Array(exports.memory.buffer, exports.slab_ptr(), slabMetrics * slabRows);
  const data = new Float32Array(activePlanes.length * rows);
  for (let p = 0; p < activePlanes.length; p++) {
    const src = activePlanes[p] * slabRows;
    data.set(slab.subarray(src, src + rows), p * rows);
  }

  const rowYear = new Uint8Array(exports.memory.buffer, exports.row_year_ptr(), slabRows);
  const rowHour = new Uint16Array(exports.memory.buffer, exports.row_hour_ptr(), slabRows);
  const rowTou = new Uint8Array(exports.memory.buffer, exports.row_tou_ptr(), slabRows);

  return {
    rows,
    data,
    // Copied, not viewed: transferred to the main thread, and the next block
    // reuses this memory.
    rowYear: rowYear.slice(0, rows),
    rowHour: rowHour.slice(0, rows),
    rowTou: rowTou.slice(0, rows),
  };
}
