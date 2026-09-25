// src/storage/store.ts
//
// Save / load of the processed cubes, main-thread side: the I/O and the two
// entry points. OPFS I/O runs in storage/worker.ts (`createSyncAccessHandle`
// is worker-only), the format is `envelope.ts`, legacy upgrades `legacy.ts`.
//
// The file path discriminates by magic; the OPFS blob has none and reads
// `manifest.version`. Both call `migrateManifest`, so a v1/v2 bundle upgrades
// identically either way. The OPFS migration is ONE-WAY: a legacy blob is
// never rewritten or deleted, since it may be the user's only copy.

import { readSavedGeneratorGroups, type SavedGeneratorGroups } from '../tables/generator/groups';
import { readSavedBusGroups, type SavedBusGroups } from '../tables/bus/groups';
import { readSavedInterfaceGroups, type SavedInterfaceGroups } from '../tables/interface/groups';
import { deserializeLookup } from '../lookups/envelope';
import { deserializeLimits, readCaseLimits } from '../limits/envelope';
import type { LimitTable } from '../limits/types';
import { readSavedInventory, type SavedInventory } from '../inventory/store';
import type { LookupTable, LookupVariant } from '../lookups/types';
import type { Case, RestoredCase } from '../model/case-model';
import {
  buildManifest,
  casesFromManifest,
  decodeValue,
  type BundleContents,
  type ManifestV3,
} from './envelope';
import { reconstructInventory } from './reconstruct';
import { assertMagicVersion, LEGACY_MAGICS, manifestVersion, migrateManifest } from './legacy';
import type { StorageRequest, StorageResponse } from './worker';
import { pinsFromLegacySelections, type SavedPin } from '../ui/browse-model';
import { saveBlob } from '../ui/download';

/** The v3 magic: the FILE path's version discriminator (OPFS has none). */
const MAGIC = 'GVMB';

/** Magics `readBundleFile` accepts; anything else is refused by name. */
export const READABLE_MAGICS: readonly string[] = [MAGIC, ...LEGACY_MAGICS];

// --------------------------------------------------------------------- OPFS

let worker: Worker | null = null;

function storageWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  }
  return worker;
}

/** Pre-warm at page load, so Load does not pay worker startup. */
export function warmStorage(): void {
  storageWorker();
}

/**
 * `loadBundle` found no saved bundle at all: normal on another machine, and
 * the ONLY load failure that falls through to the file picker. Every other
 * failure is a message the user must see.
 */
class MissingBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingBundleError';
  }
}

export function isMissingBundle(error: unknown): boolean {
  return error instanceof MissingBundleError;
}

function request(message: StorageRequest, transfer: Transferable[] = []): Promise<StorageResponse> {
  const target = storageWorker();
  return new Promise((resolve, reject) => {
    const handler = (event: MessageEvent<StorageResponse>) => {
      target.removeEventListener('message', handler);
      if (event.data.kind === 'error') {
        reject(
          event.data.code === 'missing'
            ? new MissingBundleError(event.data.message)
            : new Error(event.data.message),
        );
      } else resolve(event.data);
    };
    target.addEventListener('message', handler);
    target.postMessage(message, transfer);
  });
}

export async function saveBundle(
  cases: readonly Case[],
  onProgress?: (done: number, total: number) => void,
  contents: BundleContents = {},
): Promise<void> {
  const { manifest, cubes } = buildManifest(cases, contents);

  await request({ kind: 'saveBegin', manifest: JSON.stringify(manifest) });
  // One chunk per TABLE, cloned (transferring would detach the live cube),
  // which bounds the transient copy to one table. The reader slices by the
  // manifest's `cubeBytes`, so chunks need not match cases.
  let written = 0;
  for (let i = 0; i < cases.length; i++) {
    const tableCount = cases[i].tables.size;
    for (let t = 0; t < tableCount; t++) {
      await request({ kind: 'saveChunk', bytes: cubes[written + t] });
    }
    written += tableCount;
    onProgress?.(i + 1, cases.length);
  }
  await request({ kind: 'saveEnd' });
}

// ---------------------------------------------------------------- disk file
//
// "GVMB" | uint32 manifest length | manifest JSON | cube bytes, in manifest
// order. Streamed through a FileSystemWritableFileStream where available, so
// saving never holds a second copy of the study.

/** `showSaveFilePicker` where the browser provides it. */
interface SavePickerWindow {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<FileSystemFileHandle>;
}

