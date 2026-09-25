// src/tables/bus/wide.ts
//
// The Bus kind's adapter onto the wide shape reader. A wide bus export has an
// id row above the column header:
//
//   ,,BusNumber,10001,10002,...
//   Date, Hour, TOU,BUS_A,BUS_B,...
//
// so its header is line 6: `wideSpec('bus', 5)`, a NUMBER, so the shape reader
// and block.c learn nothing (AGENTS.md, tests/test_wide_abi.mjs). The id row
// is read HERE from `CasePlan.preamble`, and the header's entity names are
// rewritten to the ids before the column plan is built, so columns match on
// the id: bus names may repeat, and matching on them would put one bus's
// column on another's plane. Names are kept alongside as labels.

import {
  ingest as ingestWide,
  readCasePlan as readWideCasePlan,
  wideSpec,
  type CasePlan,
  type Finalize,
  type HeaderInfo,
  type IngestResult as WideIngestResult,
  type WideCase,
  type WideSpec,
} from '../wide/pool';
import { KEY_COLS } from '../wide/header';
import type { BusTable } from './types';

export { hasSimd, NO_SIMD_MESSAGE, coverageOf, cubeBytesFor, unionOf } from '../wide/pool';
export type { CasePlan } from '../wide/pool';

export const BUS_ENTITY = 'Bus';

/** Five preamble lines (the id row is the fifth), so the header is line 6. */
export const BUS_WIDE_SPEC: WideSpec = wideSpec('bus', 5);

/** The id row's third cell, which marks it as the id row. */
const ID_ROW_LABEL = 'BusNumber';

export type IngestResult = WideIngestResult<BusTable>;

/** Read the `,,BusNumber,10001,...` row from the preamble. Refused rather than
 * guessed: without ids the columns have no identity, and names are not one. */
function readIdRow(preamble: string[], columns: number): number[] {
  const row = preamble[preamble.length - 1] ?? '';
  const cells = row
    .replace(/\r$/, '')
    .split(',')
    .map((cell) => cell.trim());
  if (cells[KEY_COLS - 1] !== ID_ROW_LABEL) {
    throw new Error(
      `a wide Bus export carries a "${ID_ROW_LABEL}" id row directly above its column header ` +
        `(line ${BUS_WIDE_SPEC.preambleLines}), and this file's line ` +
        `${BUS_WIDE_SPEC.preambleLines} reads ` +
        `${JSON.stringify(cells.slice(0, KEY_COLS).join(','))} instead. Without it the columns ` +
        `have no bus number to be keyed on.`,
    );
  }

  const ids: number[] = [];
  const seen = new Set<number>();
  for (let col = KEY_COLS; col < KEY_COLS + columns; col++) {
    const cell = cells[col] ?? '';
    const id = Number(cell);
    if (cell === '' || !Number.isInteger(id) || id < -2147483648 || id > 2147483647) {
      throw new Error(
        `the ${ID_ROW_LABEL} row's entry for column ${col} is ${JSON.stringify(cell)}, which is ` +
          `not a 32-bit integer bus number. The bus axis is the id, so this cannot be guessed.`,
      );
    }
    if (seen.has(id)) {
      throw new Error(
        `bus number ${id} appears twice in the ${ID_ROW_LABEL} row. Ids are the axis's identity, ` +
          `so a duplicate would write two columns onto one plane.`,
      );
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** The header with entity names replaced by id strings, so the shape reader
 * matches on ids. `raw` keeps the file's labels (`BusTable.names`). */
function keyOnIds(header: HeaderInfo, ids: number[]): HeaderInfo {
  const canonical = [...header.canonical.slice(0, KEY_COLS), ...ids.map((id) => String(id))];
  return { ...header, canonical, entityNames: ids.map((id) => String(id)) };
}

/** The label each retained id carries, looked up from the file's own header. */
function namesFor(plan: CasePlan, axis: string[]): string[] {
  const labelById = new Map<string, string>();
  plan.header.entityNames.forEach((id, index) => {
    labelById.set(id, (plan.header.raw[index + KEY_COLS] ?? '').trim());
  });
  // An id this file lacks has no label here; the id itself is the label.
  return axis.map((id) => labelById.get(id) || id);
}

/** Bus id -> the label its first file gave it, for the picker's `name (id)`.
 * One-way: nothing keys on names. */
export function labelsOf(plans: CasePlan[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const plan of plans) {
    plan.header.entityNames.forEach((id, index) => {
      if (labels.has(id)) return;
      const name = (plan.header.raw[index + KEY_COLS] ?? '').trim();
      if (name) labels.set(id, name);
    });
  }
  return labels;
}

/** Read one wide Bus file's preamble, id row (`preamble[4]`), header and
 * first row. */
export async function readCasePlan(file: File): Promise<CasePlan> {
  let plan: CasePlan;
  try {
    plan = await readWideCasePlan(file, BUS_WIDE_SPEC);
  } catch (error) {
    // A file without the id row fails here first (line 6 is a data row); name
    // the missing row rather than repeat "line 6 is not a header".
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${file.name}: a wide Bus export carries a "${ID_ROW_LABEL}" id row on line ` +
        `${BUS_WIDE_SPEC.preambleLines} and its column header on line ` +
        `${BUS_WIDE_SPEC.preambleLines + 1}. Reading it that way failed: ${cause}`,
    );
  }
  let ids: number[];
  try {
    ids = readIdRow(plan.preamble, plan.header.entityNames.length);
  } catch (error) {
    throw new Error(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ...plan, header: keyOnIds(plan.header, ids) };
}

const finalizeBus: Finalize<BusTable> = (wide: WideCase, plan: CasePlan) => ({
  data: {
    cube: wide.cube,
    buses: Int32Array.from(wide.entities, (id) => Number(id)),
    names: namesFor(plan, wide.entities),
    presence: wide.presence,
    tou: wide.tou,
    hoursPresent: wide.hoursPresent,
    sourceColumns: plan.header.entityNames.map((id) => Number(id)),
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
  return ingestWide(plans, retained, BUS_WIDE_SPEC, finalizeBus, onProgress, groupOf);
}

/** Exposed for the ingest test, which drives the finalizer directly. */
export { finalizeBus };
