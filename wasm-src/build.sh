#!/usr/bin/env bash
# Build NAM Core (with the A2 and experimental fast paths) as a standalone WebAssembly module.
#
#   wasm/build.sh                       -> web/wasm/nam.wasm (shipping build)
#   OUT_DIR=build/wasm-variants SIMD=0 SSE=0 FAST_MATH=0 OUT_NAME=nam-scalar wasm/build.sh
#
# Shipping flags: -msimd128 -msse4.2 -ffast-math. -msse4.2 exposes Emscripten's
# SSE-on-SIMD128 headers so Eigen takes its SSE packet path (it has no wasm
# backend); -ffast-math mirrors the native tool's -Ofast. Both were measured
# (tools/bench-nam.mjs) and both keep WASM-vs-native parity at ~1e-7.
#
# NAM_CORE_DIR points at the NAM Core fork (read-only; nothing is written there). CI uses wasm/ci-build.sh,
# which builds pinned public sources (wasm/PINS) instead.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
NAM_CORE_DIR="${NAM_CORE_DIR:-$root/../nam-upstream/experimental-fast}"
EMSDK="${EMSDK:-$HOME/emsdk}"
# shellcheck disable=SC1091
source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1
SIMD="${SIMD:-1}"
SSE="${SSE:-1}"
FAST_MATH="${FAST_MATH:-1}"
out="${OUT_DIR:-$root/web/wasm}"
case "$out" in /*) ;; *) out="$root/$out";; esac
mkdir -p "$out"
name=nam
simd_flags=(-mno-simd128)
if [[ "$SIMD" == 1 ]]; then simd_flags=(-msimd128); else name=nam-scalar; fi
# SSE=1: also expose Emscripten's SSE-on-SIMD128 intrinsics, so Eigen takes its
# SSE packet path (Eigen has no native wasm backend).
if [[ "$SSE" == 1 && "$SIMD" == 1 ]]; then simd_flags+=(-msse4.2); fi
if [[ "$FAST_MATH" == 1 ]]; then simd_flags+=(-ffast-math -Wno-nan-infinity-disabled); fi
name="${OUT_NAME:-$name}"
# shellcheck disable=SC2206
extra=(${EXTRA_FLAGS:-})

srcs=( "$NAM_CORE_DIR"/NAM/*.cpp "$NAM_CORE_DIR"/NAM/wavenet/*.cpp "$here/nam_wasm.cpp" )
em++ -std=c++20 -O3 "${simd_flags[@]}" ${extra[@]+"${extra[@]}"} -fwasm-exceptions \
  -DNAM_SAMPLE_FLOAT -DNAM_ENABLE_A2_FAST -DNDEBUG \
  -I"$NAM_CORE_DIR" -I"$NAM_CORE_DIR/NAM" \
  -I"$NAM_CORE_DIR/Dependencies/eigen" -I"$NAM_CORE_DIR/Dependencies/nlohmann" \
  -sSTANDALONE_WASM=1 --no-entry \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16MB -sSTACK_SIZE=1MB \
  -sFILESYSTEM=0 \
  "${srcs[@]}" -o "$out/$name.wasm"

commit="$(git -C "$NAM_CORE_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
branch="$(git -C "$NAM_CORE_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
python3 - "$out/$name.wasm" "$commit" "$branch" "${simd_flags[*]}" <<'PY'
import hashlib, json, os, sys, subprocess
p, commit, branch, flags = sys.argv[1:]
info_path = os.path.join(os.path.dirname(p), "build-info.json")
info = json.load(open(info_path)) if os.path.exists(info_path) else {}
emcc = subprocess.run(["emcc", "--version"], capture_output=True, text=True).stdout.splitlines()[0]
info[os.path.basename(p)] = {
    "sha256": hashlib.sha256(open(p, "rb").read()).hexdigest(),
    "bytes": os.path.getsize(p),
    "nam_core": {"branch": branch, "commit": commit},
    "flags": "-O3 -fwasm-exceptions " + flags,
    "emcc": emcc,
}
json.dump(info, open(info_path, "w"), indent=1)
PY
ls -la "$out/$name.wasm"
