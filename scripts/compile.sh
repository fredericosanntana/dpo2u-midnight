#!/usr/bin/env bash
# Compile every Compact contract with a PINNED compiler version.
#
# Pinned to compactc 0.31.0 — its generated code targets compact-runtime 0.16.0
# (checkRuntimeVersion('0.16.0')) and language-version 0.23.0, which matches the
# versions pinned in package.json. Override with COMPACT_VERSION=x.y.z if needed.
set -euo pipefail

COMPILER_VERSION="${COMPACT_VERSION:-0.31.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

rm -rf build
mkdir -p build

fail=0
for src in compact/*.compact; do
  name="$(basename "$src" .compact)"
  printf '→ %-22s (compactc %s)\n' "$name" "$COMPILER_VERSION"
  if compact compile "+$COMPILER_VERSION" "$src" "build/$name" >/dev/null 2>"build/$name.err"; then
    echo "  ✓ $name"
    rm -f "build/$name.err"
  else
    echo "  ✗ FAIL: $name"
    sed 's/^/      /' "build/$name.err" || true
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "Compilation FAILED for one or more contracts." >&2
  exit 1
fi
echo "All contracts compiled (compactc $COMPILER_VERSION)."
