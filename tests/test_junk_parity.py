"""A dealer's known junk graphics are recognised by the core's pHash
(core/src/phash.rs) on both surfaces: imaging/dedupe.py's JunkFilter for
the CLI, the browser's run before it classifies a photo (it had no junk
filter before; a saved dealer page's photo list carries these cards).

The recipe is imagehash.phash's, and the core's agrees with it exactly on
every template and on 565 of 600 library photos (the rest 2 bits off,
against a threshold of 8; the closest real photo sits 14 bits from any
template). The spec's template hashes must be the core's hashes of the
files in src/lotstretcher/imaging/templates/.
"""
from __future__ import annotations

import io
import json
import shutil
import subprocess
from pathlib import Path

import imagehash
import pytest
from PIL import Image, ImageDraw

from lotstretcher import core, spec
from lotstretcher.imaging.dedupe import DEFAULT_TEMPLATES_DIR, JunkFilter

pytestmark = pytest.mark.skipif(not core.available(), reason=f"core not built: {core.why_unavailable()}")

REPO = Path(__file__).resolve().parents[1]
TEMPLATES = sorted(p for p in DEFAULT_TEMPLATES_DIR.iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp"))


def _phash(img: Image.Image) -> str:
    return core.call({"op": "phash", "image": {"$image": 0}}, [img.convert("RGB")])


def test_the_spec_holds_the_core_hash_of_every_template():
    assert {t["name"]: t["phash"] for t in spec.get("listing", "junk", "templates")} == \
        {p.name: _phash(Image.open(p)) for p in TEMPLATES}


def test_the_core_hash_is_imagehash_on_the_templates():
    for p in TEMPLATES:
        assert _phash(Image.open(p)) == str(imagehash.phash(Image.open(p).convert("RGB"))), p.name


def _photo() -> bytes:
    img = Image.new("RGB", (640, 480), (120, 130, 140))
    ImageDraw.Draw(img).rounded_rectangle((80, 200, 560, 400), 40, fill=(180, 30, 30))
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return buf.getvalue()


def test_a_template_is_dropped_and_a_photo_kept():
    f = JunkFilter()
    for p in TEMPLATES:
        # A re-encoded, resized copy, as a CDN serves it.
        img = Image.open(p).convert("RGB")
        img = img.resize((img.width * 3 // 4, img.height * 3 // 4))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=80)
        assert f.is_junk(buf.getvalue()) == (True, p.name)
        assert core.call({"op": "junk_match", "hash": _phash(img)}) == p.name
    assert f.is_junk(_photo()) == (False, None)


def test_wasm_hashes_the_templates_the_same():
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    imgs = [Image.open(p).convert("RGB") for p in TEMPLATES]
    wasm = REPO / "web" / "public" / "core" / "lotstretcher_core_bg.wasm"
    script = f"""
      import fs from 'node:fs';
      import {{ loadCore, call }} from '{(REPO / 'web' / 'public' / 'js' / 'core.js').as_posix()}';
      await loadCore(fs.readFileSync('{wasm.as_posix()}'));
      const buf = new Uint8Array(fs.readFileSync(0));
      const sizes = {json.dumps([list(i.size) for i in imgs])};
      let off = 0; const out = [];
      for (const [w, h] of sizes) {{
        const image = {{ width: w, height: h, channels: 3, data: buf.subarray(off, off + w * h * 3) }}; off += w * h * 3;
        const hash = call({{ op: 'phash', image: {{ $image: 0 }} }}, [image]);
        out.push([hash, call({{ op: 'junk_match', hash }})]);
      }}
      process.stdout.write(JSON.stringify(out));
    """
    run = subprocess.run([node, "--input-type=module", "-e", script], input=b"".join(i.tobytes() for i in imgs),
                         capture_output=True, check=True)
    assert json.loads(run.stdout) == [[_phash(i), p.name] for i, p in zip(imgs, TEMPLATES)]
