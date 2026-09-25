// src/session/reference.ts
//
// What a bundle carries BESIDE the Cases, gathered in one place.
//
// The area-to-group mapping, the reference lists, the generator group
// membership and the interface limits are four datasets with nothing in common
// except their lifetime: none belongs to a Case, all four outlive every Case
// in the session, and all four are written into a bundle and read back out of
// one. That shared lifetime is what this names.
//
// WHY IT EXISTS. `buildManifest`, `saveBundle` and `downloadBundle` each took
// the four as separate parameters DEFAULTING to a read of the module that
// holds them -- so `src/storage/` reached through four seams to answer "what
// is loaded right now?", and the parameters were there so tests could pass
// something else, which is the admission that the default could not be tested.
// A caller now says what goes in the bundle. The store is asked by whoever
// owns it, which is the composition root, and `src/storage/` imports none of
// the four.
//
// **This module reads the four stores; it does not own them.** They are still
// module-level state in their own files, and the `clear*()` functions the test
// suites reset them with are still theirs. Making them instances is the change
// that would let two sessions exist at once; it is not this one, and doing
// both at once would make a failure impossible to attribute.

import { exportGroupings } from '../tables/area/groupings';
import { exportGeneratorGroups, type SavedGeneratorGroups } from '../tables/generator/groups';
import { exportBusGroups, type SavedBusGroups } from '../tables/bus/groups';
import { exportInterfaceGroups, type SavedInterfaceGroups } from '../tables/interface/groups';
import type { LimitsStore } from '../limits/store';
import { allLookups } from '../lookups/store';
import type { LimitTable } from '../limits/types';
import type { LookupTable, LookupVariant } from '../lookups/types';

/** The four session-wide datasets, as values. */
export interface SessionReference {
  /** The whole Groupings.csv. `null` writes a bundle carrying no mapping,
   *  which restores as `null` -- distinct from an empty mapping. */
  readonly groupings: string | null;
  readonly lookups: ReadonlyMap<LookupVariant, LookupTable>;
  readonly generatorGroups: SavedGeneratorGroups | null;
  readonly busGroups: SavedBusGroups | null;
  readonly interfaceGroups: SavedInterfaceGroups | null;
  readonly limits: {
    readonly shared: LimitTable | undefined;
    /** Keyed by the Case's SYNTHETIC id, never its name. */
    readonly cases: ReadonlyMap<string, LimitTable>;
  };
}

/**
 * Read the four stores as one value.
 *
 * The single place in the app that reaches all four, and the reason nothing
 * else has to: a caller that wants to save what is loaded calls this and hands
 * the result on.
 *
 * The limits store arrives as an ARGUMENT because it is the one of the four
 * that is already an instance; the other three are still module-level and are
 * read here. Each that becomes an instance joins it in this signature.
 */
export function readSessionReference(limits: LimitsStore): SessionReference {
  return {
    groupings: exportGroupings(),
    lookups: allLookups(),
    generatorGroups: exportGeneratorGroups(),
    busGroups: exportBusGroups(),
    interfaceGroups: exportInterfaceGroups(),
    limits: { shared: limits.sharedLimits(), cases: limits.caseLimits() },
  };
}
