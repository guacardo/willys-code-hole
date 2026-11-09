#!/bin/sh
# Renders resources/icon.svg to resources/icon.png on Apple's 1024 icon grid (824 body, 100 margin),
# so the Dock and ⌘-Tab size it like other apps and draw their highlight around it.
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
rsvg-convert -w 824 -h 824 "$REPO/resources/icon.svg" |
  magick - -background none -gravity center -extent 1024x1024 "$REPO/resources/icon.png"
echo "$REPO/resources/icon.png"
