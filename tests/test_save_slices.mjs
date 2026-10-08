// tests/test_save_slices.mjs — both bundle writers under memory and disk
// pressure: the real `saveBundle`/`loadBundle` talking to the real storage
// worker through a fake `Worker` pair, over a fake OPFS sync access handle.
//
//   * OPFS gets slices of at most `SLICE_BYTES`, each a fresh copy that is
//     transferred (detached on send), never the live cube's buffer, and the
//     bytes load back identical, from a cube view that starts mid-buffer.
//   * A short write is retried once; a second short write, a thrown
//     `QuotaExceededError` and a size mismatch at `saveEnd` each reject the
//     save, empty its slot, and leave Load… returning the last complete save.
//   * Two good saves load the second; a bundle saved before the slots (slot A,
//     no pointer) loads; a pointed slot that is empty is refused as incomplete.
//   * The file picker path writes views of at most `SLICE_BYTES` and aborts
//     its stream when a write throws.
//
// Run: node tests/test_save_slices.mjs

import assert from 'node:assert/strict';
import './test_loader.mjs';

// --------------------------------------------------------------- the fakes

const SLOT_A = 'gridview-bundle-v3.bin';
const SLOT_B = 'gridview-bundle-v3-b.bin';
const POINTER = 'gridview-bundle-v3.current';

/** The OPFS directory: files by name. */
const files = new Map();
/** Every write to every file goes through `disk.write`, the policy a check
 * swaps; `store` lands the bytes. */
const disk = {
  store(file, bytes, at) {
    if (file.buffer.byteLength < at + bytes.byteLength) file.buffer.resize(at + bytes.byteLength);
    new Uint8Array(file.buffer).set(bytes, at);
    return bytes.byteLength;
  },
  write(file, bytes, at) {
    return disk.store(file, bytes, at);
  },
};
const plainWrites = () => {
  disk.write = (file, bytes, at) => disk.store(file, bytes, at);
};

function newFile() {
  return { buffer: new ArrayBuffer(0, { maxByteLength: 512 * 2 ** 20 }), open: false };
}

function syncHandle(file) {
  file.open = true;
  const view = (bytes) => new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    write: (bytes, { at = 0 } = {}) => disk.write(file, view(bytes), at),
    read: (bytes, { at = 0 } = {}) => {
      const have = new Uint8Array(file.buffer).subarray(at, at + bytes.byteLength);
      view(bytes).set(have);
      return have.byteLength;
    },
    truncate: (size) => file.buffer.resize(size),
    getSize: () => file.buffer.byteLength,
    flush: () => {},
    close: () => {
      file.open = false;
    },
  };
}

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    storage: {
      getDirectory: async () => ({
        getFileHandle: async (name, { create }) => {
          if (!files.has(name)) {
            if (!create) throw new DOMException('not there', 'NotFoundError');
            files.set(name, newFile());
          }
          return { createSyncAccessHandle: async () => syncHandle(files.get(name)) };
        },
      }),
    },
  },
});

const pointer = () =>
  files.has(POINTER) ? Buffer.from(files.get(POINTER).buffer).toString() : null;
const slotName = (slot) => (slot === 'a' ? SLOT_A : SLOT_B);

/** Every message the page posted, with its transfer list and whether each
 * transferred buffer was detached by the send. */
const posted = [];
let page = null;

/** The worker's global scope: its replies reach the page's listeners. */
globalThis.self = {
  onmessage: null,
  postMessage(message, transfer = []) {
    const data = structuredClone(message, { transfer });
    setTimeout(() => page.listeners.forEach((listener) => listener({ data })));
  },
};

globalThis.Worker = class {
  constructor() {
    this.listeners = new Set();
    page = this;
  }
  addEventListener(_, listener) {
    this.listeners.add(listener);
  }
  removeEventListener(_, listener) {
    this.listeners.delete(listener);
  }
  postMessage(message, transfer = []) {
    const data = structuredClone(message, { transfer });
    posted.push({ message, transfer, detached: transfer.map((buffer) => buffer.detached) });
    setTimeout(() => self.onmessage({ data }));
  }
};

await import('../src/storage/worker.ts');
const { saveBundle, loadBundle, downloadBundle, isMissingBundle, SLICE_BYTES } =
  await import('../src/storage/store.ts');
const { slotKey } = await import('../src/model/case-model.ts');

let passed = 0;
async function check(label, fn) {
  await fn();
  passed++;
  console.log(`ok - ${label}`);
}

const HOURS = 8784;
const FLOW = { kind: 'interface', variant: 'Power Flow (MW)' };

/** A Case holding one Interface table of `count` interfaces over one year.
 * Its cube is a view starting `lead` floats into a larger buffer, as a cube
 * sliced out of a parse arena is. */
