#!/usr/bin/env bash
# Packages the Teams app into advance-clearance-teams-app.zip
# Requires: ImageMagick (convert command) or rsvg-convert
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "→ Converting SVG icons to PNG..."

# Try ImageMagick first, then rsvg-convert, then inkscape
convert_svg() {
  local src="$1" dst="$2" size="$3"
  if command -v convert &>/dev/null; then
    convert -background none -resize "${size}x${size}" "$src" "$dst"
  elif command -v rsvg-convert &>/dev/null; then
    rsvg-convert -w "$size" -h "$size" "$src" -o "$dst"
  elif command -v inkscape &>/dev/null; then
    inkscape --export-type=png --export-width="$size" --export-height="$size" \
             --export-filename="$dst" "$src"
  else
    echo "ERROR: No SVG→PNG converter found. Install ImageMagick: sudo yum install ImageMagick"
    exit 1
  fi
}

convert_svg color.svg color.png 192
convert_svg outline.svg outline.png 32

echo "→ Creating advance-clearance-teams-app.zip..."
rm -f advance-clearance-teams-app.zip
zip advance-clearance-teams-app.zip manifest.json color.png outline.png

echo ""
echo "✓ Done: advance-clearance-teams-app.zip"
echo ""
echo "To sideload in Microsoft Teams:"
echo "  1. Open Teams → Apps → Manage your apps → Upload an app"
echo "  2. Select 'Upload an app to your org's app catalog'  (or 'Upload a custom app')"
echo "  3. Choose: advance-clearance-teams-app.zip"
echo "  4. The 'Advance Clearance' tab will appear under Apps → Built for your org"
echo ""
echo "Note: For the tab to load, Teams must be able to reach http://10.3.10.59:5174"
echo "      If your org requires HTTPS, set up a reverse proxy (nginx) with a self-signed cert."
