// src/app/drop-route.ts
//
// Where a dropped file goes, decided before anything is opened: a verdict
// becomes a destination, and the Import Dialog's answer becomes batches.
// Both are total functions over closed unions ending in `never`, so a new
// kind is a COMPILE error here rather than a silent misroute.
//
// It decides and does not act: no state, no files, no DOM, so
// `tests/test_drop_route.mjs` exercises it with literals. Generic in the
// payload, so it never learns what a `File` is.

import type { DetectResult, DetectShape } from '../detect';
import type { TableKind } from '../model/case-model';

/** One dropped file, already classified. Reading the bytes is the caller's. */
export interface RoutedFile<T> {
  readonly name: string;
  readonly item: T;
  readonly verdict: DetectResult;
}

/** One auxiliary outcome, in DROP ORDER: messages share the list with the
 * actions so the user reads them in the order the files were dropped. */
export type Auxiliary<T> =
  | { readonly action: 'bundle'; readonly item: T }
  | { readonly action: 'groupings'; readonly item: T }
  | { readonly action: 'lookup'; readonly item: T }
  /** A file no route takes, with the reason: the caller logs it refused. */
  | { readonly action: 'message'; readonly item: T; readonly text: string };

export interface DropRoute<T> {
  /** For the Import Dialog. */
  readonly tables: RoutedFile<T>[];
  /** Interface limit files, for the same dialog: their scope needs the case
   *  names that only exist there. */
  readonly limits: RoutedFile<T>[];
  readonly auxiliary: Auxiliary<T>[];
}

/** Sort a classified drop into what a caller can do with it. Shape `R` (a
 * reference list) is not a table and joins the auxiliary stream. */
export function routeDrop<T>(files: readonly RoutedFile<T>[]): DropRoute<T> {
  const tables: RoutedFile<T>[] = [];
  const limits: RoutedFile<T>[] = [];
  const auxiliary: Auxiliary<T>[] = [];

  for (const entry of files) {
    const verdict = entry.verdict;
    switch (verdict.kind) {
      case 'bundle':
        auxiliary.push({ action: 'bundle', item: entry.item });
        break;
      case 'groupings':
        auxiliary.push({ action: 'groupings', item: entry.item });
        break;
      case 'area':
      case 'interface':
      case 'bus':
      case 'generator':
        if (verdict.shape === 'R') auxiliary.push({ action: 'lookup', item: entry.item });
        else tables.push(entry);
        break;
      case 'interfacelimit':
        limits.push(entry);
        break;
      case 'unrecognized':
        // detect.ts's own reason, never an invented message.
        auxiliary.push({ action: 'message', item: entry.item, text: verdict.reason });
        break;
      default: {
        const unhandled: never = verdict.kind;
        auxiliary.push({
          action: 'message',
          item: entry.item,
          text:
            `${entry.name}: classified as "${String(unhandled)}", which this build has no route ` +
            `for. This is a bug -- the file was recognised and then dropped on the floor.`,
        });
        break;
      }
    }
  }

  return { tables, limits, auxiliary };
}

/** One confirmed plan, reduced to what the split reads. */
export interface PlannedDrop<T> {
  readonly name: string;
  /** The FINAL kind: the detector's verdict as the Import Dialog left it. */
  readonly kind: TableKind;
  readonly shape?: DetectShape;
  readonly drop: T;
}

export interface PlanSplit<T> {
  /** Drops for the wide reader, by kind. A kind with none is absent. */
  readonly wide: Map<TableKind, T[]>;
  /** Drops for the long reader, by kind. A kind with none is absent. */
  readonly long: Map<TableKind, T[]>;
  /** One message per plan naming a kind this build has no ingest for. */
  readonly bugs: string[];
}

/**
 * Split confirmed plans into the two engines' batches. KIND picks the table
 * type, SHAPE the parser, read independently. A plan with no shape falls back
 * per kind, and not uniformly: Area to LONG and Bus/Generator to WIDE (each
 * kind's original reader); unifying them would re-point plans at a parser
 * that has never read them. Interface has only a wide reader.
 */
export function splitPlans<T>(plans: readonly PlannedDrop<T>[]): PlanSplit<T> {
  const wide = new Map<TableKind, T[]>();
  const long = new Map<TableKind, T[]>();
  const bugs: string[] = [];

  const push = (into: Map<TableKind, T[]>, kind: TableKind, drop: T) => {
    const bucket = into.get(kind);
    if (bucket) bucket.push(drop);
    else into.set(kind, [drop]);
  };

  for (const plan of plans) {
    switch (plan.kind) {
      case 'area':
        push(plan.shape === 'W' ? wide : long, 'area', plan.drop);
        break;
      case 'interface':
        push(wide, 'interface', plan.drop);
        break;
      case 'bus':
        push(plan.shape === 'L' ? long : wide, 'bus', plan.drop);
        break;
      case 'generator':
        push(plan.shape === 'L' ? long : wide, 'generator', plan.drop);
        break;
      default: {
        const unhandled: never = plan.kind;
        bugs.push(
          `${plan.name}: confirmed as "${String(unhandled)}" in the Import Dialog, but this ` +
            `build has no ingest for that kind. This is a bug -- the file was accepted and ` +
            `then never parsed.`,
        );
        break;
      }
    }
  }

  return { wide, long, bugs };
}
