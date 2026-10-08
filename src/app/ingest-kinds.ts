// src/app/ingest-kinds.ts
//
// Every (kind, shape) a drop can carry, routed to its engine with the batch
// that kind states: its reader, its nouns, its entity set and its slot. The
// sequences themselves are one per shape (`./ingest-wide.ts`,
// `./ingest-long.ts`); what differs per kind is only the value handed to
// them, so a new kind is a new batch here, never a copy of a sequence.
//
// The readers arrive from the host rather than by import, so a test runs a
// whole drop with scripted readers and no Worker; the root hands in the real
// shape pools.

import type { CaseStore, TableKind, TableSlotKey } from '../model/case-model';
import type { AreaTable } from '../tables/area/types';
import { AREA_KIND, unionOf } from '../tables/area/long';
import type * as areaWide from '../tables/area/wide';
import { BUS_LONG_KIND } from '../tables/bus/long';
import type { BusTable } from '../tables/bus/types';
import type * as busWide from '../tables/bus/wide';
import { packBusLabels, LABELS_KEY as BUS_LABELS_KEY } from '../tables/bus/ui/retain';
import { GENERATOR_LONG_KIND } from '../tables/generator/long';
import type { GeneratorTable } from '../tables/generator/types';
import type * as generatorWide from '../tables/generator/wide';
import type * as interfacePool from '../tables/interface/pool';
import type { InterfaceTable } from '../tables/interface/types';
import type * as longPool from '../tables/long/pool';
import type { RetainGate } from '../ui/retain-gate';
import { yearCountOf, type Drop, type IngestHost, type IngestOutcome } from './batch';
import { createAreaLongIngest, createEntityLongIngest, type EntityLongBatch } from './ingest-long';
import { createWideIngest, type WideBatch } from './ingest-wide';

/** Area's slot key. Area has no variant: one Area table per Case. */
export const AREA_SLOT: TableSlotKey = { kind: 'area' };

/** The shape readers, one per wide kind plus the long pool every long kind
 * shares. The root passes the real modules. */
export interface IngestReaders {
  long: Pick<
    typeof longPool,
    | 'hasSimd'
    | 'NO_SIMD_MESSAGE'
    | 'readCasePlan'
    | 'discoverEntities'
    | 'ingest'
    | 'unionEntities'
    | 'unionMetricsOf'
  >;
  area: Pick<
    typeof areaWide,
    'hasSimd' | 'NO_SIMD_MESSAGE' | 'readCasePlan' | 'ingest' | 'unionOf'
  >;
  bus: Pick<
    typeof busWide,
    | 'hasSimd'
    | 'NO_SIMD_MESSAGE'
    | 'readCasePlan'
    | 'ingest'
    | 'unionOf'
    | 'coverageOf'
    | 'labelsOf'
  >;
  generator: Pick<
    typeof generatorWide,
    'hasSimd' | 'NO_SIMD_MESSAGE' | 'readCasePlan' | 'ingest' | 'unionOf' | 'coverageOf'
  >;
  interface: Pick<
    typeof interfacePool,
    'hasSimd' | 'NO_SIMD_MESSAGE' | 'readCasePlan' | 'ingest' | 'unionOf' | 'coverageOf'
  >;
}

export interface IngestKindsHost {
  /** Where every finished table is attached and recorded. */
  attach: IngestHost;
  /** Read by the retain gates, never written. */
  cases: CaseStore;
  retainGates: Readonly<Record<TableKind, RetainGate>>;
  /** Whether this drop chose "Load everything". */
  keepsEverything(): boolean;
  /** The area axis already loaded. */
  areaAxis(): string[];
  /** Rebuild every loaded Area cube on a widened axis. */
  adoptAxis(axis: string[]): void;
  /** After every batch of every kind: the Case list may have grown. */
  refresh(): void;
  /** The long bus and generator metric picker. */
  pickMetrics: EntityLongBatch['pickMetrics'];
  readers: IngestReaders;
}

