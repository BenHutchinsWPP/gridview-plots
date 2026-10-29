// src/tables/generator/append.ts
//
// A later generator table joined onto a loaded one: the generator quantity must agree, the
// merge itself is src/tables/append.ts. Keyed on the generator name.

import type { CubeFactor } from '../../ingest';
import { appendEntityTable, appendEntitySize, type Appended, unionColumns } from '../append';
import type { GeneratorTable } from './types';

function refuseUnlike(old: GeneratorTable, fresh: GeneratorTable): void {
  if (old.quantity === '' || fresh.quantity === '') {
    throw new Error(
      `Cannot join these tables: the title line of one gives no quantity (loaded "${old.quantity}", file "${fresh.quantity}").`,
    );
  }
  if (old.quantity !== fresh.quantity) {
    throw new Error(
      `Cannot join these tables: the loaded table measures "${old.quantity}" and the file measures "${fresh.quantity}".`,
    );
  }
}

function view(t: GeneratorTable) {
  return { ...t, keys: t.generators };
}

export function appendGeneratorTable(
  old: GeneratorTable,
  fresh: GeneratorTable,
): Appended<GeneratorTable> {
  refuseUnlike(old, fresh);
  const r = appendEntityTable(view(old), view(fresh));
  const sourceColumns = unionColumns(old.sourceColumns, fresh.sourceColumns);
  const m = r.merged;
  return {
    table: {
      ...old,
      cube: m.cube,
      cellCoverage: m.cellCoverage,
      generators: r.keys,
      presence: m.presence,
      tou: m.tou,
      hoursPresent: m.hoursPresent,
      sourceColumns,
      firstYear: m.firstYear,
      numYears: m.numYears,
    },
    noun: 'generator',
    added: r.added,
    overlapping: r.overlapping,
    wrote: m.wrote,
    from: r.from,
    to: r.to,
  };
}

export function generatorAppendSize(
  old: GeneratorTable,
  fresh: GeneratorTable,
): { factors: CubeFactor[]; numYears: number } {
  const { planes, numYears } = appendEntitySize(view(old), view(fresh));
  return { factors: [{ count: planes, one: 'generator', many: 'generators' }], numYears };
}
