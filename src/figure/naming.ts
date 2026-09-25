// src/figure/naming.ts
//
// What a figure is called outside itself: the caption suggested for Word's
// Insert Caption, and the file's name. There is no title inside the figure,
// so Word's caption numbering is the only title, and the caption is also
// written into the file (SVG `<title>`/`<desc>`, PNG `iTXt`) so a figure found
// later still says what it shows.
//
// Both name only what every line shares, as the context line does: a Case
// that differs between lines is listed in the caption and left out of the
// filename rather than naming one line's Case for all of them.

import { kindNoun } from '../series/label';
import type { FigureNaming } from './facts';

/** A filename at most this long, extension included. */
export const FILENAME_MAX = 80;
/** Every figure extension is three letters and a dot. */
const EXTENSION_ROOM = 4;

/** `a`, `a and b`, `a, b and c`. */
function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function distinct(items: readonly string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

/** More keys than this are counted in a caption rather than listed. */
const KEYS_LISTED = 4;

/**
 * The suggested caption. `lead` is the pane's own phrasing of what is shown
 * (`Hourly …`); `hourFilter` is the filter sentence, `all hours` unfiltered.
 */
export function suggestCaption(
  naming: FigureNaming,
  lead: (what: string) => string,
  hourFilter: string,
): string {
  const kind = naming.kind ? kindNoun(naming.kind) : '';
  const quantity = naming.quantity ?? listOf(distinct(naming.quantities));
  const what = [kind, quantity].filter(Boolean).join(' ');
  const range = naming.range ? ` as ${naming.range}` : '';
  const keys = distinct(naming.keys);
  const forKeys =
    keys.length === 0
      ? ''
      : keys.length <= KEYS_LISTED
        ? ` for ${listOf(keys)}`
        : ` for ${keys.length} series`;
  const cases = distinct(naming.cases);
  const inCases =
    cases.length === 0
      ? ''
      : cases.length === 1
        ? `, Case ${cases[0]}`
        : cases.length <= KEYS_LISTED
          ? `, Cases ${listOf(cases)}`
          : `, ${cases.length} Cases`;
  const hours = hourFilter && hourFilter !== 'all hours' ? `; hours: ${hourFilter}` : '';
  return `${lead(what)}${range}${forKeys}${inCases}${hours}.`;
}

/** Lower case, every run of anything but a letter or digit folded to `-`. */
function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * `<kind>-<quantity>_<case>_<pane>` without its extension, each facet left
 * out where lines differ. The pane token always survives: the facets before
 * it are cut to fit `FILENAME_MAX` with the extension.
 */
export function figureFileStem(naming: FigureNaming, pane: string): string {
  const head = [
    [naming.kind ?? '', naming.quantity ?? ''].map(fold).filter(Boolean).join('-'),
    fold(naming.caseLabel ?? ''),
  ]
    .filter(Boolean)
    .join('_');
  const tail = fold(pane);
  const room = FILENAME_MAX - EXTENSION_ROOM - tail.length - 1;
  const cut = head.slice(0, Math.max(0, room)).replace(/[-_]+$/, '');
  return cut ? `${cut}_${tail}` : tail;
}
