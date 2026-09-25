# WASM CSV parser — wide shape (W)

`block.c` parses WIDE-shape data rows (`Date,Hour,TOU`, then one column per
entity) for area, interface, bus and generator exports alike. It cannot tell
the kinds apart, and it must not: every value passed in is a number about bytes
and offsets (AGENTS.md, "No kind token crosses a parser ABI").

JavaScript reads the title, preamble and header line, then maps slab planes to
cube entities by trimmed header name.

## Build

```bash
./build.sh
```

Commit `block.wasm` with any `block.c` change, and bump `ABI_VERSION` with
`PARSER_ABI` in `src/tables/wide/block.ts` when the exports or arena layout
change.
