// src/lookups/parse.ts
//
// Reading a BusList or GeneratorList CSV into rows, and rows into a
// LookupTable. No wasm: these lists are a few MB (hourly exports are hundreds),
// so a plain JS parse at drop time is enough. It does need a real CSV reader:
// GeneratorList's `Long Name` is quoted and contains commas.
//
// Every table is built through `buildLookup`, merges included, so enum
// dictionaries are always derived from the merged rows and never spliced.

import {
  classifyUnknown,
  schemaFor,
  schemaForBanner,
  type DeclaredColumn,
  type ListSchema,
} from './schema';
import type { LookupColumn, LookupEntity, LookupTable } from './types';

/** Rows as strings, the form a merge works in; null is blank. */
export interface LookupRows {
  entity: LookupEntity;
  keyColumn: string;
  columns: string[];
  rows: Map<string | number, (string | null)[]>;
  sources: string[];
}

// ------------------------------------------------------------------ CSV

/** One CSV line's cells, honouring double quotes (RFC 4180 `""`). */
export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      cells.push(cell);
      cell = '';
    } else cell += ch;
  }
  cells.push(cell);
  return cells;
}

/** A BANNER line: text in the first cell, every other cell empty. The lists
 * carry one or two, so the header depth differs. */
export function isBannerLine(line: string): boolean {
  const cells = splitCsvLine(line);
  if (cells.length === 0) return false;
  if (cells[0].trim() === '') return false;
  return cells.slice(1).every((cell) => cell.trim() === '');
}

// -------------------------------------------------------- normalization

/** Every blank spelling, applied once here: a stray "NA" would become a bogus
 * extra LoadArea. */
const BLANKS = new Set(['', 'na', 'n/a', 'null', '#n/a']);

/** A cell as text, or null for blank. Unwraps `#...#` (dates, booleans), a
 * leading apostrophe (a text-typed id), and surrounding whitespace. */
export function normalizeCell(raw: string): string | null {
  let text = raw.trim();
  if (text.length >= 2 && text.startsWith('#') && text.endsWith('#'))
    text = text.slice(1, -1).trim();
  if (text.startsWith("'")) text = text.slice(1).trim();
  return BLANKS.has(text.toLowerCase()) ? null : text;
}

/** A number, with thousands separators removed (`1,234`); null unless fully
 * numeric, never `parseFloat`'s prefix match ("12 kV" is not 12). */
