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

#include "../common/fields.h"

// Bumped on any change to the exported surface or slab layout, so a stale
// committed binary is an error at instantiate, not a wrong number.
#define ABI_VERSION 8u

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

// One block's values, row index, row TOU, areaSeen and column plan. A row
// with all its fields costs 4 B per retained metric plus 5 B of placement,
// and holds at least one delimiter per field, so the arena needs at most 4x a
// block of whole rows (tests/test_long_refusals.mjs holds BLOCK_TARGET_BYTES
// to that). Short rows reserve cells they have no bytes for; a block of them
// that does not fit makes configure() fail.
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
// An unreadable date is INVALID: fields.h's NO_DAY, the same value.
_Static_assert(NO_DAY == INVALID, "a date parse failure must read as INVALID");

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
static unsigned char*  rowTou;    // [maxRows] TOU of each emitted row, 0 = OffPeak, 1 = OnPeak
static unsigned char*  areaSeen;  // [numAreas], 1 = at least one row in this block

static unsigned g_numAreas, g_numPlanes, g_maxRows, g_sourceMetrics;

// The key-column layout, set by set_key_layout(). Date, Hour and TOU are
// always columns 0-2; how many key columns follow and which is the identity
// are per KIND and arrive as NUMBERS.
static unsigned g_keyCols = 4u, g_entityCol = 3u;
static unsigned g_rows, g_emitted, g_unknownArea, g_badRow, g_overflow;
static unsigned g_yearMismatch, g_badId, g_badTou, g_badCell, g_ragged;

__attribute__((export_name("abi_version")))       unsigned       abi_version(void)       { return ABI_VERSION; }
__attribute__((export_name("inbuf_ptr")))         unsigned char* inbuf_ptr(void)         { return inbuf; }
__attribute__((export_name("inbuf_size")))        unsigned       inbuf_size(void)        { return INBUF_BYTES; }
__attribute__((export_name("arena_bytes")))       unsigned       arena_bytes(void)       { return ARENA_BYTES; }
__attribute__((export_name("plane_of_ptr")))      int*            plane_of_ptr(void)      { return planeOf; }
__attribute__((export_name("values_ptr")))        float*          values_ptr(void)        { return values; }
__attribute__((export_name("row_area_ptr")))      unsigned short* row_area_ptr(void)      { return rowArea; }
__attribute__((export_name("row_hour_ptr")))      unsigned short* row_hour_ptr(void)      { return rowHour; }
__attribute__((export_name("row_tou_ptr")))       unsigned char*  row_tou_ptr(void)       { return rowTou; }
__attribute__((export_name("area_seen_ptr")))     unsigned char*  area_seen_ptr(void)     { return areaSeen; }
__attribute__((export_name("last_rows")))         unsigned        last_rows(void)         { return g_rows; }
__attribute__((export_name("last_emitted")))      unsigned        last_emitted(void)      { return g_emitted; }
__attribute__((export_name("last_unknown_area"))) unsigned        last_unknown_area(void) { return g_unknownArea; }
__attribute__((export_name("last_bad_row")))      unsigned        last_bad_row(void)      { return g_badRow; }
__attribute__((export_name("last_overflow")))     unsigned        last_overflow(void)     { return g_overflow; }
// Rows in a year other than the Case's: a day-of-year ignores the year, so a
// second year would fold onto the same hours.
__attribute__((export_name("last_year_mismatch"))) unsigned       last_year_mismatch(void){ return g_yearMismatch; }
// Rows whose identity is blank or quoted. This reader splits on every comma,
// so a quoted field is not read as one.
__attribute__((export_name("last_bad_id")))       unsigned        last_bad_id(void)       { return g_badId; }
// Rows whose TOU is neither OnPeak nor OffPeak.
__attribute__((export_name("last_bad_tou")))      unsigned        last_bad_tou(void)      { return g_badTou; }
// Retained value cells that are neither blank nor a number.
__attribute__((export_name("last_bad_cell")))     unsigned        last_bad_cell(void)     { return g_badCell; }
// Rows with more fields than the header: a quoted comma shifts every later
// value one plane over. A short row is absent cells, as in the wide reader.
__attribute__((export_name("last_ragged")))       unsigned        last_ragged(void)       { return g_ragged; }

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
                            (unsigned long long)maxRows * 5ull + (unsigned long long)numAreas;
  if (need > (unsigned long long)ARENA_BYTES) return 0u;

  // Every region size is a multiple of its element width, so each starts
  // aligned in the 16-aligned arena.
  unsigned off = 0u;
  planeOf  = (int*)(arena + off);             off += sourceMetrics * 4u;
  values   = (float*)(arena + off);           off += (unsigned)cells * 4u;
  rowArea  = (unsigned short*)(arena + off);  off += maxRows * 2u;
  rowHour  = (unsigned short*)(arena + off);  off += maxRows * 2u;
  rowTou   = arena + off;                     off += maxRows;
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
    // A blank line is not a row, CRLF or not, as in parse_block.
    if (rowEnd == i || (rowEnd == i + 1u && b[i] == '\r')) { i = rowEnd + 1u; continue; }
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
      const unsigned char* ps = b + s;
      const unsigned char* pe = b + e;
      trim_field(&ps, &pe);
      if (pe > ps) name_insert(b, (unsigned)(ps - b), (unsigned)(pe - b));
    }

    // Everything past the identity is skipped WHOLE; that is why this is cheap.
    i = rowEnd + 1u;
  }
  return g_scanRows;
}

