"""Generate landing-page demo imagery from the real pipeline.

Honest before/after: the 'after' is composed from the 'before' by the same
code the app runs, not mocked up. Uses the existing production cutout so
the pair is genuinely the same photo.
"""
import sys
from pathlib import Path

sys.path.insert(0, "src")
from PIL import Image

from lotstretcher.imaging.compose.background import vehicle_gradient_background
from lotstretcher.imaging.compose.hero import compose_hero

V = Path("/home/asuramaya/Documents/listings/new/2026-Ford-Maverick-XLT-RB41981")
OUT = Path("web/public/demo")
OUT.mkdir(parents=True, exist_ok=True)

EXT, INT = "Azure Gray Metallic Tri-Coat", "Navy/Aspen Gry"
SRC = "03.jpg"          # a clean 3/4 front, which is the shot dealers actually lead with


def save(img, name, w, quality=82):
    img = img.convert("RGB")
    h = round(img.height * w / img.width)
    img.resize((w, h), Image.LANCZOS).save(OUT / name, "JPEG", quality=quality, optimize=True, progressive=True)
    print(f"{name}  {w}x{h}  {(OUT / name).stat().st_size / 1024:.0f} KB")


# BEFORE: the raw lot photo, centre-cropped square so it pairs with the hero.
before = Image.open(V / "images/exterior" / SRC).convert("RGB")
side = min(before.size)
before_sq = before.crop(((before.width - side) // 2, (before.height - side) // 2,
                         (before.width + side) // 2, (before.height + side) // 2))
save(before_sq, "before.jpg", 900)

# AFTER: composed from that same photo's cutout, by the real composer.
cut = V / "images/exterior/cutout" / (Path(SRC).stem + ".png")
bg = vehicle_gradient_background((1254, 1254), seed=SRC, exterior=EXT, interior=INT, sample_path=cut)
after = compose_hero(bg, None, [cut], layout="single", spotlight=True)
save(after, "after.jpg", 900)

# Supporting shots for the feature sections.
save(Image.open(V / "bundle/hero-portrait.png"), "portrait.jpg", 620)
save(Image.open(V / "bundle/window-sticker-1a.png"), "sticker.jpg", 800, quality=78)

# A strip of raw lot photos, for the "drop in a folder" visual.
strip = [Image.open(V / "images/exterior" / f"{i:02d}.jpg").convert("RGB") for i in (1, 6, 7)]
strip += [Image.open(V / "images/interior" / f"{i:02d}.jpg").convert("RGB") for i in (3, 8)]
for i, im in enumerate(strip):
    s = min(im.size)
    im = im.crop(((im.width - s) // 2, (im.height - s) // 2, (im.width + s) // 2, (im.height + s) // 2))
    save(im, f"lot-{i + 1}.jpg", 280, quality=76)
