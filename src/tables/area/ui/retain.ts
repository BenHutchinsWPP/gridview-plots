// src/tables/area/ui/retain.ts
//
// Area's answer to "which metric columns do these files keep?".
//
// On a first drop the picker decides for itself: `undefined` is its own
// recommended metric set, which is a choice no other kind makes.
//
// A different metric set between two Area tables is not a problem to overlay:
// each `AreaTable` carries its own `metrics` and the kernels resolve a metric
// through it per table. What the tables genuinely share is the AREA axis, and
// that is what `adoptAxis` reindexes.

import { createRetainGate, widenedPreselection, type RetainGate } from '../../../ui/retain-gate';
import { showPicker } from './picker';

export function createAreaRetainGate(): RetainGate {
  return createRetainGate('area', (batch, state) =>
    showPicker(
      batch.union,
      batch.fileCount,
      batch.axisCount,
      widenedPreselection(batch, state, undefined),
      batch.everything,
    ),
  );
}
