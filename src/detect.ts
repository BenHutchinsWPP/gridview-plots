// src/detect.ts
//
// Format classifier: given a file's opening bytes, say which (kind, shape) it
// is so the router can send it to the right parser.
//
// **Misdetection, not non-detection, is the failure mode that matters.** A
// file classified confidently but wrongly is parsed by the wrong parser and
// produces garbage. Unrecognised input always comes back as an explicit
// 'unrecognized' with a stated reason, never a guess and never a silent drop.
//
// Synchronous and byte-based (not `File`), so it is testable under Node.

import { parseHeaderLine } from './tables/long/header';
import { AREA_LONG } from './tables/area/long';
import { LONG_KEY_START, type LongSignature } from './tables/long/signature';
import {
  parseHeaderLine as parseWideHeaderLine,
  parseTitleLine,
  PREAMBLE_LINES,
} from './tables/wide/header';
// A long export's kind is its key columns; a wide one's is its title-line
// noun. Each kind states both in the registry; this module knows only the
// matching rules.
import { LONG_SIGNATURES, MEMBERSHIP_HEADERS, WIDE_ENTITIES } from './tables/registry';
import type { TableKind } from './model/case-model';
import { READABLE_MAGICS } from './storage/store';
import { stripBOM, stripCR } from './ingest';
import { isBannerLine, splitCsvLine } from './lookups/parse';
import { LIST_SCHEMAS, schemaForBanner } from './lookups/schema';
import { LIMITS_BANNER } from './limits/parse';

export type DetectKind =
  | 'area'
  | 'interface'
  | 'bus'
  | 'generator'
  | 'groupings'
  | 'bundle'
  // An interface limit schedule. No `DetectShape`: it is not an hourly
  // layout and not a session-wide reference list (it is assigned per Case).
  | 'interfacelimit'
  | 'unrecognized';

/**
 * How the bytes are laid out, independent of kind (AGENTS.md):
 * `'L'` long, `'W'` wide, `'R'` reference list (a banner, then a header with
 * no `Date` column; routes to `src/lookups/`, never a Case slot).
 */
export type DetectShape = 'L' | 'W' | 'R';

export interface DetectResult {
  kind: DetectKind;
  /**
   * Confidence in a POSITIVE identification: `high` routes without asking,
   * `low` confirms with the user. `unrecognized` is never `high`, since it
   * cannot be told apart from a truncated or non-UTF-8 probe.
   */
  confidence: 'high' | 'low';
  reason: string;
  /**
   * The quantity that keys a table slot (e.g. "Power Flow (MW)"), for kinds
   * where one Case holds several tables. Undefined, with `confidence: 'low'`,
   * when the title line is unreadable.
   */
  variant?: string;
  /** The shape, for table kinds. The router needs both kind and shape. */
  shape?: DetectShape;
  /**
   * The quoted quantity on a wide export's title line, INFORMATIONAL ONLY
   * (the Import Dialog shows it). Separate from `variant`: for a wide Area
   * export it is the cube's single metric, and one Case holds one Area table,
   * so `variant` stays undefined.
   */
  quantity?: string;
  /** For a `groupings` verdict: every kind whose editor writes exactly this
   * header. More than one is asked about, never picked. */
  writtenBy?: readonly TableKind[];
}

// Bundle magics come from `READABLE_MAGICS` in src/storage/store.ts, including
// the legacy ones, so a legacy file classifies as `bundle` and reaches the
// migration instead of `unrecognized`.

/**
 * The kinds whose group editor writes exactly this first line (trimmed,
 * case-blind). Exact, not a pattern: a pattern loose enough to catch
 * `BusID,Grouping` would claim any file with a `Grouping` column.
 */
function membershipWriters(firstLine: string): TableKind[] {
  const cells = splitCsvLine(firstLine).map((cell) => cell.trim().toLowerCase());
  const writers = new Set<TableKind>();
  for (const { kind, columns } of MEMBERSHIP_HEADERS) {
    if (
      columns.length === cells.length &&
      columns.every((column, i) => column.toLowerCase() === cells[i])
    ) {
      writers.add(kind);
    }
  }
  return [...writers];
}

// A long kind signature starts after `Date, Hour, TOU`. The long header parse
// counts from the same constant, so the two cannot disagree.

