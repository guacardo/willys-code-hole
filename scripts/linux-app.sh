#!/bin/sh
# Installs a .desktop launcher that runs the repo-local Electron against this checkout's out/.
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$HOME/.local/share/applications"
mkdir -p "$DIR"
rm -f "$DIR/willys-code-closet.desktop"
cat > "$DIR/willys-code-hole.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Willy's Code Hole
Exec="$REPO/node_modules/electron/dist/electron" "$REPO" --ozone-platform-hint=auto
Icon=$REPO/resources/icon.png
StartupWMClass=willys-code-hole
Categories=Development;
Terminal=false
EOF
echo "$DIR/willys-code-hole.desktop"
