"""Vendor padding is measured by the core (core/src/letterbox.rs) on
both surfaces: imaging/letterbox.py crops what it finds for the CLI, and
the browser runs the same ops on its interior set and before classifying
a photo.

EXPECTED is what imaging/letterbox.py's own numpy code returned for these
images before it was deleted (and, before that, on 900 real library
photos, 265 with bars and 36 with banners, it agreed with the core on
every one). The images are drawn here, deterministically, one per rule:
a clean white band, bands on both edges, a band that fades into bright
content, a photo with none, a pink banner with white lettering, a red
banner straddling the hue wrap, and a colourful photo that is not a
banner.
"""
from __future__ import annotations

import json
import random
import shutil
import subprocess
from pathlib import Path

import pytest
from PIL import Image, ImageDraw

from lotstretcher import core
from lotstretcher.imaging import letterbox

pytestmark = pytest.mark.skipif(not core.available(), reason=f"core not built: {core.why_unavailable()}")

REPO = Path(__file__).resolve().parents[1]
CASES = ["white_top_40", "white_top_40b", "white_both_24", "fade_top", "plain", "pink_banner", "red_wrap_banner", "colourful"]


def make(name: str) -> Image.Image:
    rng = random.Random(name)
    w, h = 320, 240
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        for x in range(w):
            v = 60 + (x * 3 + y * 5) % 80 + rng.randint(0, 12)
            px[x, y] = (v, v - 10, v + 5) if name != "colourful" else ((x * 7) % 256, (y * 11) % 256, (x * y) % 256)
    d = ImageDraw.Draw(img)
    if name.startswith("white_top_40"):
        d.rectangle((0, 0, w, 39), fill=(255, 255, 255))
    if name == "white_both_24":
        d.rectangle((0, 0, w, 23), fill=(254, 254, 254))
        d.rectangle((0, h - 24, w, h), fill=(254, 254, 254))
    if name == "fade_top":
        for y in range(30):
            d.line((0, y, w, y), fill=(255 - y * 4,) * 3)
    if name in ("pink_banner", "red_wrap_banner"):
        colour = (228, 32, 128) if name == "pink_banner" else (220, 20, 24)
        d.rectangle((0, 0, w, 27), fill=colour)
        for x in range(8, w - 20, 26):
            d.text((x, 8), "SALE", fill=(255, 255, 255))
    return img


def _expected():
    return json.loads((REPO / "tests" / "fixtures" / "letterbox-reference.json").read_text())


@pytest.mark.parametrize("name", CASES)
def test_the_core_measures_what_the_numpy_code_measured(name):
    exp = _expected()[name]
    img = make(name)
    assert list(letterbox.detect_bars(img)) == exp["bars"]
    assert list(letterbox.detect_banner(img)) == exp["banner"]


def test_the_batch_takes_the_size_most_photos_agree_on():
    imgs = [make(n) for n in ("white_top_40", "white_both_24", "fade_top", "white_top_40b", "plain")]
    assert list(letterbox.detect_batch_bars(imgs)) == _expected()["$batch"]


def test_the_rules_fire():
    exp = _expected()
    assert exp["white_top_40"]["bars"][0] > 0 and exp["plain"]["bars"] == [0, 0]
    assert exp["pink_banner"]["banner"][0] > 0 and exp["red_wrap_banner"]["banner"][0] > 0
    assert exp["colourful"]["banner"] == [0, 0] and exp["plain"]["banner"] == [0, 0]


def test_wasm_matches():
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    wasm = REPO / "web" / "public" / "core" / "lotstretcher_core_bg.wasm"
    script = f"""
      import fs from 'node:fs';
      import {{ loadCore, call }} from '{(REPO / 'web' / 'public' / 'js' / 'core.js').as_posix()}';
      await loadCore(fs.readFileSync('{wasm.as_posix()}'));
      const buf = new Uint8Array(fs.readFileSync(0));
      const n = {len(CASES)}, size = 320 * 240 * 3, out = [];
      for (let i = 0; i < n; i++) {{
        const image = {{ width: 320, height: 240, channels: 3, data: buf.subarray(i * size, (i + 1) * size) }};
        out.push([call({{ op: 'detect_bars', image: {{ $image: 0 }} }}, [image]), call({{ op: 'detect_banner', image: {{ $image: 0 }} }}, [image])]);
      }}
      process.stdout.write(JSON.stringify(out));
    """
    data = b"".join(make(n).tobytes() for n in CASES)
    run = subprocess.run([node, "--input-type=module", "-e", script], input=data, capture_output=True, check=True)
    exp = _expected()
    assert json.loads(run.stdout) == [[exp[n]["bars"], exp[n]["banner"]] for n in CASES]
