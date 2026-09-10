#!/usr/bin/env bash
# Install the OpenRouter Speech-to-Text GNOME Shell extension.
set -euo pipefail

UUID="openrouter-stt@foxxy"
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

mkdir -p "$(dirname "$DEST")"
ln -sfn "$SRC" "$DEST"
glib-compile-schemas "$SRC/schemas"

echo "Installed -> $DEST"
echo
echo "Enable it:  gnome-extensions enable $UUID"
echo "(or restart your session / log out and back in)"