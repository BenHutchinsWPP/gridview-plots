// src/tables/generator/ui/retarget.ts
//
// Generator's answers to the Selected tab's variable switch
// (`src/ui/browse-retarget.ts`). One quantity per slot, so presence is read
// from the target table. A group needs a member with data there, tested the
// way `resolveGeneratorSeries` would sum it, derived attributes included.
// A "% of range" group on a power quantity divides by GeneratorList caps and
// is refused without the list.

import { lookupFor } from '../../../lookups/store';
import { anyPresent, bucketLabelFor } from '../../../lookups/reduce';
import { CASE_GROUP_BY } from '../../../series/model';
import type { BrowseRowRef } from '../../../ui/browse-model';
import type { KindAnswers } from '../../../ui/browse-retarget';
import { derivedAttribute } from '../derived';
import { GENERATOR_GROUP_BY, unitsInGroup } from '../groups';
import { unitOf } from '../rules';
import { isPower, rangeNeedsList } from '../series';
import type { GeneratorTable } from '../types';

function groupHasData(ref: BrowseRowRef, data: GeneratorTable): boolean {
  const frozen = ref.members ? new Set<string | number>(ref.members) : undefined;
  const inFrozen = (name: string | number) => !frozen || frozen.has(name);
  const value = String(ref.groupValue);
  if (ref.groupBy === CASE_GROUP_BY) return anyPresent(data.presence, data.generators, inFrozen);
  if (ref.groupBy === GENERATOR_GROUP_BY) {
    const names = new Set<string | number>(ref.members?.map(String) ?? unitsInGroup(value));
    return anyPresent(data.presence, data.generators, (name) => names.has(name));
  }
  const list = lookupFor('generatorlist');
  if (!list) return false;
  const column = String(ref.groupBy);
  const derived = derivedAttribute(column);
  const labelOf = (name: string | number) =>
    derived
      ? derived.labelOf((source) => bucketLabelFor(name, list, source))
      : bucketLabelFor(name, list, column);
  return anyPresent(
    data.presence,
    data.generators,
    (name) => inFrozen(name) && labelOf(name) === value,
  );
}

export const generatorAnswers: KindAnswers<GeneratorTable> = {
  subjectIn(ref, data) {
    if (ref.groupBy !== undefined) return groupHasData(ref, data) ? { axisIndex: -1 } : null;
    const index = data.generators.indexOf(String(ref.entity));
    return index >= 0 && data.presence[index] === 1 ? { axisIndex: index } : null;
  },
  unitOf,
  percentRefusal(ref, data) {
    const unit = unitOf(data.quantity);
    return ref.groupBy !== undefined && isPower(unit) && !lookupFor('generatorlist')
      ? rangeNeedsList(unit)
      : undefined;
  },
};
