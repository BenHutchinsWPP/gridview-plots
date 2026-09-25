// src/tables/area/ui/retarget.ts
//
// Area's answers to the Selected tab's variable switch
// (`src/ui/browse-retarget.ts`). One Area table holds every metric, so a
// switch keeps the slot; what can refuse it is presence, which is per
// (area, metric): an area on the axis may have no rows for one metric. A
// metric with no aggregation rule is refused by `buildSeries`, so it is
// never offered.

import type { BrowseRowRef } from '../../../ui/browse-model';
import type { KindAnswers } from '../../../ui/browse-retarget';
import { areasIn } from '../groupings';
import { hasData } from '../kernels';
import { ruleFor } from '../rules';
import type { AreaTable } from '../types';

export const areaAnswers: KindAnswers<AreaTable> = {
  subjectIn(ref: BrowseRowRef, data: AreaTable, variable: string) {
    const metric = data.metrics.indexOf(variable);
    if (metric < 0 || !ruleFor(variable)) return null;
    const drawn = (area: string) => {
      const index = data.areas.indexOf(area);
      return index >= 0 && hasData(data, index, metric);
    };
    if (ref.groupBy === undefined) {
      const area = String(ref.entity);
      return drawn(area) ? { axisIndex: data.areas.indexOf(area) } : null;
    }
    // A frozen group draws its members; a live one the Grouping's current
    // membership, as `resolveAreaSeries` does. One member with data draws.
    const members = ref.members?.map(String) ?? areasIn(String(ref.groupValue));
    return members.some(drawn) ? { axisIndex: -1 } : null;
  },
  unitOf: (variable) => ruleFor(variable)?.unit ?? '',
};
