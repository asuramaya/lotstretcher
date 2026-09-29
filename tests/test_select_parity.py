"""Which shots a layout gets, and in what order, is the core's
(core/src/select.rs) on both surfaces.

imaging/select.py picked the CLI's shots and the browser's walkaround()
ordered its run, two versions of one rule. Both are hosts over the op
`select_shots` now. tests/fixtures/select-reference.json holds what the
Python pickers returned for 150 random galleries (angles, confidences
and ties drawn at random) before their logic was deleted; this test
holds the Python host (angles.json on disk) and the wasm build under
node to it. The real 2022 Escape gallery in
imaging/calibration/select_expected.json is pinned by regression.py.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from lotstretcher import core
from lotstretcher.imaging import select

pytestmark = pytest.mark.skipif(not core.available(), reason=f"core not built: {core.why_unavailable()}")

REPO = Path(__file__).resolve().parents[1]
REF = json.loads((REPO / "tests" / "fixtures" / "select-reference.json").read_text())


def _gallery(tmp_path: Path, shots: list[dict]) -> Path:
    for s in shots:
        (tmp_path / s["name"]).write_bytes(b"")
    (tmp_path / "angles.json").write_text(json.dumps({s["name"]: {"angle": s["angle"], "confidence": s["confidence"]} for s in shots}))
    return tmp_path


def _python(d: Path) -> dict:
    nm = lambda ps: [p.name for p in ps]  # noqa: E731
    pr = lambda ps: [[p.name, lbl] for p, lbl in ps]  # noqa: E731
    layout, adaptive = select.pick_adaptive(d)
    return {
        "hero0": nm(select.pick_hero_shots(d, 0)), "hero1": nm(select.pick_hero_shots(d, 1)),
        "hero2": nm(select.pick_hero_shots(d, 2)), "quad": nm(select.pick_for_quad_layout(d)),
        "conveyor": nm(select.pick_for_conveyor(d)), "adaptive": [layout, nm(adaptive)],
        "carousel": pr(select.pick_for_carousel(d)), "carousel_all": pr(select.pick_all_for_carousel(d)),
        "conveyor_start": pr(select.order_for_conveyor_start(select.pick_all_for_carousel(d), d)),
    }


@pytest.mark.parametrize("k", range(len(REF)))
def test_the_python_host_matches_the_pickers_it_replaced(tmp_path, k):
    assert _python(_gallery(tmp_path, REF[k]["shots"])) == REF[k]["expected"]


def test_the_browser_run_order_is_the_carousel_with_the_hero_first():
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed; the wasm side of the parity check cannot run")
    wasm = REPO / "web" / "public" / "core" / "lotstretcher_core_bg.wasm"
    script = f"""
      import fs from 'node:fs';
      import {{ loadCore, call }} from '{(REPO / 'web' / 'public' / 'js' / 'core.js').as_posix()}';
      await loadCore(fs.readFileSync('{wasm.as_posix()}'));
      const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
      const names = (r) => r.shots.map((s) => [s.name, s.angle]);
      process.stdout.write(JSON.stringify(cases.map((c) => ({{
        carousel_all: names(call({{ op: 'select_shots', mode: 'carousel_all', shots: c.shots }})),
        walkaround: names(call({{ op: 'select_shots', mode: 'walkaround', shots: c.shots }})),
        hero: call({{ op: 'select_shots', mode: 'hero', n_accents: 0, shots: c.shots }}).shots[0].name,
      }}))));
    """
    run = subprocess.run([node, "--input-type=module", "-e", script], input=json.dumps(REF),
                         capture_output=True, text=True, check=True)
    for case, got in zip(REF, json.loads(run.stdout)):
        assert got["carousel_all"] == case["expected"]["carousel_all"]
        # The run's lead is the still's hero; everything else keeps the walkaround.
        assert got["walkaround"][0][0] == got["hero"] == case["expected"]["hero0"][0]
        rest = [p for p in case["expected"]["carousel_all"] if p[0] != got["hero"]]
        assert got["walkaround"][1:] == rest


def _car(w: int = 320, h: int = 180):
    from PIL import Image, ImageDraw
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((10, 60, w - 10, h - 30), 20, fill=(180, 30, 40, 255))
    d.polygon([(80, 60), (120, 15), (220, 15), (260, 60)], fill=(60, 70, 90, 255))
    for cx in (70, w - 70):
        d.ellipse((cx - 28, h - 58, cx + 28, h - 2), fill=(20, 20, 20, 255))
    return img


def test_a_resized_copy_is_the_same_shot_and_a_mirror_is_not():
    from PIL import Image, ImageOps
    car = _car()
    sig = lambda im: core.call({"op": "shot_signature", "image": {"$image": 0}}, [im])  # noqa: E731
    a = sig(car)
    copy = sig(car.resize((256, 144), Image.LANCZOS))
    mirror = sig(ImageOps.mirror(car))
    cropped = sig(car.crop((0, 0, 200, 180)))
    assert core.call({"op": "same_shot", "signature": copy, "earlier": [mirror, a]}) == 1
    assert core.call({"op": "same_shot", "signature": mirror, "earlier": [a]}) is None
    assert core.call({"op": "same_shot", "signature": cropped, "earlier": [a]}) is None


def test_the_wasm_signature_is_the_native_one():
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    car = _car()
    native = core.call({"op": "shot_signature", "image": {"$image": 0}}, [car])
    wasm = REPO / "web" / "public" / "core" / "lotstretcher_core_bg.wasm"
    script = f"""
      import fs from 'node:fs';
      import {{ loadCore, call }} from '{(REPO / 'web' / 'public' / 'js' / 'core.js').as_posix()}';
      await loadCore(fs.readFileSync('{wasm.as_posix()}'));
      const data = new Uint8Array(fs.readFileSync(0));
      process.stdout.write(JSON.stringify(call({{ op: 'shot_signature', image: {{ $image: 0 }} }},
        [{{ width: {car.width}, height: {car.height}, channels: 4, data }}])));
    """
    run = subprocess.run([node, "--input-type=module", "-e", script], input=car.tobytes(), capture_output=True, check=True)
    assert json.loads(run.stdout) == native
