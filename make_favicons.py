"""Generate the site favicons: the Big Dipper + Polaris (Alaska flag motif,
which is also just... space) in gold on dark navy.

Writes every icon referenced by _includes/head/custom.html, images/manifest.json,
and images/browserconfig.xml. Re-run after tweaking the design:

    python make_favicons.py

Requires Pillow (pip install pillow).
"""

from PIL import Image, ImageDraw

OUT = "images"

NAVY_TOP = (22, 53, 95)      # subtle gradient: lighter at top...
NAVY_BOTTOM = (12, 31, 64)   # ...to deep navy at the bottom
GOLD = (255, 195, 70)
GOLD_DIM = (255, 195, 70, 80)  # constellation lines

# Star positions in a unit square (flag-like: dipper lower-left, Polaris upper-right).
DIPPER = [
    (0.13, 0.68),   # Alkaid (handle tip)
    (0.25, 0.595),  # Mizar
    (0.36, 0.55),   # Alioth
    (0.47, 0.545),  # Megrez (bowl top-left)
    (0.615, 0.575), # Dubhe (bowl top-right)
    (0.585, 0.74),  # Merak (bowl bottom-right)
    (0.43, 0.72),   # Phecda (bowl bottom-left)
]
# Lines: handle, then around the bowl (Megrez-Dubhe-Merak-Phecda-Megrez).
LINES = [(0, 1), (1, 2), (2, 3), (3, 4), (4, 5), (5, 6), (6, 3)]
POLARIS = (0.78, 0.20)

SS = 8  # supersample factor


def four_point_star(cx, cy, r_long, r_short):
    """An 8-vertex sparkle: long N/E/S/W points, short diagonals."""
    pts = []
    import math
    for i in range(8):
        ang = math.pi / 4 * i - math.pi / 2
        r = r_long if i % 2 == 0 else r_short
        pts.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))
    return pts


def render(size):
    """Render one icon at `size` px. Star radii are floored in pixels so the
    design survives 16px; constellation lines only appear at >=48px."""
    s = size * SS
    img = Image.new("RGBA", (s, s))
    d = ImageDraw.Draw(img)

    # Vertical gradient background.
    for y in range(s):
        t = y / max(s - 1, 1)
        col = tuple(round(a + (b - a) * t) for a, b in zip(NAVY_TOP, NAVY_BOTTOM))
        d.line([(0, y), (s, y)], fill=col + (255,))

    # Constellation lines (skip at tiny sizes — they'd just be mud).
    if size >= 48:
        w = max(round(0.010 * s), SS)
        for a, b in LINES:
            ax, ay = DIPPER[a]
            bx, by = DIPPER[b]
            d.line([(ax * s, ay * s), (bx * s, by * s)], fill=GOLD_DIM, width=w)

    # Dipper stars: ~3.3% of the icon, but never smaller than ~1.3 real px.
    r = max(0.033 * s, 1.3 * SS)
    for x, y in DIPPER:
        cx, cy = x * s, y * s
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=GOLD + (255,))

    # Polaris: a soft glow + a four-point sparkle, bigger than the dipper stars.
    cx, cy = POLARIS[0] * s, POLARIS[1] * s
    r_long = max(0.115 * s, 3.2 * SS)
    glow = Image.new("RGBA", (s, s))
    dg = ImageDraw.Draw(glow)
    dg.ellipse([cx - r_long, cy - r_long, cx + r_long, cy + r_long], fill=GOLD + (60,))
    img.alpha_composite(glow)
    d.polygon(four_point_star(cx, cy, r_long, r_long * 0.36), fill=GOLD + (255,))

    return img.resize((size, size), Image.LANCZOS)


def render_wide(w, h):
    """Wide mstile: render square at `h` and center it on the navy gradient."""
    img = Image.new("RGBA", (w, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(h - 1, 1)
        col = tuple(round(a + (b - a) * t) for a, b in zip(NAVY_TOP, NAVY_BOTTOM))
        d.line([(0, y), (w, y)], fill=col + (255,))
    sq = render(h)
    img.alpha_composite(sq, ((w - h) // 2, 0))
    return img


def main():
    for size in (16, 32, 96):
        render(size).save(f"{OUT}/favicon-{size}x{size}.png")
    for size in (36, 48, 72, 96, 144, 192, 512):
        render(size).save(f"{OUT}/android-chrome-{size}x{size}.png")
    for size in (57, 60, 72, 76, 114, 120, 144, 152, 180):
        render(size).save(f"{OUT}/apple-touch-icon-{size}x{size}.png")
    for size in (70, 144, 150, 310):
        render(size).save(f"{OUT}/mstile-{size}x{size}.png")
    render_wide(310, 150).save(f"{OUT}/mstile-310x150.png")
    render(256).save(f"{OUT}/favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    print("done")


if __name__ == "__main__":
    main()