export function parseNumber(text: string): number | null {
  const cleaned = text.replace(/,/g, '');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** 0 = false, 1 = true, 2 = unknown. Accepts `TRUE`/`FALSE`, the unwrapped rot-guard:allow -- CSV cell values, not symbols
 * `#TRUE#` form, and `YES`/`NO`. */
function parseBool(text: string): 0 | 1 | 2 {
  const value = text.toLowerCase();
  if (value === 'true' || value === 'yes' || value === '1') return 1;
  if (value === 'false' || value === 'no' || value === '0') return 0;
  return 2;
}

const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` as days since 1970-01-01, or -1. Parsed by hand: `new Date`
 * reads some forms as UTC and some as local, shifting a day by timezone. */
function parseDate(text: string): number {
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(text);
  if (!match) return -1;
  const days = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / MS_PER_DAY;
  return Number.isFinite(days) ? Math.round(days) : -1;
}

// ------------------------------------------------------------- parsing

export interface ParseResult {
  rows: LookupRows;
  /** Non-fatal notes for the ingest note. */
  warnings: string[];
  /** Rows dropped because their key repeated one already read in the file. */
  duplicates: number;
}

/** Parse a dropped reference list. Refuses (throws) only for an unclaimed
 * banner or a missing KEY column; extra columns are carried. */
export function parseLookupCsv(text: string, filename: string): ParseResult {
  const lines = text.split(/\r?\n/);
  let cursor = 0;
  const banners: string[] = [];
  while (cursor < lines.length && banners.length < 2 && isBannerLine(lines[cursor])) {
    banners.push(splitCsvLine(lines[cursor])[0].trim());
    cursor++;
  }
  if (banners.length === 0) {
    throw new Error(`${filename}: no banner line, so this is not a GridView reference list.`);
  }
  const schema = schemaForBanner(banners[0].split(/[\s,]/)[0]);
  if (!schema) {
    throw new Error(
      `${filename}: the banner line (line 1) reads "${banners[0].slice(0, 40)}", which names no ` +
        `reference list this build knows. Expected BUS_GENERAL or GENERATORLIST.`,
    );
  }
  if (cursor >= lines.length) {
    throw new Error(`${filename}: a banner line and nothing after it -- no column header.`);
  }

  const header = splitCsvLine(lines[cursor]).map((cell) => cell.trim());
  cursor++;
  const keyIndex = header.indexOf(schema.keyColumn);
  if (keyIndex < 0) {
    throw new Error(
      `${filename}: the key column "${schema.keyColumn}" is missing from the header, so its rows ` +
        `cannot be keyed. Columns read: ${header.slice(0, 8).join(', ')}${header.length > 8 ? ', …' : ''}`,
    );
  }

  const warnings: string[] = [];
  const declared = new Set(schema.columns.map((column) => column.name));
  const undeclared = header.filter((name) => name !== '' && !declared.has(name));
  if (undeclared.length > 0) {
    warnings.push(
      `${filename}: ${undeclared.length} column(s) this build does not declare were carried as ` +
        `text: ${undeclared.join(', ')}.`,
    );
  }
  const missing = schema.columns.filter((column) => !header.includes(column.name));
  if (missing.length > 0) {
    warnings.push(
      `${filename}: ${missing.length} declared column(s) are absent and read as blank: ` +
        `${missing.map((column) => column.name).join(', ')}.`,
    );
  }

  const rows = new Map<string | number, (string | null)[]>();
  let duplicates = 0;
  let blankKeys = 0;
  for (; cursor < lines.length; cursor++) {
    const line = lines[cursor];
    if (line.trim() === '') continue;
    const cells = splitCsvLine(line);
    const rawKey = normalizeCell(cells[keyIndex] ?? '');
    if (rawKey === null) {
      blankKeys++;
      continue;
    }
    // The key's type comes from the schema, so both lists' bus ids normalize
    // identically and join.
    const keyKind = schema.columns.find((column) => column.name === schema.keyColumn)?.kind;
    const key = keyKind === 'int' || keyKind === 'float' ? (parseNumber(rawKey) ?? rawKey) : rawKey;
    if (rows.has(key)) {
      duplicates++;
      continue; // first row wins, inside a file as well as across files
    }
    rows.set(
      key,
      header.map((_, index) => normalizeCell(cells[index] ?? '')),
    );
  }

  if (duplicates > 0) {
    warnings.push(
      `${filename}: ${duplicates} row(s) repeat a "${schema.keyColumn}" already read; the first ` +
        `copy of each was kept.`,
    );
  }
  if (blankKeys > 0) {
    warnings.push(
      `${filename}: ${blankKeys} row(s) have a blank "${schema.keyColumn}" and were skipped.`,
    );
  }

  return {
    rows: {
      entity: schema.entity,
      keyColumn: schema.keyColumn,
      columns: header.map((name, index) => (name === '' ? `column ${index + 1}` : name)),
      rows,
      sources: [filename],
    },
    warnings,
    duplicates,
  };
}

// ------------------------------------------------------------- building

/** Declared columns in schema order, then undeclared ones by name: stable
 * whichever file arrived first, as a byte-identical merge needs. */
function columnOrder(schema: ListSchema, present: Iterable<string>): string[] {
  const seen = new Set(present);
  const declared = schema.columns.map((column) => column.name).filter((name) => seen.has(name));
  const extra = [...seen].filter((name) => !schema.columns.some((c) => c.name === name)).sort();
  return [...declared, ...extra];
}

function encodeColumn(
  name: string,
  declared: DeclaredColumn | undefined,
  cells: (string | null)[],
): LookupColumn {
  const n = cells.length;
  switch (declared?.kind) {
    case 'int':
    case 'float': {
      const values = declared.kind === 'int' ? new Int32Array(n) : new Float64Array(n);
      const nulls = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const text = cells[i];
        const value = text === null ? null : parseNumber(text);
        if (value === null || (declared.zeroIsNull && value === 0)) {
          nulls[i] = 1;
          continue;
        }
        values[i] = declared.kind === 'int' ? Math.round(value) : value;
      }
      return declared.kind === 'int'
        ? { name, kind: 'int', values: values as Int32Array, nulls }
        : { name, kind: 'float', values: values as Float64Array, nulls };
    }
    case 'bool': {
      const values = new Uint8Array(n);
      for (let i = 0; i < n; i++) values[i] = cells[i] === null ? 2 : parseBool(cells[i] as string);
      return { name, kind: 'bool', values };
    }
    case 'date': {
      const values = new Int32Array(n);
      for (let i = 0; i < n; i++)
        values[i] = cells[i] === null ? -1 : parseDate(cells[i] as string);
      return { name, kind: 'date', values };
    }
    case 'text': {
      const values = new Array<string>(n);
      for (let i = 0; i < n; i++) values[i] = cells[i] ?? '';
      return { name, kind: 'text', values };
    }
    case 'enum':
    default: {
      // Undeclared columns: enum when low-cardinality, else text, never a
      // number (see classifyUnknown).
      const distinct = new Set<string>();
      for (const cell of cells) if (cell !== null) distinct.add(cell);
      if (declared === undefined && classifyUnknown(distinct.size, n) === 'text') {
        const values = new Array<string>(n);
        for (let i = 0; i < n; i++) values[i] = cells[i] ?? '';
        return { name, kind: 'text', values };
      }
      // Sorted, so codes do not depend on arrival order.
      const labels = [...distinct].sort();
      const codeOf = new Map(labels.map((label, index) => [label, index]));
      const codes = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        const cell = cells[i];
        codes[i] = cell === null ? -1 : (codeOf.get(cell) ?? -1);
      }
      return { name, kind: 'enum', codes, labels };
    }
  }
}

/** Rows -> the stored table, sorted by key and with every dictionary derived
 * here, so arrival order never matters. */
export function buildLookup(source: LookupRows): LookupTable {
  const schema = schemaFor(source.entity);
  const keys = [...source.rows.keys()].sort((a, b) =>
    typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)),
  );
  const names = columnOrder(schema, source.columns);
  const columns = names.map((name) => {
    const at = source.columns.indexOf(name);
    const cells = keys.map((key) =>
      at < 0 ? null : ((source.rows.get(key) as (string | null)[])[at] ?? null),
    );
    return encodeColumn(
      name,
      schema.columns.find((column) => column.name === name),
      cells,
    );
  });
  return {
    entity: source.entity,
    rowCount: keys.length,
    columns,
    byName: new Map(columns.map((column, index) => [column.name, index])),
    index: new Map(keys.map((key, row) => [key, row])),
    keyColumns: [source.keyColumn],
    sources: [...source.sources],
  };
}
