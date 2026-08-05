#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(dirname -- "$SCRIPT_DIR")
PBXPROJ="$PROJECT_DIR/safari-project/MediaTrace/MediaTrace.xcodeproj/project.pbxproj"
DEFAULT_BASE_ID="app.mediatrace"
BASE_ID=${MEDIATRACE_APPLE_BASE_ID:-$DEFAULT_BASE_ID}
TEAM_ID=${MEDIATRACE_APPLE_TEAM_ID:-}

if [ -t 0 ] && [ -z "${MEDIATRACE_APPLE_BASE_ID:-}" ]; then
  printf 'Apple Base Bundle Identifier [%s]: ' "$DEFAULT_BASE_ID"
  IFS= read -r ENTERED_BASE_ID
  [ -z "$ENTERED_BASE_ID" ] || BASE_ID=$ENTERED_BASE_ID
fi
if [ -t 0 ] && [ -z "$TEAM_ID" ]; then
  printf 'Apple Developer Team ID: '
  IFS= read -r TEAM_ID
fi

case "$BASE_ID" in
  *[!A-Za-z0-9.-]*|.*|*.|*..*) echo "Error: invalid Base Bundle Identifier: $BASE_ID" >&2; exit 1 ;;
esac
case "$BASE_ID" in *.*) ;; *) echo "Error: Base Bundle Identifier must contain a dot" >&2; exit 1 ;; esac
case "$TEAM_ID" in
  ''|*[!A-Za-z0-9]*) echo "Error: Apple Developer Team ID is required and must be alphanumeric" >&2; exit 1 ;;
esac

node -e '
  const fs = require("fs");
  const file = process.argv[1], base = process.argv[2], team = process.argv[3];
  const source = fs.readFileSync(file, "utf8");
  let changed = 0;
  const output = source.replace(/buildSettings = \{([\s\S]*?)\n\s*\};/g, (whole, body) => {
    const plist = body.match(/INFOPLIST_FILE = "([^"]+)";/)?.[1];
    if (!plist || !/(?:iOS|macOS) \((?:App|Extension)\)\/Info\.plist/.test(plist)) return whole;
    const extension = plist.includes("(Extension)");
    const bundle = `${base}${extension ? ".Extension" : ""}`;
    let updated = body.replace(/\n\s*DEVELOPMENT_TEAM = [^;]+;/g, "");
    updated = updated.replace(/(CODE_SIGN_STYLE = Automatic;)/, `$1\n\t\t\t\tDEVELOPMENT_TEAM = ${team};`);
    updated = updated.replace(/PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/, `PRODUCT_BUNDLE_IDENTIFIER = ${bundle};`);
    changed += 1;
    return `buildSettings = {${updated}\n\t\t\t};`;
  });
  if (changed !== 8) throw new Error(`Expected 8 Apple build configurations, updated ${changed}`);
  fs.writeFileSync(file, output);
' "$PBXPROJ" "$BASE_ID" "$TEAM_ID"

echo "Apple signing configuration updated."
echo "Team ID: $TEAM_ID"
echo "iOS App: $BASE_ID"
echo "iOS Extension: $BASE_ID.Extension"
echo "macOS App: $BASE_ID"
echo "macOS Extension: $BASE_ID.Extension"
