// src/tables/bus/ui/retarget.ts
//
// Bus's answers to the Selected tab's variable switch
// (`src/ui/browse-retarget.ts`). One quantity per slot, so a switch moves the
// pin to another table, whose bus axis and names are its own: presence, axis
// index and label are read from THAT table. A group needs a member with data
// there, tested the way `resolveBusSeries` would sum it.

import { lookupFor } from '../../../lookups/store';
import { anyPresent, bucketLabelFor } from '../../../lookups/reduce';
import { CASE_GROUP_BY } from '../../../series/model';
import type { BrowseRowRef } from '../../../ui/browse-model';
import type { KindAnswers } from '../../../ui/browse-retarget';
import { BUS_GROUP_BY, busesInGroup } from '../groups';
import { busLabel, unitOf } from '../rules';
import type { BusTable } from '../types';

function groupHasData(ref: BrowseRowRef, data: BusTable): boolean {
  const frozen = ref.members ? new Set<string | number>(ref.members.map(Number)) : undefined;
  const inFrozen = (id: string | number) => !frozen || frozen.has(id);
  const value = String(ref.groupValue);
  if (ref.groupBy === CASE_GROUP_BY) return anyPresent(data.presence, data.buses, inFrozen);
  if (ref.groupBy === BUS_GROUP_BY) {
    const ids = frozen ?? new Set<string | number>(busesInGroup(value));
    return anyPresent(data.presence, data.buses, (id) => ids.has(id));
  }
  const list = lookupFor('buslist');
  const column = String(ref.groupBy);
  return (
    list !== undefined &&
    anyPresent(
      data.presence,
      data.buses,
      (id) => inFrozen(id) && bucketLabelFor(id, list, column) === value,
    )
  );
}

export const busAnswers: KindAnswers<BusTable> = {
  subjectIn(ref, data) {
    if (ref.groupBy !== undefined) return groupHasData(ref, data) ? { axisIndex: -1 } : null;
    const id = Number(ref.entity);
    const index = data.buses.indexOf(id);
    if (index < 0 || data.presence[index] !== 1) return null;
    // The export's name, as the Bus tab labels its rows; the pin keeps the
    // list's name when this file carries none.
    const name = data.names[index] ?? '';
    return { axisIndex: index, ...(name.trim() ? { label: busLabel(name, id) } : {}) };
  },
  unitOf,
};
