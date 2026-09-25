// src/tables/interface/block.ts
//
// The Interface kind's view of the wide parser's JS side. Nothing here is
// Interface-specific: the module, its ABI, its budgets and its slab arithmetic
// are properties of the SHAPE, and they live in `src/tables/wide/block.ts`.
// This file exists so a kind's ingest is still read at
// `src/tables/<kind>/block.ts`.

export {
  OVERFLOW_MARKER,
  afterNextNewline,
  instantiateParser,
  maxRowsAt,
  parseBytes,
} from '../wide/block';
