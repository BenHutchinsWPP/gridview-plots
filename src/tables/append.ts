// src/tables/append.ts
//
// Merging a later table into a loaded one at the cube: the planes of two
// tables over their joined years, who keeps a cell, and the notes that say
// what joined. Kind-free: a kind hands in planes and keys, never a name for
// what they mean. Every merge builds new arrays; a committed cube, and the
// TOU and hours sibling long tables share, are never written.

import { hasCell, coverCell } from './coverage';
import { YEAR_SLOT_HOURS, type YearSpan } from '../model/calendar';
import { fewNames, MAX_CASE_YEARS, yearGapRefusal, spanLabel } from '../ingest';

export interface PlaneSource extends YearSpan {
  cube: Float32Array;
  cellCoverage?: Uint8Array;
  presence?: Uint8Array;
  tou: Uint8Array;
  hoursPresent?: Uint8Array;
}

export interface Merged extends YearSpan {
  cube: Float32Array;
  cellCoverage: Uint8Array;
  presence: Uint8Array;
  tou: Uint8Array;
  hoursPresent: Uint8Array;
  /** Per out plane: 1 where both sides held some cell. */
  overlapped: Uint8Array;
  /** Cells taken from the fresh side. */
  wrote: number;
}

export function unionSpan(
  a: YearSpan,
  b: YearSpan,
): { span: YearSpan; missing: number[]; tooLong: boolean } {
  const firstYear = Math.min(a.firstYear, b.firstYear);
  const end = Math.max(a.firstYear + a.numYears, b.firstYear + b.numYears);
  const missing: number[] = [];
  for (let y = firstYear; y < end; y++) {
    const inA = y >= a.firstYear && y < a.firstYear + a.numYears;
    const inB = y >= b.firstYear && y < b.firstYear + b.numYears;
    if (!inA && !inB) missing.push(y);
  }
  const numYears = end - firstYear;
  return { span: { firstYear, numYears }, missing, tooLong: numYears > MAX_CASE_YEARS };
}

/** One side's row flags laid on the union's hours. */
function rowsOn(src: PlaneSource, first: number, hours: number): Uint8Array {
  const out = new Uint8Array(hours);
  const at = (src.firstYear - first) * YEAR_SLOT_HOURS;
  const n = src.numYears * YEAR_SLOT_HOURS;
  for (let h = 0; h < n; h++) {
    out[at + h] = src.hoursPresent ? (src.hoursPresent[h] ? 1 : 0) : src.tou[h] !== 0xff ? 1 : 0;
  }
  return out;
}

export function mergePlanes(
  old: PlaneSource,
  fresh: PlaneSource,
  outPlanes: number,
  oldAt: Int32Array,
  freshAt: Int32Array,
): Merged {
  const { span, missing, tooLong } = unionSpan(old, fresh);
  if (missing.length > 0) {
    const years: number[] = [];
    for (let y = span.firstYear; y < span.firstYear + span.numYears; y++) {
      if (!missing.includes(y)) years.push(y);
    }
    throw new Error(yearGapRefusal('The loaded table and this file have', years, missing));
  }
  if (tooLong) {
    throw new Error(
      `The loaded table and this file together cover ${span.numYears} years. A Case spans ` +
        `at most ${MAX_CASE_YEARS} years, so the load is refused.`,
    );
  }
  const hours = span.numYears * YEAR_SLOT_HOURS;
  const planeLen = hours;
  const oldOff = (old.firstYear - span.firstYear) * YEAR_SLOT_HOURS;
  const freshOff = (fresh.firstYear - span.firstYear) * YEAR_SLOT_HOURS;
  const oldLen = old.numYears * YEAR_SLOT_HOURS;
  const freshLen = fresh.numYears * YEAR_SLOT_HOURS;

  const oldRow = rowsOn(old, span.firstYear, hours);
  const freshRow = rowsOn(fresh, span.firstYear, hours);
  const hoursPresent = new Uint8Array(hours);
  const tou = new Uint8Array(hours).fill(0xff);
  for (let h = 0; h < hours; h++) {
    hoursPresent[h] = oldRow[h] | freshRow[h];
    if (oldRow[h]) tou[h] = old.tou[h - oldOff];
    else if (freshRow[h]) tou[h] = fresh.tou[h - freshOff];
    else if (h >= oldOff && h < oldOff + oldLen) tou[h] = old.tou[h - oldOff];
    else if (h >= freshOff && h < freshOff + freshLen) tou[h] = fresh.tou[h - freshOff];
  }

  const cube = new Float32Array(outPlanes * planeLen).fill(NaN);
  const cellCoverage = new Uint8Array(Math.ceil(cube.length / 8));
  const presence = new Uint8Array(outPlanes);
  const overlapped = new Uint8Array(outPlanes);
  let wrote = 0;

  const carries = (src: PlaneSource, len: number, p: number): boolean => {
    if (p < 0) return false;
    if (src.presence) return src.presence[p] !== 0;
    for (let h = p * len; h < (p + 1) * len; h++) if (!Number.isNaN(src.cube[h])) return true;
    return false;
  };
  // Older bundles did not retain per-cell ownership. Keep their stated
  // rows authoritative rather than guessing whether a NaN was explicit.
  const owns = (src: PlaneSource, p: number, h: number, len: number, carried: boolean): boolean => {
    if (p < 0 || h < 0 || h >= len) return false;
    if (src.cellCoverage) return hasCell(src.cellCoverage, p * len + h);
    const row = src.hoursPresent ? src.hoursPresent[h] !== 0 : src.tou[h] !== 0xff;
    return row && (src.presence ? carried : !Number.isNaN(src.cube[p * len + h]));
  };

  for (let q = 0; q < outPlanes; q++) {
    const po = oldAt[q];
    const pf = freshAt[q];
    const carriedOld = carries(old, oldLen, po);
    const carriedFresh = carries(fresh, freshLen, pf);
    presence[q] = carriedOld || carriedFresh ? 1 : 0;
    const base = q * planeLen;
    for (let h = 0; h < hours; h++) {
      const ho = h - oldOff;
      const hf = h - freshOff;
      const o = owns(old, po, ho, oldLen, carriedOld);
      const f = owns(fresh, pf, hf, freshLen, carriedFresh);
      if (o && f) overlapped[q] = 1;
      if (o) cube[base + h] = old.cube[po * oldLen + ho];
      else if (f) {
        cube[base + h] = fresh.cube[pf * freshLen + hf];
        wrote++;
      }
      if (o || f) coverCell(cellCoverage, base + h);
    }
  }
  return { ...span, cube, cellCoverage, presence, tou, hoursPresent, overlapped, wrote };
}

