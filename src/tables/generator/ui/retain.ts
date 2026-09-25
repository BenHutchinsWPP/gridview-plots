// src/tables/generator/ui/retain.ts
//
// Generator's answer to "which units do these files keep?".
//
// The picker opens with nothing ticked, for Bus's reason: a full-width
// generator case is a cube of well over a hundred megabytes, so keeping the lot
// is a choice, not a default. A cancelled picker stops the batch and never
// falls back to the whole axis.
//
// The axis is the unit NAME, not an id: a generator name is unique and a
// duplicate in a wide header is refused at ingest, so there is no id row to
// carry and no labels map to unpack.

import { createRetainGate, type RetainGate } from '../../../ui/retain-gate';
import { showGeneratorPicker } from './picker';

export function createGeneratorRetainGate(): RetainGate {
  return createRetainGate('generator', (batch, state) =>
    showGeneratorPicker(
      batch.union,
      batch.coverage,
      batch.fileCount,
      state.retainedColumns ?? [],
      batch.everything,
    ),
  );
}
