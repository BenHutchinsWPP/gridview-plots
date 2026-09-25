// src/figure/dpi.ts
//
// Writes a resolution into an encoded PNG or JPEG, so Word inserts a 300 dpi
// figure at its intended 6.5" rather than at the 96 dpi it assumes for an
// image that states none (20" wide). The browser's encoders write no density,
// so the bytes are patched after `toBlob`.
//
// Byte-level and DOM-free, so a test can check every chunk's CRC under Node.
//
// A PNG caption goes in an `iTXt` chunk, not `tEXt`: `tEXt` holds Latin-1
// only, and captions carry `≥` and `−`.

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const METRES_PER_INCH = 0.0254;
/** The PNG keyword a caption is stored under, which image viewers show. */
const CAPTION_KEYWORD = 'Description';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The PNG chunk CRC (ISO 3309) over `bytes`. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function readU32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

function ascii(text: string): number[] {
  return [...text].map((ch) => ch.charCodeAt(0));
}

function pngChunk(type: string, data: readonly number[] | Uint8Array): Uint8Array {
  const body = Uint8Array.from([...ascii(type), ...data]);
  return Uint8Array.from([...u32(data.length), ...body, ...u32(crc32(body))]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Whether an `iTXt` chunk's data starts with the caption keyword. */
function isCaption(data: Uint8Array): boolean {
  const key = ascii(CAPTION_KEYWORD);
  return key.every((ch, i) => data[i] === ch) && data[key.length] === 0;
}

/**
 * The PNG with a `pHYs` chunk stating `dpi` right after `IHDR`, and, when a
 * caption is given, an `iTXt` Description after it. An existing `pHYs` or
 * Description is replaced, never duplicated, so restamping is safe.
 */
export function stampPng(bytes: Uint8Array, dpi: number, caption?: string): Uint8Array {
  if (!PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) throw new Error('not a PNG');
  const kept: Uint8Array[] = [bytes.subarray(0, PNG_SIGNATURE.length)];
  let at = PNG_SIGNATURE.length;
  let stamped = false;
  while (at + 8 <= bytes.length) {
    const length = readU32(bytes, at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const end = at + 12 + length;
    const data = bytes.subarray(at + 8, at + 8 + length);
    const drop = type === 'pHYs' || (type === 'iTXt' && caption !== undefined && isCaption(data));
    if (!drop) kept.push(bytes.subarray(at, end));
    if (type === 'IHDR') {
      const perMetre = Math.round(dpi / METRES_PER_INCH);
      kept.push(pngChunk('pHYs', [...u32(perMetre), ...u32(perMetre), 1]));
      if (caption !== undefined) {
        const text = new TextEncoder().encode(caption);
        // keyword NUL, uncompressed (0, 0), empty language NUL, empty
        // translated keyword NUL, then UTF-8 text.
        kept.push(pngChunk('iTXt', [...ascii(CAPTION_KEYWORD), 0, 0, 0, 0, 0, ...text]));
      }
      stamped = true;
    }
    at = end;
  }
  if (!stamped) throw new Error('a PNG without IHDR');
  return concat(kept);
}

/**
 * The JPEG with its JFIF density set to `dpi` (units = dots per inch). An
 * encoder that wrote no JFIF `APP0` gets one inserted after SOI.
 */
export function stampJpeg(bytes: Uint8Array, dpi: number): Uint8Array {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('not a JPEG');
  const out = Uint8Array.from(bytes);
  let at = 2;
  // Walk the marker segments up to the scan: JFIF sits among them.
  while (at + 4 <= out.length && out[at] === 0xff) {
    const marker = out[at + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const length = (out[at + 2] << 8) | out[at + 3];
    const isJfif =
      marker === 0xe0 && length >= 16 && ascii('JFIF\0').every((ch, i) => out[at + 4 + i] === ch);
    if (isJfif) {
      // After the id (5) and version (2): units, x density, y density.
      const units = at + 4 + 7;
      out[units] = 1;
      out[units + 1] = out[units + 3] = (dpi >> 8) & 0xff;
      out[units + 2] = out[units + 4] = dpi & 0xff;
      return out;
    }
    at += 2 + length;
  }
  const app0 = Uint8Array.from([
    0xff,
    0xe0,
    0,
    16,
    ...ascii('JFIF\0'),
    1,
    1,
    1,
    (dpi >> 8) & 0xff,
    dpi & 0xff,
    (dpi >> 8) & 0xff,
    dpi & 0xff,
    0,
    0,
  ]);
  return concat([bytes.subarray(0, 2), app0, bytes.subarray(2)]);
}
