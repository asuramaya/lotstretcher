"""core/src/matting.rs: the cutout's rim loses the background's colour and
its alpha follows the photo's edge; opaque pixels are untouched."""
from __future__ import annotations

import pytest
from PIL import Image, ImageDraw, ImageFilter

from lotstretcher import core

pytestmark = pytest.mark.skipif(not core.available(), reason=f"core not built: {core.why_unavailable()}")


def _soft_cutout():
    """A dark car-coloured block photographed against a white wall, with
    the matte a blurred (stretched-from-small) version of its outline."""
    w, h = 1000, 750
    box = (250, 200, 750, 550)
    photo = Image.new("RGB", (w, h), (245, 245, 245))
    ImageDraw.Draw(photo).rectangle(box, fill=(40, 60, 150))
    # The lens blurs the real edge a little: the rim mixes paint and wall.
    photo = photo.filter(ImageFilter.GaussianBlur(1.2))
    # The matte is computed at 256x256 and stretched back, as in the browser.
    small = Image.new("L", (256, 256), 0)
    ImageDraw.Draw(small).rectangle(tuple(round(v * 256 / s) for v, s in zip(box, (w, h, w, h))), fill=255)
    mask = small.filter(ImageFilter.GaussianBlur(0.8)).resize((w, h), Image.BILINEAR)
    rgba = photo.copy()
    rgba.putalpha(mask)
    return rgba


def test_rim_loses_the_wall_colour_and_opaque_pixels_are_untouched():
    raw = _soft_cutout()
    out = core.call({"op": "refine_cutout", "image": {"$image": 0}}, [raw])
    assert out.mode == "RGBA" and out.size == raw.size
    rp, op = raw.load(), out.load()

    # Deep inside: byte for byte.
    assert op[500, 375] == rp[500, 375]

    # The rim: every semi-transparent pixel on the left edge is closer to
    # the paint than it was (less of the white wall in it).
    closer = 0
    total = 0
    for x in range(236, 264):
        r0, g0, b0, a0 = rp[x, 375]
        r1, g1, b1, a1 = op[x, 375]
        if 10 < a1 < 245:
            total += 1
            if (r1 + g1) < (r0 + g0):
                closer += 1
    assert total and closer == total

    # The alpha is tighter: fewer faintly-visible pixels outside the block.
    def veil(img):
        a = img.split()[-1]
        return sum(1 for v in a.getdata() if 8 < v < 128)
    assert veil(out) < veil(raw)
