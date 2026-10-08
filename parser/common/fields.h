// parser/common/fields.h
//
// The cell readers both shape readers share: a number, an hour, a date, a
// TOU, and the walk that finds every field boundary in a block. They are one
// copy because a Date or a value must read the same whichever shape carried
// it; two copies drift, and a file then parses differently by layout alone.
//
// Nothing here knows a shape or a kind: each function takes bytes and returns
// a number, so including this cannot carry a kind token across a parser ABI.
// Everything is `static` in a header rather than a linked object: each
// block.c is one translation unit built with -flto, and the per-cell calls
// must inline into its field loop. Only the cold retry of a refused value
// stays out of line.

#ifndef GRIDVIEW_PARSER_FIELDS_H
#define GRIDVIEW_PARSER_FIELDS_H

#include <wasm_simd128.h>

// Cumulative days before each month, and each month's length, on a leap
// calendar: every year is laid out as 366 days, so a date is the same day
// index in every year and Feb 29 is day 59 whether or not the year has one.
static const unsigned short CUM[12] = {0,31,60,91,121,152,182,213,244,274,305,335};
static const unsigned char  DIM[12] = {31,29,31,30,31,30,31,31,30,31,30,31};

// date_to_day's refusal: an unreadable date, or a day its year lacks.
#define NO_DAY 0xFFFFFFFFu

// read_tou's refusal: neither OnPeak nor OffPeak.
#define NO_TOU 0xFFu

// The padding exports put around a field. A Name, TOU or value that is merely
// spaced reads as its trimmed self.
static inline int is_pad(unsigned char c) { return c == ' ' || c == '\t'; }

static inline void trim_field(const unsigned char** p, const unsigned char** e) {
  while (*p < *e && is_pad(**p)) (*p)++;
  while (*e > *p && is_pad((*e)[-1])) (*e)--;
}

static inline float parse_float_or(const unsigned char* p, const unsigned char* e,
                                   unsigned* bad);

// A value parse_float refused. Padding is not an error: trim and read again.
// Blank is absent; anything else (`N/A`, `#VALUE!`) is counted in `*bad` for
// the reader to refuse. Out of line and cold, so the clean cell's path is
// parse_float's alone.
__attribute__((noinline, cold))
static float reread_value(const unsigned char* p, const unsigned char* e, unsigned* bad) {
  trim_field(&p, &e);
  if (e <= p) return 0.0f / 0.0f;
  float v = parse_float_or(p, e, 0);
  if (v != v) (*bad)++;
  return v;
}

// f64 digit accumulation. Do NOT swap in fast_float's Eisel-Lemire: it lost on
// wasm32 when measured. Re-measure before believing either result.
// Exponent notation is real (`2.568664E-03`, `7E-05` for near-zero values) and
// must parse: NaN would silently read as an absent cell.
//
// With `bad`, a refused field goes to reread_value instead of reading as NaN.
// Each refusal is an exit the parse already branches on, so the retry costs a
// clean cell nothing: an extra NaN test on every cell measured 3-5% slower.
static inline float parse_float_or(const unsigned char* p, const unsigned char* e,
                                   unsigned* bad) {
  if (e <= p) return 0.0f / 0.0f;
  const unsigned char* const field = p;
  int neg = 0;
  if (*p == '-') { neg = 1; p++; }
  else if (*p == '+') { p++; }

  // Integer part, then `frac / scale`. This rounds twice where strtod rounds
  // once: a 1-ulp float32 difference on a few cells of 8-digit money columns
  // and the widest flow columns. MEASURED, do not "fix": one f64 mantissa with
  // a single division costs 20% throughput and changes none of those cells.
  // The reference comparison gates this at <= 1 ulp.
  const unsigned char* digits = p;
  double ip = 0.0;
  while (p < e) {
    unsigned d = (unsigned)(*p - '0');
    if (d > 9) break;
    ip = ip * 10.0 + (double)d;
    p++;
  }
  int any = p > digits;
  double v = ip;
  if (p < e && *p == '.') {
    p++;
    const unsigned char* frac = p;
    double f = 0.0, sc = 1.0;
    while (p < e) {
      unsigned d = (unsigned)(*p - '0');
      if (d > 9) break;
      f = f * 10.0 + (double)d;
      sc *= 10.0;
      p++;
    }
    any |= p > frac;
    v += f / sc;
  }
  // A lone `-` or `.` has no digits: not a zero, and refused.
  if (!any) return bad ? reread_value(field, e, bad) : 0.0f / 0.0f;
  if (p < e && (*p == 'e' || *p == 'E')) {
    p++;
    int eneg = 0;
    if (p < e && (*p == '-' || *p == '+')) { eneg = (*p == '-'); p++; }
    const unsigned char* exp = p;
    int ex = 0;
    while (p < e) {
      unsigned d = (unsigned)(*p - '0');
      if (d > 9) break;
      ex = ex * 10 + (int)d;
      if (ex > 400) ex = 400;   // past f32 range either way
      p++;
    }
    if (p == exp) return bad ? reread_value(field, e, bad) : 0.0f / 0.0f;
    // Exponentiation by squaring: no libm in a freestanding module.
    double scale = 1.0, base = 10.0;
    for (int k = ex; k; k >>= 1) { if (k & 1) scale *= base; base *= base; }
    v = eneg ? v / scale : v * scale;
  }

  // Leftover characters make the field NaN: a partial parse of a mangled
  // field would be a plausible wrong number.
  if (p != e) return bad ? reread_value(field, e, bad) : 0.0f / 0.0f;
  return (float)(neg ? -v : v);
}

