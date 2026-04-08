#!/usr/bin/env python3
"""
generate-icons.py
-----------------
Creates PNG app icons for the Church Schedule PWA using only
Python's built-in libraries (no Pillow / external deps needed).

Produces:
  icons/icon-192.png      → PWA manifest icon
  icons/icon-512.png      → PWA manifest icon (large)
  icons/apple-touch-icon.png → iOS Safari "Add to Home Screen"

Run once after cloning:
    python3 generate-icons.py
"""

import struct
import zlib
import os
import math

# ── Colours (Blue #1a56db  / White #ffffff) ──────────────────────────────────
BG  = (26, 86, 219)   # #1a56db
FG  = (255, 255, 255) # white
TRANS = (0, 0, 0, 0)  # transparent (alpha)

def lerp(a, b, t):
    return int(a + (b - a) * t)

# ── Low-level PNG writer (pure Python) ───────────────────────────────────────
def _chunk(tag: bytes, data: bytes) -> bytes:
    payload = tag + data
    return (struct.pack('>I', len(data)) + payload
            + struct.pack('>I', zlib.crc32(payload) & 0xFFFFFFFF))

def encode_png(pixels, w, h):
    """pixels: list of [w*h] tuples of (R,G,B)  — 8-bit RGB"""
    raw = b''.join(
        b'\x00' + b''.join(struct.pack('BBB', r, g, b) for r, g, b in row)
        for row in pixels
    )
    ihdr = _chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
    idat = _chunk(b'IDAT', zlib.compress(raw, 9))
    iend = _chunk(b'IEND', b'')
    return b'\x89PNG\r\n\x1a\n' + ihdr + idat + iend

# ── Drawing helpers ───────────────────────────────────────────────────────────
def fill_rect(px, x0, y0, x1, y1, colour, w, h):
    for y in range(max(0, y0), min(h, y1 + 1)):
        for x in range(max(0, x0), min(w, x1 + 1)):
            px[y][x] = colour

def fill_circle(px, cx, cy, r, colour, w, h):
    for y in range(max(0, cy - r), min(h, cy + r + 1)):
        for x in range(max(0, cx - r), min(w, cx + r + 1)):
            if (x - cx) ** 2 + (y - cy) ** 2 <= r * r:
                px[y][x] = colour

def fill_rounded_rect(px, x0, y0, x1, y1, rx, colour, w, h):
    # Fill interior
    fill_rect(px, x0 + rx, y0, x1 - rx, y1, colour, w, h)
    fill_rect(px, x0, y0 + rx, x1, y1 - rx, colour, w, h)
    # Four corners
    for cx, cy in [(x0+rx, y0+rx), (x1-rx, y0+rx),
                   (x0+rx, y1-rx), (x1-rx, y1-rx)]:
        fill_circle(px, cx, cy, rx, colour, w, h)

# ── Icon drawing ──────────────────────────────────────────────────────────────
def draw_icon(size):
    px = [[BG] * size for _ in range(size)]

    s  = size / 512.0   # scale factor relative to 512 design

    # --- Rounded background already filled ---

    # Cross (vertical bar)
    cv_x0 = int(243 * s);  cv_x1 = int((243 + 26) * s)
    cv_y0 = int(85  * s);  cv_y1 = int((85 + 80)  * s)
    fill_rect(px, cv_x0, cv_y0, cv_x1, cv_y1, FG, size, size)

    # Cross (horizontal bar)
    ch_x0 = int(215 * s);  ch_x1 = int((215 + 82) * s)
    ch_y0 = int(105 * s);  ch_y1 = int((105 + 26) * s)
    fill_rect(px, ch_x0, ch_y0, ch_x1, ch_y1, FG, size, size)

    # Open book  ─ simplified as two rounded rectangular pages
    lw = int(14 * s)   # line width

    # Left page outline (just the spine-side and top/bottom lines)
    bk_top  = int(155 * s)
    bk_bot  = int(355 * s)
    bk_left = int(100 * s)
    bk_mid  = int(256 * s)

    fill_rect(px, bk_left,    bk_top, bk_left+lw, bk_bot, FG, size, size)
    fill_rect(px, bk_left,    bk_top, bk_mid,      bk_top+lw, FG, size, size)
    fill_rect(px, bk_left,    bk_bot-lw, bk_mid,   bk_bot, FG, size, size)

    # Right page
    bk_right = int(412 * s)
    fill_rect(px, bk_right-lw, bk_top, bk_right, bk_bot, FG, size, size)
    fill_rect(px, bk_mid,      bk_top, bk_right,  bk_top+lw, FG, size, size)
    fill_rect(px, bk_mid,      bk_bot-lw, bk_right, bk_bot, FG, size, size)

    # Spine
    fill_rect(px, bk_mid - lw//2, bk_top, bk_mid + lw//2, bk_bot, FG, size, size)

    return px

def create_icon(path, size):
    px = draw_icon(size)
    data = encode_png(px, size, size)
    with open(path, 'wb') as f:
        f.write(data)
    print(f"  ✓  {path}  ({size}×{size})")

# ── Main ──────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    icons_dir = os.path.join(os.path.dirname(__file__), 'icons')
    os.makedirs(icons_dir, exist_ok=True)

    print("Generating icons…")
    create_icon(os.path.join(icons_dir, 'icon-192.png'),         192)
    create_icon(os.path.join(icons_dir, 'icon-512.png'),         512)
    create_icon(os.path.join(icons_dir, 'apple-touch-icon.png'), 180)
    print("Done! All icons created successfully.")