/** True when the user cancelled the file dialog rather than hitting an error. */
export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export async function downloadBundle(
  cases: readonly Case[],
  onProgress?: (done: number, total: number) => void,
  contents: BundleContents = {},
): Promise<string> {
  const built = buildManifest(cases, contents);
  const manifest = new TextEncoder().encode(JSON.stringify(built.manifest));
  const header = new Uint8Array(MAGIC.length + 4);
  header.set(new TextEncoder().encode(MAGIC));
  new DataView(header.buffer).setUint32(MAGIC.length, manifest.byteLength, true);

  const suggestedName = `gridview-${cases.length}-case${cases.length === 1 ? '' : 's'}.gvmb`;
  const picker = (window as SavePickerWindow).showSaveFilePicker;

  if (picker) {
    const handle = await picker.call(window, {
      suggestedName,
      types: [
        { description: 'GridView plots bundle', accept: { 'application/octet-stream': ['.gvmb'] } },
      ],
    });
    const stream = await handle.createWritable();
    await stream.write(header);
    await stream.write(manifest);
    let written = 0;
    for (let i = 0; i < cases.length; i++) {
      const tableCount = cases[i].tables.size;
      for (let t = 0; t < tableCount; t++) await stream.write(built.cubes[written + t]);
      written += tableCount;
      onProgress?.(i + 1, cases.length);
    }
    await stream.close();
    return handle.name;
  }

  // Fallback: one Blob and an anchor click; the browser materialises the file.
  const blob = new Blob([header, manifest, ...built.cubes], {
    type: 'application/octet-stream',
  });
  saveBlob(blob, suggestedName);
  onProgress?.(cases.length, cases.length);
  return suggestedName;
}

export async function readBundleFile(file: File): Promise<RestoredBundle> {
  const headerBytes = new Uint8Array(await file.slice(0, MAGIC.length + 4).arrayBuffer());
  const magic = new TextDecoder().decode(headerBytes.subarray(0, MAGIC.length));
  if (!READABLE_MAGICS.includes(magic)) {
    throw new Error(`${file.name} is not a GridView bundle this build can read.`);
  }
  const manifestLength = new DataView(headerBytes.buffer).getUint32(MAGIC.length, true);
  const start = MAGIC.length + 4;
  const rawManifest = JSON.parse(await file.slice(start, start + manifestLength).text()) as unknown;

  // `GVAP` promises v1, `GVIP` v2, `GVMB` whatever the JSON says. The only
  // step the OPFS path lacks; the rest is the shared `migrateManifest`.
  assertMagicVersion(magic, manifestVersion(rawManifest));

  // Sliced from the RAW manifest by `cases[].cubeBytes`, which every version
  // carries, so both readers hand `migrateManifest` the same inputs.
  const rawCases = (rawManifest as { cases?: { cubeBytes: number }[] }).cases;
  if (!Array.isArray(rawCases)) {
    throw new Error(`${file.name}: the bundle's manifest has no list of cases.`);
  }

  let offset = start + manifestLength;
  const cubes: ArrayBuffer[] = [];
  for (const entry of rawCases) {
    cubes.push(await file.slice(offset, offset + entry.cubeBytes).arrayBuffer());
    offset += entry.cubeBytes;
  }

  const migrated = migrateManifest(rawManifest, cubes);
  return restoreBundle(migrated.manifest, migrated.cubes, migrated.warnings);
}

export interface RestoredBundle {
  /** Every restored Case with every table this build can read: the ONLY view
   * of what a bundle carried. A second, per-kind view would let a restore
   * drop tables; do not add one. */
  restoredCases: RestoredCase[];
  /** The mapping the bundle was saved under, or null. */
  groupings: string | null;
  /** The reference lists the bundle carried, keyed by variant. Empty is not
   * an error: older bundles carry none. */
  lookups: Map<LookupVariant, LookupTable>;
  /** Pinned rows by case INDEX, resolved by `restorePins` after the restore.
   * Older id-keyed `selections` are migrated here. */
  pins: readonly SavedPin[];
  layout?: readonly string[];
  /** The drawer's dragged height; undefined when saved on a detent. */
  drawerHeight?: number;
  /** The generator group map, or null. */
  generatorGroups: SavedGeneratorGroups | null;
  busGroups: SavedBusGroups | null;
  interfaceGroups: SavedInterfaceGroups | null;
  /** Interface limits. `byIndex` is by case INDEX (older id-keyed `cases`
   * migrated here); `dropped` counts tables naming a Case the bundle lacks. */
  limits: { shared?: LimitTable; byIndex: Map<number, LimitTable>; dropped: number };
  /** The Contents panel's inventory, Cases by INDEX (resolved by
   * `Inventory.restore` against the Cases the restore made). Rebuilt from the
   * rest of the bundle when it carries none (`reconstructInventory`). */
  inventory: SavedInventory;
  /** Table kinds this build has no reader for, named as dropped. */
  warnings: string[];
}

