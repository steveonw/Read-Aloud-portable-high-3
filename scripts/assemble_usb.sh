#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
WASM_DIR="$PROJECT_ROOT/build/wasm"
LAUNCHERS="$PROJECT_ROOT/build/launchers"
OUTPUT_ROOT="$PROJECT_ROOT/dist/ReadAloudUSB-Lessac-High"

if [[ ! -d "$WASM_DIR" ]]; then
  printf 'Missing WASM build. Run scripts/build_wasm.sh first.\n' >&2
  exit 1
fi
if [[ ! -d "$LAUNCHERS" ]]; then
  printf 'Missing launchers. Run scripts/build_launchers.sh first.\n' >&2
  exit 1
fi

rm -rf "$OUTPUT_ROOT"
mkdir -p \
  "$OUTPUT_ROOT/shared" \
  "$OUTPUT_ROOT/platform/linux" \
  "$OUTPUT_ROOT/START - MACOS.app/Contents/MacOS" \
  "$OUTPUT_ROOT/START - MACOS.app/Contents/Resources" \
  "$OUTPUT_ROOT/LICENSES"

cp -R "$WASM_DIR"/. "$OUTPUT_ROOT/shared"/
cp "$PROJECT_ROOT/web/start-here.html" "$OUTPUT_ROOT/START HERE.html"
cp "$LAUNCHERS/readaloud-windows-x64.exe" "$OUTPUT_ROOT/START - WINDOWS.exe"
cp "$LAUNCHERS/readaloud-linux-x64" "$OUTPUT_ROOT/platform/linux/readaloud-server"
cp "$LAUNCHERS/readaloud-macos-universal" "$OUTPUT_ROOT/START - MACOS.app/Contents/MacOS/readaloud"
cp "$PROJECT_ROOT/packaging/macos/Info.plist" "$OUTPUT_ROOT/START - MACOS.app/Contents/Info.plist"
cp "$PROJECT_ROOT/LICENSES/NOTICE.txt" "$OUTPUT_ROOT/LICENSES/NOTICE.txt"
cp "$PROJECT_ROOT/packaging/linux/start-linux.sh" "$OUTPUT_ROOT/START - LINUX.sh"
cp "$PROJECT_ROOT/README-USB.txt" "$OUTPUT_ROOT/README.txt"

chmod +x \
  "$OUTPUT_ROOT/START - LINUX.sh" \
  "$OUTPUT_ROOT/platform/linux/readaloud-server" \
  "$OUTPUT_ROOT/START - MACOS.app/Contents/MacOS/readaloud"

(
  cd "$OUTPUT_ROOT"
  find . -type f ! -name SHA256SUMS.txt -print0 \
    | sort -z \
    | xargs -0 sha256sum > SHA256SUMS.txt
)

rm -f "$PROJECT_ROOT/dist/ReadAloudUSB-Lessac-High.zip"
(
  cd "$PROJECT_ROOT/dist"
  zip -q -r -9 ReadAloudUSB-Lessac-High.zip ReadAloudUSB-Lessac-High
)

printf 'USB folder: %s\n' "$OUTPUT_ROOT"
printf 'ZIP archive: %s\n' "$PROJECT_ROOT/dist/ReadAloudUSB-Lessac-High.zip"