export interface EntityView<K> extends PlaneSource {
  keys: readonly K[];
}

/** A table's `sourceColumns` joined: every column either file carried,
 * retained or not, old first. Not aligned with any plane axis. */
export function unionColumns<K>(old: readonly K[], fresh: readonly K[]): K[] {
  const out = [...old];
  const seen = new Set(old);
  for (const column of fresh) {
    if (!seen.has(column)) {
      seen.add(column);
      out.push(column);
    }
  }
  return out;
}

export function appendEntitySize<K>(
  old: EntityView<K>,
  fresh: EntityView<K>,
): { planes: number; numYears: number } {
  const known = new Set(old.keys);
  let planes = old.keys.length;
  for (const key of fresh.keys) if (!known.has(key)) planes++;
  return { planes, numYears: unionSpan(old, fresh).span.numYears };
}

export function appendEntityTable<K>(
  old: EntityView<K>,
  fresh: EntityView<K>,
): {
  keys: K[];
  merged: Merged;
  added: K[];
  overlapping: K[];
  from: YearSpan;
  to: YearSpan;
} {
  const keys = [...old.keys];
  const index = new Map<K, number>(keys.map((k, i) => [k, i]));
  const added: K[] = [];
  const freshIndex: number[] = [];
  fresh.keys.forEach((key, i) => {
    const at = index.get(key);
    if (at !== undefined) {
      freshIndex[at] = i;
      return;
    }
    index.set(key, keys.length);
    freshIndex[keys.length] = i;
    keys.push(key);
    added.push(key);
  });
  const oldAt = new Int32Array(keys.length).fill(-1);
  const freshAt = new Int32Array(keys.length).fill(-1);
  for (let p = 0; p < keys.length; p++) {
    if (p < old.keys.length) oldAt[p] = p;
    if (freshIndex[p] !== undefined) freshAt[p] = freshIndex[p];
  }
  const merged = mergePlanes(old, fresh, keys.length, oldAt, freshAt);
  const overlapping = keys.filter((_, p) => merged.overlapped[p]);
  return {
    keys,
    merged,
    added,
    overlapping,
    from: { firstYear: old.firstYear, numYears: old.numYears },
    to: { firstYear: merged.firstYear, numYears: merged.numYears },
  };
}

export interface Appended<T> {
  table: T;
  noun: string;
  added: string[];
  overlapping: string[];
  wrote: number;
  from: YearSpan;
  to: YearSpan;
  /** Calculated columns the joined table could offer whose operands arrived
   * in different drops: named, never filled. */
  apart?: string[];
}

export function appendNotes(files: string, table: string, a: Appended<unknown>): string[] {
  const notes: string[] = [];
  const grew = a.from.firstYear !== a.to.firstYear || a.from.numYears !== a.to.numYears;
  if (a.added.length > 0 || grew) {
    const news =
      a.added.length > 0 ? `${a.added.length} new ${a.noun}(s) (${fewNames(a.added)})` : '';
    const spans = grew
      ? `the table now spans ${spanLabel(a.to)} (it spanned ${spanLabel(a.from)})`
      : '';
    notes.push(`${files} joined ${table}: ${[news, spans].filter(Boolean).join(', and ')}.`);
  }
  if (a.overlapping.length > 0) {
    notes.push(
      `${files}: ${a.overlapping.length} ${a.noun}(s) were already in ${table} for the same ` +
        `hours (${fewNames(a.overlapping)}); the loaded values were kept.`,
    );
  }
  if (a.apart !== undefined && a.apart.length > 0) {
    notes.push(
      `${files}: ${fewNames(a.apart)} could be calculated from columns now in ${table}, but ` +
        `their operands came from different files, so it was not filled.`,
    );
  }
  if (a.added.length === 0 && !grew && a.wrote === 0) {
    notes.push(
      `${files} added nothing new to ${table}: every ${a.noun} and hour it carries was ` +
        `already loaded, and the loaded values were kept.`,
    );
  }
  return notes;
}
