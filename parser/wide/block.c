// parser/wide/block.c
//
// The WASM CSV parser for WIDE-SHAPE exports (shape W). A SHAPE reader: area,
// interface, bus and generator exports all come in this shape and nothing
// here can tell them apart. Every ABI argument is a NUMBER about bytes and
// offsets, so `if (kind == BUS)` is unrepresentable (tests/test_wide_abi.mjs).
//
// Input shape; JS consumes the preamble and header, so this sees data rows only:
//
//   line 1   <Entity> Hourly 'Power Flow (MW)' Data for Year 2034
//   line 2-4 preamble (bus exports add an id row, pushing the header to 6)
//   line 5   Date, Hour, TOU,<entity 1>,<entity 2>,...
//   line 6+  one row per HOUR
//
// Invariants:
//
// 1. MEMORY is a function of BLOCK size, never case size (every Worker has
//    its own instance): a fixed input window plus a fixed arena, split between
//    width and rows at runtime.
// 2. BLOCK INDEPENDENCE. Each row's hour comes from its own Date and Hour,
//    never a row counter, so blocks parse in any order.
// 3. ONE ROW = ONE HOUR, so no hour spans two blocks.
// 4. ROW ORDER DOES NOT MATTER. Output is a row list with each row's hour in
//    rowHour[r]; the main thread scatters it.
//
// Build: ./build.sh

#include <wasm_simd128.h>

// ---------------------------------------------------------------- dimensions
//
// Two byte budgets are the only build parameters (`-D` from build.sh):
// `BLOCK_BYTES` (input window) and `ARENA_BYTES` (one block's output). The
// defaults are the shipping build that block.wasm is committed from.
//
// The slab's SHAPE is not compiled in: `configure(numMetrics, maxRows)`
// re-points the output regions inside the arena and refuses a layout that
// does not fit. Width and rows-per-block are inversely related (blocks are cut
// in bytes), so one budget serves every width: an 8 MiB block needs about the
// same slab at 215 entities as at 5,900. Sizing both as independent maxima
// would make bus width unaffordable.
//
// block.ts configures in the same call that parses, so it always indexes with
// the shape it asked for: a wrong stride leaves every number plausible.

// The input window one block is copied into.
#ifndef BLOCK_BYTES
#define BLOCK_BYTES     (12u * 1024u * 1024u)
#endif

// One block's values, row hours and row TOU codes: about 2.7x what an 8 MiB
// block needs at any width. A layout that does not fit makes configure()
// fail, which JS turns into an error rather than a truncated parse.
#ifndef ARENA_BYTES
#define ARENA_BYTES     (9u * 1024u * 1024u)
#endif

#define KEY_COLS        3           // Date, Hour, TOU

// A bad -D fails at compile time, not as a wrong number in a browser.
_Static_assert(BLOCK_BYTES >= 1024u * 1024u,
               "BLOCK_BYTES below 1 MiB cannot hold a block the JS side dispatches");
_Static_assert(ARENA_BYTES >= 1024u * 1024u,
               "ARENA_BYTES below 1 MiB cannot hold one block's values");

// Bumped on any change to the exported surface or the slab's meaning, so a
// stale committed binary fails at instantiate rather than misparsing.
#define ABI_VERSION     3u

static unsigned char inbuf[BLOCK_BYTES];
static unsigned char arena[ARENA_BYTES] __attribute__((aligned(16)));

// Arena regions, re-pointed by configure(); null until it succeeds.
// slab[m * g_maxRows + r] is PLANE-major, so one entity's block of values is a
// contiguous copy on the JS side.
static float*          slab;
// Where each emitted row lands: hour of the year, 0..8759.
static unsigned short* rowHour;
// Per-row TOU code, 0 = OffPeak, 1 = OnPeak. TOU is FILE DATA, never
// recomputed from the calendar (the real rule varies by tariff and holidays);
// read here only so the bytes are scanned once.
static unsigned char*  rowTou;

// The configured layout. Both 0 until configure() succeeds, which makes an
// unconfigured parse_block a no-op rather than a write through null.
static unsigned g_metrics, g_maxRows;

