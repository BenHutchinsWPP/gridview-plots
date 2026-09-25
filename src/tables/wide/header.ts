// src/tables/wide/header.ts
//
// Preamble, header parse and column plan for the WIDE SHAPE; nothing here
// knows what an entity column means. Columns map by trimmed header name,
// never position: two exports of one study list entities in different
// orders, and a positional map would plot one path's flows under another's
// name with nothing thrown. No DOM, so Node tests import it.

import { dayOfYear, stripBOM, stripCR } from '../../ingest';

export { dayOfYear };

/** Fixed by the FILE FORMAT: every row opens with Date, Hour, TOU, so source
 * column 3 onward is an entity. The slab width is per file (`buildColumnPlan`). */
export const KEY_COLS = 3; // block.c: Date, Hour, TOU; source col >= 3 is an entity

/**
 * Lines above the header in the common wide export (title, blank, date-range
 * note, blank), fixed by the exporter: a constant and a hard requirement,
 * never "skip until something looks like a header". A bus export's id row
 * makes its preamble 5, passed as a NUMBER in its `WideSpec`, never an
 * `isBus` flag.
 */
export const PREAMBLE_LINES = 4;

/**
 * What a kind tells the wide reader: numbers, plus a noun used only in
 * messages. A field something BRANCHES on would be the mechanism failing
 * (`tests/test_wide_abi.mjs`).
 */
export interface WideSpec {
  /** Lines above the column header: 4, or 5 for a bus export's id row. */
  preambleLines: number;
  /** What one entity column is, for messages only: 'interface', 'area', … */
  entityNoun: string;
}

/** The ordinary wide export: four preamble lines, header on line 5. */
export function wideSpec(entityNoun: string, preambleLines = PREAMBLE_LINES): WideSpec {
  return { preambleLines, entityNoun };
}

export interface HeaderInfo {
  /** Fields exactly as they appear in the file (CR stripped), for display. */
  raw: string[];
  /** `raw` trimmed -- the key everything else matches on. */
  canonical: string[];
  dateCol: number;
  hourCol: number;
  touCol: number;
  /** In source order. */
  entityNames: string[];
}

/** What the title line above the header states about the whole file. */
export interface TitleInfo {
  /** The quoted quantity, e.g. `Power Flow (MW)` -- '' when unreadable. */
  quantity: string;
  /** The title's year, or null; a cross-check on the first data row's. */
  year: number | null;
  /**
   * The FIRST WORD of line 1 (`Interface` in `Interface Hourly ...`), or ''.
   * Every wide kind is structurally identical, so this word is the only thing
   * saying WHICH kind a file is. Reported raw; mapping it to a kind is
   * `src/detect.ts`'s job.
   */
  entity: string;
}

export interface ColumnPlan {
  /** The cube's entity axis: the retained list, in cube-index order. */
  entities: string[];
  /** By SOURCE column: the cube entity index it feeds, or -1 (key columns
   * always). */
  plan: Int32Array;
  /** The same mapping by slab plane (`plane m` = `source column m + KEY_COLS`),
   * so its length is the slab width. The worker and blit index by this. */
  slabPlan: Int32Array;
  /** Slab planes with a destination, ascending -- the transfer order. */
  activePlanes: Int32Array;
  /** Per-entity presence: 1 = this file's header carries it, 0 = absent. */
  presence: Uint8Array;
}

/**
 * Read entity, quantity and year from line 1:
 *
 *   Interface Hourly 'Power Flow (MW)' Data for Year 2034
 *   ^^^^^^^^^          ^^^^^^^^^^^^^^^             ^^^^
 *   entity             quantity                    year
 *
 * The quantity is the file's unit and aggregation rule. Unreadable is
 * reported, never guessed: the file still plots, without a unit.
 */
export function parseTitleLine(line: string): TitleInfo {
  const text = stripBOM(stripCR(line));
  const quoted = /'([^']+)'/.exec(text);
  const year = /year\s+(\d{4})/i.exec(text);
  // Anchored at `^`, letters only: a prefix of line 1, so src/detect.ts's
  // truncation-safe rule holds.
  const entity = /^\s*([A-Za-z]+)/.exec(text);
  return {
    quantity: quoted ? quoted[1].trim() : '',
    year: year ? Number(year[1]) : null,
    entity: entity ? entity[1] : '',
  };
}

/**
 * Parse a header line into raw (for display) and trimmed (the key) names, and
 * find the three key columns BY NAME: real headers carry stray spaces.
 */
export function parseHeaderLine(line: string, entityNoun = 'entity'): HeaderInfo {
  const raw = stripBOM(stripCR(line)).split(',');
  const canonical = raw.map((s) => s.trim());

  const at = (name: string): number => {
    const i = canonical.indexOf(name);
    if (i < 0) {
      throw new Error(
        `CSV header is missing the required key column "${name}". Found: ${canonical
          .slice(0, KEY_COLS)
          .map((c) => JSON.stringify(c))
          .join(', ')}`,
      );
    }
    return i;
  };

  const dateCol = at('Date');
  const hourCol = at('Hour');
  const touCol = at('TOU');

  // block.c hardcodes cols 0-2 as Date, Hour, TOU; refuse any other layout
  // rather than let the module misread it.
  if (dateCol !== 0 || hourCol !== 1 || touCol !== 2) {
    throw new Error(
      `Unsupported column layout: parser/wide/block.c requires the key columns in the ` +
        `canonical order Date,Hour,TOU at indices 0-2, but this export has ` +
        `Date@${dateCol}, Hour@${hourCol}, TOU@${touCol}.`,
    );
  }

  const entityNames = canonical.slice(KEY_COLS).filter((name) => name.length > 0);
  if (entityNames.length === 0) {
    throw new Error(`CSV header carries no ${entityNoun} columns after Date, Hour, TOU.`);
  }
  return { raw, canonical, dateCol, hourCol, touCol, entityNames };
}

/**
 * Every entity name in any header, first-seen order. The picker waits for
 * every dropped file so a path only one file monitors can still be picked;
 * per-file presence says who carried it.
 */
export function unionSchema(headers: HeaderInfo[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of headers) {
    for (const name of h.entityNames) {
      if (name.length === 0 || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * The source-column -> cube-entity plan for one file. `retained` fixes the
 * cube's axis and order; this file's order only locates bytes. The slab width
 * is this header's entity count.
 */
export function buildColumnPlan(header: HeaderInfo, retained: string[]): ColumnPlan {
  const slabMetrics = Math.max(0, header.canonical.length - KEY_COLS);
  const entities = retained.map((n) => n.trim());
  const wanted = new Map<string, number>();
  for (let i = 0; i < entities.length; i++) {
    if (!wanted.has(entities[i])) wanted.set(entities[i], i);
  }

  const plan = new Int32Array(header.canonical.length).fill(-1);
  const presence = new Uint8Array(entities.length);

  for (let col = KEY_COLS; col < header.canonical.length; col++) {
    const dest = wanted.get(header.canonical[col]);
    if (dest === undefined) continue;
    // A duplicated header name: first occurrence wins.
    if (presence[dest]) continue;
    plan[col] = dest;
    presence[dest] = 1;
  }

  const slabPlan = new Int32Array(slabMetrics).fill(-1);
  const active: number[] = [];
  for (let m = 0; m < slabMetrics; m++) {
    const col = m + KEY_COLS;
    const dest = col < plan.length ? plan[col] : -1;
    slabPlan[m] = dest;
    if (dest >= 0) active.push(m);
  }

  return { entities, plan, slabPlan, activePlanes: Int32Array.from(active), presence };
}
