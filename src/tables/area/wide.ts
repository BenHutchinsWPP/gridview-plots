// src/tables/area/wide.ts
//
// The Area kind's adapter onto the WIDE shape reader. A single-metric Area
// export is shape W (areas across the columns); multi-metric ones are shape L
// (`long.ts`). Both finalize into the same `AreaTable`: at one metric the
// cube index `(area * numMetrics + metric) * 8760 + hour` is exactly the wide
// cube's, so the wide cube is adopted, not copied. Nothing here teaches
// `src/tables/wide/` anything about areas.

import {
  finalizeWide,
  ingest as ingestWide,
  readCasePlan as readWideCasePlan,
  wideSpec,
  type CasePlan,
  type Finalize,
  type IngestResult as WideIngestResult,
  type WideCase,
  type WideSpec,
} from '../wide/pool';
import type { AreaTable } from './types';

// Re-exported so main.ts reaches this kind's wide ingest at one address.
export { hasSimd, NO_SIMD_MESSAGE, unionOf } from '../wide/pool';
export type { CasePlan } from '../wide/pool';

/** The entity word a wide Area title opens with (`Area Hourly 'Load (MWh)'
 * ...`); `src/detect.ts` routes on it. */
export const AREA_ENTITY = 'Area';

/** The ordinary four preamble lines. */
export const AREA_WIDE_SPEC: WideSpec = wideSpec('area');

export type IngestResult = WideIngestResult<AreaTable>;

/** Read one wide Area file's preamble, header and first row. A title with no
 * quantity is refused here (the reader only warns): for a wide Area table the
 * quantity is its only metric. */
export async function readCasePlan(file: File): Promise<CasePlan> {
  const plan = await readWideCasePlan(file, AREA_WIDE_SPEC);
  if (plan.title.quantity.trim() === '') {
    throw new Error(
      `${file.name}: a wide Area export's title line names the one metric every column ` +
        `measures (e.g. Area Hourly 'Load (MWh)' Data for Year 2034), and this file's ` +
        `carries no quoted quantity. Without it the column has no name to plot or aggregate ` +
        `under.`,
    );
  }
  return plan;
}

/** The wide cube as an `AreaTable`: one metric, named by the title's trimmed
 * quantity, which is the key `data/area/aggregation-rules.json` rules on. */
const finalizeArea: Finalize<AreaTable> = (wide: WideCase) => {
  const metric = wide.title.quantity.trim();
  return {
    data: {
      // Adopted, not copied.
      cube: wide.cube,
      areas: wide.entities,
      metrics: [metric],
      presence: wide.presence,
      tou: wide.tou,
      hoursPresent: wide.hoursPresent,
      sourceColumns: [metric],
      year: wide.year,
    },
    warnings: [],
  };
};

/** Exposed for the ingest test. */
export function finalizeCase(
  accumulator: Parameters<typeof finalizeWide>[0],
  name: string,
  year: number,
  title: WideCase['title'],
): { data: AreaTable; warnings: string[] } {
  const shaped = finalizeWide(accumulator, name, year, title, AREA_WIDE_SPEC);
  const finalized = finalizeArea(shaped.data, null as unknown as CasePlan);
  return { data: finalized.data, warnings: [...shaped.warnings, ...finalized.warnings] };
}

/** Parse every plan into its own `AreaTable`. `retained` is the AREA axis
 * (dropped headers plus the loaded axis); the metric is the title quantity. */
export function ingest(
  plans: CasePlan[],
  retained: string[],
  onProgress?: (done: number, total: number) => void,
  groupOf?: number[],
): Promise<IngestResult> {
  return ingestWide(plans, retained, AREA_WIDE_SPEC, finalizeArea, onProgress, groupOf);
}
