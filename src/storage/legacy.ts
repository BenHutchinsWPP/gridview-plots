// src/storage/legacy.ts
//
// Reading the two legacy bundle formats, v1 (`GVAP`, Area-only) and v2
// (`GVIP`, Interface-only), upgraded to v3 in memory. One-way: the original
// is never rewritten (it may be the user's only copy). Kept out of
// `store.ts` so the live save path carries nothing about formats nothing
// writes.
//
// **Footgun.** The reader's accepted magics and `VERSION_FOR_MAGIC` are one
// seam: out of step, a legacy bundle is refused, or worse, read at the wrong
// version with plausible numbers. So `LEGACY_MAGICS` is derived from the map
// and `store.ts` builds `READABLE_MAGICS` from it.

import { slotKey, type TableSlotKey } from '../model/case-model';
import {
  BUNDLE_VERSION,
  BYTES_TAG,
  type ManifestCaseV3,
  type ManifestTableV3,
  type ManifestV3,
} from './envelope';

/** Legacy Area-only magic (v1). */
const LEGACY_AREA_MAGIC = 'GVAP';
/** Legacy Interface-only magic (v2). */
const LEGACY_INTERFACE_MAGIC = 'GVIP';

// ------------------------------------------------------- legacy migration
//
// v1 and v2 each held one table per case, with no `tables` map or slot keys.
// The shapes below match the legacy apps' manifests exactly. `presence`/`tou`
// arrive already base64, so they are wrapped in `{ [BYTES_TAG]: ... }` and
// never re-encoded: relabelled, not touched.

interface LegacyAreaManifestCase {
  name: string;
  year: number;
  metrics: string[];
  sourceColumns: string[];
  /** May be empty (older v1); `deserializeAreaTable` substitutes `allAreas()`. */
  areas: string[];
  presence: string;
  tou: string;
  cubeBytes: number;
}

interface LegacyAreaManifest {
  version: number;
  cases: LegacyAreaManifestCase[];
  /** Carried into v3's top-level `groupings`, never dropped. */
  groupings?: string;
}

interface LegacyInterfaceManifestCase {
  name: string;
  year: number;
  interfaces: string[];
  sourceColumns: string[];
  quantity: string;
  unit: string;
  presence: string;
  tou: string;
  cubeBytes: number;
}

interface LegacyInterfaceManifest {
  version: number;
  cases: LegacyInterfaceManifestCase[];
}

/** The version each magic promises (`GVAP` 1, `GVIP` 2; `GVMB` states its own
 * in the JSON). The only thing the file path knows that OPFS does not. */
const VERSION_FOR_MAGIC: Readonly<Record<string, number>> = {
  [LEGACY_AREA_MAGIC]: 1,
  [LEGACY_INTERFACE_MAGIC]: 2,
};

/** Legacy magics `readBundleFile` accepts, derived from the map above (see
 * the header). */
export const LEGACY_MAGICS: readonly string[] = Object.keys(VERSION_FOR_MAGIC);

/** Refuse a legacy file whose `version` disagrees with its magic (a higher one
 * gets the "upgrade the app" wording). `GVMB` always passes. */
export function assertMagicVersion(magic: string, version: number): void {
  const expected = VERSION_FOR_MAGIC[magic];
  if (expected === undefined || version === expected) return;
  const upgrade = version > expected ? ' Upgrade the app to open it.' : '';
  throw new Error(
    `Saved bundle claims magic "${magic}" with version ${version}; this build reads ` +
      `${magic} as version ${expected}.${upgrade}`,
  );
}