static unsigned g_rows, g_overflow, g_wideField, g_badRow, g_feb29, g_yearMismatch;

__attribute__((export_name("inbuf_ptr")))     unsigned char* inbuf_ptr(void)    { return inbuf; }
__attribute__((export_name("inbuf_size")))    unsigned       inbuf_size(void)   { return BLOCK_BYTES; }
__attribute__((export_name("arena_bytes")))   unsigned       arena_bytes(void)  { return ARENA_BYTES; }
__attribute__((export_name("slab_ptr")))      float*         slab_ptr(void)     { return slab; }
__attribute__((export_name("row_hour_ptr")))  unsigned short* row_hour_ptr(void){ return rowHour; }
__attribute__((export_name("row_tou_ptr")))   unsigned char* row_tou_ptr(void)  { return rowTou; }
// The layout currently configured (0 before the first configure()).
__attribute__((export_name("slab_rows")))     unsigned       slab_rows(void)    { return g_maxRows; }
__attribute__((export_name("slab_metrics")))  unsigned       slab_metrics(void) { return g_metrics; }
__attribute__((export_name("abi_version")))   unsigned       abi_version(void)  { return ABI_VERSION; }
__attribute__((export_name("last_rows")))     unsigned       last_rows(void)    { return g_rows; }
// Rows past the configured maxRows. JS sizes blocks so this cannot happen and
// shrinks them if it does; a backstop, not a normal outcome.
__attribute__((export_name("last_overflow")))   unsigned     last_overflow(void){ return g_overflow; }
// Fields past the configured width, and rows whose Date/Hour did not resolve.
// Both would be silent data loss if unreported. Feb 29 is counted apart,
// because dropping it is intended.
__attribute__((export_name("last_wide_field"))) unsigned     last_wide_field(void){ return g_wideField; }
__attribute__((export_name("last_bad_row")))    unsigned     last_bad_row(void)  { return g_badRow; }
__attribute__((export_name("last_feb29")))      unsigned     last_feb29(void)    { return g_feb29; }
// Rows whose year differs from the file's first data row. date_to_day ignores
// the year, so without this a two-year file would fold onto the same 8,760
// hours. Counted here, refused by JS.
__attribute__((export_name("last_year_mismatch"))) unsigned  last_year_mismatch(void){ return g_yearMismatch; }

// Cumulative days before each month, non-leap; Feb 29 rows are skipped.
static const unsigned short CUM[12] = {0,31,59,90,120,151,181,212,243,273,304,334};

// f64 digit accumulation. Do NOT swap in fast_float's Eisel-Lemire: it lost on
// wasm32 when measured. Re-measure before believing either result.
// Exponent notation is real (`2.568664E-03` for near-zero values) and must
// parse: NaN would silently read as an absent cell.
static inline float parse_float(const unsigned char* p, const unsigned char* e) {
  if (e <= p) return 0.0f / 0.0f;
  int neg = 0;
  if (*p == '-') { neg = 1; p++; }
  else if (*p == '+') { p++; }

  // Integer part, then `frac / scale`. This rounds twice where strtod rounds
  // once: a 1-ulp float32 difference on a few cells of the widest columns.
  // MEASURED, do not "fix": one f64 mantissa with a single division costs 20%
  // throughput and changes none of those cells (they carry 18 significant
  // digits). The reference comparison gates this at <= 1 ulp.
  double ip = 0.0;
  while (p < e) {
    unsigned d = (unsigned)(*p - '0');
    if (d > 9) break;
    ip = ip * 10.0 + (double)d;
    p++;
  }
  double v = ip;
  if (p < e && *p == '.') {
    p++;
    double f = 0.0, sc = 1.0;
    while (p < e) {
      unsigned d = (unsigned)(*p - '0');
      if (d > 9) break;
      f = f * 10.0 + (double)d;
      sc *= 10.0;
      p++;
    }
    v += f / sc;
  }
  if (p < e && (*p == 'e' || *p == 'E')) {
    p++;
    int eneg = 0;
    if (p < e && (*p == '-' || *p == '+')) { eneg = (*p == '-'); p++; }
    int ex = 0;
    while (p < e) {
      unsigned d = (unsigned)(*p - '0');
      if (d > 9) break;
      ex = ex * 10 + (int)d;
      if (ex > 400) ex = 400;   // past f32 range either way
      p++;
    }
    // Exponentiation by squaring: no libm in a freestanding module.
    double scale = 1.0, base = 10.0;
    for (int k = ex; k; k >>= 1) { if (k & 1) scale *= base; base *= base; }
    v = eneg ? v / scale : v * scale;
  }

  // Leftover characters make the field NaN: a partial parse of a mangled
  // field would be a plausible wrong number.
  if (p != e) return 0.0f / 0.0f;
  return (float)(neg ? -v : v);
}

