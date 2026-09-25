// scripts/file-blob.mjs
//
// A file-backed stand-in for the browser's `File`, so the real ingest path can
// read a half-gigabyte export in Node without loading it. Support code only;
// nothing ships it. It implements exactly what ingest uses (`name`, `size`,
// `slice().arrayBuffer()`), so a new dependency on anything else fails loudly
// instead of the benchmark quietly measuring a reimplementation.

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { basename } from 'node:path';

/** One lazy slice; `arrayBuffer()` reads, as in the browser. */
class FileSlice {
  constructor(fd, name, start, end) {
    this.fd = fd;
    this.name = name;
    this.start = start;
    this.end = end;
    this.size = end - start;
  }

  async arrayBuffer() {
    // allocUnsafeSlow: a pooled buffer's `.buffer` would expose the whole pool.
    const buffer = Buffer.allocUnsafeSlow(this.size);
    let filled = 0;
    while (filled < this.size) {
      const got = readSync(this.fd, buffer, filled, this.size - filled, this.start + filled);
      // A short read is refused: a partial buffer would look like a shorter
      // file.
      if (got === 0) {
        throw new Error(
          `${this.name}: read ${filled} of ${this.size} B at offset ${this.start} before EOF.`,
        );
      }
      filled += got;
    }
    return buffer.buffer;
  }
}

/** Open `path` as a File-like; one descriptor for its life. Call `.close()`. */
export function fileBlob(path) {
  const fd = openSync(path, 'r');
  const size = statSync(path).size;
  const name = basename(path);

  return {
    name,
    size,
    slice(start = 0, end = size) {
      // Blob.slice clamps rather than throwing, and the ingest path relies on
      // that: the last block of every file asks for `start + blockBytes`,
      // which is past EOF by design.
      const from = Math.max(0, Math.min(size, start));
      const to = Math.max(from, Math.min(size, end));
      return new FileSlice(fd, name, from, to);
    },
    close() {
      closeSync(fd);
    },
  };
}
