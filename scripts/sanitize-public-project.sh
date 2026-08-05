#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(dirname -- "$SCRIPT_DIR")
PBXPROJ="$PROJECT_DIR/safari-project/MediaTrace/MediaTrace.xcodeproj/project.pbxproj"

node -e '
  const fs = require("fs");
  const file = process.argv[1];
  let source = fs.readFileSync(file, "utf8");
  source = source.replace(/\n\s*DEVELOPMENT_TEAM = [^;]+;/g, "");
  source = source.replace(/buildSettings = \{([\s\S]*?)\n\s*\};/g, (whole, body) => {
    const plist = body.match(/INFOPLIST_FILE = "([^"]+)";/)?.[1];
    if (!plist || !/(?:iOS|macOS) \((?:App|Extension)\)\/Info\.plist/.test(plist)) return whole;
    const extension = plist.includes("(Extension)");
    const bundle = `app.mediatrace${extension ? ".Extension" : ""}`;
    const updated = body.replace(/PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/, `PRODUCT_BUNDLE_IDENTIFIER = ${bundle};`);
    return `buildSettings = {${updated}\n\t\t\t};`;
  });
  fs.writeFileSync(file, source);
' "$PBXPROJ"

/usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier app.mediatrace' "$PROJECT_DIR/native-host/Info.plist"
node -e '
  const fs = require("fs"), file = process.argv[1];
  const source = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, source.replace(/const NATIVE_APP_ID = "[^"]+";/, "const NATIVE_APP_ID = \"app.mediatrace\";"));
' "$PROJECT_DIR/src/background.js"
node -e '
  const fs = require("fs"), file = process.argv[1];
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  delete manifest.key;
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
' "$PROJECT_DIR/manifest.json"

rm -f "$PROJECT_DIR/dist/chrome/mediatrace.pem" "$PROJECT_DIR/dist/chrome/mediatrace.crx"
rm -rf "$PROJECT_DIR/safari-project/MediaTrace/MediaTrace.xcodeproj/xcuserdata" \
  "$PROJECT_DIR/safari-project/MediaTrace/MediaTrace.xcodeproj/project.xcworkspace/xcuserdata"

if rg -n 'DEVELOPMENT_TEAM' "$PBXPROJ"; then
  echo "Error: Apple Team ID remains in the Xcode project" >&2
  exit 1
fi
echo "Public project sanitized: personal identifiers, Team IDs, local keys and Xcode user data removed."
