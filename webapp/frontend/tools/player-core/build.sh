#!/usr/bin/env bash
# Regenerate public/vh-hls-core.min.js from unwrap.entry.js:
#   esbuild (bundle crypto-js) -> javascript-obfuscator (Spayee-level obfuscation).
# Run from anywhere; paths are resolved relative to this script.
set -euo pipefail
cd "$(dirname "$0")/../.."          # -> webapp/frontend
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

npx --yes esbuild tools/player-core/unwrap.entry.js \
  --bundle --format=iife --minify --outfile="$TMP/unwrap.bundle.js"

npx --yes javascript-obfuscator "$TMP/unwrap.bundle.js" \
  --output public/vh-hls-core.min.js \
  --compact true \
  --control-flow-flattening true --control-flow-flattening-threshold 0.75 \
  --dead-code-injection true --dead-code-injection-threshold 0.3 \
  --string-array true --string-array-encoding base64 --string-array-threshold 0.75 \
  --identifier-names-generator hexadecimal \
  --numbers-to-expressions true --simplify true \
  --self-defending false
  # NOTE: transform-object-keys is intentionally OFF — it renames the object keys
  # crypto-js relies on (lib.WordArray, etc.) and breaks decryption.

echo "built public/vh-hls-core.min.js ($(wc -c < public/vh-hls-core.min.js) bytes)"
