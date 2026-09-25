// parser/long/block.c
//
// The WASM CSV parser for LONG-SHAPE exports (shape L): one row per
// (entity, hour), many metrics. Nothing about an export's shape is compiled
// in; entity count, metric count, retained columns and rows per block arrive
// through configure(). A JS fallback for other shapes was 4.7x slower.
//
// 1. MEMORY IS A FUNCTION OF BLOCK SIZE, NEVER CASE SIZE. Every Worker has
//    its own instance (no SharedArrayBuffer on GitHub Pages), so case-sized
//    buffers would multiply by the pool.
// 2. ROW ORDER DOES NOT MATTER. Output is a row list, each row carrying its
//    own (area, hour); the main thread scatters it.
// 3. BLOCKS ARE INDEPENDENT. Placement comes from each row's own fields,
//    never a row counter.
// 4. SILENCE IS THE ENEMY. Every failure seen here is counted and reported,
//    and JS refuses the load.
//
// Build: parser/long/build.sh

#include <wasm_simd128.h>

// Bumped on any change to the exported surface or slab layout, so a stale
// committed binary is an error at instantiate, not a wrong number.
#define ABI_VERSION 7u

// ---------------------------------------------------------------- dimensions
//
// INBUF_BYTES, ARENA_BYTES, AREA_TABLE and MAX_NAMES are build parameters
// (`-D` from build.sh); the defaults are the committed shipping build.
// Per-block storage is laid out at runtime by configure(); only the arena's
// total size and the two hash tables are compiled in. The table capacities
// have no exports: `area_table_put` returns 0 when full and `axis_overflow()`
// counts names past MAX_NAMES (how scripts/bench-ingest.mjs probes them).

#ifndef INBUF_BYTES
#define INBUF_BYTES (12u * 1024u * 1024u)
#endif

// One block's values, row index, TOU, areaSeen and column plan. Values are
// rows * planes * 4 B, and a row of `metrics` fields is at least
// 2 * (4 + metrics) bytes, so values stay under twice the block's length.
// A shape that does not fit makes configure() fail.
#ifndef ARENA_BYTES
#define ARENA_BYTES (20u * 1024u * 1024u)
#endif

// Open addressing, filled once per axis. Static and never resized: `useAxis`
// refills live workers' tables in place, so configure() must never move it.
#ifndef AREA_TABLE
#define AREA_TABLE 4096u
#endif

#define INVALID 0xFFFFFFFFu
#define NO_AREA INVALID
// Feb 29 is dropped on purpose; INVALID is an unreadable date. Kept apart so
// only the second refuses the load.
#define FEB29   0xFFFFFFFEu

static unsigned char inbuf[INBUF_BYTES];
static unsigned char arena[ARENA_BYTES] __attribute__((aligned(16)));

static unsigned areaHash[AREA_TABLE];
static unsigned areaIdx[AREA_TABLE];

#define HOURS_PER_YEAR 8760u

// Arena regions, re-pointed by configure().
static int*            planeOf;   // [sourceMetrics] source metric -> output plane, or -1
static float*          values;    // [maxRows * numPlanes], row-major
static unsigned short* rowArea;   // [maxRows] cube area index of each emitted row
static unsigned short* rowHour;   // [maxRows] hour-of-year of each emitted row
static unsigned char*  touOut;    // [8760], 0 = OffPeak, 1 = OnPeak, 0xFF = uncovered
static unsigned char*  areaSeen;  // [numAreas], 1 = at least one row in this block

static unsigned g_numAreas, g_numPlanes, g_maxRows, g_sourceMetrics;

// The key-column layout, set by set_key_layout(). Date, Hour and TOU are
// always columns 0-2; how many key columns follow and which is the identity
// are per KIND and arrive as NUMBERS. Area: Date,Hour,TOU,Name (4, identity
// at 3, the defaults). Bus: Date,Hour,TOU,BusID,BusName,Area (6, identity at
// 3).
static unsigned g_keyCols = 4u, g_entityCol = 3u;
static unsigned g_rows, g_emitted, g_unknownArea, g_badRow, g_overflow;

