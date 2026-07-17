#!/usr/bin/env bash
# Regenerates the PNG icon set from web/public/favicon.svg — the SVG is the
# source of truth; run this after editing the M so the raster icons stay in
# sync:
#   web/public/apple-touch-icon.png  (180x180, iOS home-screen / bookmarks)
#   web/public/favicon-32x32.png     (PNG favicon fallback)
#   web/public/favicon-16x16.png     (PNG favicon fallback)
#
# Renders one high-res master with headless Chrome (small windows render
# unreliably, so render large once) then downscales with Pillow (LANCZOS).
# Requires: Chrome/Chromium + Python 3 with Pillow (`pip install Pillow`).
# Override the browser with CHROME=/path/to/chrome (defaults to google-chrome).
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

CHROME="${CHROME:-google-chrome}"
SRC="web/public/favicon.svg"
BG="#0a0d13"              # dark brand surface baked into the PNGs (iOS drops alpha)

python3 -c "import PIL" 2>/dev/null || {
  echo "error: Pillow is required — run 'pip install Pillow'" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Master: the transparent M (from $SRC) on the dark page background, at 512px.
# Force width/height onto the <svg> tag so Chrome sizes it reliably.
{
  echo '<!doctype html><meta charset=utf-8>'
  echo "<style>*{margin:0;padding:0}html,body{background:$BG;overflow:hidden}svg{display:block}</style>"
  sed 's/<svg /<svg width="512" height="512" /' "$SRC"
} > "$tmp/master.html"

"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --screenshot="$tmp/master.png" --window-size=512,512 "file://$tmp/master.html"

python3 - "$tmp/master.png" <<'PY'
import sys
from PIL import Image
master = Image.open(sys.argv[1]).convert("RGB")
for size, path in [(180, "web/public/apple-touch-icon.png"),
                   (32,  "web/public/favicon-32x32.png"),
                   (16,  "web/public/favicon-16x16.png")]:
    master.resize((size, size), Image.LANCZOS).save(path)
    print(f"wrote {path} ({size}x{size})")
PY

echo "regenerated icon PNGs from $SRC"
