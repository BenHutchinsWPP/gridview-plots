// src/tables/interface/ui/retarget.ts
//
// Interface's answers to the Selected tab's variable switch
// (`src/ui/browse-retarget.ts`). One quantity per slot, so presence is read
// from the target table. The only group is an authored boundary: its members
// and directions stay the group's, so a switch changes the quantity summed
// and nothing about who is summed or which way.

import { anyPresent } from '../../../lookups/reduce';
import type { KindAnswers } from '../../../ui/browse-retarget';
import { INTERFACE_GROUP_BY, boundaryCoefficients } from '../groups';
import type { InterfaceTable } from '../types';

export const interfaceAnswers: KindAnswers<InterfaceTable> = {
  subjectIn(ref, data) {
    if (ref.groupBy !== undefined) {
      if (ref.groupBy !== INTERFACE_GROUP_BY) return null;
      const signs = boundaryCoefficients(String(ref.groupValue), ref.members);
      return anyPresent(data.presence, data.interfaces, (name) => signs.has(name))
        ? { axisIndex: -1 }
        : null;
    }
    const index = data.interfaces.indexOf(String(ref.entity));
    return index >= 0 && data.presence[index] === 1 ? { axisIndex: index } : null;
  },
  unitOf: (_variable, data) => data.unit,
};