// Latin-1 comparison only; every magic is ASCII.
function startsWithMagic(bytes: Uint8Array, magic: string): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * How many opening bytes a caller should hand `classify`.
 *
 * 64 KiB clears any Area or Groupings header, but a wide header of about
 * 4,000+ entities is TRUNCATED in it. Raising the constant only moves that
 * wall, so the rule is what is width-proof:
 *
 *   THE TRUNCATION-SAFE RULE. Every branch must reach its verdict from a
 *   PREFIX of the probe: the opening bytes of a line, never a whole line and
 *   never a column list. The full header is parsed later by the case-plan
 *   readers against their own larger probes.
 *
 * `tests/test_detect.mjs` holds the wide branches to it at bus width.
 */
export const DETECT_PROBE_BYTES = 64 * 1024;

/**
 * Classify a dropped file from its opening bytes. `headBytes` must cover at
 * least the first line; less is reported as `unrecognized`, not a crash.
 */
const BOM_NOTE = ' A leading UTF-8 BOM was stripped before comparison; that was not the problem.';

export function classify(headBytes: Uint8Array, filename: string): DetectResult {
  // Bundle magic is checked on raw bytes: what follows it is binary.
  // Truncation-safe: the first few bytes.
  for (const magic of READABLE_MAGICS) {
    if (startsWithMagic(headBytes, magic)) {
      return {
        kind: 'bundle',
        confidence: 'high',
        reason: `${filename}: starts with the "${magic}" saved-bundle magic bytes.`,
      };
    }
  }

  // Strip a leading BOM before comparing: a file detection vouches for must
  // not then fail in the parser. `hadBOM` is read off the RAW bytes because
  // `TextDecoder` consumes a leading BOM itself.
  const hadBOM =
    headBytes.length >= 3 &&
    headBytes[0] === 0xef &&
    headBytes[1] === 0xbb &&
    headBytes[2] === 0xbf;
  const text = new TextDecoder('utf-8').decode(headBytes);

  // Truncation-safe: a membership header is a few short names, so a cut line
  // can only fail to match.
  const writers = membershipWriters(text.split(/\r?\n/, 1)[0] ?? '');
  if (writers.length > 0) {
    return {
      kind: 'groupings',
      confidence: 'high',
      reason: `${filename}: first line is the header a group editor writes (${writers.join(', ')}).`,
      writtenBy: writers,
    };
  }

  // Truncation-safe: the verdict rests on cells 0-3 of line 1. Do not read the
  // metric columns `parseHeaderLine` returns; at bus width they are truncated.
  const lines = text.split('\n');
  const firstLine = lines[0];

  // --- An interface limit schedule ------------------------------------------
  //
  // Cell 1 of line 1 is a unique token, so this is `high` off one cell. It
  // sits above the reference-list branch so its correctness does not depend
  // on a property of that neighbouring format. Truncation-safe: first cell.
  if (splitCsvLine(firstLine)[0].trim().toUpperCase() === LIMITS_BANNER) {
    return {
      kind: 'interfacelimit',
      confidence: 'high',
      reason: `${filename}: line 1 opens with the "${LIMITS_BANNER}" banner.`,
    };
  }

  // --- Shape R: a reference list --------------------------------------------
  //
  // One or two BANNER lines (text in cell 1, other cells empty), then a header
  // with no `Date` column; every hourly export has one. The banner word is the
  // kind, and an unclaimed word is refused BY NAME. Truncation-safe: the
  // banner is the front of the probe and the fixed-schema header is ~400 B.
  const bannerLines: string[] = [];
  while (
    bannerLines.length < 2 &&
    lines.length > bannerLines.length &&
    isBannerLine(lines[bannerLines.length])
  ) {
    bannerLines.push(lines[bannerLines.length]);
  }
  if (bannerLines.length > 0 && lines.length > bannerLines.length) {
    const header = splitCsvLine(lines[bannerLines.length]).map((cell) => cell.trim());
    const hasDate = header.some((cell) => cell.toLowerCase() === 'date');
    // The banner is a LONE TOKEN (`BUS_GENERAL`). A wide title line also has
    // text only in cell 1, so without this check any wide file with a blank
    // second line would be claimed here.
    const banner = splitCsvLine(bannerLines[0])[0].trim();
    if (!hasDate && header.length > 1 && /^[A-Za-z][A-Za-z0-9_.-]*$/.test(banner)) {
      const word = banner;
      const schema = schemaForBanner(word);
      if (schema) {
        return {
          kind: schema.entity,
          shape: 'R',
          confidence: 'high',
          reason:
            `${filename}: line 1 is the "${schema.banner}" banner and line ${bannerLines.length + 1} ` +
            `is a header with no Date column -- a ${schema.entity} reference list.`,
        };
      }
      return {
        kind: 'unrecognized',
        confidence: 'low',
        reason:
          `${filename}: line 1 is a banner reading "${word}" over a header with no Date column, ` +
          `which is the reference-list shape, but no list this build knows is named "${word}". ` +
          `Expected ${LIST_SCHEMAS.map((schema) => `"${schema.banner}"`).join(' or ')}.${hadBOM ? BOM_NOTE : ''}`,
      };
    }
  }

  let areaOk = false;
  let areaDetail = '';
  try {
    parseHeaderLine(firstLine, AREA_LONG);
    areaOk = true;
  } catch (error) {
    areaDetail = error instanceof Error ? error.message : String(error);
  }

  // --- Shape L: which KIND, from the key-column signature -------------------
  //
  // Longest signature first, so a prefix never shadows a more specific match.
  // Area's bare `Name` is the `parseHeaderLine` check above. There is no
  // signature for a long interface export (no key columns): one that matches
  // on the absence of evidence would claim every unplaced Date,Hour,TOU file.
  // Truncation-safe: cells 0-5 of line 1; metric columns are not read.
  const LONG_KINDS: { kind: DetectKind; sig: LongSignature }[] = [...LONG_SIGNATURES].sort(
    (a, b) => b.sig.keys.length - a.sig.keys.length,
  );

  const longCells = stripBOM(stripCR(firstLine))
    .split(',')
    .map((cell) => cell.trim());
  const longHead = longCells[0] === 'Date' && longCells[1] === 'Hour' && longCells[2] === 'TOU';
  const longKind = longHead
    ? LONG_KINDS.find((candidate) =>
        candidate.sig.keys.every((key, offset) => longCells[LONG_KEY_START + offset] === key),
      )
    : undefined;

  // Two signals, because shape alone cannot route:
  //
  //   SHAPE: the header line parses through wide/header.ts's parseHeaderLine.
  //   KIND: the title's first word. Every wide kind passes the shape test
  //     identically, so the entity word is the only thing separating them.
  //     An unclaimed word is a refusal naming it.
  //
  // `parseTitleLine` never throws; it reports '' for anything unreadable.
  // The header is on line 5, or 6 for a bus export (id row above it): both
  // are tried as a NUMBER of preamble lines, not a kind branch.
  //
  // Truncation-safe: each candidate rests on its first three cells plus the
  // existence of a fourth, and on the title's first word.
  const requiredLines = PREAMBLE_LINES + 1;
  let interfaceShapeOk = false;
  let interfaceDetail = '';
  let headerLine = requiredLines;
  for (const candidate of [PREAMBLE_LINES, PREAMBLE_LINES + 1]) {
    if (lines.length < candidate + 1) {
      interfaceDetail =
        `only ${lines.length} line(s) present; a wide export needs a ` +
        `${PREAMBLE_LINES}-line preamble (5 for a bus export's id row) plus a column header.`;
      break;
    }
    try {
      parseWideHeaderLine(lines[candidate], 'entity');
      interfaceShapeOk = true;
      headerLine = candidate + 1;
      interfaceDetail = '';
      break;
    } catch (error) {
      // Report line 5's failure: that is where the header normally is.
      if (!interfaceDetail)
        interfaceDetail = error instanceof Error ? error.message : String(error);
    }
  }

  const title = parseTitleLine(firstLine);
  const entity = title.entity;
  // The entity word -> kind map comes from the registry, so an unregistered
  // noun refuses rather than loading as its neighbour.
  const WIDE_KINDS: readonly { entity: string; kind: DetectKind }[] = WIDE_ENTITIES;
  const wideKind = WIDE_KINDS.find(
    (candidate) => candidate.entity.toLowerCase() === entity.toLowerCase(),
  );

  const bomNote = hadBOM ? BOM_NOTE : '';

  // Two positive SHAPE matches on one file (a hand-built fixture) is refused,
  // never resolved by check order, whatever the title word says.
  if ((areaOk || longKind) && interfaceShapeOk) {
    const longName = longKind ? `a long ${longKind.kind}` : 'an Area';
    return {
      kind: 'unrecognized',
      confidence: 'low',
      reason:
        `${filename}: matches BOTH ${longName} export header (line 1) and an Interface export ` +
        `header (line ${headerLine}) -- refusing to guess which this file is.`,
    };
  }

  if (longKind) {
    return {
      kind: longKind.kind,
      shape: 'L',
      confidence: 'high',
      reason:
        `${filename}: header line 1 has Date,Hour,TOU followed by ` +
        `${longKind.sig.keys.join(',')}, matching a long ${longKind.kind} export.`,
    };
  }

  if (areaOk) {
    return {
      kind: 'area',
      shape: 'L',
      confidence: 'high',
      reason: `${filename}: header line has Date,Hour,TOU,Name at indices 0-3, matching a long Area export.`,
    };
  }

  // The wide shape with an entity word no adapter claims: refused, naming it.
  if (interfaceShapeOk && !wideKind) {
    const supported = WIDE_KINDS.map((candidate) => `"${candidate.entity}"`).join(' or ');
    const named = entity
      ? `the title line (line 1) names the entity kind "${entity}", not ${supported}`
      : `the title line (line 1) carries no readable entity kind word`;
    return {
      kind: 'unrecognized',
      confidence: 'low',
      reason:
        `${filename}: line ${headerLine} has the wide export shape (Date,Hour,TOU plus entity ` +
        `columns), but ${named}, so this build has no parser for it.${bomNote}`,
    };
  }

  // A wide AREA export: areas across, one metric (the title's quantity).
  // It finalizes into the same `AreaTable` as a long one.
  if (interfaceShapeOk && wideKind?.kind === 'area') {
    const quantity = title.quantity.trim();
    return {
      kind: 'area',
      shape: 'W',
      // Not a slot variant: one Case holds one Area table. Reported so the
      // dialog can say which metric was read.
      quantity: quantity || undefined,
      confidence: quantity ? 'high' : 'low',
      reason: quantity
        ? `${filename}: line ${headerLine} has Date,Hour,TOU at indices 0-2 with at least one ` +
          `area column, and the title line names the entity kind "${entity}" and quantity ` +
          `"${quantity}" -- a wide Area export.`
        : `${filename}: line ${headerLine} has the wide Area export shape, but the title line ` +
          `(line 1) carries no readable quoted quantity, so the metric this file measures is ` +
          `unknown.`,
    };
  }

  // Bus and Generator: quantity-as-variant, as Interface (one Case can hold
  // LMP and Load from one run).
  if (interfaceShapeOk && (wideKind?.kind === 'bus' || wideKind?.kind === 'generator')) {
    const quantity = title.quantity.trim();
    return {
      kind: wideKind.kind,
      shape: 'W',
      confidence: quantity ? 'high' : 'low',
      variant: quantity || undefined,
      quantity: quantity || undefined,
      reason: quantity
        ? `${filename}: line ${headerLine} has Date,Hour,TOU at indices 0-2 with at least one ` +
          `entity column, and the title line names the entity kind "${entity}" and quantity ` +
          `"${quantity}" -- a wide ${entity} export.`
        : `${filename}: line ${headerLine} has the wide ${entity} export shape, but the title ` +
          `line (line 1) carries no readable quoted quantity, so the table-slot variant is ` +
          `unknown.`,
    };
  }

  if (interfaceShapeOk) {
    // The variant becomes a slot key, so it is held to the truncation rule
    // too: it comes off the short title line. Never take it from the header.
    const quantity = title.quantity.trim();
    if (quantity) {
      return {
        kind: 'interface',
        shape: 'W',
        confidence: 'high',
        quantity,
        reason:
          `${filename}: line ${headerLine} has Date,Hour,TOU at indices 0-2 with at least one ` +
          `interface column, matching an Interface export; the title line names quantity "${quantity}".`,
        variant: quantity,
      };
    }
    return {
      kind: 'interface',
      shape: 'W',
      // Legitimate: two such files on one Case collide on the same slot key,
      // which the Import Dialog resolves.
      confidence: 'low',
      reason:
        `${filename}: line ${headerLine} matches an Interface export, but the title line ` +
        `(line 1) carries no readable quoted quantity, so the table-slot variant is unknown.`,
      variant: undefined,
    };
  }

  return {
    kind: 'unrecognized',
    confidence: 'low',
    reason:
      `${filename}: does not match a saved bundle, a group editor's membership CSV, an Area ` +
      `export header, or an Interface export header.${bomNote} Area: ${areaDetail} Interface: ${interfaceDetail}`,
  };
}
