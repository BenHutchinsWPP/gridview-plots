// src/tables/interface/ui/retain.ts
//
// Interface's answer to "which paths do these files keep?".
//
// A first drop opens ticked with EVERYTHING, unlike Bus and Generator: an
// interface export is tens of columns, not thousands, so keeping the lot costs
// nothing anybody has to be protected from.
//
// A wider second table costs a table and no reindex: each `InterfaceTable`
// owns its own axis and its own cube.

import { createRetainGate, widenedPreselection, type RetainGate } from '../../../ui/retain-gate';
import { showPicker } from './picker';

export function createInterfaceRetainGate(): RetainGate {
  return createRetainGate('interface', (batch, state) =>
    showPicker(
      batch.union,
      batch.coverage,
      batch.fileCount,
      widenedPreselection(batch, state, batch.union),
      batch.everything,
    ),
  );
}
