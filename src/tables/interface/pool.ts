// src/tables/interface/pool.ts
//
// The Interface kind's adapter onto the wide shape reader.
//
// Everything about parsing shape W -- the worker pool, the block cutting, the
// shrink-retry loop, the cube scatter -- is in `src/tables/wide/pool.ts` and is
// shared with every other kind that arrives in that shape. What is
// Interface's, and what this file is, is exactly three things:
//
//   * the spec: four preamble lines, header on line 5, entity noun
//     "interface". Numbers plus a word used only in messages.
//   * `finalize`: turning the shape's `(entity x 8760)` cube into an
//     `InterfaceTable`, which is where the quantity, the unit and the source
//     column list are attached.
//   * the entry points main.ts and this kind's tests call.
//
// Nothing in `src/tables/wide/` learns that any of this exists.

import {
  finalizeWide,
  ingest as ingestWide,
  ingestWithWorkers as ingestWideWithWorkers,
  readCasePlan as readWideCasePlan,
  type CasePlan,
  type Finalize,
  type IngestResult as WideIngestResult,
  type WideCase,
} from '../wide/pool';
import type { ParserBudget } from '../wide/block';
import { INTERFACE_SPEC } from './header';
import type { InterfaceTable } from './types';
import { unitOf } from './rules';

// The shape reader's surface, re-exported so main.ts, the benches and the
// tests keep reaching a kind's ingest at `src/tables/<kind>/pool.ts`.
export {
  BLOCK_TARGET_BYTES,
  blitBlock,
  caseNameOf,
  coverageOf,
  createAccumulator,
  cubeBytesFor,
  hasSimd,
  layoutFor,
  NO_SIMD_MESSAGE,
  partitionByFailure,
  safeBlockRows,
  unionOf,
  warmPool,
} from '../wide/pool';
export type { CasePlan, WideCase } from '../wide/pool';

/** One Interface batch's result. */
export type IngestResult = WideIngestResult<InterfaceTable>;

/** Read one Interface file's preamble, header and first row. */
export function readCasePlan(file: File): Promise<CasePlan> {
  return readWideCasePlan(file, INTERFACE_SPEC);
}

/**
 * The shape's cube plus what only Interface knows about it: the quantity the
 * title line names, the unit that quantity implies
 * (`data/interface/quantity-rules.json`), and every column the source carried.
 *
 * A Case can hold two Interface tables (e.g. Power Flow and Congestion
 * Cost from one run) and the quantity is what the slot variant is derived
 * from, so losing it here would leave them indistinguishable.
 */
const finalizeInterface: Finalize<InterfaceTable> = (wide: WideCase, plan: CasePlan) => ({
  data: {
    cube: wide.cube,
    interfaces: wide.entities,
    presence: wide.presence,
    tou: wide.tou,
    hoursPresent: wide.hoursPresent,
    sourceColumns: plan.header.entityNames,
    year: wide.year,
    quantity: wide.title.quantity,
    unit: unitOf(wide.title.quantity),
  },
  warnings: [],
});

/**
 * Close one accumulator into an `InterfaceTable`.
 *
 * Kept at this signature because it is what this kind's tests drive directly:
 * the shape's finalizer runs first and reports what bytes and coverage can see,
 * then Interface's attaches the quantity.
 */
export function finalizeCase(
  accumulator: Parameters<typeof finalizeWide>[0],
  name: string,
  sourceColumns: string[],
  year: number,
  title: WideCase['title'],
): { data: InterfaceTable; warnings: string[] } {
  const shaped = finalizeWide(accumulator, name, year, title, INTERFACE_SPEC);
  return {
    data: {
      cube: shaped.data.cube,
      interfaces: shaped.data.entities,
      presence: shaped.data.presence,
      tou: shaped.data.tou,
      hoursPresent: shaped.data.hoursPresent,
      sourceColumns,
      year,
      quantity: title.quantity,
      unit: unitOf(title.quantity),
    },
    warnings: shaped.warnings,
  };
}

/** Parse every plan into its own `InterfaceTable`. */
export function ingest(
  plans: CasePlan[],
  retained: string[],
  onProgress?: (done: number, total: number) => void,
  groupOf?: number[],
): Promise<IngestResult> {
  return ingestWide(plans, retained, INTERFACE_SPEC, finalizeInterface, onProgress, groupOf);
}

/** `ingest` against a GIVEN set of workers -- what tests/test_interface_attempt.mjs
 * drives with stubs, so the retry loop and the failure attribution stay
 * executable under plain node with no Worker and no wasm. */
export function ingestWithWorkers(
  workers: Worker[],
  budget: ParserBudget,
  plans: CasePlan[],
  retained: string[],
  onProgress?: (done: number, total: number) => void,
  groupOf?: number[],
): Promise<IngestResult> {
  return ingestWideWithWorkers(
    workers,
    budget,
    plans,
    retained,
    INTERFACE_SPEC,
    finalizeInterface,
    onProgress,
    groupOf,
  );
}
