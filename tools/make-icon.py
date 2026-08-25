"""Generates the mini app's PNG icon (dark background, moon and alarm dot)."""
import sys
from PIL import Image, ImageDraw

size = int(sys.argv[1]) if len(sys.argv) > 1 else 124
out = sys.argv[2]

img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# background circle
d.ellipse([0, 0, size - 1, size - 1], fill=(24, 32, 54, 255))

# crescent moon: a filled circle minus an offset circle
m = size * 0.20
d.ellipse([m, m, size - m, size - m], fill=(240, 214, 122, 255))
off = size * 0.13
d.ellipse([m + off, m - off * 0.35, size - m + off, size - m - off * 0.35],
          fill=(24, 32, 54, 255))

# the dot = the alarm
r = size * 0.055
cx, cy = size * 0.70, size * 0.70
d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(120, 220, 140, 255))

img.save(out, "PNG")
print("written", out, size)
