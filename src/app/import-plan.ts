// src/app/import-plan.ts
//
// Pure logic behind the Import Dialog: given classified dropped files and how
// the user wants them grouped, decide each file's Case, kind, variant, and
// whether it collides in this batch or replaces a loaded table. No DOM, so it
// is tested in plain Node (tests/test_import_plan.mjs); the dialog only renders.

import type { DetectResult, DetectShape } from '../detect';
import { caseForName, slotKey, type TableKind } from '../model/case-model';
import { HOURS_PER_YEAR } from '../model/calendar';
import { TABLE_KINDS } from '../tables/registry';

/** The table kinds the dialog routes to. Re-exported, never re-declared, so a
 *  new kind cannot be added to one copy and missed in another. */
export type { TableKind };

export interface ImportFile {
  name: string;
  detected: DetectResult;
}

export type ImportMode = 'one-case' | 'derive' | 'individual';

/**
 * Per-file corrections on top of what `mode` derives. `caseName` applies only
 * in 'individual' mode. The dialog writes only `caseName`; the overrides are
 * a planner API for programmatic callers, since kind and quantity are never
 * chosen on screen.
 */
export interface FileOverride {
  /** 'individual' mode: the case name typed for this one file. */
  caseName?: string;
  /** Corrects a misdetected kind (planner API, not a control). */
  kindOverride?: TableKind;
  /** Replaces `detected.variant` (planner API, not a control). */
  variantOverride?: string;
}

/** A Case loaded before this batch, so a matching name is EXISTING and an
 * occupied slot is a replace rather than a same-batch collision. */
export interface ExistingCase {
  name: string;
  /** What the Case is shown as; a typed name matching it joins this Case. */
  displayName?: string;
  /** Occupied slot keys, in `slotKey`'s format (src/model/case-model.ts). */
  occupiedSlots: string[];
  /**
   * Hours covered by each occupied slot, so a replace onto a HALF year can
   * say so (a replace does not combine hours). Missing or `null` means
   * unknown, never a year of absence.
   */
  slotHours?: Record<string, number | null>;
}

export interface ImportModeParams {
  /** 'one-case' mode (required for that mode): every file's case name. */
  caseName?: string;
  /** 'derive' mode: a filename glob with one `*` capturing the case name.
   * Default `'*'` (the whole stem). */
  pattern?: string;
  /** Per-file overrides keyed by INDEX in `files`, never name: two dropped
   * files can share a name. */
  overrides?: Record<number, FileOverride>;
  /** Cases already loaded before this batch runs. */
  existingCases?: ExistingCase[];
}