__attribute__((export_name("abi_version")))       unsigned       abi_version(void)       { return ABI_VERSION; }
__attribute__((export_name("inbuf_ptr")))         unsigned char* inbuf_ptr(void)         { return inbuf; }
__attribute__((export_name("inbuf_size")))        unsigned       inbuf_size(void)        { return INBUF_BYTES; }
__attribute__((export_name("arena_bytes")))       unsigned       arena_bytes(void)       { return ARENA_BYTES; }
__attribute__((export_name("plane_of_ptr")))      int*            plane_of_ptr(void)      { return planeOf; }
__attribute__((export_name("values_ptr")))        float*          values_ptr(void)        { return values; }
__attribute__((export_name("row_area_ptr")))      unsigned short* row_area_ptr(void)      { return rowArea; }
__attribute__((export_name("row_hour_ptr")))      unsigned short* row_hour_ptr(void)      { return rowHour; }
__attribute__((export_name("tou_ptr")))           unsigned char*  tou_ptr(void)           { return touOut; }
__attribute__((export_name("area_seen_ptr")))     unsigned char*  area_seen_ptr(void)     { return areaSeen; }
__attribute__((export_name("last_rows")))         unsigned        last_rows(void)         { return g_rows; }
__attribute__((export_name("last_emitted")))      unsigned        last_emitted(void)      { return g_emitted; }
__attribute__((export_name("last_unknown_area"))) unsigned        last_unknown_area(void) { return g_unknownArea; }
__attribute__((export_name("last_bad_row")))      unsigned        last_bad_row(void)      { return g_badRow; }
__attribute__((export_name("last_overflow")))     unsigned        last_overflow(void)     { return g_overflow; }

/**
 * Lay the arena out for one block. `maxRows` is the axis scan's exact count
 * for these bytes. Returns 0 if it does not fit, which the caller must treat
 * as an error.
 */
__attribute__((export_name("configure")))
unsigned configure(unsigned numAreas, unsigned numPlanes, unsigned maxRows, unsigned sourceMetrics) {
  if (numAreas == 0u) return 0u;

  // 64-bit: rows * planes overflows 32 bits before the arena check.
  unsigned long long cells = (unsigned long long)maxRows * numPlanes;
  unsigned long long need = (unsigned long long)sourceMetrics * 4ull + cells * 4ull +
                            (unsigned long long)maxRows * 4ull + HOURS_PER_YEAR +
                            (unsigned long long)numAreas;
  if (need > (unsigned long long)ARENA_BYTES) return 0u;

  // Every region size is a multiple of its element width, so each starts
  // aligned in the 16-aligned arena.
  unsigned off = 0u;
  planeOf  = (int*)(arena + off);             off += sourceMetrics * 4u;
  values   = (float*)(arena + off);           off += (unsigned)cells * 4u;
  rowArea  = (unsigned short*)(arena + off);  off += maxRows * 2u;
  rowHour  = (unsigned short*)(arena + off);  off += maxRows * 2u;
  touOut   = arena + off;                     off += HOURS_PER_YEAR;
  areaSeen = arena + off;

  g_numAreas      = numAreas;
  g_numPlanes     = numPlanes;
  g_maxRows       = maxRows;
  g_sourceMetrics = sourceMetrics;
  return 1u;
}

/**
 * Set the key-column layout for later scan_axis and parse_block calls (the
 * scan runs before configure() has its dimensions). Returns 0 for an
 * unreadable layout, which JS must refuse.
 */
__attribute__((export_name("set_key_layout")))
unsigned set_key_layout(unsigned keyCols, unsigned entityCol) {
  if (entityCol < 3u || keyCols <= entityCol) return 0u;
  g_keyCols   = keyCols;
  g_entityCol = entityCol;
  return 1u;
}

