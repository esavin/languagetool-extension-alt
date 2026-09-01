#!/usr/bin/env python3
"""Generate extension icons (pure stdlib, no dependencies)."""
import struct, sys, zlib, os

def dist(px, py, x, y):
    return ((px - x) ** 2 + (py - y) ** 2) ** 0.5

def dist_to_segment(px, py, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1
    if dx == 0 and dy == 0:
        return dist(px, py, x1, y1)
    t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)))
    return dist(px, py, x1 + t * dx, y1 + t * dy)

def make_icon(size):
    bg = (26, 115, 232, 255)      # blue circle
    fg = (255, 255, 255, 255)     # white check mark
    tr = (0, 0, 0, 0)             # transparent
    c = size / 2.0
    r = size / 2.0 - max(1.0, size / 16.0)
    lw = max(1.5, size / 8.0)     # check stroke width
    # check mark: (0.28,0.53) -> (0.44,0.68) -> (0.74,0.33) in unit coords
    a = (0.28 * size, 0.53 * size)
    b = (0.44 * size, 0.69 * size)
    d = (0.74 * size, 0.33 * size)
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            px = x + 0.5
            py = y + 0.5
            if dist(px, py, c, c) <= r:
                if (dist_to_segment(px, py, *a, *b) <= lw / 2
                        or dist_to_segment(px, py, *b, *d) <= lw / 2):
                    row.extend(fg)
                else:
                    row.extend(bg)
            else:
                row.extend(tr)
        rows.append(bytes(row))
    raw = b"".join(b"\x00" + r for r in rows)
    return b"".join([
        b"\x89PNG\r\n\x1a\n",
        chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)),
        chunk(b"IDAT", zlib.compress(raw, 9)),
        chunk(b"IEND", b""),
    ])

def chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

if __name__ == "__main__":
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "icons"
    os.makedirs(out_dir, exist_ok=True)
    for s in (16, 48, 128):
        with open(os.path.join(out_dir, f"icon{s}.png"), "wb") as f:
            f.write(make_icon(s))
        print(f"wrote {out_dir}/icon{s}.png")