function flowCase(count, lead = 0, name = 'SAMPLE_case') {
  const length = count * HOURS;
  const arena = new Float32Array(lead + length);
  const cube = arena.subarray(lead);
  for (let i = 0; i < length; i++) cube[i] = (i % 65521) * 0.25 - i / length;
  const data = {
    cube,
    interfaces: Array.from({ length: count }, (_, i) => `SAMPLE_P${i}`),
    presence: new Uint8Array(count).fill(1),
    tou: new Uint8Array(HOURS),
    hoursPresent: new Uint8Array(HOURS).fill(1),
    sourceColumns: [],
    firstYear: 2032,
    numYears: 1,
    quantity: 'Power Flow (MW)',
    unit: 'MW',
  };
  return {
    id: 'case-1',
    name,
    tables: new Map([[slotKey(FLOW), { key: FLOW, data }]]),
  };
}

const bytesOf = (view) => Buffer.from(view.buffer, view.byteOffset, view.byteLength);
const FULL_MESSAGE =
  /^Wrote [\d,]+ of [\d,]+ bytes; the browser's storage is full or this is a private window\. Any earlier save is still in this browser$/;

const loadedNames = async () => (await loadBundle()).restoredCases.map((study) => study.name);

/** A save that must fail after a good one: its message, then its own slot
 * emptied and closed, the pointer unmoved, and Load… returning the good save
 * rather than refusing it as incomplete. Arms `policy` only after the good
 * save, so its call count starts at the failing save. */
async function assertRefusedSave(pattern, policy) {
  plainWrites();
  await saveBundle([flowCase(2, 0, 'SAMPLE_good')]);
  const before = pointer();
  policy();
  await assert.rejects(saveBundle([flowCase(4, 0, 'SAMPLE_failed')]), (error) => {
    assert.match(error.message, pattern);
    return true;
  });
  plainWrites();
  const failed = files.get(slotName(before === 'a' ? 'b' : 'a'));
  assert.equal(failed.buffer.byteLength, 0, 'its slot is emptied, never left a prefix');
  assert.equal(failed.open, false, 'and the handle closed');
  assert.equal(pointer(), before, 'the pointer still names the good save');
  assert.deepEqual(await loadedNames(), ['SAMPLE_good'], 'Load… returns the good save');
}

// ------------------------------------------------------------------ OPFS

await check('a 200 MB table is sent as transferred copies of at most 64 MB', async () => {
  // Three floats in, so the cube's bytes start at byteOffset 12.
  const study = flowCase(Math.ceil((200 * 2 ** 20) / (HOURS * 4)), 3);
  const cube = study.tables.get(slotKey(FLOW)).data.cube;
  assert.equal(cube.byteOffset, 12);
  const before = Buffer.from(bytesOf(cube));
  const progress = [];
  posted.length = 0;
  await saveBundle([study], (written, total) => progress.push([written, total]));

  const chunks = posted.filter((entry) => entry.message.kind === 'saveChunk');
  assert.ok(chunks.length >= 4, `${chunks.length} slices`);
  for (const { message, transfer, detached } of chunks) {
    assert.ok(message.bytes.byteLength <= SLICE_BYTES);
    assert.deepEqual(transfer, [message.bytes.buffer], 'each slice is transferred');
    assert.deepEqual(detached, [true], 'and detached by the send');
    assert.notEqual(transfer[0], cube.buffer, 'never the live cube');
  }
  assert.equal(cube.byteLength, before.byteLength, 'the live cube is left attached');
  assert.ok(bytesOf(cube).equals(before), 'and unchanged');
  assert.equal(progress.length, chunks.length, 'progress moves with every slice');
  assert.equal(progress.at(-1)[0], progress.at(-1)[1], 'and ends at the whole');

  const loaded = await loadBundle();
  const back = [...loaded.restoredCases[0].tables.values()][0].data.cube;
  assert.ok(bytesOf(back).equals(before), 'the bytes load back identical');
});

await check('a short write is retried once for the remainder', async () => {
  let calls = 0;
  disk.write = (file, bytes, at) => {
    calls++;
    return calls === 2 ? disk.store(file, bytes.subarray(0, 100), at) : disk.store(file, bytes, at);
  };
  const study = flowCase(4);
  await saveBundle([study]);
  plainWrites();
  const loaded = await loadBundle();
  const back = [...loaded.restoredCases[0].tables.values()][0].data.cube;
  assert.ok(bytesOf(back).equals(bytesOf(study.tables.get(slotKey(FLOW)).data.cube)));
});

await check('a second short write fails the save and empties only its slot', async () => {
  await assertRefusedSave(FULL_MESSAGE, () => {
    let calls = 0;
    disk.write = (file, bytes, at) => {
      calls++;
      return calls >= 3 ? disk.store(file, bytes.subarray(0, 8), at) : disk.store(file, bytes, at);
    };
  });
});

await check('a thrown QuotaExceededError takes the same path', async () => {
  await assertRefusedSave(FULL_MESSAGE, () => {
    let calls = 0;
    disk.write = (file, bytes, at) => {
      calls++;
      if (calls >= 3) throw new DOMException('full', 'QuotaExceededError');
      return disk.store(file, bytes, at);
    };
  });
});

