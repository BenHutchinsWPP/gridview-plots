// src/tables/wide/worker.ts
//
// One worker = one WASM instance = one byte range at a time. The unit of work
// is a BYTE RANGE, so one file uses every core; each row carries its own hour,
// so blocks and rows may arrive in any order. The arena's split between width
// and rows travels with each block from the main thread, which knows the
// header. The real work is block.ts; this reads bytes, widens to whole rows,
// and transfers back.

import {
  afterNextNewline,
  instantiateParser,
  parseBytes,
  type BlockPayload,
  type Parser,
  type ParserBudget,
  type SlabLayout,
} from './block';

/** Bytes read past the end to finish the last row; a longer row re-reads
 * wider rather than truncating. */
const TAIL_BYTES = 64 * 1024;

export interface InitMessage {
  kind: 'init';
  module: WebAssembly.Module;
}

export interface BlockMessage {
  kind: 'block';
  blockId: number;
  caseIndex: number;
  file: File;
  start: number;
  end: number;
  /** False only for a file's first block (see src/tables/long/worker.ts). */
  skipPartialFirstRow: boolean;
  /** Ascending; see ColumnPlan.activePlanes. */
  activePlanes: Int32Array;
  /** The slab shape for this block: per block, since files in one drop may
   * differ in width. */
  layout: SlabLayout;
  /** The case's year; rows from another year are refused, not folded in. */
  year: number;
}

export type WorkerRequest = InitMessage | BlockMessage;

export interface BlockResult extends BlockPayload {
  kind: 'done';
  blockId: number;
  caseIndex: number;
}

export interface WorkerReady {
  kind: 'ready';
  /** The byte budgets this worker's instance reported: only a worker holds the
   * module, so this reply carries them. The pool checks all workers agree. */
  budget: ParserBudget;
}

export interface WorkerError {
  kind: 'error';
  blockId: number;
  message: string;
}

export type WorkerResponse = WorkerReady | BlockResult | WorkerError;

let parser: Parser | null = null;

/** Read [start, end) widened to whole rows (see src/tables/long/worker.ts).
 * The ranges must TILE the data region: an overlap is a duplicated hour. */
export async function readWholeRows(
  message: BlockMessage,
): Promise<{ bytes: Uint8Array; from: number; to: number }> {
  const size = message.file.size;
  let tail = TAIL_BYTES;
  for (;;) {
    const stop = Math.min(message.end + tail, size);
    const bytes = new Uint8Array(await message.file.slice(message.start, stop).arrayBuffer());

    let from = 0;
    if (message.skipPartialFirstRow) {
      from = afterNextNewline(bytes, 0);
      // No row boundary: every byte belongs to the previous block's row.
      if (from < 0) return { bytes, from: 0, to: 0 };
    }

    // Only the LAST block runs to the end of the file. Do not loosen this to
    // `stop >= size`: a block ending within TAIL_BYTES of EOF would then
    // re-parse the rows after it, and blitBlock refuses the duplicate hours.
    if (message.end >= size) return { bytes, from, to: bytes.length };

    const to = afterNextNewline(bytes, message.end - message.start);
    if (to >= 0) return { bytes, from, to };

    // Reached EOF: the final row straddles `end` and belongs to this block.
    if (stop >= size) return { bytes, from, to: bytes.length };

    // A row longer than the tail: retry wider.
    tail *= 4;
    if (message.start + tail > size + TAIL_BYTES) {
      throw new Error(`No row boundary within ${tail} B past byte ${message.end}.`);
    }
  }
}

/** The message pump, installed only in a real Worker, so Node tests can
 * import `readWholeRows`. */
const handleMessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  try {
    if (message.kind === 'init') {
      parser = await instantiateParser(message.module);
      const ready: WorkerReady = { kind: 'ready', budget: parser.budget };
      (self as unknown as Worker).postMessage(ready);
      return;
    }

    if (!parser) throw new Error('worker received a block before init');
    const { bytes, from, to } = await readWholeRows(message);
    const payload = parseBytes(
      parser,
      message.layout,
      bytes,
      from,
      to,
      message.activePlanes,
      message.year,
    );
    const result: BlockResult = {
      kind: 'done',
      blockId: message.blockId,
      caseIndex: message.caseIndex,
      ...payload,
    };
    (self as unknown as Worker).postMessage(result, [
      result.data.buffer,
      result.rowHour.buffer,
      result.rowTou.buffer,
    ]);
  } catch (error) {
    const failure: WorkerError = {
      kind: 'error',
      blockId: message.kind === 'block' ? message.blockId : -1,
      message: error instanceof Error ? error.message : String(error),
    };
    (self as unknown as Worker).postMessage(failure);
  }
};

if (typeof self !== 'undefined') self.onmessage = handleMessage;