static inline unsigned parse_uint(const unsigned char* p, const unsigned char* e) {
  unsigned v = 0;
  for (; p < e; p++) {
    unsigned d = (unsigned)(*p - '0');
    if (d > 9) break;
    v = v * 10u + d;
  }
  return v;
}

// M/D/YYYY -> day-of-year, with the year returned for the same-year check.
// FEB29 (dropped on purpose) and NO_DAY (unreadable) are distinct, so the
// leap day never looks like a mangled file.
#define FEB29  0xFFFFFFFEu
#define NO_DAY 0xFFFFFFFFu
static inline unsigned date_to_day(const unsigned char* p, const unsigned char* e,
                                   unsigned* yearOut) {
  unsigned month = 0, day = 0, year = 0;
  while (p < e && *p != '/') { month = month * 10u + (unsigned)(*p - '0'); p++; }
  p++;
  while (p < e && *p != '/') { day = day * 10u + (unsigned)(*p - '0'); p++; }
  p++;
  while (p < e) {
    unsigned d = (unsigned)(*p - '0');
    if (d > 9) break;
    year = year * 10u + d;
    p++;
  }
  *yearOut = year;
  if (month < 1 || month > 12 || day < 1 || day > 31) return NO_DAY;
  if (month == 2 && day == 29) return FEB29;   // Feb 29 dropped
  return CUM[month - 1] + day - 1;
}

/**
 * Lay the arena out for one block: `numMetrics` planes of `maxRows` rows, both
 * taken from the file. Returns 0 if it does not fit, which the caller MUST
 * treat as an error; the regions are then left null so nothing is written at
 * a stale stride.
 */
__attribute__((export_name("configure")))
unsigned configure(unsigned numMetrics, unsigned maxRows) {
  g_metrics = 0u; g_maxRows = 0u;
  slab = 0; rowHour = 0; rowTou = 0;
  if (numMetrics == 0u || maxRows == 0u) return 0u;

  // 64-bit: metrics * rows overflows 32 bits before the arena check could
  // catch it.
  unsigned long long cells = (unsigned long long)numMetrics * maxRows;
  unsigned long long need = cells * 4ull + (unsigned long long)maxRows * 3ull;
  if (need > (unsigned long long)ARENA_BYTES) return 0u;

  // The slab is whole floats, so rowHour starts 4-aligned (it needs 2).
  unsigned off = 0u;
  slab    = (float*)(arena + off);           off += (unsigned)cells * 4u;
  rowHour = (unsigned short*)(arena + off);  off += maxRows * 2u;
  rowTou  = arena + off;

  g_metrics = numMetrics;
  g_maxRows = maxRows;
  return 1u;
}

/**
 * NaN-fill the value planes for `rows` rows. A row with fewer fields than the
 * header leaves later planes untouched, and a stale float from the previous
 * block would be a plausible wrong number.
 */
__attribute__((export_name("slab_fill_nan")))
void slab_fill_nan(unsigned rows) {
  const unsigned maxRows = g_maxRows;
  if (maxRows == 0u) return;                 // never configured; nothing to fill
  if (rows > maxRows) rows = maxRows;
  const float nan = 0.0f / 0.0f;
  for (unsigned m = 0; m < g_metrics; m++) {
    float* column = slab + m * maxRows;
    for (unsigned r = 0; r < rows; r++) column[r] = nan;
  }
}