await check('a file that ends short of what was written fails at saveEnd', async () => {
  // Every write reports success and one quietly loses its last bytes.
  await assertRefusedSave(FULL_MESSAGE, () => {
    let calls = 0;
    disk.write = (file, bytes, at) => {
      calls++;
      if (calls === 3) disk.store(file, bytes.subarray(0, bytes.byteLength - 4), at);
      else disk.store(file, bytes, at);
      return bytes.byteLength;
    };
  });
});

await check(
  'a pointer that cannot be written fails the save and keeps the earlier one',
  async () => {
    plainWrites();
    await saveBundle([flowCase(2, 0, 'SAMPLE_good')]);
    const before = pointer();
    disk.write = (file, bytes, at) => {
      if (file === files.get(POINTER)) throw new DOMException('full', 'QuotaExceededError');
      return disk.store(file, bytes, at);
    };
    await assert.rejects(saveBundle([flowCase(4, 0, 'SAMPLE_unpointed')]), (error) => {
      assert.match(error.message, /^Saved, but could not mark the save as the current one \(/);
      assert.match(error.message, /Any earlier save is still in this browser$/);
      return true;
    });
    plainWrites();
    assert.equal(pointer(), before);
    assert.equal(files.get(POINTER).open, false, 'the pointer handle is closed');
    assert.deepEqual(await loadedNames(), ['SAMPLE_good']);
  },
);

await check('two good saves load the second, alternating slots', async () => {
  plainWrites();
  await saveBundle([flowCase(2, 0, 'SAMPLE_first')]);
  const first = pointer();
  await saveBundle([flowCase(2, 0, 'SAMPLE_second')]);
  assert.notEqual(pointer(), first, 'the second save wrote the other slot');
  assert.deepEqual(await loadedNames(), ['SAMPLE_second']);
  assert.ok(files.get(slotName(first)).buffer.byteLength > 0, 'the idle slot is never deleted');
});

await check('a bundle saved before the slots, with no pointer, loads and is kept', async () => {
  plainWrites();
  await saveBundle([flowCase(2, 0, 'SAMPLE_old')]);
  const bytes = Buffer.from(files.get(slotName(pointer())).buffer);
  files.clear();
  files.set(SLOT_A, newFile());
  disk.store(files.get(SLOT_A), bytes, 0);
  assert.deepEqual(await loadedNames(), ['SAMPLE_old']);
  await saveBundle([flowCase(2, 0, 'SAMPLE_new')]);
  assert.equal(pointer(), 'b', 'the first save with slots leaves slot A alone');
  assert.ok(Buffer.from(files.get(SLOT_A).buffer).equals(bytes));
  assert.deepEqual(await loadedNames(), ['SAMPLE_new']);
});

await check('a pointed slot that is empty is refused as incomplete', async () => {
  files.get(slotName(pointer())).buffer.resize(0);
  await assert.rejects(loadBundle(), (error) => {
    assert.ok(!isMissingBundle(error), 'Load… refuses it rather than offering a file');
    assert.match(error.message, /incomplete: its last save did not finish/);
    return true;
  });
});

// ---------------------------------------------------------------- picker

/** A save-file picker whose stream records each write; `failAt` throws on
 * that write. */
function picker(failAt) {
  const stream = { writes: [], aborted: false, closed: false };
  globalThis.window = {
    showSaveFilePicker: async () => ({
      name: 'SAMPLE.gvmb',
      createWritable: async () => ({
        write: async (bytes) => {
          if (stream.writes.length === failAt) throw new DOMException('full', 'QuotaExceededError');
          stream.writes.push(Buffer.from(bytesOf(bytes)));
        },
        close: async () => {
          stream.closed = true;
        },
        abort: async () => {
          stream.aborted = true;
        },
      }),
    }),
  };
  return stream;
}

await check('the picker writes views of at most 64 MB, in order', async () => {
  const stream = picker();
  const study = flowCase(Math.ceil((150 * 2 ** 20) / (HOURS * 4)), 1);
  const cube = study.tables.get(slotKey(FLOW)).data.cube;
  assert.equal(await downloadBundle([study]), 'SAMPLE.gvmb');
  assert.ok(stream.closed);
  const body = stream.writes.slice(2);
  assert.ok(body.length >= 3, `${body.length} pieces`);
  for (const piece of body) assert.ok(piece.byteLength <= SLICE_BYTES);
  assert.ok(Buffer.concat(body).equals(bytesOf(cube)), 'the pieces are the cube');
});

await check('a throw mid-write aborts the stream and rejects', async () => {
  const stream = picker(2);
  await assert.rejects(downloadBundle([flowCase(4)]), { name: 'QuotaExceededError' });
  assert.ok(stream.aborted, 'the partial file is aborted');
  assert.ok(!stream.closed);
});

console.log(`\n${passed} save-slice checks passed.`);
