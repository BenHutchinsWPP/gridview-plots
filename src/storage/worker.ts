// src/storage/worker.ts
//
// OPFS read/write via `createSyncAccessHandle` (worker-only). The bundle is
//
//   [4-byte manifest length][UTF-8 JSON manifest][cube bytes, case by case]
//
// A raw Float32Array dump because decode time decided it. Saving streams case
// by case to avoid one huge structured clone.
//
// Legacy apps wrote `gridview-bundle.bin`, and every Pages repo under one
// `*.github.io` account shares ONE origin. So this build writes only
// `gridview-bundle-v3.bin` and reads the legacy name only as a one-way
// migration source; it never writes or deletes it (it may be the user's only
// copy). The framing has no magic: `manifest.version` tells v1/v2 from v3.

/** The only name this build ever WRITES. */
const FILE_NAME = 'gridview-bundle-v3.bin';
/** Legacy name, read once as a migration source. Never written, never
 * deleted -- there is no `removeEntry` call here. rot-guard:allow -- OPFS's
 * own method, deliberately never called. */
const LEGACY_FILE_NAME = 'gridview-bundle.bin';
const HEADER_BYTES = 4;

export interface SaveBegin {
  kind: 'saveBegin';
  manifest: string;
}
export interface SaveChunk {
  kind: 'saveChunk';
  bytes: Uint8Array;
}
export interface SaveEnd {
  kind: 'saveEnd';
}
export interface LoadAll {
  kind: 'load';
}
export type StorageRequest = SaveBegin | SaveChunk | SaveEnd | LoadAll;

export interface StorageOk {
  kind: 'ok';
  /** For the progress readout. */
  written?: number;
}
export interface StorageLoaded {
  kind: 'loaded';
  manifest: string;
  cubes: ArrayBuffer[];
}
export interface StorageError {
  kind: 'error';
  message: string;
  /** Nothing saved in this browser yet. Not a refusal: a stale bundle is
   * shown to the user, a missing one falls through to the file picker. */
  code?: 'missing';
}
export type StorageResponse = StorageOk | StorageLoaded | StorageError;

type SyncHandle = {
  write(buffer: ArrayBufferView | ArrayBuffer, options?: { at?: number }): number;
  read(buffer: ArrayBufferView | ArrayBuffer, options?: { at?: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
};

let handle: SyncHandle | null = null;
let offset = 0;

/** Nothing is saved in this browser yet. Distinct from every other failure:
 * it is the normal state on any machine the study was not built on. */
class MissingBundle extends Error {}

async function syncHandle(file: FileSystemFileHandle): Promise<SyncHandle> {
  // Typed loosely: createSyncAccessHandle is worker-only and not in every
  // lib.dom.d.ts yet.
  return (await (
    file as unknown as {
      createSyncAccessHandle(): Promise<SyncHandle>;
    }
  ).createSyncAccessHandle()) as SyncHandle;
}

/** The WRITE handle. Always the current name -- the legacy blob is a read
 * source only, and writing it would hand an older deploy a v3 manifest it
 * would misparse. */
async function openForWrite(): Promise<SyncHandle> {
  const root = await navigator.storage.getDirectory();
  return syncHandle(await root.getFileHandle(FILE_NAME, { create: true }));
}

/** The current name, else the legacy one, opened read-only and left as is. */
async function openForRead(): Promise<SyncHandle> {
  const root = await navigator.storage.getDirectory();
  for (const name of [FILE_NAME, LEGACY_FILE_NAME]) {
    let file: FileSystemFileHandle;
    try {
      file = await root.getFileHandle(name, { create: false });
    } catch (error) {
      // Only "it is not there" falls through to the next name. Anything else
      // (a locked handle, a quota error) is a real failure and is reported.
      if (error instanceof DOMException && error.name === 'NotFoundError') continue;
      throw error;
    }
    return syncHandle(file);
  }
  throw new MissingBundle('Nothing is saved in this browser yet.');
}

/** A read that stops short is a save that stopped short: refuse it, or its
 * unread cube bytes load as zeros that look like data. */
function readFully(reader: SyncHandle, bytes: Uint8Array, at: number): void {
  if (reader.read(bytes, { at }) !== bytes.byteLength) {
    throw new Error(
      'The bundle saved in this browser is incomplete: its last save did not finish. ' +
        'Load a .gvmb file instead.',
    );
  }
}

function post(message: StorageResponse, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(message, transfer);
}

self.onmessage = async (event: MessageEvent<StorageRequest>) => {
  const message = event.data;
  try {
    if (message.kind === 'saveBegin') {
      handle = await openForWrite();
      handle.truncate(0);
      const manifest = new TextEncoder().encode(message.manifest);
      const header = new Uint8Array(HEADER_BYTES);
      new DataView(header.buffer).setUint32(0, manifest.byteLength, true);
      handle.write(header, { at: 0 });
      handle.write(manifest, { at: HEADER_BYTES });
      offset = HEADER_BYTES + manifest.byteLength;
      post({ kind: 'ok', written: offset });
      return;
    }

    if (message.kind === 'saveChunk') {
      if (!handle) throw new Error('saveChunk before saveBegin');
      handle.write(message.bytes, { at: offset });
      offset += message.bytes.byteLength;
      post({ kind: 'ok', written: offset });
      return;
    }

    if (message.kind === 'saveEnd') {
      if (!handle) throw new Error('saveEnd before saveBegin');
      handle.flush();
      handle.close();
      handle = null;
      post({ kind: 'ok', written: offset });
      return;
    }

    // load
    const reader = await openForRead();
    try {
      const header = new Uint8Array(HEADER_BYTES);
      readFully(reader, header, 0);
      const manifestLength = new DataView(header.buffer).getUint32(0, true);
      const manifestBytes = new Uint8Array(manifestLength);
      readFully(reader, manifestBytes, HEADER_BYTES);
      const manifest = new TextDecoder().decode(manifestBytes);

      const parsed = JSON.parse(manifest) as { cases: { cubeBytes: number }[] };
      let at = HEADER_BYTES + manifestLength;
      const cubes: ArrayBuffer[] = [];
      for (const entry of parsed.cases) {
        const bytes = new Uint8Array(entry.cubeBytes);
        readFully(reader, bytes, at);
        at += entry.cubeBytes;
        cubes.push(bytes.buffer);
      }
      post({ kind: 'loaded', manifest, cubes }, cubes);
    } finally {
      reader.close();
    }
  } catch (error) {
    if (handle) {
      try {
        handle.close();
      } catch {
        // already closed
      }
      handle = null;
    }
    post({
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof MissingBundle ? { code: 'missing' as const } : {}),
    });
  }
};