/**
 * Read this browser's origin-private cache. Rejects with `MissingBundleError`
 * when nothing is saved here. The blob has no magic, so `manifest.version`
 * discriminates, and a legacy blob goes through the same `migrateManifest`.
 */
export async function loadBundle(): Promise<RestoredBundle> {
  const response = await request({ kind: 'load' });
  if (response.kind !== 'loaded') throw new Error('unexpected storage reply');
  const migrated = migrateManifest(JSON.parse(response.manifest) as unknown, response.cubes);
  return restoreBundle(migrated.manifest, migrated.cubes, migrated.warnings);
}

/**
 * The restore both entry points share: a pure function of a v3 manifest and
 * one cube block per case, so a test can drive it on identical bytes.
 * `priorWarnings` (from migration) come first, so an upgraded bundle with an
 * unreadable kind reports both.
 */
export function restoreBundle(
  manifest: ManifestV3,
  cubes: readonly ArrayBuffer[],
  priorWarnings: readonly string[] = [],
): RestoredBundle {
  const { cases, warnings } = casesFromManifest(manifest, cubes);
  const lookups = new Map<LookupVariant, LookupTable>();
  const lookupWarnings: string[] = [];
  for (const [variant, raw] of Object.entries(manifest.lookups ?? {})) {
    try {
      lookups.set(variant as LookupVariant, deserializeLookup(decodeValue(raw)));
    } catch (error) {
      // A malformed list is dropped with its reason, never restored half-read.
      lookupWarnings.push(
        `Dropped the saved "${variant}" reference list: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  // A half-read membership silently shrinks a fleet: drop the field whole.
  let generatorGroups: SavedGeneratorGroups | null = null;
  const generatorGroupsWarnings: string[] = [];
  if (manifest.generatorGroups !== undefined) {
    try {
      generatorGroups = readSavedGeneratorGroups(manifest.generatorGroups);
    } catch (error) {
      generatorGroupsWarnings.push(
        `Dropped the saved generator group membership: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  let busGroups: SavedBusGroups | null = null;
  const busGroupsWarnings: string[] = [];
  if (manifest.busGroups !== undefined) {
    try {
      busGroups = readSavedBusGroups(manifest.busGroups);
    } catch (error) {
      busGroupsWarnings.push(
        `Dropped the saved bus group membership: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  let interfaceGroups: SavedInterfaceGroups | null = null;
  const interfaceGroupsWarnings: string[] = [];
  if (manifest.interfaceGroups !== undefined) {
    try {
      interfaceGroups = readSavedInterfaceGroups(manifest.interfaceGroups);
    } catch (error) {
      interfaceGroupsWarnings.push(
        `Dropped the saved interface group membership: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  // Tolerant on purpose: a bad limits block costs an annotation, while
  // refusing the bundle would cost the study.
  const caseLimits = readCaseLimits(
    manifest.limits,
    manifest.cases.map((entry) => entry.id),
  );
  const shared = deserializeLimits(manifest.limits?.shared);
  const saved =
    manifest.inventory === undefined ? undefined : readSavedInventory(manifest.inventory);
  const inventoryWarnings =
    manifest.inventory !== undefined && saved === undefined
      ? [
          'The saved Contents inventory is not one this build can read; the panel lists what ' +
            'the bundle holds, with filenames not recorded.',
        ]
      : [];
  const inventory =
    saved ?? reconstructInventory(manifest, cases, { lookups, limits: { shared, ...caseLimits } });
  return {
    restoredCases: cases,
    inventory,
    limits: { shared, ...caseLimits },
    groupings: manifest.groupings ?? null,
    lookups,
    pins:
      manifest.pins ??
      pinsFromLegacySelections(
        manifest.selections ?? [],
        manifest.cases.map((entry) => entry.id),
      ),
    layout: manifest.layout,
    drawerHeight: manifest.drawerHeight,
    generatorGroups,
    busGroups,
    interfaceGroups,
    warnings: [
      ...priorWarnings,
      ...warnings,
      ...lookupWarnings,
      ...generatorGroupsWarnings,
      ...busGroupsWarnings,
      ...interfaceGroupsWarnings,
      ...inventoryWarnings,
    ],
  };
}