/**
 * Parse a block of WHOLE rows (`len` bytes from a row boundary, ending after
 * a '\n') into a ROW LIST: values[row * numPlanes + plane], placement in
 * rowArea[row] / rowHour[row] / rowTou[row]. `year` is the Case's; every row
 * is checked against it. Columns: Date, Hour, TOU at 0-2, identity at
 * `g_entityCol`, other key columns skipped, then source metric
 * `col - g_keyCols` routed through planeOf. Metrics were matched by trimmed
 * header name on the JS side.
 */
__attribute__((export_name("parse_block")))
unsigned parse_block(unsigned len, unsigned year) {
  const unsigned char* b = inbuf;
  unsigned col = 0u, fs = 0u;
  unsigned rowDay = NO_DAY, rowYear = 0u, rowHourOfDay = 0u, touCode = NO_TOU;
  unsigned area = NO_AREA, slot = INVALID, rowBase = 0u;
  const unsigned rowFields = g_keyCols + g_sourceMetrics;
  // A local, so read_value's counter stays in a register.
  unsigned badCell = 0u;

  g_rows = 0u; g_emitted = 0u; g_unknownArea = 0u; g_badRow = 0u; g_overflow = 0u;
  g_yearMismatch = 0u; g_badId = 0u; g_badTou = 0u; g_ragged = 0u;

  // Unwritten cells must read as absent (NaN), never a stale float or zero.
  // Done here so no caller can skip it.
  {
    const v128_t nan4 = wasm_f32x4_splat(0.0f / 0.0f);
    unsigned n = g_maxRows * g_numPlanes;
    unsigned i = 0u;
    for (; i + 4u <= n; i += 4u) wasm_v128_store(values + i, nan4);
    for (; i < n; i++) values[i] = 0.0f / 0.0f;
  }
  for (unsigned k = 0; k < g_numAreas; k++) areaSeen[k] = 0;

  // Each row is placed or counted against exactly one refusal, in this
  // order. Feb 29 comes first: it is dropped whatever else is wrong with it.
  #define FIELD(END)                                                            \
    {                                                                           \
      unsigned e = (END);                                                       \
      if (e > fs && b[e - 1] == '\r') e--;                                      \
      if (col == 0u) {                                                          \
        rowDay = date_to_day(b + fs, b + e, &rowYear);                          \
      } else if (col == 1u) {                                                   \
        rowHourOfDay = read_hour(b + fs, b + e);                                \
      } else if (col == 2u) {                                                   \
        touCode = read_tou(b + fs, b + e);                                      \
      } else if (col == g_entityCol) {                                          \
        /* The axis is built from TRIMMED names, so the hash must see the       \
           trimmed bytes or a padded Name field becomes an unknown area and     \
           refuses a file that is merely spaced. */                             \
        const unsigned char* ns = b + fs;                                       \
        const unsigned char* ne = b + e;                                        \
        trim_field(&ns, &ne);                                                   \
        unsigned h = (rowDay < FEB29 && rowHourOfDay >= 1u &&                   \
                      rowHourOfDay <= 24u) ? rowDay * 24u + (rowHourOfDay - 1u) \
                                           : INVALID;                           \
        slot = INVALID;                                                         \
        area = NO_AREA;                                                         \
        if (rowDay == FEB29) {                                                  \
          /* dropped on purpose */                                              \
        } else if (h == INVALID) {                                              \
          g_badRow++;                                                           \
        } else if (rowYear != year) {                                           \
          g_yearMismatch++;                                                     \
        } else if (ne == ns || *ns == '"' || ne[-1] == '"') {                   \
          g_badId++;                                                            \
        } else if ((area = area_lookup(fnv1a(ns, ne))) >= g_numAreas) {         \
          area = NO_AREA;                                                       \
          g_unknownArea++;                                                      \
        } else if (touCode == NO_TOU) {                                         \
          area = NO_AREA;                                                       \
          g_badTou++;                                                           \
        } else {                                                                \
          areaSeen[area] = 1;                                                   \
          if (g_emitted < g_maxRows) {                                          \
            slot = g_emitted++;                                                 \
            /* Hoisted: the metric branch below runs once per FIELD, and         \
               recomputing slot * numPlanes there is a multiply and a global     \
               load on every one of the file's ~19M value cells. */              \
            rowBase = slot * g_numPlanes;                                       \
            rowArea[slot] = (unsigned short)area;                               \
            rowHour[slot] = (unsigned short)h;                                  \
            rowTou[slot] = (unsigned char)touCode;                              \
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
            values[rowBase + (unsigned)pl] = read_value(b + fs, b + e, &badCell); \
          }                                                                     \
        }                                                                       \
      }                                                                         \
    }

  #define EMIT(AT, BYTE)                                                        \
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
          else if (col > rowFields) g_ragged++;                                 \
        }                                                                       \
        col = 0u; area = NO_AREA; slot = INVALID; rowDay = NO_DAY;              \
      }                                                                         \
    }

  FOR_EACH_DELIMITER(b, len, EMIT)
  #undef EMIT
  #undef FIELD
  g_badCell = badCell;
  return g_rows;
}
