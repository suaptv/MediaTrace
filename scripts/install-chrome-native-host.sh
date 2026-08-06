#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(dirname -- "$SCRIPT_DIR")
KEY_PATH="$PROJECT_DIR/dist/chrome/mediatrace.pem"
SOURCE_PATH="$PROJECT_DIR/native-host/Sources/main.swift"
INSTALL_DIR="$HOME/Library/Application Support/MediaTrace"
CHROME_HOST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
EDGE_HOST_DIR="$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
APP_DIR="$INSTALL_DIR/MediaTrace Native Host.app"
HOST_PATH="$APP_DIR/Contents/MacOS/mediatrace-native-host"
MODULE_CACHE="$INSTALL_DIR/ModuleCache"
HOST_ID_STATE="$INSTALL_DIR/NativeHostIdentifier"
DEFAULT_NATIVE_ID="app.mediatrace"
NATIVE_ID=${MEDIATRACE_NATIVE_ID:-${MEDIATRACE_NATIVE_BUNDLE_ID:-$DEFAULT_NATIVE_ID}}
SIGN_IDENTITY=${MEDIATRACE_CODESIGN_IDENTITY:--}

if [ -t 0 ] && [ -z "${MEDIATRACE_NATIVE_ID:-}${MEDIATRACE_NATIVE_BUNDLE_ID:-}" ]; then
  printf 'Native Host Identifier [%s]: ' "$DEFAULT_NATIVE_ID"
  IFS= read -r ENTERED_NATIVE_ID
  [ -z "$ENTERED_NATIVE_ID" ] || NATIVE_ID=$ENTERED_NATIVE_ID
fi

case "$NATIVE_ID" in
  *[!a-z0-9_.]*|.*|*.|*..*)
    echo "Error: invalid Native Host Identifier: $NATIVE_ID" >&2
    exit 1
    ;;
esac

case "$NATIVE_ID" in
  *.*) ;;
  *)
    echo "Error: Native Host Identifier must contain at least one dot: $NATIVE_ID" >&2
    exit 1
    ;;
esac
case "$NATIVE_ID" in
  *.extension)
    echo "Error: Native Host must not reuse a Safari Extension Bundle Identifier: $NATIVE_ID" >&2
    exit 1
    ;;
esac

# One identifier is used by the extension, native manifest and signed app.
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $NATIVE_ID" \
  "$PROJECT_DIR/native-host/Info.plist"
node -e '
  const fs = require("fs");
  const file = process.argv[1], id = process.argv[2];
  const source = fs.readFileSync(file, "utf8");
  const updated = source.replace(/const NATIVE_APP_ID = "[^"]+";/, `const NATIVE_APP_ID = "${id}";`);
  if (updated === source && !source.includes(`const NATIVE_APP_ID = "${id}";`)) throw new Error("NATIVE_APP_ID not found");
  fs.writeFileSync(file, updated);
' "$PROJECT_DIR/src/background.js" "$NATIVE_ID"
node "$PROJECT_DIR/scripts/prepare-chromium-background.mjs"
CHROME_MANIFEST_PATH="$CHROME_HOST_DIR/$NATIVE_ID.json"
EDGE_MANIFEST_PATH="$EDGE_HOST_DIR/$NATIVE_ID.json"

if [ ! -f "$KEY_PATH" ]; then
  echo "Chromium extension private key is absent; generating a new local CRX identity..."
  "$PROJECT_DIR/scripts/build-chrome-crx.sh"
fi
if [ ! -f "$KEY_PATH" ]; then
  echo "Error: the Chromium package did not generate the private key: $KEY_PATH" >&2
  exit 1
fi