export function createIngestKinds(host: IngestKindsHost) {
  const long = host.readers.long;

  /**
   * The LONG Area batch. Area's own decisions: its metric union includes
   * calculated columns, its axis is the app-wide area axis, and committing on a
   * widened axis reindexes every loaded cube.
   */
  const ingestAreaFiles = createAreaLongIngest(host.attach, {
    reader: long,
    sig: AREA_KIND.sig,
    union: (plans) => unionOf(plans),
    axis: (plans) => long.unionEntities(plans, host.areaAxis()),
    retained: (union, fileCount, axisCount, yearCount) =>
      // Gated on the AREA kind's own retained set -- never a case count, never
      // `areaCases()[0]`, both of which count the other kinds' Cases too.
      host.retainGates.area.resolveRetained(host.cases, {
        union,
        fileCount,
        axisCount,
        yearCount,
        coverage: new Map(),
        everything: host.keepsEverything(),
      }),
    parse: (plans, retained, axis, onProgress, groupOf) =>
      long.ingest(plans, retained, axis, AREA_KIND, onProgress, groupOf),
    adoptAxis: host.adoptAxis,
    slot: AREA_SLOT,
    refresh: host.refresh,
  });

  /** The LONG bus and generator batch: the `LongKind` passed in is the only
   * kind-specific input. */
  const ingestLongFiles = createEntityLongIngest(host.attach, {
    reader: long,
    // `unionMetricsOf`, not `unionOf`: the calculated columns are built by
    // `applyDerived`, which only Area's finalizer calls.
    union: (plans) => long.unionMetricsOf(plans),
    // No base axis. The area axis is Area's, and a bus id union merged into it
    // would put buses on the area picker and reindex every loaded area cube.
    axis: (plans) => long.unionEntities(plans),
    noteTablesChanged: (state) => state.noteTablesChanged(host.cases),
    pickMetrics: host.pickMetrics,
    everything: host.keepsEverything,
    parse: (plans, retained, axis, longKind, onProgress, groupOf) =>
      long.ingest(plans, retained, axis, longKind, onProgress, groupOf),
    refresh: host.refresh,
  });

  /**
   * The four WIDE batches: one sequence in `src/app/ingest-wide.ts`, plus what
   * each kind decides (its entity set and its slot). A kind needing a new step
   * gets a hook on `WideBatch`, never a copy or a flag the engine branches on.
   */
  const runWideBatch = createWideIngest(host.attach);

  /**
   * The WIDE Area batch: same `AreaTable` and area axis as `ingestAreaFiles`,
   * different parser. No axis scan (the areas are the header) and no metric
   * picker (a wide file carries one metric); the entity set is the area axis.
   */
  const wideAreaBatch: WideBatch<AreaTable, Drop> = {
    reader: host.readers.area,
    noun: 'area',
    plural: 'areas',
    async entities(plans) {
      // ONCE, over the surviving plans plus the loaded axis: the same union rule
      // as the long path, from the header instead of a scan.
      return {
        entities: host.readers.area.unionOf(plans).reduce<string[]>((union, area) => {
          const name = area.trim();
          if (name && !union.includes(name)) union.push(name);
          return union;
        }, host.areaAxis().slice()),
      };
    },
    // ONCE: every already-loaded cube, long or wide, is rebuilt on the widened
    // axis. The engine skips it when nothing committed.
    adopt: host.adoptAxis,
    // One Case holds one Area table, so a second wide Area file aimed at the
    // same Case is a slot collision the Import Dialog blocks before it gets here.
    slot: () => AREA_SLOT,
    refresh: host.refresh,
  };

  /**
   * The bus batch: Interface's shape, plus two things of its own.
   *
   *   * **The picker opens with nothing ticked**: a full-width bus case is one
   *     Float32Array of hundreds of megabytes.
   *   * **A widening drop reopens the picker**, ticked with what is loaded; the
   *     retained set is sticky only over buses the user was shown. No realloc:
   *     each `BusTable` has its own axis and cube.
   */
  const busBatch: WideBatch<BusTable, Drop> = {
    reader: host.readers.bus,
    noun: 'bus',
    plural: 'buses',
    async entities(plans) {
      const coverage = host.readers.bus.coverageOf(plans);
      // The id -> name map the picker labels its rows with, carried on the
      // coverage map under a key no bus id can collide with (ids are integers).
      coverage.set(BUS_LABELS_KEY, packBusLabels(host.readers.bus.labelsOf(plans)));
      const retained = await host.retainGates.bus.resolveRetained(host.cases, {
        union: host.readers.bus.unionOf(plans),
        fileCount: plans.length,
        yearCount: yearCountOf(plans),
        axisCount: 0,
        coverage,
        everything: host.keepsEverything(),
      });
      // Cancelled: say so. This picker opens empty, so a silent stop would read
      // as a drop that did nothing at all. Confirmed with nothing ticked: stop
      // without a sentence, because the user has just said it.
      if (retained === null) {
        return {
          stop: [
            'No bus was selected, so no bus table was loaded. Drop the file(s) again to choose.',
          ],
        };
      }
      return retained.length === 0 ? { stop: [] } : { entities: retained };
    },
    slot: (drop) => ({ kind: 'bus', variant: drop.variant }),
    refresh: host.refresh,
  };

  /**
   * The generator batch: the bus batch with a name axis (the picker opens
   * empty; a full-width case is ~170 MB). No id row or labels map: generator
   * names are unique, and a duplicate header is refused at ingest.
   */
  const generatorBatch: WideBatch<GeneratorTable, Drop> = {
    reader: host.readers.generator,
    noun: 'generator',
    plural: 'generators',
    async entities(plans) {
      const retained = await host.retainGates.generator.resolveRetained(host.cases, {
        union: host.readers.generator.unionOf(plans),
        fileCount: plans.length,
        yearCount: yearCountOf(plans),
        axisCount: 0,
        coverage: host.readers.generator.coverageOf(plans),
        everything: host.keepsEverything(),
      });
      if (retained === null) {
        return {
          stop: [
            'No generator was selected, so no generator table was loaded. Drop the file(s) ' +
              'again to choose.',
          ],
        };
      }
      return retained.length === 0 ? { stop: [] } : { entities: retained };
    },
    slot: (drop) => ({ kind: 'generator', variant: drop.variant }),
    refresh: host.refresh,
  };

  /**
   * The Interface batch: no axis pass, no shared axis, no reindex. An empty
   * selection is passed to the reader, which refuses it by name: the picker
   * opens with everything ticked, so emptying it is worth a sentence.
   */
  const interfaceBatch: WideBatch<InterfaceTable, Drop> = {
    reader: host.readers.interface,
    noun: 'interface',
    plural: 'interfaces',
    async entities(plans) {
      // The union of every dropped header, so a path only one file monitors can
      // still be picked.
      const retained = await host.retainGates.interface.resolveRetained(host.cases, {
        union: host.readers.interface.unionOf(plans),
        fileCount: plans.length,
        yearCount: yearCountOf(plans),
        axisCount: 0,
        coverage: host.readers.interface.coverageOf(plans),
        everything: host.keepsEverything(),
      });
      // A path nobody was offered reopens the picker, so a path missing from
      // `retained` is one the user was shown and unticked.
      return retained === null ? { stop: [] } : { entities: retained };
    },
    slot: (drop) => ({ kind: 'interface', variant: drop.variant }),
    refresh: host.refresh,
  };

  return {
    /** Run one (kind, shape) batch through its engine. */
    ingest(kind: TableKind, shape: 'W' | 'L', drops: Drop[]): Promise<IngestOutcome> {
      switch (kind) {
        case 'area':
          return shape === 'L' ? ingestAreaFiles(drops) : runWideBatch(wideAreaBatch, drops);
        case 'interface':
          return runWideBatch(interfaceBatch, drops);
        case 'bus':
          return shape === 'L'
            ? ingestLongFiles(drops, 'bus', BUS_LONG_KIND)
            : runWideBatch(busBatch, drops);
        case 'generator':
          return shape === 'L'
            ? ingestLongFiles(drops, 'generator', GENERATOR_LONG_KIND)
            : runWideBatch(generatorBatch, drops);
      }
    },
  };
}
