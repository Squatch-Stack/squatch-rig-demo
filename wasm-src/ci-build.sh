#!/usr/bin/env bash
# Build nam.wasm from pinned public sources: upstream NAM Core at NAM_CORE_COMMIT, plus
# wasm/experimental-fast.patch, compiled by the Emscripten version in wasm/PINS. Nothing is read from a
# developer's machine. Used by the Pages workflow; also runs locally:
#
#   wasm/ci-build.sh OUT_DIR [WORK_DIR]       -> OUT_DIR/nam.wasm and OUT_DIR/nam-experimental.wasm (+ build-info.json)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:?usage: ci-build.sh OUT_DIR [WORK_DIR]}"
work="${2:-$(mktemp -d)}"
# shellcheck disable=SC1091
source "$here/PINS"
mkdir -p "$work" "$out"
work="$(cd "$work" && pwd)"; out="$(cd "$out" && pwd)"

if [[ ! -x "$work/emsdk/emsdk" ]]; then
  git clone --quiet --filter=blob:none "$EMSDK_REPO" "$work/emsdk"
  git -C "$work/emsdk" checkout --quiet "$EMSDK_COMMIT"
fi
"$work/emsdk/emsdk" install "$EMSDK_VERSION" >/dev/null
"$work/emsdk/emsdk" activate "$EMSDK_VERSION" >/dev/null

# Two builds from the same pinned commit:
#   nam.wasm               the standard engine: stock upstream NAM Core, nothing added (the default the page loads)
#   nam-experimental.wasm  the same plus wasm/experimental-fast.patch (loaded only when a user selects Experimental)
core="$work/nam-core"
if [[ ! -d "$core/.git" ]]; then
  git clone --quiet --no-checkout "$NAM_CORE_REPO" "$core"
  git -C "$core" checkout --quiet "$NAM_CORE_COMMIT"
  git -C "$core" submodule update --quiet --init --depth 1 Dependencies/eigen
fi
test "$(git -C "$core" rev-parse HEAD)" = "$NAM_CORE_COMMIT"
test -z "$(git -C "$core" status --porcelain --untracked-files=no)" || { echo "stock NAM Core tree is not clean" >&2; exit 1; }

exp="$work/nam-core-experimental"
if [[ ! -d "$exp" ]]; then
  cp -R "$core" "$exp"
  git -C "$exp" apply --whitespace=nowarn "$here/experimental-fast.patch"
fi

EMSDK="$work/emsdk" NAM_CORE_DIR="$core" OUT_DIR="$out" OUT_NAME=nam "$here/build.sh"
EMSDK="$work/emsdk" NAM_CORE_DIR="$exp" OUT_DIR="$out" OUT_NAME=nam-experimental "$here/build.sh"