# Write the PEM public key into manifest.json so Chrome assigns the same ID to
# both the unpacked folder and the CRX package.
EXTENSION_ID=$(node "$PROJECT_DIR/scripts/sync-chrome-extension-id.mjs" "$PROJECT_DIR/manifest.json" "$KEY_PATH")
if [ ${#EXTENSION_ID} -ne 32 ]; then
  echo "Error: failed to derive the Chrome extension ID." >&2
  exit 1
fi

# Retain IDs from older unpacked installations during migration. A caller may
# also provide a currently visible Chrome ID when Chrome has not flushed its
# profile Preferences file yet.
ALLOWED_ORIGINS="\"chrome-extension://$EXTENSION_ID/\""
EXTRA_EXTENSION_IDS="${MEDIATRACE_CHROME_EXTENSION_IDS:-${MEDIATRACE_CHROME_EXTENSION_ID:-}} ${MEDIATRACE_EDGE_EXTENSION_IDS:-${MEDIATRACE_EDGE_EXTENSION_ID:-}}"
for EXTRA_ID in $(printf '%s' "$EXTRA_EXTENSION_IDS" | tr ',' ' '); do
  case "$EXTRA_ID" in
    *[!a-p]*)
      echo "Error: invalid Chrome extension ID: $EXTRA_ID" >&2
      exit 1
      ;;
  esac
  if [ ${#EXTRA_ID} -ne 32 ]; then
    echo "Error: invalid Chrome extension ID: $EXTRA_ID" >&2
    exit 1
  fi
  case "$ALLOWED_ORIGINS" in
    *"chrome-extension://$EXTRA_ID/"*) ;;
    *) ALLOWED_ORIGINS="$ALLOWED_ORIGINS, \"chrome-extension://$EXTRA_ID/\"" ;;
  esac
done
for BROWSER_DATA_DIR in "$HOME/Library/Application Support/Google/Chrome" "$HOME/Library/Application Support/Microsoft Edge"; do
  for PREFERENCES_PATH in "$BROWSER_DATA_DIR"/*/Preferences "$BROWSER_DATA_DIR"/*/"Secure Preferences"; do
  [ -f "$PREFERENCES_PATH" ] || continue
  UNPACKED_IDS=$(node -e '
    const fs = require("fs");
    const path = require("path");
    const prefs = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const project = fs.realpathSync(process.argv[2]);
    for (const [id, setting] of Object.entries(prefs.extensions?.settings ?? {})) {
      if (!setting?.path) continue;
      try {
        if (fs.realpathSync(path.resolve(setting.path)) === project) process.stdout.write(`${id}\n`);
      } catch {}
    }
  ' "$PREFERENCES_PATH" "$PROJECT_DIR" || true)
  for UNPACKED_ID in $UNPACKED_IDS; do
    case "$ALLOWED_ORIGINS" in
      *"chrome-extension://$UNPACKED_ID/"*) ;;
      *) ALLOWED_ORIGINS="$ALLOWED_ORIGINS, \"chrome-extension://$UNPACKED_ID/\"" ;;
    esac
  done
  done
done

mkdir -p "$APP_DIR/Contents/MacOS" "$CHROME_HOST_DIR" "$EDGE_HOST_DIR" "$MODULE_CACHE"
if [ -f "$HOST_ID_STATE" ]; then
  PREVIOUS_NATIVE_ID=$(sed -n '1p' "$HOST_ID_STATE")
  if [ -n "$PREVIOUS_NATIVE_ID" ] && [ "$PREVIOUS_NATIVE_ID" != "$NATIVE_ID" ]; then
    rm -f "$CHROME_HOST_DIR/$PREVIOUS_NATIVE_ID.json" "$EDGE_HOST_DIR/$PREVIOUS_NATIVE_ID.json"
  fi
fi
xcrun swiftc -module-cache-path "$MODULE_CACHE" -O "$SOURCE_PATH" -o "$HOST_PATH"
chmod 755 "$HOST_PATH"
cp "$PROJECT_DIR/native-host/Info.plist" "$APP_DIR/Contents/Info.plist"
if [ "$SIGN_IDENTITY" = "-" ]; then
  codesign --force --sign - "$APP_DIR" >/dev/null
else
  codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$APP_DIR" >/dev/null
fi

sed -e "s|__NATIVE_HOST_NAME__|$NATIVE_ID|g" -e "s|__HOST_PATH__|$HOST_PATH|g" -e "s|__ALLOWED_ORIGINS__|$ALLOWED_ORIGINS|g" \
  "$PROJECT_DIR/native-host/native-host.json.template" > "$CHROME_MANIFEST_PATH"
cp "$CHROME_MANIFEST_PATH" "$EDGE_MANIFEST_PATH"
chmod 644 "$CHROME_MANIFEST_PATH" "$EDGE_MANIFEST_PATH"
printf '%s\n' "$NATIVE_ID" > "$HOST_ID_STATE"

echo "MediaTrace Chrome/Edge Native Host installed."
echo "Native Host Identifier: $NATIVE_ID"
echo "Code Sign Identity: $SIGN_IDENTITY"
echo "Extension ID: $EXTENSION_ID"
echo "Allowed origins: $ALLOWED_ORIGINS"
echo "Executable: $HOST_PATH"
echo "Chrome Manifest: $CHROME_MANIFEST_PATH"
echo "Edge Manifest: $EDGE_MANIFEST_PATH"
echo "Restart Chrome and Microsoft Edge before using DLNA discovery."
