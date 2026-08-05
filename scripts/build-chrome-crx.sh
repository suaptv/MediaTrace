#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(dirname -- "$SCRIPT_DIR")
OUTPUT_DIR="$PROJECT_DIR/dist/chrome"
PACKAGE_NAME="mediatrace"
STAGING_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/mediatrace-chrome.XXXXXX")
STAGING_EXTENSION="$STAGING_ROOT/$PACKAGE_NAME"
trap 'rm -rf "$STAGING_ROOT"' EXIT HUP INT TERM

if [ ! -f "$PROJECT_DIR/manifest.json" ]; then
  echo "Error: manifest.json not found at $PROJECT_DIR/manifest.json" >&2
  exit 1
fi

if [ -n "${MEDIATRACE_CHROME_BIN:-}" ]; then
  CHROME_BIN="$MEDIATRACE_CHROME_BIN"
elif [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
  CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
elif [ -x "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary" ]; then
  CHROME_BIN="/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
elif [ -x "/Applications/Chromium.app/Contents/MacOS/Chromium" ]; then
  CHROME_BIN="/Applications/Chromium.app/Contents/MacOS/Chromium"
else
  echo "Error: Google Chrome or Chromium was not found in /Applications." >&2
  echo "Set MEDIATRACE_CHROME_BIN to the browser executable path and retry." >&2
  exit 1
fi

mkdir -p "$STAGING_EXTENSION" "$OUTPUT_DIR"
cp "$PROJECT_DIR/manifest.json" "$STAGING_EXTENSION/manifest.json"
cp -R "$PROJECT_DIR/src" "$STAGING_EXTENSION/src"
cp -R "$PROJECT_DIR/assets" "$STAGING_EXTENSION/assets"

KEY_PATH="$OUTPUT_DIR/$PACKAGE_NAME.pem"
if [ -f "$KEY_PATH" ]; then
  "$CHROME_BIN" \
    --pack-extension="$STAGING_EXTENSION" \
    --pack-extension-key="$KEY_PATH" \
    --no-first-run \
    --disable-default-apps
else
  "$CHROME_BIN" \
    --pack-extension="$STAGING_EXTENSION" \
    --no-first-run \
    --disable-default-apps
fi

GENERATED_CRX="$STAGING_ROOT/$PACKAGE_NAME.crx"
GENERATED_PEM="$STAGING_ROOT/$PACKAGE_NAME.pem"
if [ ! -f "$GENERATED_CRX" ]; then
  echo "Error: Chrome did not generate $GENERATED_CRX" >&2
  exit 1
fi

mv -f "$GENERATED_CRX" "$OUTPUT_DIR/$PACKAGE_NAME.crx"
if [ -f "$GENERATED_PEM" ]; then
  mv -f "$GENERATED_PEM" "$KEY_PATH"
  chmod 600 "$KEY_PATH"
fi

# Give unpacked and CRX installations the same stable extension ID. Chrome
# derives an unpacked ID from manifest.key and a packed ID from this PEM; both
# values refer to the same public key after synchronization.
EXTENSION_ID=$(node "$PROJECT_DIR/scripts/sync-chrome-extension-id.mjs" "$PROJECT_DIR/manifest.json" "$KEY_PATH")

echo "Chrome CRX: $OUTPUT_DIR/$PACKAGE_NAME.crx"
echo "Private key: $KEY_PATH"
echo "Extension ID: $EXTENSION_ID"
echo "Keep the PEM private; future builds reuse it to preserve the extension ID."
