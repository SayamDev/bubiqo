"""
Generate Bubiqo's icons with no image-library dependency.

The mark is a radar: a ring with a single point on it. That is literally what
Problem Radar does — one thing worth your attention, found on a sweep — and a ring
plus a dot is one of the few marks that still reads at 16 pixels.

Written in pure Python (zlib + struct) so `npm run icons` works on a clean machine
with no ImageMagick, no librsvg and no Pillow.
"""

import math
import struct
import zlib
from pathlib import Path

INK = (22, 22, 26)        # near-black, calm rather than pure #000
PAPER = (250, 250, 249)   # warm off-white
ACCENT = (217, 119, 6)    # amber: the one point on the sweep

SS = 4  # supersampling factor, for antialiasing


def rounded_rect(x, y, w, h, r):
    """Signed coverage test for a rounded rectangle."""
    def inside(px, py):
        cx = min(max(px, x + r), x + w - r)
        cy = min(max(py, y + r), y + h - r)
        if x + r <= px <= x + w - r or y + r <= py <= y + h - r:
            return x <= px <= x + w and y <= py <= y + h
        return (px - cx) ** 2 + (py - cy) ** 2 <= r * r
    return inside


def render(size: int) -> bytes:
    n = size * SS
    # Start transparent.
    buf = [[(0, 0, 0, 0)] * n for _ in range(n)]

    pad = n * 0.06
    body = rounded_rect(pad, pad, n - 2 * pad, n - 2 * pad, n * 0.22)

    cx = cy = n / 2
    ring_r = n * 0.27
    ring_w = max(n * 0.075, SS * 1.2)

    # The point sits at roughly 1 o'clock on the ring.
    angle = -math.pi / 4
    px, py = cx + ring_r * math.cos(angle), cy + ring_r * math.sin(angle)
    dot_r = n * 0.105

    for yy in range(n):
        for xx in range(n):
            fx, fy = xx + 0.5, yy + 0.5
            if not body(fx, fy):
                continue
            colour = INK

            d_ring = abs(math.hypot(fx - cx, fy - cy) - ring_r)
            if d_ring <= ring_w / 2:
                colour = PAPER

            if math.hypot(fx - px, fy - py) <= dot_r:
                colour = ACCENT

            buf[yy][xx] = (*colour, 255)

    # Downsample with a box filter for clean edges.
    out = bytearray()
    for y in range(size):
        out.append(0)  # PNG filter type 0 for this scanline
        for x in range(size):
            r = g = b = a = 0
            for sy in range(SS):
                for sx in range(SS):
                    pr, pg, pb, pa = buf[y * SS + sy][x * SS + sx]
                    r += pr * pa; g += pg * pa; b += pb * pa; a += pa
            if a == 0:
                out += bytes((0, 0, 0, 0))
            else:
                out += bytes((r // a, g // a, b // a, a // (SS * SS)))
    return bytes(out)


def write_png(path: Path, size: int) -> None:
    raw = render(size)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)
    print(f"  {path}  ({len(png):,} bytes)")


if __name__ == "__main__":
    out_dir = Path(__file__).resolve().parent.parent / "extension" / "public" / "icons"
    out_dir.mkdir(parents=True, exist_ok=True)
    print("Generating icons:")
    for s in (16, 32, 48, 128):
        write_png(out_dir / f"icon-{s}.png", s)