__attribute__((export_name("area_table_reset")))
void area_table_reset(void) {
  for (unsigned i = 0; i < AREA_TABLE; i++) { areaHash[i] = 0; areaIdx[i] = NO_AREA; }
}

/** Returns 0 if the table is full, so JS can refuse rather than lose an area. */
__attribute__((export_name("area_table_put")))
unsigned area_table_put(unsigned hash, unsigned idx) {
  unsigned s = hash & (AREA_TABLE - 1u);
  for (unsigned p = 0; p < AREA_TABLE; p++) {
    unsigned k = (s + p) & (AREA_TABLE - 1u);
    if (areaIdx[k] == NO_AREA) { areaHash[k] = hash; areaIdx[k] = idx; return 1u; }
  }
  return 0u;
}

static inline unsigned area_lookup(unsigned hash) {
  unsigned s = hash & (AREA_TABLE - 1u);
  for (unsigned p = 0; p < AREA_TABLE; p++) {
    unsigned k = (s + p) & (AREA_TABLE - 1u);
    if (areaIdx[k] == NO_AREA) return NO_AREA;
    if (areaHash[k] == hash) return areaIdx[k];
  }
  return NO_AREA;
}

static inline unsigned fnv1a(const unsigned char* p, const unsigned char* e) {
  unsigned h = 0x811c9dc5u;
  for (; p < e; p++) { h ^= *p; h *= 0x01000193u; }
  return h;
}

// Days before each month, non-leap; Feb 29 rows are skipped.
static const unsigned short CUM[12] = {0,31,59,90,120,151,181,212,243,273,304,334};

// f64 digit accumulation; see parse_float in parser/wide/block.c for why not
// Eisel-Lemire. Exponent notation (`7E-05`) appears in real exports for
// near-zero values and must parse, or the cell silently reads as absent.
static inline float parse_float(const unsigned char* p, const unsigned char* e) {
  if (e <= p) return 0.0f / 0.0f;
  int neg = 0;
  if (*p == '-') { neg = 1; p++; }
  else if (*p == '+') { p++; }

  // Rounds twice where strtod rounds once: a 1-ulp float32 difference in 8 of
  // 18,834,000 cells on two 8-digit money columns. Measured, do not "fix":
  // a single-division f64 mantissa is 20% slower and changes none of them.
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
    // Exponentiation by squaring (no libm).
    double scale = 1.0, base = 10.0;
    for (int k = ex; k; k >>= 1) { if (k & 1) scale *= base; base *= base; }
    v = eneg ? v / scale : v * scale;
  }

  // Leftover characters make it NaN rather than a partial, plausible number.
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

// M/D/YYYY -> day-of-year. FEB29 for Feb 29 (dropped), INVALID if unreadable.
static inline unsigned date_to_day(const unsigned char* p, const unsigned char* e) {
  unsigned month = 0, day = 0;
  while (p < e && *p != '/') { month = month * 10u + (unsigned)(*p - '0'); p++; }
  p++;
  while (p < e && *p != '/') { day = day * 10u + (unsigned)(*p - '0'); p++; }
  if (month < 1 || month > 12 || day < 1 || day > 31) return INVALID;
  if (month == 2 && day == 29) return FEB29;
  return CUM[month - 1] + day - 1;
}

// ---------------------------------------------------------------- axis scan
//
// The axis is read from every row's KEY columns, not guessed from the first
// rows (which fails on shuffled or incomplete first hours). Skipping metric
// fields whole makes this about 4x cheaper than a full parse.

#ifndef MAX_NAMES
#define MAX_NAMES  4096u   // <= AREA_TABLE: an axis larger than this cannot be routed
#endif
// Load factor 0.5, derived from MAX_NAMES so a -D cannot move one without
// the other.
#define NAME_TABLE (MAX_NAMES * 2u)

