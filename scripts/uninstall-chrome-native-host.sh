#!/bin/sh
set -eu

INSTALL_DIR="$HOME/Library/Application Support/MediaTrace"
APP_DIR="$INSTALL_DIR/MediaTrace Native Host.app"
HOST_ID_STATE="$INSTALL_DIR/NativeHostIdentifier"
NATIVE_ID=$(sed -n '1p' "$HOST_ID_STATE" 2>/dev/null || true)
NATIVE_ID=${NATIVE_ID:-app.mediatrace.native}
CHROME_MANIFEST_PATH="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/$NATIVE_ID.json"
EDGE_MANIFEST_PATH="$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts/$NATIVE_ID.json"

if [ -f "$CHROME_MANIFEST_PATH" ]; then rm "$CHROME_MANIFEST_PATH"; fi
if [ -f "$EDGE_MANIFEST_PATH" ]; then rm "$EDGE_MANIFEST_PATH"; fi
if [ -d "$APP_DIR" ]; then rm -R "$APP_DIR"; fi
if [ -d "$INSTALL_DIR/ModuleCache" ]; then rm -R "$INSTALL_DIR/ModuleCache"; fi
if [ -f "$HOST_ID_STATE" ]; then rm "$HOST_ID_STATE"; fi
if [ -d "$INSTALL_DIR" ]; then rmdir "$INSTALL_DIR" 2>/dev/null || true; fi
echo "MediaTrace Chrome/Edge Native Host removed."
