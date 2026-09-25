// src/tables/generator/wide.ts
//
// The Generator kind's adapter onto the wide shape reader.
//
// This file is the whole price of a fifth kind under the shared-reader
// design: a spec (numbers plus a noun), a finalizer, an entry point. No `.c`
// change, no ABI change, no build-script change.

import {
  ingest as ingestWide,
  readCasePlan as readWideCasePlan,
  wideSpec,
  type CasePlan,
  type Finalize,
  type IngestResult as WideIngestResult,
  type WideCase,
  type WideSpec,
} from '../wide/pool';
import type { GeneratorTable } from './types';

export { hasSimd, NO_SIMD_MESSAGE, coverageOf, cubeBytesFor, unionOf } from '../wide/pool';
export type { CasePlan } from '../wide/pool';

/** The entity word a wide Generator export's title line opens with. */
export const GENERATOR_ENTITY = 'Generator';

/** Numbers only: the ordinary four preamble lines, header on line 5. */
export const GENERATOR_WIDE_SPEC: WideSpec = wideSpec('generator');

export type IngestResult = WideIngestResult<GeneratorTable>;

export function readCasePlan(file: File): Promise<CasePlan> {
  return readWideCasePlan(file, GENERATOR_WIDE_SPEC);
}

const finalizeGenerator: Finalize<GeneratorTable> = (wide: WideCase, plan: CasePlan) => ({
  data: {
    cube: wide.cube,
    generators: wide.entities,
    presence: wide.presence,
    tou: wide.tou,
    hoursPresent: wide.hoursPresent,
    sourceColumns: plan.header.entityNames,
    year: wide.year,
    quantity: wide.title.quantity,
  },
  warnings: [],
});

export function ingest(
  plans: CasePlan[],
  retained: string[],
  onProgress?: (done: number, total: number) => void,
  groupOf?: number[],
): Promise<IngestResult> {
  return ingestWide(plans, retained, GENERATOR_WIDE_SPEC, finalizeGenerator, onProgress, groupOf);
}

/** Exposed for the ingest test, which drives the finalizer directly. */
export { finalizeGenerator };
