#!/usr/bin/env bash
# Builds the web app of any commit into a folder, for the speed comparison
# (scripts/bench/README.md). The commit is checked out as a temporary git
# worktree next to the repo's own temp folder, built with low priority and
# removed again; only the built folder stays.
#
# Usage: scripts/bench/build-ref.sh <commit|tag|branch|WORKTREE> <out-dir>
#   WORKTREE   builds the current working tree as it is (with uncommitted changes)
# Environment:
#   BENCH_TMP  where the temporary checkout goes (default /tmp/tonuino-bench)
set -Eeuo pipefail

ref="${1:?Aufruf: build-ref.sh <commit|WORKTREE> <ausgabe-ordner>}"
out="${2:?Aufruf: build-ref.sh <commit|WORKTREE> <ausgabe-ordner>}"
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="${BENCH_TMP:-/tmp/tonuino-bench}"
mkdir -p "$tmp"
out="$(mkdir -p "$out" && cd "$out" && pwd)"

# Low priority: the computer stays usable while this builds.
if ionice -c 3 true 2>/dev/null; then low() { nice -n 15 ionice -c 3 "$@"; }; else low() { nice -n 15 "$@"; }; fi

build_in() {
  local dir="$1"
  # Test builds: "Entdecken" may lack its release settings here.
  (cd "$dir" && SOURCES_RELEASE_CHECK=off low npx vite build --logLevel warn --outDir "$out" --emptyOutDir)
}

if [[ "$ref" == WORKTREE ]]; then
  build_in "$ROOT_DIR"
  exit 0
fi

sha="$(git -C "$ROOT_DIR" rev-parse --verify "$ref^{commit}")"
src="$tmp/src-${sha:0:12}"
cleanup() {
  git -C "$ROOT_DIR" worktree remove --force "$src" >/dev/null 2>&1 || rm -rf "$src"
  git -C "$ROOT_DIR" worktree prune >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup
git -C "$ROOT_DIR" worktree add --detach "$src" "$sha" >/dev/null
# The packages of this checkout serve the old commit too (no new dependencies since 0.2).
ln -s "$(readlink -f "$ROOT_DIR/node_modules")" "$src/node_modules"
build_in "$src"
echo "$sha" >"$out/.bench-commit"
