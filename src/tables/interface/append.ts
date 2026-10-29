// src/tables/interface/append.ts
//
// A later interface table joined onto a loaded one: the interface quantity must agree, the
// merge itself is src/tables/append.ts. Keyed on the interface name.

import type { CubeFactor } from '../../ingest';
import { appendEntityTable, appendEntitySize, type Appended, unionColumns } from '../append';
import type { InterfaceTable } from './types';

function refuseUnlike(old: InterfaceTable, fresh: InterfaceTable): void {
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
  if (old.unit !== fresh.unit) {
    throw new Error(
      `Cannot join these tables: the loaded table is in ${old.unit} and the file is in ${fresh.unit}.`,
    );
  }
}

function view(t: InterfaceTable) {
  return { ...t, keys: t.interfaces };
}

export function appendInterfaceTable(
  old: InterfaceTable,
  fresh: InterfaceTable,
): Appended<InterfaceTable> {
  refuseUnlike(old, fresh);
  const r = appendEntityTable(view(old), view(fresh));
  const sourceColumns = unionColumns(old.sourceColumns, fresh.sourceColumns);
  const m = r.merged;
  return {
    table: {
      ...old,
      cube: m.cube,
      cellCoverage: m.cellCoverage,
      interfaces: r.keys,
      presence: m.presence,
      tou: m.tou,
      hoursPresent: m.hoursPresent,
      sourceColumns,
      firstYear: m.firstYear,
      numYears: m.numYears,
    },
    noun: 'interface',
    added: r.added,
    overlapping: r.overlapping,
    wrote: m.wrote,
    from: r.from,
    to: r.to,
  };
}

export function interfaceAppendSize(
  old: InterfaceTable,
  fresh: InterfaceTable,
): { factors: CubeFactor[]; numYears: number } {
  const { planes, numYears } = appendEntitySize(view(old), view(fresh));
  return { factors: [{ count: planes, one: 'interface', many: 'interfaces' }], numYears };
}
