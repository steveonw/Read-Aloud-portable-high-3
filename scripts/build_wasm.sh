#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="${READALOUD_WORK_DIR:-$PROJECT_ROOT/build/work}"
SHERPA_TAG="${SHERPA_TAG:-v1.13.4}"
VOICE_ID="${VOICE_ID:-vits-piper-en_US-lessac-high}"
VOICE_DISPLAY_NAME="${VOICE_DISPLAY_NAME:-Lessac High}"
MODEL_FILENAME="${MODEL_FILENAME:-en_US-lessac-high.onnx}"
MODEL_URL="${MODEL_URL:-https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-lessac-high.tar.bz2}"
REPO_DIR="$WORK_DIR/sherpa-onnx"
MODEL_ARCHIVE="$WORK_DIR/${VOICE_ID}.tar.bz2"
OUTPUT_DIR="$PROJECT_ROOT/build/wasm"

for command in git curl tar emcc cmake python3; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'Missing required build command: %s\n' "$command" >&2
    exit 1
  fi
done

rm -rf "$REPO_DIR" "$OUTPUT_DIR"
mkdir -p "$WORK_DIR" "$OUTPUT_DIR"

printf 'Cloning sherpa-onnx %s...\n' "$SHERPA_TAG"
git clone --depth 1 --branch "$SHERPA_TAG" https://github.com/k2-fsa/sherpa-onnx.git "$REPO_DIR"

printf 'Downloading converted %s model...\n' "$VOICE_DISPLAY_NAME"
curl --fail --location --retry 4 --retry-delay 3 \
  --output "$MODEL_ARCHIVE" "$MODEL_URL"

MODEL_UNPACK="$WORK_DIR/model-unpack"
rm -rf "$MODEL_UNPACK"
mkdir -p "$MODEL_UNPACK"
tar -xjf "$MODEL_ARCHIVE" -C "$MODEL_UNPACK"

MODEL_FILE="$(find "$MODEL_UNPACK" -type f -name "$MODEL_FILENAME" -print -quit)"
TOKENS_FILE="$(find "$MODEL_UNPACK" -type f -name 'tokens.txt' -print -quit)"
ESPEAK_DIR="$(find "$MODEL_UNPACK" -type d -name 'espeak-ng-data' -print -quit)"

if [[ -z "$MODEL_FILE" || -z "$TOKENS_FILE" || -z "$ESPEAK_DIR" ]]; then
  printf 'The %s archive did not contain the expected model, tokens, and espeak-ng-data.\n' "$VOICE_DISPLAY_NAME" >&2
  exit 1
fi

ASSETS="$REPO_DIR/wasm/tts/assets"
find "$ASSETS" -mindepth 1 -maxdepth 1 ! -name README.md -exec rm -rf {} +
cp "$MODEL_FILE" "$ASSETS/model.onnx"
cp "$TOKENS_FILE" "$ASSETS/tokens.txt"
cp -R "$ESPEAK_DIR" "$ASSETS/espeak-ng-data"

printf 'Building single-threaded SIMD WebAssembly TTS for %s...\n' "$VOICE_DISPLAY_NAME"
(
  cd "$REPO_DIR"
  ./build-wasm-simd-tts.sh
)

GENERATED="$REPO_DIR/build-wasm-simd-tts/install/bin/wasm/tts"
if [[ ! -d "$GENERATED" ]]; then
  printf 'Sherpa build completed without the expected output directory: %s\n' "$GENERATED" >&2
  exit 1
fi

cp -R "$GENERATED"/. "$OUTPUT_DIR"/
cp "$PROJECT_ROOT/web/index.html" "$OUTPUT_DIR/index.html"
cp "$PROJECT_ROOT/web/app.js" "$OUTPUT_DIR/app.js"
cp "$PROJECT_ROOT/web/style.css" "$OUTPUT_DIR/style.css"

for required in index.html app.js style.css sherpa-onnx-tts.js sherpa-onnx-tts.worker.js; do
  if [[ ! -f "$OUTPUT_DIR/$required" ]]; then
    printf 'Missing generated file: %s\n' "$required" >&2
    exit 1
  fi
done

if ! compgen -G "$OUTPUT_DIR/*.wasm" >/dev/null; then
  printf 'No .wasm file was generated.\n' >&2
  exit 1
fi
if ! compgen -G "$OUTPUT_DIR/*.data" >/dev/null; then
  printf 'No Emscripten .data package was generated.\n' >&2
  exit 1
fi

cat > "$OUTPUT_DIR/VOICE-EDITION.txt" <<META
Voice edition: $VOICE_DISPLAY_NAME
Sherpa model ID: $VOICE_ID
Model filename: $MODEL_FILENAME
Model source: $MODEL_URL
Sherpa tag: $SHERPA_TAG
META

printf 'WASM application written to %s\n' "$OUTPUT_DIR"
