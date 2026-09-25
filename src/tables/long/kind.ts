// src/tables/long/kind.ts
//
// The long SHAPE's data types, and the seam a KIND joins it at. Kept beside
// the reader, not in a kind, so each kind describes its ingest without
// importing another kind (asserted in tests/test_kernels_bus.mjs).

import type { LongSignature } from './signature';

export interface HeaderInfo {
  /** Fields exactly as they appear in the file (CR stripped), for display. */
  raw: string[];
  /** `raw` trimmed -- the key everything else matches on. */
  canonical: string[];
  dateCol: number;
  hourCol: number;
  touCol: number;
  /** The column carrying the row's identity -- `Name`, `BusID`, `UnitName`. */
  entityCol: number;
  /** Key columns in THIS file. Source metric `m` is column `keyCols + m`. */
  keyCols: number;
  /** In source order. */
  metricNames: string[];
}

export interface ColumnPlan {
  /** The cube's metric axis: the retained list, in cube-metric-index order. */
  metrics: string[];
  /** By SOURCE column: the cube metric index it feeds, or -1 (key columns
   * always). */
  plan: Int32Array;
  /** The same mapping by slab plane (`plane m` = `source column m + keyCols`),
   * length `sourceMetricCount`; the worker and blit index by this. */
  slabPlan: Int32Array;
  /** Slab planes with a destination, ascending -- the transfer order. */
  activePlanes: Int32Array;
  /** Per-metric presence: 1 = this case's header carries it, 0 = absent. */
  presence: Uint8Array;
  /** Source metric slots in this file, independent of what was retained. */
  sourceMetricCount: number;
}

export interface CasePlan {
  file: File;
  /** What a note calls this plan: the file's name, or every merged file's. */
  label: string;
  header: HeaderInfo;
  /** Byte offset of the first data row -- block 0 starts here, not at 0. */
  dataStart: number;
  year: number;
  /** This case's entity axis, read from every row by discoverEntities(). */
  entities: string[];
  /** Rows per byte range from the same scan: an exact bound per block. */
  rowsPerBlock: number[];
}

export interface CaseAccumulator {
  plan: ColumnPlan;
  entityCount: number;
  cube: Float32Array;
  /** Per-hour TOU code, 0xFF until a row covers the hour. */
  tou: Uint8Array;
  entitySeen: Uint8Array;
  hourSeen: Uint8Array;
  /** One bit per (entity, hour): a second row for a cell (two concatenated
   * exports) is refused rather than silently overwriting. */
  covered: Uint8Array;
}

/** How a KIND turns a finished accumulator into its table(s): Area builds
 * one `AreaTable`; a one-quantity kind builds one table per metric. The same
 * seam as the wide reader's `Finalize`. */
export type Finalize<T> = (
  accumulator: CaseAccumulator,
  plan: CasePlan,
  axis: string[],
) => { data: T; warnings: string[] };

/** One long-shape kind: its key columns, its retention notes, and its
 * finalizer, in one object so a file cannot be read as one kind and
 * finalized as another. No kind token: the reader only calls back. */
export interface LongKind<T> {
  sig: LongSignature;
  /** Notes about the retained set before the parse (Area: a missing weight). */
  retention?: (metrics: string[]) => string[];
  finalize: Finalize<T>;
}
