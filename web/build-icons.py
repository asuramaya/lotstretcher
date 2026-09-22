#!/usr/bin/env python3
"""Rasterise the app icon to the PNG sizes iOS and Android launchers need.

icons/icon.svg is the source of truth for the mark; this redraws the same
shapes with PIL rather than parsing the SVG, so the build needs no
cairosvg/rsvg and stays a one-command step:

    python3 web/build-icons.py

If you change icon.svg, change the geometry here to match.
"""
from pathlib import Path

from PIL import Image, ImageDraw

ICONS = Path(__file__).parent / "public" / "icons"
BG = (19, 21, 25, 255)
WHEEL = BG


def gradient_fill(size, a=(255, 184, 81), b=(196, 125, 33)):
    """The accent ramp, top-left to bottom-right."""
    g = Image.new("RGB", (size, size))
    px = g.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * size - 2)
            px[x, y] = tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))
    return g


def draw_icon(size, maskable=False):
    """Two bracket marks pulled apart around a vehicle silhouette --
    a lot line being stretched."""
    S = 512
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=114, fill=BG)

    # Artwork drawn as a mask, then filled with the gradient, so the
    # bars and the body share one continuous ramp.
    mask = Image.new("L", (S, S), 0)
    m = ImageDraw.Draw(mask)

    m.rounded_rectangle([81, 168, 111, 344], radius=15, fill=255)   # left bracket
    m.rounded_rectangle([401, 168, 431, 344], radius=15, fill=255)  # right bracket

    # Cabin + body: a rounded slab with a tapered greenhouse on top.
    m.polygon([(202, 268), (228, 232), (284, 232), (310, 268)], fill=255)
    m.rounded_rectangle([168, 262, 344, 341], radius=22, fill=255)

    art = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    art.paste(gradient_fill(S), (0, 0), mask)
    img = Image.alpha_composite(img, art)

    d = ImageDraw.Draw(img)
    for cx in (208, 304):
        d.ellipse([cx - 13, 299, cx + 13, 325], fill=WHEEL)

    if maskable:
        # Launchers crop maskable icons to a circle; pad into the safe zone.
        pad = Image.new("RGBA", (S, S), BG)
        inset = round(S * 0.1)
        pad.paste(img.resize((S - 2 * inset, S - 2 * inset), Image.LANCZOS),
                  (inset, inset), img.resize((S - 2 * inset, S - 2 * inset), Image.LANCZOS))
        img = pad

    return img.resize((size, size), Image.LANCZOS)


def main():
    for name, size, maskable in [
        ("icon-180.png", 180, False),
        ("icon-512.png", 512, False),
        ("icon-512-maskable.png", 512, True),
    ]:
        out = ICONS / name
        draw_icon(size, maskable).save(out, optimize=True)
        print(f"{out.relative_to(ICONS.parent.parent)}  {out.stat().st_size / 1024:.1f} KB")


if __name__ == "__main__":
    main()
