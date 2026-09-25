// src/tables/bus/ui/retain.ts
//
// Bus's answer to "which buses do these files keep?".
//
// **The picker opens with nothing ticked.** A full-width bus case finalizes
// into one contiguous Float32Array of hundreds of megabytes, so an empty
// selection is what stops the Enter key from allocating it. A cancelled picker
// stops the batch and loads no bus table; it never falls back to keeping
// everything, which is the outcome this picker exists to prevent.
//
// The id -> name map the picker labels its rows with rides on the coverage map
// under a key no bus id can collide with, because ids are integers and this one
// starts with a space.

import { createRetainGate, type RetainGate } from '../../../ui/retain-gate';
import { showBusPicker } from './picker';

export const LABELS_KEY = ' labels';

export function packBusLabels(labels: Map<string, string>): string[] {
  return [...labels].map(([id, name]) => `${id} ${name}`);
}

function busLabelsOf(batch: { coverage: Map<string, string[]> }): Map<string, string> {
  const labels = new Map<string, string>();
  for (const entry of batch.coverage.get(LABELS_KEY) ?? []) {
    const at = entry.indexOf(' ');
    if (at > 0) labels.set(entry.slice(0, at), entry.slice(at + 1));
  }
  return labels;
}

export function createBusRetainGate(): RetainGate {
  return createRetainGate('bus', (batch, state) =>
    showBusPicker(
      batch.union,
      busLabelsOf(batch),
      batch.coverage,
      batch.fileCount,
      state.retainedColumns ?? [],
      batch.everything,
    ),
  );
}
