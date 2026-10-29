// src/app/extend.ts
//
// Whether a table's years fit its Case, as pure judgements over spans: one
// table at a time as it is about to attach (`judgeSpan`), and a Case's whole
// set when a drop that extends its years ends (`settleSpans`). Kept apart
// from the engines and the host so the batch, the attach and the Import
// Dialog judge a span by one rule.
//
// A table's resulting span is its slot's loaded years joined with the
// file's when it adds, or the file's alone when it replaces. It must contain
// the Case's span: a table that covers less would leave the Case's other
// tables with years it has no rows for. One that covers more extends the
// Case, which every other table of the Case must then match.

import type { YearSpan } from '../model/calendar';
import { MAX_CASE_YEARS, spanLabel, yearGapRefusal } from '../ingest';
import { unionSpan } from '../tables/append';
import type { AttachMode, HeldSpan, SlotSpan } from './batch';

export type SpanVerdict = { accept: true; extendsTo?: YearSpan } | { accept: false; note: string };

/** The years a table spans once it lands: the slot's joined with the
 * file's on an add, the file's alone on a replace or onto an empty slot. */
export function resultingSpan(
  group: YearSpan,
  slotSpan: YearSpan | null,
  mode: AttachMode,
): YearSpan {
  return mode === 'add' && slotSpan !== null ? unionSpan(group, slotSpan).span : group;
}

/**
 * Judge the files `who` (a merge group spanning `group`) landing on one slot
 * that holds `slotSpan`, in a Case whose span is `caseSpan`. A join that
 * skips a year or runs past `MAX_CASE_YEARS` is refused; a resulting span
 * equal to the Case's is accepted, and one strictly containing it is
 * accepted as an extension (`extendsTo`). Anything else is refused.
 */
export function judgeSpan(
  group: YearSpan,
  slotSpan: YearSpan | null,
  caseSpan: HeldSpan | null,
  mode: AttachMode,
  who: readonly string[],
): SpanVerdict {
  const one = who.length === 1;
  const names = who.join(' and ');
  if (mode === 'add' && slotSpan !== null) {
    const joined = unionSpan(group, slotSpan);
    const onto = `${names} and the table ${one ? 'it adds' : 'they add'} to`;
    if (joined.missing.length > 0) {
      const years: number[] = [];
      const last = joined.span.firstYear + joined.span.numYears;
      for (let y = joined.span.firstYear; y < last; y++) {
        if (!joined.missing.includes(y)) years.push(y);
      }
      return { accept: false, note: yearGapRefusal(`${onto} have`, years, joined.missing) };
    }
    if (joined.tooLong) {
      return {
        accept: false,
        note:
          `${onto} cover ${spanLabel(joined.span)}, ${joined.span.numYears} years. A Case spans ` +
          `at most ${MAX_CASE_YEARS} years, so the load is refused.`,
      };
    }
  }
  const result = resultingSpan(group, slotSpan, mode);
  if (caseSpan === null || sameSpan(result, caseSpan.span)) return { accept: true };
  if (contains(result, caseSpan.span)) return { accept: true, extendsTo: result };
  const opener = one ? `${names} spans` : `${names} together span`;
  const joinedTo = sameSpan(result, group)
    ? ''
    : `, ${spanLabel(result)} with the table ${one ? 'it adds' : 'they add'} to`;
  return {
    accept: false,
    note:
      `${opener} ${spanLabel(group)}${joinedTo}, but ${caseSpan.holder} spans ` +
      `${spanLabel(caseSpan.span)}. One Case holds one run of years; load ` +
      `${one ? 'it as its' : 'them as their'} own Case.`,
  };
}

/**
 * Whether a Case's held extensions may attach: the target is the union of
 * every held span, and every held table and every committed table must
 * state it. A committed table on a slot a held one fills is that table's
 * old self and is not judged. `held` is never empty.
 */
export function settleSpans(
  committed: readonly SlotSpan[],
  held: readonly SlotSpan[],
):
  | { accept: true; span: YearSpan }
  | { accept: false; target: YearSpan; differ: { holder: string; span: YearSpan }[] } {
  if (held.length === 0) throw new Error('settleSpans is asked about a Case with nothing held.');
  const target = held
    .slice(1)
    .reduce((span, entry) => unionSpan(span, entry.span).span, held[0].span);
  const heldSlots = new Set(held.map((entry) => entry.slot));
  const differ = [...held, ...committed.filter((entry) => !heldSlots.has(entry.slot))]
    .filter((entry) => !sameSpan(entry.span, target))
    .map(({ holder, span }) => ({ holder, span }));
  return differ.length === 0 ? { accept: true, span: target } : { accept: false, target, differ };
}

/** The refusal for a Case's held set: the files that would have extended
 * it, the run they would make, and each table that states another. */
export function settleRefusal(
  files: readonly string[],
  target: YearSpan,
  differ: readonly { holder: string; span: YearSpan }[],
): string {
  const one = files.length === 1;
  const others = differ.map((entry) => `${entry.holder} spans ${spanLabel(entry.span)}`);
  const list =
    others.length === 1
      ? others[0]
      : `${others.slice(0, -1).join(', ')} and ${others[others.length - 1]}`;
  return (
    `${files.join(' and ')} would make this Case ${spanLabel(target)}, but ${list}. Every ` +
    `table of a Case states the same years, so ${one ? 'it is' : 'they are'} refused and the ` +
    `loaded tables are kept. Drop the other tables' years in the same drop, or load ` +
    `${one ? 'it as its' : 'them as their'} own Case.`
  );
}

function sameSpan(a: YearSpan, b: YearSpan): boolean {
  return a.firstYear === b.firstYear && a.numYears === b.numYears;
}

/** `outer` covers every year of `inner`. */
function contains(outer: YearSpan, inner: YearSpan): boolean {
  return (
    outer.firstYear <= inner.firstYear &&
    outer.firstYear + outer.numYears >= inner.firstYear + inner.numYears
  );
}
