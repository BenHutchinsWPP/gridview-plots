#!/usr/bin/env bash
# Build the WASM CSV parser for LONG-shape exports (area, bus, generator).
# Freestanding wasm32: no libc, no imports.
#
# Toolchain: clang 18 plus wasm-ld (`sudo apt-get install -y lld-18`).
#
# The four dimensions are -D parameters, so one source yields variants:
#
#   ./build.sh                                        # the shipping build
#   ARENA_MIB=8 OUT=block-a8.wasm ./build.sh          # a smaller per-block arena
#   AREA_TABLE=8192 MAX_NAMES=8192 OUT=block-8k.wasm ./build.sh
#
# The DEFAULTS ARE THE SHIPPING BUILD that the committed block.wasm is built
# from. A variant goes in its own OUT, never block.wasm. Case width is not
# compiled in (configure() lays out each block at runtime); these move the
# arena's total size and the two hash tables.
#
# Linear memory is DERIVED from the declared arrays, as in the wide build.
#
set -euo pipefail
cd "$(dirname "$0")"

CLANG=${CLANG:-clang-18}
export PATH="/usr/lib/llvm-18/bin:$PATH"   # wasm-ld lives here

# ---- dimensions.
# INBUF and ARENA are reported back out by the module (inbuf_size, arena_bytes).
# The two table capacities have no export -- adding one would change the
# exported surface and so needs an ABI_VERSION bump and a rebuild -- so they are
# OBSERVED instead: area_table_put returns 0 on a full table and axis_overflow()
# counts names past MAX_NAMES. scripts/bench-ingest.mjs probes them that way.
INBUF_MIB=${INBUF_MIB:-12}          # input window
ARENA_MIB=${ARENA_MIB:-20}          # one block's values, row keys, TOU, plan
AREA_TABLE=${AREA_TABLE:-4096}      # routing table capacity; power of two
MAX_NAMES=${MAX_NAMES:-4096}        # axis names one scan may discover; <= AREA_TABLE
OUT=${OUT:-block.wasm}

# Slack above the statics for wasm-ld's shadow stack; see the wide build.
HEADROOM_MIB=${HEADROOM_MIB:-1}

MIB=$((1024 * 1024))
INBUF_BYTES=$((INBUF_MIB * MIB))
ARENA_BYTES=$((ARENA_MIB * MIB))
NAME_TABLE=$((MAX_NAMES * 2))       # block.c derives this; mirrored for the sum

# The same arrays block.c declares: inbuf + arena + areaHash/areaIdx +
# nameHash/nameSlot + nameOff/nameLen.
STATIC_BYTES=$((INBUF_BYTES + ARENA_BYTES + AREA_TABLE * 8 + NAME_TABLE * 8 + MAX_NAMES * 8))
STATIC_MIB=$(( (STATIC_BYTES + MIB - 1) / MIB ))
INITIAL_MEMORY_MIB=${INITIAL_MEMORY_MIB:-$((STATIC_MIB + HEADROOM_MIB))}
INITIAL_MEMORY=$((INITIAL_MEMORY_MIB * MIB))

if [ "$INITIAL_MEMORY" -lt "$STATIC_BYTES" ]; then
  echo "refusing to build: ${INITIAL_MEMORY_MIB} MiB of linear memory cannot hold" >&2
  echo "${STATIC_BYTES} B of static arrays at ARENA_MIB=${ARENA_MIB}," >&2
  echo "AREA_TABLE=${AREA_TABLE}, MAX_NAMES=${MAX_NAMES}." >&2
  exit 1
fi

$CLANG --target=wasm32 -O3 -flto -msimd128 -mbulk-memory \
  -nostdlib -ffreestanding -fno-builtin \
  -DINBUF_BYTES="${INBUF_BYTES}u" \
  -DARENA_BYTES="${ARENA_BYTES}u" \
  -DAREA_TABLE="${AREA_TABLE}u" \
  -DMAX_NAMES="${MAX_NAMES}u" \
  -Wl,--no-entry \
  -Wl,--export-dynamic \
  -Wl,--initial-memory=$INITIAL_MEMORY \
  -Wl,--lto-O3 \
  -o "$OUT" block.c

echo "built $OUT ($(stat -c%s "$OUT") bytes)"
echo "  input window ${INBUF_MIB} MiB  arena ${ARENA_MIB} MiB"
echo "  AREA_TABLE=${AREA_TABLE}  MAX_NAMES=${MAX_NAMES}  NAME_TABLE=${NAME_TABLE}"
echo "  statics ${STATIC_MIB} MiB, +${HEADROOM_MIB} MiB headroom"
echo "  => ${INITIAL_MEMORY_MIB} MiB linear memory per worker instance"
