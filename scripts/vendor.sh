#!/usr/bin/env bash
# Copy the speech library and its ONNX runtime into ./vendor so the site does not need a CDN.
# Usage: bash scripts/vendor.sh [output-folder]
set -euo pipefail
VERSION="3.5.1"
OUT="${1:-vendor}"
TMP="$(mktemp -d)"
mkdir -p "$OUT"
( cd "$TMP" && npm pack "@huggingface/transformers@${VERSION}" --silent && tar -xzf huggingface-transformers-*.tgz )
cp "$TMP/package/dist/transformers.min.js" \
   "$TMP/package/dist/ort-wasm-simd-threaded.jsep.mjs" \
   "$TMP/package/dist/ort-wasm-simd-threaded.jsep.wasm" "$OUT/"
rm -rf "$TMP"
echo "Vendored transformers.js ${VERSION} into $OUT/"
