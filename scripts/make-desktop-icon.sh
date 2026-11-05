#!/bin/sh
# Draws the desktop app's icon (build/icon.icns, build/icon.png) from web/public/icon.svg. Run from the repo root.
set -e
inner=$(sed -e 's/^<svg[^>]*>//' -e 's/<\/svg>$//' web/public/icon.svg)
cat > build/icon-1024.svg <<SVG
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect x="100" y="100" width="824" height="824" rx="185" fill="#f5f1ea"/><g transform="translate(160 160) scale(11)">$inner</g></svg>
SVG
set=build/icon.iconset
rm -rf "$set" && mkdir "$set"
for size in 16 32 128 256 512; do
  rsvg-convert -w $size -h $size build/icon-1024.svg > "$set/icon_${size}x${size}.png"
  rsvg-convert -w $((size * 2)) -h $((size * 2)) build/icon-1024.svg > "$set/icon_${size}x${size}@2x.png"
done
iconutil -c icns "$set" -o build/icon.icns
rsvg-convert -w 1024 -h 1024 build/icon-1024.svg > build/icon.png
rm -rf "$set" build/icon-1024.svg