export interface ImportPlan {
  file: string;
  fileIndex?: number;
  caseName: string;
  caseIsNew: boolean;
  kind: TableKind;
  /**
   * The detected SHAPE, carried through. Correcting a misdetected KIND does
   * not change the layout. Undefined falls back to the kind's original parser.
   */
  shape?: DetectShape;
  variant?: string;
  /**
   * BLOCKING: two files in THIS batch resolve to the same slot and cannot
   * merge, so one would be lost to last-write-wins. Never set for a replace
   * of a loaded table (`replacesExisting`, non-blocking).
   */
  slotConflict: boolean;
  conflictReason?: string;
  /**
   * Several files fill one slot as ONE table: the date-split halves the user
   * asked for by naming them alike. Not a conflict; agreement is checked at
   * the header pass.
   */
  merges: boolean;
  /**
   * NON-blocking: the target Case already has a table at this slot, which
   * this import overwrites. The dialog warns but allows it. A plan can also be
   * `slotConflict`, which still blocks.
   */
  replacesExisting: boolean;
  replaceReason?: string;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stemOf(filename: string): string {
  return filename.replace(/\.[^./\\]+$/, '');
}

/**
 * A Case name from a filename and a glob with one `*` capture. No `*` or no
 * match falls back to the filename stem rather than guessing.
 */
export function deriveCaseName(filename: string, pattern: string = '*'): string {
  if (pattern === '*') return stemOf(filename);
  const star = pattern.indexOf('*');
  if (star === -1) return stemOf(filename);
  const before = pattern.slice(0, star);
  const after = pattern.slice(star + 1);
  const match = new RegExp(`^${escapeRegExp(before)}(.*)${escapeRegExp(after)}$`).exec(filename);
  return match ? match[1] : stemOf(filename);
}

/** The slot key for (kind, variant), via `slotKey` in src/model/case-model.ts.
 * Two files with no variant land on the SAME key. */
export function slotKeyFor(kind: TableKind, variant: string | undefined): string {
  return slotKey({ kind, variant });
}

/** The slot for display: `slotKeyFor` keeps a trailing separator (`"area "`)
 * that reads as a typo on screen. */
function slotLabel(kind: TableKind, variant: string | undefined): string {
  return variant === undefined || variant === '' ? kind : `${kind} ${variant}`;
}

interface ResolvedFile {
  file: string;
  caseName: string;
  kind: TableKind;
  shape?: DetectShape;
  variant?: string;
}

/** One `ImportPlan` per dropped file: case naming, variants and collision
 * detection all live here. */
export function planImports(
  files: ImportFile[],
  mode: ImportMode,
  params: ImportModeParams = {},
): ImportPlan[] {
  const overrides = params.overrides ?? {};
  const existingCases = params.existingCases ?? [];
  const existingByName = new Map(existingCases.map((c) => [c.name, c]));

  const resolved: ResolvedFile[] = files.map((f, index) => {
    const override = overrides[index];

    let caseName: string;
    if (mode === 'one-case') {
      if (params.caseName === undefined) {
        throw new Error(`'one-case' mode requires params.caseName`);
      }
      caseName = params.caseName;
    } else if (mode === 'derive') {
      caseName = deriveCaseName(f.name, params.pattern ?? '*');
    } else {
      if (override?.caseName === undefined) {
        throw new Error(`${f.name}: 'individual' mode requires a caseName override for this file`);
      }
      caseName = override.caseName;
    }

    // A non-table verdict here is a caller bug: refuse rather than mistype it.
    const kind = override?.kindOverride ?? f.detected.kind;
    if (!TABLE_KINDS.includes(kind as TableKind)) {
      throw new Error(
        `${f.name}: detected kind "${kind}" is not an importable table kind ` +
          `(${TABLE_KINDS.join('/')}) -- Groupings/bundle files must not reach the Import ` +
          `Dialog.`,
      );
    }

    const variant =
      override?.variantOverride !== undefined ? override.variantOverride : f.detected.variant;

    // A name typed as a Case is shown joins that Case under its NAME, the key
    // every later lookup (and a same-batch collision) matches on.
    caseName = caseForName(existingCases, caseName)?.name ?? caseName;

    return { file: f.name, caseName, kind: kind as TableKind, shape: f.detected.shape, variant };
  });

  // Group by (caseName, slot) to find same-batch collisions.
  const groups = new Map<string, ResolvedFile[]>();
  for (const r of resolved) {
    const groupKey = `${r.caseName}\u0000${slotKeyFor(r.kind, r.variant)}`;
    const bucket = groups.get(groupKey);
    if (bucket) bucket.push(r);
    else groups.set(groupKey, [r]);
  }

  return resolved.map((r, index) => {
    const slotKeyStr = slotKeyFor(r.kind, r.variant);
    const groupKey = `${r.caseName}\u0000${slotKeyStr}`;
    const batchSiblings = groups.get(groupKey) ?? [r];
    const existingCase = existingByName.get(r.caseName);
    const caseIsNew = !existingCase;

    let slotConflict = false;
    let conflictReason: string | undefined;

    // Several files for one slot MERGE into one cube; what they must agree on
    // is checked at the header pass (`src/tables/<shape>/merge.ts`). It is a
    // collision instead when the shapes differ (one cube, one reader) or when
    // no title quantity was read, since the files may then measure different
    // things.
    const sameShape = new Set(batchSiblings.map((s) => s.shape)).size === 1;
    // Undefined and empty both mean "not read", and key the same slot.
    const unreadableVariant =
      r.kind === 'interface' && (r.variant === undefined || r.variant === '');
    const merges = batchSiblings.length > 1 && sameShape && !unreadableVariant;
    if (batchSiblings.length > 1 && !merges) {
      slotConflict = true;
      // Name only the overlapping files; the row and summary say the rest.
      const others = batchSiblings.filter((s) => s !== r).map((s) => `"${s.file}"`);
      conflictReason = `Overlaps with ${others.join(', ')}.`;
    }

    // A loaded table at this slot is a replace (allowed), not a collision.
    let replacesExisting = false;
    let replaceReason: string | undefined;
    if (existingCase?.occupiedSlots.includes(slotKeyStr)) {
      replacesExisting = true;
      const covers = existingCase.slotHours?.[slotKeyStr];
      // Only a PARTIAL year gets the extra warning; unknown coverage gets none.
      const partial =
        typeof covers === 'number' && covers < HOURS_PER_YEAR
          ? ` It covers ${covers.toLocaleString()} of ${HOURS_PER_YEAR.toLocaleString()} hours, ` +
            `which a replace does not combine — drop date-split halves TOGETHER instead.`
          : '';
      replaceReason = `Replaces the "${slotLabel(r.kind, r.variant)}" table already in this Case.${partial}`;
    }

    return {
      file: r.file,
      fileIndex: index,
      caseName: r.caseName,
      caseIsNew,
      kind: r.kind,
      shape: r.shape,
      variant: r.variant,
      slotConflict,
      conflictReason,
      merges,
      replacesExisting,
      replaceReason,
    };
  });
}

// ------------------------------------------------------- interface limits

/** Where one limits file applies: `'all'` (the shared fallback) or one Case,
 * which then stops falling back. Resolution is `src/limits/store.ts`'s. */
export type LimitScope = { kind: 'all' } | { kind: 'case'; caseName: string };

/**
 * One limits file's assignment. Deliberately NOT an `ImportPlan`: a limits
 * file has no kind, cube or slot, and widening `kind` past `TableKind` would
 * break `routeDrop`'s exhaustive switch (`src/app/drop-route.ts`).
 */
export interface LimitPlan {
  file: string;
  /** Index into the limits array, not the table files. */
  fileIndex: number;
  scope: LimitScope;
}

/**
 * Each limits file's scope: a derived default plus the user's corrections.
 * One file defaults to `all` (one published set across many runs); two or
 * more default to a Case each (a run per limit set), picked as the first case
 * name found in the filename, else the first Case in the batch. With no
 * Cases, every file is `all`, and the dialog says the later replaces the
 * earlier.
 */
export function planLimits(
  files: readonly ImportFile[],
  caseNames: readonly string[],
  overrides: Readonly<Record<number, LimitScope | undefined>> = {},
): LimitPlan[] {
  return files.map((file, index) => {
    const override = overrides[index];
    if (override !== undefined) return { file: file.name, fileIndex: index, scope: override };
    if (files.length === 1 || caseNames.length === 0) {
      return { file: file.name, fileIndex: index, scope: { kind: 'all' } };
    }
    const lowered = file.name.toLowerCase();
    const matched = caseNames.find((name) => name !== '' && lowered.includes(name.toLowerCase()));
    return {
      file: file.name,
      fileIndex: index,
      scope: { kind: 'case', caseName: matched ?? caseNames[0] },
    };
  });
}
