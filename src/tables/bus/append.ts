// src/tables/bus/append.ts
//
// A later bus table joined onto a loaded one, keyed on the bus id: two buses
// may share a name, so a name never decides which plane a column joins. The
// merge is src/tables/append.ts.

import type { CubeFactor } from '../../ingest';
import { appendEntityTable, appendEntitySize, type Appended, unionColumns } from '../append';
import type { BusTable } from './types';

function refuseUnlike(old: BusTable, fresh: BusTable): void {
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

function view(t: BusTable) {
  return { ...t, keys: Array.from(t.buses) };
}

export function appendBusTable(old: BusTable, fresh: BusTable): Appended<BusTable> {
  refuseUnlike(old, fresh);
  const r = appendEntityTable(view(old), view(fresh));
  const sourceColumns = unionColumns(old.sourceColumns, fresh.sourceColumns);
  const freshName = new Map<number, string>();
  fresh.buses.forEach((id, i) => freshName.set(id, fresh.names[i]));
  const oldAt = new Map<number, number>();
  old.buses.forEach((id, i) => oldAt.set(id, i));
  const names = r.keys.map((id) => {
    const at = oldAt.get(id);
    const have = at === undefined ? '' : old.names[at];
    return have !== '' ? have : (freshName.get(id) ?? '');
  });
  const m = r.merged;
  return {
    table: {
      ...old,
      cube: m.cube,
      cellCoverage: m.cellCoverage,
      buses: Int32Array.from(r.keys),
      names,
      presence: m.presence,
      tou: m.tou,
      hoursPresent: m.hoursPresent,
      sourceColumns,
      firstYear: m.firstYear,
      numYears: m.numYears,
    },
    noun: 'bus',
    added: r.added.map(String),
    overlapping: r.overlapping.map(String),
    wrote: m.wrote,
    from: r.from,
    to: r.to,
  };
}

export function busAppendSize(
  old: BusTable,
  fresh: BusTable,
): { factors: CubeFactor[]; numYears: number } {
  const { planes, numYears } = appendEntitySize(view(old), view(fresh));
  return { factors: [{ count: planes, one: 'bus', many: 'buses' }], numYears };
}