static inline float parse_float(const unsigned char* p, const unsigned char* e) {
  return parse_float_or(p, e, 0);
}

// A value cell: NaN for a blank (absent), the number otherwise, and anything
// else counted in `*bad`.
static inline float read_value(const unsigned char* p, const unsigned char* e, unsigned* bad) {
  return parse_float_or(p, e, bad);
}

// Hour-ending 1-24, or 0 for anything unreadable (which both readers refuse
// as out of range). `1.0` is how a spreadsheet re-save writes 1; `13.5` and
// `7:00` are not hours.
static inline unsigned read_hour(const unsigned char* p, const unsigned char* e) {
  trim_field(&p, &e);
  const unsigned char* digits = p;
  unsigned v = 0;
  for (; p < e; p++) {
    unsigned d = (unsigned)(*p - '0');
    if (d > 9) break;
    if (v < 1000u) v = v * 10u + d;
  }
  if (p == digits) return 0;
  if (p < e && *p == '.') { p++; while (p < e && *p == '0') p++; }
  return p == e ? v : 0;
}

// Does the field spell `word` (lower case), ignoring case and the spaces,
// dashes and underscores exports put in it ("On-Peak", "ON PEAK")?
static inline int spells(const unsigned char* p, const unsigned char* e, const char* word) {
  for (; p < e; p++) {
    unsigned char c = *p;
    if (is_pad(c) || c == '-' || c == '_') continue;
    if (*word == 0 || (c | 0x20) != (unsigned char)*word) return 0;
    word++;
  }
  return *word == 0;
}

// 1 = OnPeak, 0 = OffPeak, NO_TOU for anything else. TOU is file data, never
// a default: a blank or a third label ("Shoulder") is refused, not OffPeak.
static inline unsigned read_tou(const unsigned char* p, const unsigned char* e) {
  // The exact spellings first: `spells` on every row costs ~2% of a parse.
  if (e - p == 6 && p[0] == 'O' && p[1] == 'n' && p[2] == 'P' && p[3] == 'e' && p[4] == 'a' &&
      p[5] == 'k') return 1u;
  if (e - p == 7 && p[0] == 'O' && p[1] == 'f' && p[2] == 'f' && p[3] == 'P' && p[4] == 'e' &&
      p[5] == 'a' && p[6] == 'k') return 0u;
  if (spells(p, e, "onpeak")) return 1u;
  if (spells(p, e, "offpeak")) return 0u;
  return NO_TOU;
}

// Digits up to a stop byte, or `e`. Returns the pointer past them, or null for
// no digits, so `1//2035` and `a/1/2035` do not read as a date.
static inline const unsigned char* read_digits(const unsigned char* p, const unsigned char* e,
                                               unsigned* out) {
  const unsigned char* start = p;
  unsigned v = 0;
  for (; p < e; p++) {
    unsigned d = (unsigned)(*p - '0');
    if (d > 9) break;
    if (v < 100000u) v = v * 10u + d;
  }
  *out = v;
  return p > start ? p : 0;
}

// A time after the date: a spreadsheet re-save writes `1/1/2035 0:00` or
// `1/1/2035 12:00:00 AM`. Midnight says no more than the date, so it reads
// through; any other time is refused, since the Hour cell places the row and
// a second clock could contradict it.
static inline int is_midnight(const unsigned char* p, const unsigned char* e) {
  unsigned h = 0, m = 0, s = 0;
  p = read_digits(p, e, &h);
  if (!p || p == e || *p != ':') return 0;
  p = read_digits(p + 1, e, &m);
  if (!p || m) return 0;
  if (p < e && *p == ':') {
    p = read_digits(p + 1, e, &s);
    if (!p || s) return 0;
  }
  while (p < e && is_pad(*p)) p++;
  if (p == e) return h == 0;
  return h == 12 && e - p == 2 && (p[0] | 0x20) == 'a' && (p[1] | 0x20) == 'm';
}

// M/D/YYYY -> leap-calendar day 0..365 or NO_DAY, with the year in `*yearOut`
// for the reader to place the row in the Case's years. The day must exist in
// its month, so 4/31 is refused rather than read as May 1, and 2/29 must
// exist in its year: in any other it is a mangled date, not an empty slot.
static inline unsigned date_to_day(const unsigned char* p, const unsigned char* e,
                                   unsigned* yearOut) {
  unsigned month = 0, day = 0, year = 0;
  *yearOut = 0;
  trim_field(&p, &e);
  p = read_digits(p, e, &month);
  if (!p || p == e || *p != '/') return NO_DAY;
  p = read_digits(p + 1, e, &day);
  if (!p || p == e || *p != '/') return NO_DAY;
  p = read_digits(p + 1, e, &year);
  if (!p) return NO_DAY;
  if (p != e) {
    if (!is_pad(*p)) return NO_DAY;
    while (is_pad(*p)) p++;   // trimmed, so a non-pad byte stops this first
    if (!is_midnight(p, e)) return NO_DAY;
  }
  *yearOut = year;
  if (month < 1 || month > 12 || day < 1 || day > DIM[month - 1]) return NO_DAY;
  if (month == 2 && day == 29 &&
      !((year % 4u == 0u && year % 100u != 0u) || year % 400u == 0u)) return NO_DAY;
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
