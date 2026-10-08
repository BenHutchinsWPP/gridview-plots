// src/app/import-plan.ts
//
// Pure logic behind the Import Dialog: given classified dropped files and how
// the user wants them grouped, decide each file's Case, kind, variant, and
// whether it collides in this batch or replaces a loaded table. No DOM, so it
// is tested in plain Node (tests/test_import_plan.mjs); the dialog only renders.

import type { DetectResult, DetectShape } from '../detect';
import { spanLabel } from '../ingest';
import type { YearSpan } from '../model/calendar';
import { caseForName, slotKey, type TableKind } from '../model/case-model';
import type { SampledYears } from '../tables/long/sample-years';
import { TABLE_KINDS } from '../tables/registry';

/** The table kinds the dialog routes to. Re-exported, never re-declared, so a
 *  new kind cannot be added to one copy and missed in another. */
export type { TableKind };

export interface ImportFile {
  name: string;
  detected: DetectResult;
  /** A long file's years, from its first and last rows (`sampleYears`). */
  sampled?: SampledYears;
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
  slotHours?: Record<string, SlotCoverage | null>;
  /** The years each occupied slot's table spans; missing or `null` is
   * unknown. */
  slotSpans?: Record<string, YearSpan | null>;
}

/** A table's real hours with a row, `covers`, of the `of` its year(s) have. */
export interface SlotCoverage {
  covers: number;
  of: number;
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
  /** The file's years as the dialog shows them: a wide file's date line, or
   * a long file's sample (`sampled`). */
  years?: YearSpan;
  sampled?: boolean;
  /**
   * BLOCKING: this file's years certainly differ from its Case's, so ingest
   * would refuse it (`keepSpans` in `./batch.ts`). Files merged into one
   * table are judged per unbroken run of years, so a skipped year reads as
   * the later run differing. Only a span known exactly (a date line, a
   * loaded table, a long sample in date order) can disagree; an unordered
   * long sample disagrees only by a year it holds.
   */
  spanConflict: boolean;
  /** One short line for the row: the Case's years. */
  spanReason?: string;
  /** The whole account, for a tooltip. */
  spanDetail?: string;
  /** The Case name that clears `spanConflict`: this Case's name and the
   * file's years. */
  splitTo?: string;
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
  /** What is known of the file's years; `whole` false is only years seen. */
  known?: { span: YearSpan; whole: boolean };
  sampled: boolean;
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

