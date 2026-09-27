// parser/common/fields.h
//
// The cell readers both shape readers share: a number, an hour, a date, and
// the walk that finds every field boundary in a block. They are one copy
// because a Date or a value must read the same whichever shape carried it; two
// copies drift, and a file then parses differently by layout alone.
//
// Nothing here knows a shape or a kind: each function takes bytes and returns
// a number, so including this cannot carry a kind token across a parser ABI.
// Everything is `static inline` in a header rather than a linked object: each
// block.c is one translation unit built with -flto, and the per-cell calls
// must inline into its field loop.

#ifndef GRIDVIEW_PARSER_FIELDS_H
#define GRIDVIEW_PARSER_FIELDS_H

#include <wasm_simd128.h>

// Cumulative days before each month, non-leap; Feb 29 rows are dropped.
static const unsigned short CUM[12] = {0,31,59,90,120,151,181,212,243,273,304,334};

// date_to_day's two refusals. FEB29 (dropped on purpose) and NO_DAY
// (unreadable) are distinct, so the leap day never looks like a mangled file.
#define FEB29  0xFFFFFFFEu
#define NO_DAY 0xFFFFFFFFu

// f64 digit accumulation. Do NOT swap in fast_float's Eisel-Lemire: it lost on
// wasm32 when measured. Re-measure before believing either result.
// Exponent notation is real (`2.568664E-03`, `7E-05` for near-zero values) and
// must parse: NaN would silently read as an absent cell.
static inline float parse_float(const unsigned char* p, const unsigned char* e) {
  if (e <= p) return 0.0f / 0.0f;
  int neg = 0;
  if (*p == '-') { neg = 1; p++; }
  else if (*p == '+') { p++; }

  // Integer part, then `frac / scale`. This rounds twice where strtod rounds
  // once: a 1-ulp float32 difference on a few cells of 8-digit money columns
  // and the widest flow columns. MEASURED, do not "fix": one f64 mantissa with
  // a single division costs 20% throughput and changes none of those cells.
  // The reference comparison gates this at <= 1 ulp.
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

// M/D/YYYY -> day-of-year, FEB29 or NO_DAY. With `yearOut`, the year is read
// too, for a reader that checks every row against one year. A reader that
// checks none passes null, and the read folds away once this inlines: an
// unread year loop is otherwise kept.
static inline unsigned date_to_day(const unsigned char* p, const unsigned char* e,
                                   unsigned* yearOut) {
  unsigned month = 0, day = 0, year = 0;
  while (p < e && *p != '/') { month = month * 10u + (unsigned)(*p - '0'); p++; }
  p++;
  while (p < e && *p != '/') { day = day * 10u + (unsigned)(*p - '0'); p++; }
  if (yearOut) {
    p++;
    while (p < e) {
      unsigned d = (unsigned)(*p - '0');
      if (d > 9) break;
      year = year * 10u + d;
      p++;
    }
    *yearOut = year;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return NO_DAY;
  if (month == 2 && day == 29) return FEB29;
  return CUM[month - 1] + day - 1;
}

// Run `EMIT(at, byte)` for every ',' and '\n' in `b[0, len)`, in byte order:
// sixteen bytes per compare, then the tail a byte at a time. `byte` is the
// delimiter itself, already loaded in the tail. `EMIT` is a macro, not a
// function pointer, so each reader's per-field branch inlines into this loop.
#define FOR_EACH_DELIMITER(b, len, EMIT)                                        \
  {                                                                             \
    const v128_t vcomma_ = wasm_i8x16_splat(',');                               \
    const v128_t vnl_    = wasm_i8x16_splat('\n');                              \
    unsigned i_ = 0;                                                            \
    for (; i_ + 16 <= (len); i_ += 16) {                                        \
      v128_t chunk_ = wasm_v128_load((b) + i_);                                 \
      v128_t hit_   = wasm_v128_or(wasm_i8x16_eq(chunk_, vcomma_),              \
                                   wasm_i8x16_eq(chunk_, vnl_));                \
      unsigned mask_ = (unsigned)wasm_i8x16_bitmask(hit_);                      \
      while (mask_) {                                                           \
        unsigned pos_ = i_ + (unsigned)__builtin_ctz(mask_);                    \
        mask_ &= mask_ - 1;                                                     \
        EMIT(pos_, (b)[pos_])                                                   \
      }                                                                         \
    }                                                                           \
    for (; i_ < (len); i_++) {                                                  \
      unsigned char c_ = (b)[i_];                                               \
      if (c_ == ',' || c_ == '\n') EMIT(i_, c_)                                 \
    }                                                                           \
  }

#endif