// Tables are masked with `size - 1`, so a non-power-of-two -D must fail at
// compile time rather than silently lose slots.
_Static_assert(AREA_TABLE >= 2u && (AREA_TABLE & (AREA_TABLE - 1u)) == 0u,
               "AREA_TABLE must be a power of two: it is masked, not modulo'd");
_Static_assert(NAME_TABLE >= 2u && (NAME_TABLE & (NAME_TABLE - 1u)) == 0u,
               "MAX_NAMES must be a power of two so NAME_TABLE is one too");
_Static_assert(MAX_NAMES <= AREA_TABLE,
               "an axis larger than AREA_TABLE cannot be routed, so MAX_NAMES may not exceed it");
_Static_assert(INBUF_BYTES >= 1024u * 1024u,
               "INBUF_BYTES below 1 MiB cannot hold a block the JS side dispatches");
_Static_assert(ARENA_BYTES >= 1024u * 1024u,
               "ARENA_BYTES below 1 MiB cannot hold one block's values");

static unsigned nameHash[NAME_TABLE];
static unsigned nameSlot[NAME_TABLE];
static unsigned nameOff[MAX_NAMES];
static unsigned nameLen[MAX_NAMES];
static unsigned g_names, g_scanRows, g_scanOverflow;

__attribute__((export_name("axis_names")))     unsigned  axis_names(void)     { return g_names; }
__attribute__((export_name("axis_off_ptr")))   unsigned* axis_off_ptr(void)   { return nameOff; }
__attribute__((export_name("axis_len_ptr")))   unsigned* axis_len_ptr(void)   { return nameLen; }
__attribute__((export_name("axis_rows")))      unsigned  axis_rows(void)      { return g_scanRows; }
__attribute__((export_name("axis_overflow")))  unsigned  axis_overflow(void)  { return g_scanOverflow; }

static inline unsigned find_byte(const unsigned char* b, unsigned i, unsigned end, unsigned char target) {
  const v128_t v = wasm_i8x16_splat((char)target);
  for (; i + 16u <= end; i += 16u) {
    unsigned mask = (unsigned)wasm_i8x16_bitmask(wasm_i8x16_eq(wasm_v128_load(b + i), v));
    if (mask) {
      unsigned at = i + (unsigned)__builtin_ctz(mask);
      return at < end ? at : end;
    }
  }
  for (; i < end; i++) if (b[i] == target) return i;
  return end;
}

/** Record a distinct name and where it first occurs, so JS decodes a few
 * bytes rather than every row's Name. */
static inline void name_insert(const unsigned char* b, unsigned s, unsigned e) {
  unsigned h = fnv1a(b + s, b + e);
  unsigned start = h & (NAME_TABLE - 1u);
  for (unsigned p = 0; p < NAME_TABLE; p++) {
    unsigned k = (start + p) & (NAME_TABLE - 1u);
    if (nameSlot[k] == INVALID) {
      if (g_names >= MAX_NAMES) { g_scanOverflow++; return; }
      nameHash[k] = h;
      nameSlot[k] = g_names;
      nameOff[g_names] = s;
      nameLen[g_names] = e - s;
      g_names++;
      return;
    }
    if (nameHash[k] == h) {
      // Same hash is not the same name: confirm by bytes, or a collision
      // drops an area silently.
      unsigned idx = nameSlot[k];
      if (nameLen[idx] == e - s) {
        unsigned q = 0;
        while (q < nameLen[idx] && b[nameOff[idx] + q] == b[s + q]) q++;
        if (q == nameLen[idx]) return;
      }
      // Genuine collision: keep probing so both names get a slot.
    }
  }
  g_scanOverflow++;
}

/**
 * Read every row's identity and nothing else: fills the distinct-name table
 * and counts non-blank rows, the exact `maxRows` for a parse of these bytes.
 * Date and Hour are not read; row order carries no meaning, and duplicates
 * are caught by blitBlock.
 */
