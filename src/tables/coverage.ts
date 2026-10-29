// src/tables/coverage.ts
// Preserve offered cells separately from NaN: an explicit blank keeps priority,
// while a cell no file offered can be supplied by a later drop.

export function hasCell(bits: Uint8Array, cell: number): boolean {
  return (bits[Math.floor(cell / 8)] & (1 << (cell % 8))) !== 0;
}

export function coverCell(bits: Uint8Array, cell: number): void {
  bits[Math.floor(cell / 8)] |= 1 << (cell % 8);
}

export function savedCellCoverage(raw: unknown, cells: number): Uint8Array | undefined {
  if (raw === undefined) return undefined;
  if (!(raw instanceof Uint8Array) || raw.length !== Math.ceil(cells / 8)) {
    throw new Error(`saved cell coverage must be ${Math.ceil(cells / 8)} bytes (one bit per cell)`);
  }
  return raw;
}