    return {
      file: f.name,
      caseName,
      kind: kind as TableKind,
      shape: f.detected.shape,
      variant,
      known: f.detected.years
        ? { span: f.detected.years, whole: true }
        : f.sampled
          ? { span: f.sampled, whole: f.sampled.whole }
          : undefined,
      sampled: f.detected.years === undefined && f.sampled !== undefined,
    };
  });

  // Group by (caseName, slot) to find same-batch collisions.
  const groups = new Map<string, ResolvedFile[]>();
  for (const r of resolved) {
    const groupKey = `${r.caseName}\u0000${slotKeyFor(r.kind, r.variant)}`;
    const bucket = groups.get(groupKey);
    if (bucket) bucket.push(r);
    else groups.set(groupKey, [r]);
  }

  const spans = spanConflicts(resolved, groups, existingByName);

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
      const coverage = existingCase.slotHours?.[slotKeyStr];
      // Only a PARTIAL year gets the extra warning; unknown coverage gets none.
      const partial =
        coverage && coverage.covers < coverage.of
          ? ` It covers ${coverage.covers.toLocaleString()} of ${coverage.of.toLocaleString()} hours, ` +
            `which a replace does not combine — drop date-split halves TOGETHER instead.`
          : '';
      replaceReason = `Replaces the "${slotLabel(r.kind, r.variant)}" table already in this Case.${partial}`;
    }

    return {
      file: r.file,
      fileIndex: index,
      ...(r.known ? { years: r.known.span, sampled: r.sampled } : {}),
      spanConflict: false,
      ...spans.get(r),
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

/** One table of the batch for a Case: the files merged into one slot, and
 * what is known of their years together. */
interface SpanUnit {
  members: ResolvedFile[];
  slot: string;
  known?: { span: YearSpan; whole: boolean };
}

function unitOf(slot: string, members: ResolvedFile[]): SpanUnit {
  const known = members.flatMap((m) => (m.known ? [m.known] : []));
  if (known.length === 0) return { members, slot };
  const first = Math.min(...known.map((k) => k.span.firstYear));
  const last = Math.max(...known.map((k) => k.span.firstYear + k.span.numYears - 1));
  return {
    members,
    slot,
    known: {
      span: { firstYear: first, numYears: last - first + 1 },
      // A member of unknown years may reach past the others.
      whole: known.length === members.length && known.every((k) => k.whole),
    },
  };
}

/**
 * A merge group as the tables the load could make of it: when every member's
 * years are known exactly, one per unbroken run of years, so a 2045 file
 * merged with a 2035 one is a 2045 table that differs from its Case rather
 * than a gap. Otherwise the group is one table.
 */
function runsOf(slot: string, members: ResolvedFile[]): SpanUnit[] {
  const exact = members.flatMap((m) => (m.known?.whole ? [{ m, span: m.known.span }] : []));
  if (members.length < 2 || exact.length < members.length) return [unitOf(slot, members)];
  exact.sort((a, b) => a.span.firstYear - b.span.firstYear);
  const runs: ResolvedFile[][] = [];
  let reach = -Infinity;
  for (const { m, span } of exact) {
    if (span.firstYear > reach + 1) runs.push([]);
    runs[runs.length - 1].push(m);
    reach = Math.max(reach, span.firstYear + span.numYears - 1);
  }
  return runs.map((run) => unitOf(slot, run));
}

const inSpan = (year: number, span: YearSpan) =>
  year >= span.firstYear && year < span.firstYear + span.numYears;

/**
 * Every file the load would certainly refuse for its years, mirroring the
 * ingest check: a Case's span is its loaded tables' outside the slots this
 * batch fills (a replaced table's years go with it), else the span most of
 * the batch's tables state exactly. Only the tables that differ from it are
 * marked, so the rename that clears them is theirs alone.
 */
function spanConflicts(
  resolved: readonly ResolvedFile[],
  groups: ReadonlyMap<string, ResolvedFile[]>,
  existingByName: ReadonlyMap<string, ExistingCase>,
): Map<ResolvedFile, Pick<ImportPlan, 'spanConflict' | 'spanReason' | 'spanDetail' | 'splitTo'>> {
  const out = new Map<
    ResolvedFile,
    Pick<ImportPlan, 'spanConflict' | 'spanReason' | 'spanDetail' | 'splitTo'>
  >();
  const byCase = new Map<string, SpanUnit[]>();
  for (const members of groups.values()) {
    const units = byCase.get(members[0].caseName) ?? [];
    units.push(...runsOf(slotKeyFor(members[0].kind, members[0].variant), members));
    byCase.set(members[0].caseName, units);
  }
  for (const [caseName, units] of byCase) {
    units.sort((a, b) => resolved.indexOf(a.members[0]) - resolved.indexOf(b.members[0]));
    const filled = new Set(units.map((unit) => unit.slot));
    let reference: { span: YearSpan; name: string; unit?: SpanUnit } | undefined;
    for (const [slot, span] of Object.entries(existingByName.get(caseName)?.slotSpans ?? {})) {
      if (span && !filled.has(slot)) {
        reference = { span, name: `this Case's loaded "${slot.trim()}" table` };
        break;
      }
    }
    if (!reference) {
      // The span most of the batch's tables state exactly, the first on a
      // tie, so the fewer files are the ones moved off.
      const exact = units.flatMap((unit) =>
        unit.known?.whole ? [{ unit, label: spanLabel(unit.known.span) }] : [],
      );
      const count = (label: string) => exact.filter((other) => other.label === label).length;
      const most = exact.reduce<(typeof exact)[number] | undefined>(
        (best, entry) =>
          best === undefined || count(entry.label) > count(best.label) ? entry : best,
        undefined,
      )?.unit;
      if (most?.known) {
        const files = most.members.map((m) => `"${m.file}"`).join(' and ');
        reference = { span: most.known.span, name: `${files}, for the same Case,`, unit: most };
      }
    }
    for (const unit of units) {
      const known = unit.known;
      if (!reference || !known || unit === reference.unit) continue;
      const span = known.span;
      const last = span.firstYear + span.numYears - 1;
      const differs = known.whole
        ? span.firstYear !== reference.span.firstYear || span.numYears !== reference.span.numYears
        : !inSpan(span.firstYear, reference.span) || !inSpan(last, reference.span);
      if (!differs) continue;
      for (const member of unit.members) {
        const what = member.sampled
          ? `Its ${known.whole ? 'first and last' : 'sampled'} rows are dated ${spanLabel(span)}`
          : `Spans ${spanLabel(span)}`;
        out.set(member, {
          spanConflict: true,
          spanReason: `The rest of this Case is ${spanLabel(reference.span)}.`,
          spanDetail:
            `${what}, but ${reference.name} spans ${spanLabel(reference.span)}. One Case holds ` +
            'one run of years, so the load will refuse this file; give it its own Case.',
          splitTo: `${caseName}_${spanLabel(span)}`,
        });
      }
    }
  }
  return out;
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