__attribute__((export_name("scan_axis")))
unsigned scan_axis(unsigned len) {
  const unsigned char* b = inbuf;
  g_names = 0; g_scanRows = 0; g_scanOverflow = 0;
  for (unsigned i = 0; i < NAME_TABLE; i++) nameSlot[i] = INVALID;

  unsigned i = 0;

  while (i < len) {
    unsigned rowEnd = find_byte(b, i, len, '\n');
    if (rowEnd == i) { i++; continue; }             // blank line, not a row
    g_scanRows++;

    // Walk the comma chain past the key fields before the identity.
    unsigned s = i;
    unsigned reached = 1u;
    for (unsigned k = 0; k < g_entityCol; k++) {
      unsigned c = find_byte(b, s, rowEnd, ',');
      if (c >= rowEnd) { reached = 0u; break; }
      s = c + 1u;
    }

    if (reached) {
      unsigned e = find_byte(b, s, rowEnd, ',');
      if (e > s && b[e - 1u] == '\r') e--;
      while (s < e && (b[s] == ' ' || b[s] == '\t')) s++;
      while (e > s && (b[e - 1u] == ' ' || b[e - 1u] == '\t')) e--;
      if (e > s) name_insert(b, s, e);
    }

    // Everything past the identity is skipped WHOLE; that is why this is cheap.
    i = rowEnd + 1u;
  }
  return g_scanRows;
}

/**
 * Parse a block of WHOLE rows (`len` bytes from a row boundary, ending after
 * a '\n') into a ROW LIST: values[row * numPlanes + plane], placement in
 * rowArea[row] / rowHour[row]. Columns: Date, Hour, TOU at 0-2, identity at
 * `g_entityCol`, other key columns skipped, then source metric
 * `col - g_keyCols` routed through planeOf. Metrics were matched by trimmed
 * header name on the JS side.
 */
