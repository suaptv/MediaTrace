#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
EXTENSION_DIR=$(dirname -- "$SCRIPT_DIR")
PROJECT_DIR="${1:-$EXTENSION_DIR/safari-project}"
STAGING_DIR=$(mktemp -d "${TMPDIR:-/tmp}/mediatrace-safari.XXXXXX")
trap 'rm -rf "$STAGING_DIR"' EXIT HUP INT TERM

if [ ! -f "$EXTENSION_DIR/manifest.json" ]; then
  echo "Error: manifest.json not found at $EXTENSION_DIR/manifest.json" >&2
  exit 1
fi

cp "$EXTENSION_DIR/manifest.json" "$STAGING_DIR/manifest.json"
cp -R "$EXTENSION_DIR/src" "$STAGING_DIR/src"
cp -R "$EXTENSION_DIR/assets" "$STAGING_DIR/assets"
node "$SCRIPT_DIR/prepare-safari.mjs" "$STAGING_DIR"

XCODE_PROJECT="$PROJECT_DIR/MediaTrace/MediaTrace.xcodeproj/project.pbxproj"
RESOURCE_DIR="$PROJECT_DIR/MediaTrace/Shared (Extension)/Resources"

if [ -f "$XCODE_PROJECT" ] && [ -d "$RESOURCE_DIR" ]; then
  # Update extension resources without recreating the Xcode project. This preserves
  # the user's Team, bundle identifiers, signing, and other Xcode configuration.
  cp -R "$STAGING_DIR/." "$RESOURCE_DIR/"
  echo "Safari extension resources updated at: $RESOURCE_DIR"
else
  xcrun safari-web-extension-converter "$STAGING_DIR" --project-location "$PROJECT_DIR" --app-name "MediaTrace" --bundle-identifier "com.example.mediatrace" --copy-resources --no-open --no-prompt
  echo "Safari Xcode project created at: $PROJECT_DIR"
fi