function migrateAreaManifest(raw: LegacyAreaManifest): ManifestV3 {
  const cases: ManifestCaseV3[] = raw.cases.map((entry, index) => {
    const key: TableSlotKey = { kind: 'area' };
    const table: ManifestTableV3 = {
      kind: 'area',
      cubeBytes: entry.cubeBytes,
      year: entry.year,
      metrics: entry.metrics,
      sourceColumns: entry.sourceColumns,
      areas: entry.areas,
      presence: { [BYTES_TAG]: entry.presence },
      tou: { [BYTES_TAG]: entry.tou },
    };
    return {
      id: `legacy-area-${index}`,
      name: entry.name,
      cubeBytes: entry.cubeBytes,
      tables: { [slotKey(key)]: table },
    };
  });

  const manifest: ManifestV3 = { version: BUNDLE_VERSION, cases };
  // Only GVAP carries groupings, and only when non-empty.
  if (raw.groupings !== undefined) manifest.groupings = raw.groupings;
  return manifest;
}

function migrateInterfaceManifest(raw: LegacyInterfaceManifest): ManifestV3 {
  const cases: ManifestCaseV3[] = raw.cases.map((entry, index) => {
    // An unreadable title saved an empty quantity: no variant is invented.
    const variant = entry.quantity ? entry.quantity : undefined;
    const key: TableSlotKey =
      variant === undefined ? { kind: 'interface' } : { kind: 'interface', variant };
    const table: ManifestTableV3 = {
      kind: 'interface',
      ...(variant === undefined ? {} : { variant }),
      cubeBytes: entry.cubeBytes,
      year: entry.year,
      interfaces: entry.interfaces,
      sourceColumns: entry.sourceColumns,
      quantity: entry.quantity,
      unit: entry.unit,
      presence: { [BYTES_TAG]: entry.presence },
      tou: { [BYTES_TAG]: entry.tou },
    };
    return {
      id: `legacy-interface-${index}`,
      name: entry.name,
      cubeBytes: entry.cubeBytes,
      tables: { [slotKey(key)]: table },
    };
  });

  return { version: BUNDLE_VERSION, cases };
}

/** The manifest's declared version, refused (never defaulted) when missing or
 * not an integer. */
export function manifestVersion(raw: unknown): number {
  const version = (raw as { version?: unknown } | null)?.version;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new Error(
      'Saved bundle has no version number in its manifest — it is not a GridView bundle ' +
        'this build can read.',
    );
  }
  return version;
}

/** Said once when a legacy bundle is upgraded on read: the original is left
 * as it was, and only a fresh Save writes the current format. */
function migratedNote(version: number, what: string): string {
  return (
    `Migrated a version-${version} (${what}) bundle to version ${BUNDLE_VERSION} as it loaded. ` +
    `The original was left untouched — save again to keep this study in the current format.`
  );
}

/**
 * Migrate-or-refuse on `manifest.version`: the ONE function both entry points
 * use. `readBundleFile` maps its magic to a version first; `loadBundle` (OPFS,
 * no magic) reads the version directly. Pure: cubes pass through untouched,
 * since a v1/v2 case holds one table whose cube is the whole case block.
 */
export function migrateManifest(
  raw: unknown,
  cubes: readonly ArrayBuffer[],
): { manifest: ManifestV3; cubes: readonly ArrayBuffer[]; warnings: string[] } {
  const version = manifestVersion(raw);

  if (version === BUNDLE_VERSION) return { manifest: raw as ManifestV3, cubes, warnings: [] };
  if (version > BUNDLE_VERSION) {
    throw new Error(
      `Saved bundle is version ${version}; this build reads version ${BUNDLE_VERSION}. ` +
        `Upgrade the app to open it.`,
    );
  }
  if (version === 1) {
    return {
      manifest: migrateAreaManifest(raw as LegacyAreaManifest),
      cubes,
      warnings: [migratedNote(1, 'Area-only')],
    };
  }
  if (version === 2) {
    return {
      manifest: migrateInterfaceManifest(raw as LegacyInterfaceManifest),
      cubes,
      warnings: [migratedNote(2, 'Interface-only')],
    };
  }
  throw new Error(
    `Saved bundle is version ${version}; this build reads versions 1, 2 and ${BUNDLE_VERSION}.`,
  );
}
