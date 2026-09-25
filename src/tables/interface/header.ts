// src/tables/interface/header.ts
//
// The Interface KIND's view of the wide shape reader.
//
// Everything about how a wide export is LAID OUT -- the preamble depth, the
// `Date,Hour,TOU` key columns, the header parse, the column plan -- lives in
// `src/tables/wide/header.ts` and is shared with every other kind that arrives
// in shape W. This module adds the one thing that is Interface's: the entity
// word its files carry, and the noun its messages use.
//
// Re-exported rather than wrapped, so `src/tables/<kind>/header.ts` stays the
// address a kind's ingest is read from.

export {
  KEY_COLS,
  PREAMBLE_LINES,
  buildColumnPlan,
  dayOfYear,
  parseHeaderLine,
  parseTitleLine,
  unionSchema,
} from '../wide/header';
export type { WideSpec } from '../wide/header';

import { wideSpec, type WideSpec } from '../wide/header';

/**
 * The entity word an Interface export's title line opens with, e.g.
 * `Interface Hourly 'Power Flow (MW)' Data for Year 2034`.
 *
 * This is the ONLY thing in a wide export that says which kind it is: area,
 * bus, generator and interface exports are byte-identical in structure. It
 * stays here, in the kind's own module, rather than in the shape reader.
 */
export const INTERFACE_ENTITY = 'Interface';

/** How the wide reader is configured for an Interface export: the ordinary
 * four preamble lines, header on line 5. Numbers only. */
export const INTERFACE_SPEC: WideSpec = wideSpec('interface');
