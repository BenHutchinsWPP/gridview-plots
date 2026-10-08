// src/storage/worker.ts
//
// OPFS read/write via `createSyncAccessHandle` (worker-only). The bundle is
//
//   [4-byte manifest length][UTF-8 JSON manifest][cube bytes, case by case]
//
// A raw Float32Array dump because decode time decided it. Saving streams in
// slices (`saveBundle`) to avoid one huge structured clone.
//
// A save writes the slot the pointer does NOT name and moves the pointer only
// once every byte landed, so a save that fails leaves the last complete one
// loadable. Rejected: write a temp file and `move()` it over, which not every
// browser's OPFS offers. The cost is quota: a save peaks at the old bundle plus
// the new. The idle slot keeps its bundle until its next save truncates it.
//
// Legacy apps wrote `gridview-bundle.bin`, and every Pages repo under one
// `*.github.io` account shares ONE origin. So this build writes only its two
// slots and reads the legacy name only as a one-way migration source; it never
// writes or deletes it (it may be the user's only copy). The framing has no
// magic: `manifest.version` tells v1/v2 from v3.

/** Slot A. Its name predates the slots, so a bundle saved before them is
 * slot A with no pointer and keeps loading. */
const FILE_NAME = 'gridview-bundle-v3.bin';
const SLOT_B_NAME = 'gridview-bundle-v3-b.bin';
/** One byte, `a` or `b`: the slot holding the last complete save. */
const POINTER_NAME = 'gridview-bundle-v3.current';
type Slot = 'a' | 'b';
const SLOT_NAMES: Record<Slot, string> = { a: FILE_NAME, b: SLOT_B_NAME };
/** Legacy name, read once as a migration source. Never written, never
 * deleted -- there is no `removeEntry` call here. rot-guard:allow -- OPFS's
 * own method, deliberately never called. */
const LEGACY_FILE_NAME = 'gridview-bundle.bin';
const HEADER_BYTES = 4;

export interface SaveBegin {
  kind: 'saveBegin';
  manifest: string;
  /** Every cube byte the save will send, so a short write names the whole. */
  cubeBytes: number;
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
/** The slot `handle` writes; the pointer moves to it at `saveEnd`. */
let writing: Slot = 'a';
let offset = 0;
/** The bundle's size once every chunk lands. */
let expected = 0;

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

type Directory = FileSystemDirectoryHandle;

/** `name`, or null when it is not there. Only "it is not there" is null.
 * Anything else (a locked handle, a quota error) is a real failure and is
 * reported. */
async function existing(root: Directory, name: string): Promise<FileSystemFileHandle | null> {
  try {
    return await root.getFileHandle(name, { create: false });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return null;
    throw error;
  }
}

/** The slot the pointer names, or null with no pointer (nothing saved since
 * the slots, or the pointer unreadable). */
async function pointedSlot(root: Directory): Promise<Slot | null> {
  const file = await existing(root, POINTER_NAME);
  if (!file) return null;
  const reader = await syncHandle(file);
  try {
    const byte = new Uint8Array(1);
    if (reader.read(byte, { at: 0 }) !== 1) return null;
    const slot = String.fromCharCode(byte[0]);
    return slot === 'a' || slot === 'b' ? slot : null;
  } finally {
    reader.close();
  }
}

/** The WRITE handle: the slot the pointer does not name. With no pointer,
 * slot A may hold a bundle saved before the slots, so B is written. Never the
 * legacy blob -- it is a read source only, and writing it would hand an older
 * deploy a v3 manifest it would misparse. */
async function openForWrite(): Promise<SyncHandle> {
  const root = await navigator.storage.getDirectory();
  writing = (await pointedSlot(root)) === 'b' ? 'a' : 'b';
  return syncHandle(await root.getFileHandle(SLOT_NAMES[writing], { create: true }));
}

/** Point Load… at the slot just written. One byte overwritten in place, so
 * the pointer is never absent; a failure leaves it naming the earlier save. */
async function writePointer(slot: Slot): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const pointer = await syncHandle(await root.getFileHandle(POINTER_NAME, { create: true }));
  try {
    if (pointer.write(new Uint8Array([slot.charCodeAt(0)]), { at: 0 }) !== 1) {
      throw new Error('short write');
    }
    pointer.truncate(1);
    pointer.flush();
  } finally {
    pointer.close();
  }
}

/** The pointed slot, else slot A (saved before the slots), else the legacy
 * blob, opened read-only and left as is. A pointed slot that is empty is
 * refused as incomplete, not passed over: the other slot is not known to be
 * any better. */
async function openForRead(): Promise<SyncHandle> {
  const root = await navigator.storage.getDirectory();
  const slot = await pointedSlot(root);
  const names = [...(slot ? [SLOT_NAMES[slot]] : []), FILE_NAME, LEGACY_FILE_NAME];
  for (const name of names) {
    const file = await existing(root, name);
    if (file) return syncHandle(file);
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

function shortWrite(written: number): Error {
  return new Error(
    `Wrote ${written.toLocaleString()} of ${expected.toLocaleString()} bytes; ` +
      "the browser's storage is full or this is a private window. " +
      'Any earlier save is still in this browser',
  );
}

/** Write all of `bytes` at `at`, or throw. A full disk is spec'd to throw
 * `QuotaExceededError`, and a browser may instead return a short count, so
 * both are caught; a short count is retried once for the remainder. */
function writeFully(writer: SyncHandle, bytes: Uint8Array, at: number): void {
  let done = 0;
  try {
    done = writer.write(bytes, { at });
    if (done < bytes.byteLength) {
      done += writer.write(bytes.subarray(done), { at: at + done });
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      throw shortWrite(at + done);
    }
    throw error;
  }
  if (done < bytes.byteLength) throw shortWrite(at + done);
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
      offset = HEADER_BYTES + manifest.byteLength;
      expected = offset + message.cubeBytes;
      writeFully(handle, header, 0);
      writeFully(handle, manifest, HEADER_BYTES);
      post({ kind: 'ok', written: offset });
      return;
    }

    if (message.kind === 'saveChunk') {
      if (!handle) throw new Error('saveChunk before saveBegin');
      writeFully(handle, message.bytes, offset);
      offset += message.bytes.byteLength;
      post({ kind: 'ok', written: offset });
      return;
    }

    if (message.kind === 'saveEnd') {
      if (!handle) throw new Error('saveEnd before saveBegin');
      handle.flush();
      const size = handle.getSize();
      if (size !== offset) throw shortWrite(size);
      handle.close();
      handle = null;
      try {
        await writePointer(writing);
      } catch (error) {
        throw new Error(
          'Saved, but could not mark the save as the current one ' +
            `(${error instanceof Error ? error.message : String(error)}). ` +
            'Any earlier save is still in this browser',
        );
      }
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
    // A save that stopped part-way empties its own slot, never whatever bytes
    // happened to land. The pointer still names the last complete save.
    if (handle) {
      try {
        handle.truncate(0);
        handle.flush();
      } catch {
        // the handle failed outright; nothing more can be written
      }
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
