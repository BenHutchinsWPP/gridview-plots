// src/tables/long/header.ts
//
// Long-shape header parse and column plan. **Columns map by trimmed header
// name, never position**: index 35 is a weight column in one export and an
// all-zero column in another, and a positional map would divide by zeros
// while the chart still renders. DOM-free, so Node tests import it.

import { dayOfYear, stripBOM, stripCR } from '../../ingest';
import { LONG_KEY_START, keyColsOf, type LongSignature } from './signature';
import type { ColumnPlan, HeaderInfo } from './kind';

// The long shape's vocabulary reaches this kind's callers through here.
export { keyColsOf, type LongSignature };
export type { ColumnPlan, HeaderInfo };
export { dayOfYear };

/** Parse a header into raw (display) and trimmed (key) names, finding the key
 * columns BY NAME: real headers have stray and missing spaces. */
export function parseHeaderLine(line: string, sig: LongSignature): HeaderInfo {
  const raw = stripBOM(stripCR(line)).split(',');
  const canonical = raw.map((s) => s.trim());
  const keyCols = keyColsOf(sig);

  const at = (name: string): number => {
    const i = canonical.indexOf(name);
    if (i < 0) {
      throw new Error(
        `CSV header is missing the required key column "${name}". Found: ${canonical
          .slice(0, keyCols)
          .map((c) => JSON.stringify(c))
          .join(', ')}`,
      );
    }
    return i;
  };

  const dateCol = at('Date');
  const hourCol = at('Hour');
  const touCol = at('TOU');
  const keyCol = sig.keys.map(at);

  // parser/long/block.c fixes col 0 = Date, col 1 = Hour, reads the identity
  // at the column `set_key_layout()` names, and treats every col >= keyCols
  // as metric -- so a layout it would silently misread is refused here first.
  const misplaced = sig.keys.findIndex((_, i) => keyCol[i] !== LONG_KEY_START + i);
  if (dateCol !== 0 || hourCol !== 1 || touCol >= keyCols || misplaced >= 0) {
    const expected = ['Date', 'Hour', 'TOU', ...sig.keys].join(',');
    const found = [
      `Date@${dateCol}`,
      `Hour@${hourCol}`,
      `TOU@${touCol}`,
      ...sig.keys.map((name, i) => `${name}@${keyCol[i]}`),
    ].join(', ');
    throw new Error(
      `Unsupported column layout: parser/long/block.c requires the key columns in the ` +
        `canonical order ${expected} at indices 0-${keyCols - 1}, but this export has ${found}.`,
    );
  }

  const metricNames = canonical.slice(keyCols);
  return {
    raw,
    canonical,
    dateCol,
    hourCol,
    touCol,
    entityCol: sig.entityCol,
    keyCols,
    metricNames,
  };
}

/** Every metric name in any header, first-seen order: the cube's metric axis,
 * with per-case presence, never one file's column order. */
export function unionSchema(headers: HeaderInfo[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of headers) {
    for (const name of h.metricNames) {
      if (name.length === 0 || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** Source column -> cube metric for one file; `retained` fixes the axis
 * order. */
export function buildColumnPlan(header: HeaderInfo, retained: string[]): ColumnPlan {
  const metrics = retained.map((n) => n.trim());
  const wanted = new Map<string, number>();
  for (let i = 0; i < metrics.length; i++) {
    if (!wanted.has(metrics[i])) wanted.set(metrics[i], i);
  }

  const plan = new Int32Array(header.canonical.length).fill(-1);
  const presence = new Uint8Array(metrics.length);

  for (let col = header.keyCols; col < header.canonical.length; col++) {
    const dest = wanted.get(header.canonical[col]);
    if (dest === undefined) continue;
    // A duplicated header name would otherwise double-write one plane;
    // first occurrence wins.
    if (presence[dest]) continue;
    plan[col] = dest;
    presence[dest] = 1;
  }

  const sourceMetricCount = header.metricNames.length;
  const slabPlan = new Int32Array(sourceMetricCount).fill(-1);
  const active: number[] = [];
  for (let m = 0; m < sourceMetricCount; m++) {
    const col = m + header.keyCols;
    const dest = col < plan.length ? plan[col] : -1;
    slabPlan[m] = dest;
    if (dest >= 0) active.push(m);
  }

  return {
    metrics,
    plan,
    slabPlan,
    activePlanes: Int32Array.from(active),
    presence,
    sourceMetricCount,
  };
}

/** FNV-1a identical to block.c's. Pass trimmed names: block.c trims before
 * hashing, and the axis is built from trimmed names. */
function fnv1a(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c > 0x7f) {
      throw new Error(
        `Area name "${name}" contains a non-ASCII character; block.c hashes raw ` +
          `bytes, so the JS-side hash would not match.`,
      );
    }
    h ^= c;
    // FNV prime 0x01000193, kept in uint32 via Math.imul.
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Hash every entity name for block.c's table, proving they are distinct: a
 * collision would route one entity's rows to another's plane. */
export function entityHashes(areas: string[]): Uint32Array {
  const out = new Uint32Array(areas.length);
  const seen = new Map<number, string>();
  for (let i = 0; i < areas.length; i++) {
    // Trimmed on both sides, always: block.c trims the Name field before
    // hashing, and a mismatch here routes rows to no area at all.
    const h = fnv1a(areas[i].trim());
    const clash = seen.get(h);
    if (clash !== undefined) {
      throw new Error(`FNV-1a collision between area names "${clash}" and "${areas[i]}".`);
    }
    seen.set(h, areas[i]);
    out[i] = h;
  }
  return out;
}
