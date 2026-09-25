// src/ui/browse-retarget.ts
//
// The Selected tab's switch: every pin moved to another variable in one move.
// Pure data, so it tests under Node.
//
//   * **A rewrite, not a link.** A switch builds new pins from the old ones;
//     no pin remembers the dropdown, so bundles, restore and row ids are
//     untouched.
//   * **Never partway.** A variable is offered only when EVERY pin can take
//     it. Leaving some pins behind would mix variables and turn the control
//     off under the analyst's hand.
//   * **The slot is found here, once, for every kind.** A table holding
//     `metrics` keeps its slot; one holding a single `quantity` per slot moves.
//     Two slots in one Case holding the variable refuse it: there is no rule
//     for which one the analyst meant. The kind answers only what it alone
//     knows: whether the subject has data there, its unit, and whether a group
//     combines it.
//   * **"% of range" switches the same way**: on for all when any pin is in
//     its own unit, off only when every pin is already %. A pin in MW and the
//     same pin in % become one pin, the first one's colour and place kept.

import {
  dependsOnVariable,
  withRowId,
  type BrowseRowRef,
  type SelectionEntry,
} from './browse-model';

/** The pin's filter context with what each variable-dependent filter was
 * chosen on, taken BEFORE the rewrite and never overwritten: the first
 * stamp is the truth however many switches follow. */
function stamped(ref: BrowseRowRef): Pick<BrowseRowRef, 'filterContext'> {
  if (!ref.filterContext) return {};
  return {
    filterContext: ref.filterContext.map((entry) =>
      entry.chosenOn || !dependsOnVariable(entry.key)
        ? entry
        : { ...entry, chosenOn: { variable: ref.variable, unit: ref.unit } },
    ),
  };
}

/** What a kind's table carries for this lookup, whichever shape it came in. */
interface QuantityHolder {
  readonly metrics?: readonly string[];
  readonly quantity?: string;
}

export interface RetargetRow<D> {
  readonly caseId: string;
  readonly slotKey: string;
  readonly data: D;
}

/** Where a pin's subject sits in the target table. Both are stored on the
 * ref, and a label can come from the file (a bus name). */
export interface SubjectAt {
  readonly axisIndex: number;
  readonly label?: string;
}

/** What only the kind knows. Method syntax, so a kind's own table type fits. */
export interface KindAnswers<D> {
  /** The subject's place in `data` when it has data for `variable`, else
   * null. A group needs at least one member with data. */
  subjectIn(ref: BrowseRowRef, data: D, variable: string): SubjectAt | null;
  unitOf(variable: string, data: D): string;
  /** Why this pin cannot be drawn as "% of range", or undefined when it can.
   * Absent: every pin of the kind can. */
  percentRefusal?(ref: BrowseRowRef, data: D): string | undefined;
}

/** A kind's answers over its loaded tables, with the rule its groups tab
 * offers by (the root's, since it keys that rule by tab). */
export interface KindRetarget<D extends QuantityHolder = QuantityHolder> extends KindAnswers<D> {
  readonly rows: readonly RetargetRow<D>[];
  combines(variable: string, data: D): boolean;
}

export type KindRetargets = Readonly<Record<string, KindRetarget>>;

interface PinTarget {
  readonly slotKey: string;
  readonly unit: string;
  readonly axisIndex: number;
  readonly label?: string;
}

const quantitiesOf = (data: QuantityHolder): readonly string[] =>
  data.metrics ?? (data.quantity !== undefined ? [data.quantity] : []);

/** Where `ref` lands on `variable`, or null when it cannot go there. */
export function targetOf(
  kinds: KindRetargets,
  ref: BrowseRowRef,
  variable: string,
): PinTarget | null {
  const kind = kinds[ref.kind];
  if (!kind) return null;
  const holders = kind.rows.filter(
    (row) => row.caseId === ref.caseId && quantitiesOf(row.data).includes(variable),
  );
  if (holders.length !== 1) return null;
  const { slotKey, data } = holders[0];
  if (ref.groupBy !== undefined && !kind.combines(variable, data)) return null;
  // A % pin must still draw as %.
  if (ref.perUnit && kind.percentRefusal?.(ref, data)) return null;
  const at = kind.subjectIn(ref, data, variable);
  if (!at) return null;
  return {
    slotKey,
    unit: ref.perUnit ? '%' : kind.unitOf(variable, data),
    axisIndex: at.axisIndex,
    ...(at.label !== undefined ? { label: at.label } : {}),
  };
}

/** The Selected tab's Variable dropdown: what it lists, what it shows, and
 * why it is off when it is. */
export interface VariableSwitch {
  readonly variables: readonly string[];
  readonly variable: string;
  readonly refusal?: string;
}

const refused = (refusal: string): VariableSwitch => ({ variables: [], variable: '', refusal });

