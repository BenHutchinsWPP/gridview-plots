#!/usr/bin/env bash
# Build the WASM CSV parser for wide-shape exports (Date,Hour,TOU + one column
# per entity). Freestanding wasm32: no libc, no imports.
#
# Toolchain: clang 18 plus wasm-ld (`sudo apt-get install -y lld-18`).
#
# The two byte budgets are -D parameters, so one source yields variants:
#
#   ./build.sh                                  # the shipping build
#   ARENA_MIB=4 OUT=block-a4.wasm ./build.sh    # a smaller per-block arena
#   BLOCK_MIB=8 OUT=block-b8.wasm ./build.sh    # a smaller input window
#
# Width is not a build parameter: configure() splits the arena at runtime.
#
# The DEFAULTS ARE THE SHIPPING BUILD that the committed block.wasm is built
# from. A variant goes in its own OUT, never block.wasm.
#
# Linear memory is DERIVED from the same arrays block.c declares, so a
# variant whose statics do not fit refuses to build instead of trapping inside
# a parse.
#
set -euo pipefail
cd "$(dirname "$0")"

CLANG=${CLANG:-clang-18}
export PATH="/usr/lib/llvm-18/bin:$PATH"   # wasm-ld lives here

# ---- budgets. Both are reported back out by the module (inbuf_size,
# ---- arena_bytes) and read by src/tables/wide/block.ts, which sizes each
# ---- block's layout from them rather than mirroring a constant.
BLOCK_MIB=${BLOCK_MIB:-12}                       # input window
ARENA_MIB=${ARENA_MIB:-9}                        # one block's values, hours, TOU
OUT=${OUT:-block.wasm}

# Slack above the static arrays: only wasm-ld's shadow stack lives there (no
# libc, malloc or memory.grow). HEADROOM_MIB=0 fails the link at 66,640 B over
# the statics (64 KiB stack plus globals), so 1 MiB is 16x the need, and an
# array that outgrows it fails at the link.
HEADROOM_MIB=${HEADROOM_MIB:-1}

MIB=$((1024 * 1024))
BLOCK_BYTES=$((BLOCK_MIB * MIB))
ARENA_BYTES=$((ARENA_MIB * MIB))

# The same two arrays block.c declares; nothing here depends on width.
STATIC_BYTES=$((BLOCK_BYTES + ARENA_BYTES))
STATIC_MIB=$(( (STATIC_BYTES + MIB - 1) / MIB ))
INITIAL_MEMORY_MIB=${INITIAL_MEMORY_MIB:-$((STATIC_MIB + HEADROOM_MIB))}
INITIAL_MEMORY=$((INITIAL_MEMORY_MIB * MIB))

if [ "$INITIAL_MEMORY" -lt "$STATIC_BYTES" ]; then
  echo "refusing to build: ${INITIAL_MEMORY_MIB} MiB of linear memory cannot hold" >&2
  echo "${STATIC_BYTES} B of static arrays at BLOCK_MIB=${BLOCK_MIB}, ARENA_MIB=${ARENA_MIB}." >&2
  exit 1
fi

$CLANG --target=wasm32 -O3 -flto -msimd128 -mbulk-memory \
  -nostdlib -ffreestanding -fno-builtin \
  -DBLOCK_BYTES="${BLOCK_BYTES}u" \
  -DARENA_BYTES="${ARENA_BYTES}u" \
  -Wl,--no-entry \
  -Wl,--export-dynamic \
  -Wl,--initial-memory=$INITIAL_MEMORY \
  -Wl,--lto-O3 \
  -o "$OUT" block.c

echo "built $OUT ($(stat -c%s "$OUT") bytes)"
echo "  input window ${BLOCK_MIB} MiB  arena ${ARENA_MIB} MiB (width is runtime, not built in)"
echo "  statics ${STATIC_MIB} MiB, +${HEADROOM_MIB} MiB headroom"
echo "  => ${INITIAL_MEMORY_MIB} MiB linear memory per worker instance"
