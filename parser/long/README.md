# WASM CSV parser — long shape (L)

`block.c` reads LONG-shape rows (entity per row, many metrics, no preamble)
for area, bus and generator exports alike. Nothing in it is kind-specific; see
AGENTS.md, "Kind is not shape". Every shape parameter arrives from JS through
`configure()`, and nothing about a particular export is compiled in.

## Build

```bash
sudo apt-get install -y lld-18     # supplies wasm-ld
./build.sh
```

Commit `block.wasm` with any change to `block.c` or `../common/fields.h`,
and bump `ABI_VERSION` with `PARSER_ABI` in `src/tables/long/block.ts` when
the exports or arena layout change.

## Decisions

- **No JS fallback parser.** A fixed-shape wasm with a JS fallback for every
  other shape measured about 5x slower on the fallback path.
- **The axis is read from every row's Name.** `scan_axis` skips metric fields
  whole, so it costs about 5% of ingest. Inferring the axis from the first
  rows assumes the first hour lists every area once. On a shuffled export
  that returns a partial axis and says nothing.
- **Row order carries no meaning.** `parse_block` emits a row list with each
  row's own `(area, hour)`, and the main thread scatters it into the cube.
  That costs about 10% of ingest compared with copying contiguous hour runs,
  and it buys correct loads of sorted or shuffled exports. Do not add an
  ordering counter: a live one invites refusing files this parser reads
  correctly.
- **Duplicates are refused.** `blitBlock` keeps one bit per (area, hour) and
  refuses a second row for the same cell, instead of letting whichever worker
  finished last win.
- **Hour arithmetic lives only here.** `dayOfYear` in
  `src/ingest.ts` mirrors `date_to_day` for the tests' reference
  parser only. Keep it field-for-field identical.
- Keep exponent notation such as `7E-05`. Read `TOU` from the file; never
  derive it. A TOU that is neither label is refused rather than read as
  OffPeak.
- **Cell rules are shared with the wide reader** (`../common/fields.h`), so a
  value, hour, date or TOU reads the same in either shape. Padding, case and
  a spreadsheet's `1.0` hour read through. Anything else is counted, and JS
  refuses the load.
- **Only extra fields are refused.** A short row leaves its missing cells
  absent, as in the wide reader. An extra field is how a quoted comma shows
  up, since this reader splits on every comma.
- **TOU is compared per row in `blitBlock`,** after the duplicate check, so
  a concatenated file is reported as duplicates rather than as a TOU clash.

## Footguns in the cube fill

- **Bucket rows by area before writing.** An area's planes are one contiguous
  region of the cube, so bucketing keeps writes local. It is worth about 2.4x.
- **Step the inner loop instead of indexing a lookup table** when retained
  planes are consecutive. This is the larger win and the easiest to lose in a
  refactor.
- Having the worker emit rows pre-bucketed was measured and rejected: it
  needs per-area counts plumbed through every layer and gained almost nothing.

## Memory

Buffers are sized to a block, never a case, because each worker holds its own
instance. Values are `maxRows × planes × 4 B`. Each cell costs at least its
one-byte delimiter, so a block of whole rows needs up to 4x its bytes when
most cells are empty. That is why `BLOCK_TARGET_BYTES` is 4 MiB against a
20 MiB arena, not 8. Raising either means raising the other. Short rows
reserve cells with no bytes behind them. A block of them that does not fit
makes `configure()` return 0, and JS refuses the load.
