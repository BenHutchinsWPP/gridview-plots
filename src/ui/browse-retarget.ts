// src/ui/browse-retarget.ts
//
// The Selected tab's switches: every pin moved to another variable, another
// Case or "% of range" in one move. Pure data, so it tests under Node.
//
//   * **A rewrite, not a link.** A switch builds new pins from the old ones;
//     no pin remembers the dropdown, so bundles, restore and row ids are
//     untouched.
//   * **Never partway.** A variable or a Case is offered only when EVERY pin
//     can take it. Leaving some pins behind would mix them and turn the
//     control off under the analyst's hand, and dropping the ones that cannot
//     move would lose them on the way back (A → B → A must return A's pins).
//   * **The slot is found here, once, for every kind.** A table holding
//     `metrics` keeps its slot; one holding a single `quantity` per slot moves.
//     Two slots in one Case holding the variable refuse it: there is no rule
//     for which one the analyst meant. The kind answers only what it alone
//     knows: whether the subject has data there, its unit, and whether a group
//     combines it.
//   * **"% of range" switches the same way**: on for all when any pin is in
//     its own unit, off only when every pin is already %. A pin in MW and the
//     same pin in % become one pin, the first one's colour and place kept.

import { CASE_GROUP_BY } from '../series/model';
import {
  dependsOnVariable,
  withRowId,
  type BrowseRowRef,
  type SelectionEntry,
} from './browse-model';

/** The pin's filter context with what each variable-dependent filter was
 * chosen on, taken BEFORE the rewrite and never overwritten: the first
 * stamp is the truth however many switches follow. The Case is stamped the
 * first time the Case moves (`caseName` is the pin's Case before it does),
 * separately, so a pin that switched variable first still records it. */
function stamped(ref: BrowseRowRef, caseName?: string): Pick<BrowseRowRef, 'filterContext'> {
  if (!ref.filterContext) return {};
  return {
    filterContext: ref.filterContext.map((entry) => {
      if (!dependsOnVariable(entry.key)) return entry;
      let chosen = entry.chosenOn ?? { variable: ref.variable, unit: ref.unit };
      if (caseName !== undefined && chosen.case === undefined)
        chosen = { ...chosen, case: caseName };
      return chosen === entry.chosenOn ? entry : { ...entry, chosenOn: chosen };
    }),
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

/** Where `ref` lands on `variable` in `caseId` (its own Case unless
 * named), or null when it cannot go there. */
export function targetOf(
  kinds: KindRetargets,
  ref: BrowseRowRef,
  variable: string,
  caseId: string = ref.caseId,
): PinTarget | null {
  const kind = kinds[ref.kind];
  if (!kind) return null;
  const holders = kind.rows.filter(
    (row) => row.caseId === caseId && quantitiesOf(row.data).includes(variable),
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

/** A loaded Case as the Case switch offers it. `name` is the key a by-Case
 * bucket's row id holds; `label` is what the analyst reads. */
export interface CaseChoice {
  readonly id: string;
  readonly name: string;
  readonly label: string;
}

/** One option of the Case switch: disabled, with the pins that block it,
 * when some pin has nowhere to land there. */
export interface CaseOption {
  readonly id: string;
  readonly label: string;
  readonly blocked?: string;
}

/** The Selected tab's Case dropdown: what it lists, what it shows, and why it
 * is off when it is. */
export interface CaseSwitch {
  readonly cases: readonly CaseOption[];
  readonly caseId: string;
  readonly refusal?: string;
}

/** How many blocking pins an option names before it counts the rest. */
const NAMED_BLOCKERS = 3;

const pinName = (ref: BrowseRowRef): string => ref.label ?? String(ref.entity);

/** Every loaded Case in load order, each offered when every pin lands there.
 * A blocked Case is still listed, disabled and naming its blockers, so what
 * is withheld is said; a native `<select>` skips it under the arrow keys. */
export function caseSwitch(
  pins: readonly BrowseRowRef[],
  kinds: KindRetargets,
  cases: readonly CaseChoice[],
): CaseSwitch {
  const off = (refusal: string): CaseSwitch => ({ cases: [], caseId: '', refusal });
  if (pins.length === 0) return off('Pin a series to switch its Case.');
  const shown = [...new Set(pins.map((ref) => ref.caseId))];
  if (shown.length > 1) return off('The pins span several Cases; switching needs one.');
  const current = shown[0];
  const options = cases.map((entry): CaseOption => {
    if (entry.id === current) return { id: entry.id, label: entry.label };
    const stuck = pins.filter((ref) => targetOf(kinds, ref, ref.variable, entry.id) === null);
    if (stuck.length === 0) return { id: entry.id, label: entry.label };
    const named = stuck.slice(0, NAMED_BLOCKERS).map(pinName);
    const rest = stuck.length - named.length;
    return {
      id: entry.id,
      label: entry.label,
      blocked: `no data: ${named.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}`,
    };
  });
  if (!options.some((option) => option.id === current)) {
    return off("The pins' Case is no longer loaded.");
  }
  return {
    cases: options,
    caseId: current,
    ...(options.length < 2 ? { refusal: 'Only one Case is loaded.' } : {}),
  };
}

/** Every pin moved to Case `caseId`, colour and order kept. A by-Case bucket
 * carries the Case's name in its group value and row id, so it takes the new
 * name. A pin that cannot move stays; `caseSwitch` offers only what every pin
 * takes. */
export function retargetCase(
  entries: readonly SelectionEntry[],
  caseId: string,
  cases: readonly CaseChoice[],
  kinds: KindRetargets,
): SelectionEntry[] {
  const to = cases.find((entry) => entry.id === caseId);
  if (!to) return [...entries];
  const moved = entries.map((entry) => {
    const ref = entry.ref;
    if (ref.caseId === caseId) return entry;
    const target = targetOf(kinds, ref, ref.variable, caseId);
    if (!target) return entry;
    const from = cases.find((c) => c.id === ref.caseId)?.name;
    const byCase = ref.groupBy === CASE_GROUP_BY;
    // A by-Case bucket's label opens with its Case's name (`rowSubject`).
    const label =
      byCase && ref.groupValue !== undefined && ref.label?.startsWith(ref.groupValue)
        ? to.name + ref.label.slice(ref.groupValue.length)
        : (target.label ?? ref.label);
    const next = withRowId({
      ...ref,
      ...stamped(ref, from),
      caseId,
      slotKey: target.slotKey,
      unit: target.unit,
      axisIndex: target.axisIndex,
      ...(label !== undefined ? { label } : {}),
      ...(byCase ? { entity: to.name, groupValue: to.name } : {}),
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