export function variableSwitch(
  pins: readonly BrowseRowRef[],
  kinds: KindRetargets,
): VariableSwitch {
  if (pins.length === 0) return refused('Pin a series to switch its variable.');
  const kindNames = [...new Set(pins.map((ref) => ref.kind))];
  if (kindNames.length > 1) {
    return refused(`The pins span ${kindNames.join(', ')}; switching needs one kind.`);
  }
  const shown = [...new Set(pins.map((ref) => ref.variable))];
  if (shown.length > 1) return refused('The pins show several variables; switching needs one.');
  const current = shown[0];
  const kind = kinds[kindNames[0]];
  // Every pin must take it, so the first pin's Case lists every candidate.
  const candidates = new Set<string>([current]);
  for (const row of kind?.rows ?? []) {
    if (row.caseId === pins[0].caseId) for (const q of quantitiesOf(row.data)) candidates.add(q);
  }
  // The current one always, so the dropdown shows what is drawn even when a
  // pin could not be re-taken onto it (an Area member frozen without data).
  const variables = [...candidates]
    .filter(
      (variable) =>
        variable === current || pins.every((ref) => targetOf(kinds, ref, variable) !== null),
    )
    .sort();
  return {
    variables,
    variable: current,
    ...(variables.length < 2 ? { refusal: 'No other variable has data for every pin.' } : {}),
  };
}

/** Keep the first entry per row id: `Map.set` on a repeat keeps the first
 * POSITION but the second VALUE, which would hand the survivor a new colour. */
function firstPerId(entries: readonly SelectionEntry[]): SelectionEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.ref.id)) return false;
    seen.add(entry.ref.id);
    return true;
  });
}

/** Every pin moved to `variable`, colour and order kept. A pin that cannot
 * move stays as it is; `variableSwitch` offers only what every pin takes. */
export function retargetVariable(
  entries: readonly SelectionEntry[],
  variable: string,
  kinds: KindRetargets,
): SelectionEntry[] {
  const moved = entries.map((entry) => {
    const ref = entry.ref;
    if (ref.variable === variable) return entry;
    const target = targetOf(kinds, ref, variable);
    if (!target) return entry;
    const next = withRowId({
      ...ref,
      ...stamped(ref),
      variable,
      slotKey: target.slotKey,
      unit: target.unit,
      axisIndex: target.axisIndex,
      ...(target.label !== undefined ? { label: target.label } : {}),
    });
    return { ref: next, color: entry.color };
  });
  return firstPerId(moved);
}

/** The pin's own table, where a % switch reads its unit and its refusal. */
function tableOf(kinds: KindRetargets, ref: BrowseRowRef): QuantityHolder | undefined {
  return kinds[ref.kind]?.rows.find(
    (row) => row.caseId === ref.caseId && row.slotKey === ref.slotKey,
  )?.data;
}

/** The Selected tab's "% of range" button: whether every pin is % (what it
 * shows), what a click sets, and why it is off when it is. */
export interface PercentSwitch {
  readonly on: boolean;
  readonly next: boolean;
  readonly refusal?: string;
}

export function percentSwitch(pins: readonly BrowseRowRef[], kinds: KindRetargets): PercentSwitch {
  if (pins.length === 0) {
    return { on: false, next: true, refusal: 'Pin a series to switch it to % of range.' };
  }
  if (pins.every((ref) => ref.perUnit === true)) return { on: true, next: false };
  for (const ref of pins) {
    const data = tableOf(kinds, ref);
    const why = data && !ref.perUnit ? kinds[ref.kind]?.percentRefusal?.(ref, data) : undefined;
    if (!why) continue;
    // Some pin cannot go to %; if others already are, the click brings them
    // back instead, so the set can always be made uniform.
    return pins.some((other) => other.perUnit)
      ? { on: false, next: false }
      : { on: false, next: true, refusal: `${ref.label ?? String(ref.entity)}: ${why}` };
  }
  return { on: false, next: true };
}

/** Every pin set to "% of range" or back to its own unit, colour and order
 * kept, a pin that now repeats another merged into the first. */
export function retargetPercent(
  entries: readonly SelectionEntry[],
  on: boolean,
  kinds: KindRetargets,
): SelectionEntry[] {
  const moved = entries.map((entry) => {
    const ref = entry.ref;
    if (Boolean(ref.perUnit) === on) return entry;
    const data = tableOf(kinds, ref);
    const kind = kinds[ref.kind];
    // A pin whose table is gone draws nothing either way; leave it be.
    if (!data || !kind) return entry;
    const { perUnit: _dropped, ...rest } = ref;
    const next = withRowId({
      ...rest,
      ...stamped(ref),
      unit: on ? '%' : kind.unitOf(ref.variable, data),
      ...(on ? { perUnit: true } : {}),
    });
    return { ref: next, color: entry.color };
  });
  return firstPerId(moved);
}