__attribute__((export_name("parse_block")))
unsigned parse_block(unsigned len) {
  const unsigned char* b = inbuf;
  unsigned col = 0u, fs = 0u;
  unsigned rowDay = INVALID, rowHourOfDay = 0u, rowTou = 0xFFu;
  unsigned area = NO_AREA, slot = INVALID, rowBase = 0u;

  g_rows = 0u; g_emitted = 0u; g_unknownArea = 0u; g_badRow = 0u; g_overflow = 0u;

  // Unwritten cells must read as absent (NaN), never a stale float or zero.
  // Done here so no caller can skip it.
  {
    const v128_t nan4 = wasm_f32x4_splat(0.0f / 0.0f);
    unsigned n = g_maxRows * g_numPlanes;
    unsigned i = 0u;
    for (; i + 4u <= n; i += 4u) wasm_v128_store(values + i, nan4);
    for (; i < n; i++) values[i] = 0.0f / 0.0f;
  }
  for (unsigned k = 0; k < HOURS_PER_YEAR; k++) touOut[k] = 0xFFu;
  for (unsigned k = 0; k < g_numAreas; k++) areaSeen[k] = 0;

  #define FIELD(END)                                                            \
    {                                                                           \
      unsigned e = (END);                                                       \
      if (e > fs && b[e - 1] == '\r') e--;                                      \
      if (col == 0u) {                                                          \
        rowDay = date_to_day(b + fs, b + e);                                    \
      } else if (col == 1u) {                                                   \
        rowHourOfDay = parse_uint(b + fs, b + e);                               \
      } else if (col == 2u) {                                                   \
        /* "OnPeak" / "OffPeak" differ at byte 1: 'n' vs 'f'. */                \
        rowTou = (e > fs + 1u && b[fs + 1u] == 'n') ? 1u : 0u;                  \
      } else if (col == g_entityCol) {                                          \
        /* The axis is built from TRIMMED names, so the hash must see the       \
           trimmed bytes or a padded Name field becomes an unknown area and     \
           refuses a file that is merely spaced. */                             \
        unsigned s = fs, t = e;                                                 \
        while (s < t && (b[s] == ' ' || b[s] == '\t')) s++;                     \
        while (t > s && (b[t - 1] == ' ' || b[t - 1] == '\t')) t--;             \
        area = area_lookup(fnv1a(b + s, b + t));                                \
        if (area >= g_numAreas) { area = NO_AREA; g_unknownArea++; }            \
        unsigned h = (rowDay < FEB29 && rowHourOfDay >= 1u &&                   \
                      rowHourOfDay <= 24u) ? rowDay * 24u + (rowHourOfDay - 1u) \
                                           : INVALID;                           \
        slot = INVALID;                                                         \
        if (h == INVALID) { if (rowDay != FEB29) g_badRow++; }                  \
        else if (area != NO_AREA) {                                             \
          areaSeen[area] = 1;                                                   \
          touOut[h] = (unsigned char)rowTou;                                    \
          if (g_emitted < g_maxRows) {                                          \
            slot = g_emitted++;                                                 \
            /* Hoisted: the metric branch below runs once per FIELD, and         \
               recomputing slot * numPlanes there is a multiply and a global     \
               load on every one of the file's ~19M value cells. */              \
            rowBase = slot * g_numPlanes;                                       \
            rowArea[slot] = (unsigned short)area;                               \
            rowHour[slot] = (unsigned short)h;                                  \
          } else g_overflow++;                                                  \
        }                                                                       \
      } else if (col < g_keyCols) {                                             \
        /* A key column this kind carries but the cube does not: a bus's        \
           BusName and Area, a generator's UnitID. Skipped whole. */            \
      } else {                                                                  \
        unsigned m = col - g_keyCols;                                           \
        if (slot != INVALID && m < g_sourceMetrics) {                           \
          int pl = planeOf[m];                                                  \
          if (pl >= 0 && (unsigned)pl < g_numPlanes) {                          \
            values[rowBase + (unsigned)pl] = parse_float(b + fs, b + e);        \
          }                                                                     \
        }                                                                       \
      }                                                                         \
    }

  #define EMIT(AT)                                                              \
    {                                                                           \
      unsigned at = (AT);                                                       \
      unsigned start = fs;                                                      \
      FIELD(at)                                                                 \
      fs = at + 1u;                                                             \
      col++;                                                                    \
      if (b[at] == '\n') {                                                      \
        unsigned end = at;                                                      \
        if (end > start && b[end - 1] == '\r') end--;                           \
        /* A blank line is not a row. The reference parser the tests compare against  \
           skips them too, and the row counts have to agree. */                 \
        if (col > 1u || end > start) {                                          \
          g_rows++;                                                             \
          /* Ended before the identity column: no entity, no hour, no row. */   \
          if (col <= g_entityCol) g_badRow++;                                   \
        }                                                                       \
        col = 0u; area = NO_AREA; slot = INVALID; rowDay = INVALID;             \
      }                                                                         \
    }

  const v128_t vcomma = wasm_i8x16_splat(',');
  const v128_t vnl    = wasm_i8x16_splat('\n');
  unsigned i = 0;

  for (; i + 16 <= len; i += 16) {
    v128_t chunk = wasm_v128_load(b + i);
    v128_t hit   = wasm_v128_or(wasm_i8x16_eq(chunk, vcomma), wasm_i8x16_eq(chunk, vnl));
    unsigned mask = (unsigned)wasm_i8x16_bitmask(hit);
    while (mask) {
      unsigned pos = i + (unsigned)__builtin_ctz(mask);
      mask &= mask - 1;
      EMIT(pos)
    }
  }
  for (; i < len; i++) {
    unsigned char c = b[i];
    if (c == ',' || c == '\n') EMIT(i)
  }
  #undef EMIT
  #undef FIELD
  return g_rows;
}