// Parse a block of WHOLE rows (`len` bytes from a row boundary, ending after
// a '\n'). `year` is the case's year from JS; every row is checked against it.
// Rows are emitted in byte order with rowHour[row] giving their hour. Source
// column `c` writes plane `c - KEY_COLS`; JS maps planes to the cube by
// trimmed header name.
__attribute__((export_name("parse_block")))
unsigned parse_block(unsigned len, unsigned year) {
  // Hoisted out of the per-field macro, where a global reload would be paid
  // millions of times.
  const unsigned maxRows = g_maxRows;
  const unsigned numMetrics = g_metrics;
  // Unconfigured: writing would go through address 0, which in wasm is real
  // memory and would corrupt the data segment silently.
  if (maxRows == 0u) return 0u;

  const unsigned char* b = inbuf;
  unsigned col = 0, fs = 0;
  unsigned rowDay = NO_DAY, rowYear = 0;
  // Slot this row will occupy, or NO_DAY while the row is being rejected.
  unsigned slot = NO_DAY;
  g_rows = 0; g_overflow = 0; g_wideField = 0; g_badRow = 0; g_feb29 = 0;
  g_yearMismatch = 0;

  const v128_t vcomma = wasm_i8x16_splat(',');
  const v128_t vnl    = wasm_i8x16_splat('\n');
  unsigned i = 0;

  #define FIELD(END)                                                            \
    {                                                                           \
      unsigned e = (END);                                                       \
      if (e > fs && b[e - 1] == '\r') e--;                                      \
      if (col == 0) {                                                           \
        rowDay = date_to_day(b + fs, b + e, &rowYear);                          \
      } else if (col == 1) {                                                    \
        unsigned hourOfDay = parse_uint(b + fs, b + e);                         \
        slot = NO_DAY;                                                          \
        if (rowDay == FEB29) {                                                  \
          g_feb29++;                     /* dropped on purpose */          \
        } else if (rowDay == NO_DAY || hourOfDay < 1 || hourOfDay > 24) {       \
          g_badRow++;                    /* unreadable Date or Hour */          \
        } else if (rowYear != year) {                                           \
          g_yearMismatch++;              /* a second year in one case */        \
        } else if (g_rows >= maxRows) {                                         \
          g_overflow++;                  /* more rows than the layout holds */  \
        } else {                                                                \
          slot = g_rows++;                                                      \
          rowHour[slot] = (unsigned short)(rowDay * 24u + (hourOfDay - 1u));    \
          rowTou[slot] = 0;                                                     \
        }                                                                       \
      } else if (col == 2) {                                                    \
        /* "OnPeak" / "OffPeak" differ at byte 1: 'n' vs 'f'. */                \
        if (slot != NO_DAY) {                                                   \
          rowTou[slot] = (unsigned char)((e > fs + 1 && b[fs + 1] == 'n') ? 1 : 0); \
        }                                                                       \
      } else {                                                                  \
        unsigned m = col - (unsigned)KEY_COLS;                                  \
        if (m >= numMetrics) g_wideField++;                                     \
        else if (slot != NO_DAY) {                                              \
          slab[m * maxRows + slot] = parse_float(b + fs, b + e);                \
        }                                                                       \
      }                                                                         \
    }

  for (; i + 16 <= len; i += 16) {
    v128_t chunk = wasm_v128_load(b + i);
    v128_t hit   = wasm_v128_or(wasm_i8x16_eq(chunk, vcomma), wasm_i8x16_eq(chunk, vnl));
    unsigned mask = (unsigned)wasm_i8x16_bitmask(hit);
    while (mask) {
      unsigned pos = i + (unsigned)__builtin_ctz(mask);
      mask &= mask - 1;
      FIELD(pos)
      fs = pos + 1;
      col++;
      /* g_rows counts EMITTED rows and is advanced when a slot is claimed, so
         a newline only resets the per-row state. */
      if (b[pos] == '\n') { col = 0; rowDay = NO_DAY; slot = NO_DAY; }
    }
  }
  for (; i < len; i++) {
    unsigned char c = b[i];
    if (c == ',' || c == '\n') {
      FIELD(i)
      fs = i + 1;
      col++;
      if (c == '\n') { col = 0; rowDay = NO_DAY; slot = NO_DAY; }
    }
  }
  #undef FIELD
  return g_rows;
}
