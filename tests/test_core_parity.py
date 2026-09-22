"""The Rust core against the Python it replaces.

While a piece of the pipeline is being moved into core/, this is the
regression guard: the core, called through ctypes, must produce what
the existing Python produced on the same inputs, within the tolerance
that different resamplers allow. Once the Python path is deleted the
test keeps running against the retained reference implementations
below, so the core cannot drift from the documented behaviour either.

Skipped, and says so, when the core has not been built
(cargo build --release in core/).
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from lotstretcher import core

pytestmark = pytest.mark.skipif(not core.available(), reason=f"core not built: {core.why_unavailable()}")

REPO = Path(__file__).resolve().parents[1]
SPEC = json.loads((REPO / "shared" / "pipeline-spec.json").read_text())


def synthetic_cutout(w=420, h=240, color=(180, 40, 40)):
    """An RGBA blob with soft edges: enough to exercise placement, the
    dim measurement, glow and compositing without a model."""
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    px = img.load()
    cx, cy = w / 2, h / 2
    for y in range(h):
        for x in range(w):
            d = ((x - cx) / (w / 2)) ** 2 + ((y - cy) / (h / 2)) ** 2
            if d < 1.0:
                a = int(255 * min(1.0, (1.0 - d) * 6))
                shade = int(255 * (0.6 + 0.4 * (x / w)))
                px[x, y] = (color[0] * shade // 255, color[1] * shade // 255, color[2] * shade // 255, a)
    return img


def mean_abs_diff(a: Image.Image, b: Image.Image) -> float:
    return float(np.abs(np.asarray(a, dtype=np.int16) - np.asarray(b, dtype=np.int16)).mean())


def test_gradient_colors_match_the_palette_module():
    from lotstretcher.imaging.palette import vehicle_gradient_colors
    for ext, inr in [("Agate Black", "Ebony"), ("Antimatter Blue", "Black Onyx"), ("Avalanche", None),
                     ("Rapid Red Metallic", "Medium Dark Slate"), (None, None)]:
        assert core.vehicle_gradient_colors(ext, inr) == vehicle_gradient_colors(ext, inr), (ext, inr)


def test_sampled_paint_matches(tmp_path):
    from lotstretcher.imaging.palette import vehicle_gradient_colors
    cut = synthetic_cutout(color=(40, 90, 200))
    p = tmp_path / "cut.png"
    cut.save(p)
    # "Avalanche" carries no colour word, so both sides measure the paint.
    assert core.vehicle_gradient_colors("Avalanche", "Black", cut) == vehicle_gradient_colors("Avalanche", "Black", p)


def test_compose_is_deterministic_and_seeded():
    cut = synthetic_cutout()
    bg = {"kind": "vehicle", "seed": "vin:1:photo", "exterior": "Agate Black", "interior": "Ebony"}
    a = core.compose_hero([cut], 400, 400, bg)
    b = core.compose_hero([cut], 400, 400, bg)
    c = core.compose_hero([cut], 400, 400, {**bg, "seed": "vin:2:photo"})
    assert a.tobytes() == b.tobytes()
    assert a.tobytes() != c.tobytes(), "a different seed must give a different backdrop"


def test_compose_matches_python_within_resampler_tolerance():
    """Same colours, same placement, same spotlight; the only freedom is
    the resampler and the gradient's seeded angle, so the comparison is
    made with the Python fed the core's own gradient as its background."""
    from lotstretcher.imaging.compose.hero import compose_hero as py_compose

    cut = synthetic_cutout()
    core_img = core.compose_hero([cut], 600, 500, {"kind": "generic", "seed": "s"}, spotlight=False)
    # Rebuild the same backdrop through the core alone (no car) by
    # composing with an all-transparent cutout, then hand it to Python.
    blank = Image.new("RGBA", (10, 10), (0, 0, 0, 0))
    backdrop = core.compose_hero([blank], 600, 500, {"kind": "generic", "seed": "s"}, spotlight=False)
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        cp = Path(d) / "cut.png"
        cut.save(cp)
        py_img = py_compose(backdrop, None, [cp], layout="single", spotlight=False, canvas_size=(600, 500))
    assert mean_abs_diff(core_img, py_img) < 1.5


def test_spotlight_matches_python():
    from lotstretcher.imaging.compose.hero import compose_hero as py_compose
    cut = synthetic_cutout(color=(200, 200, 200))
    blank = Image.new("RGBA", (10, 10), (0, 0, 0, 0))
    backdrop = core.compose_hero([blank], 500, 500, {"kind": "generic", "seed": "bright"}, spotlight=False)
    core_img = core.compose_hero([cut], 500, 500, {"kind": "generic", "seed": "bright"}, spotlight=True)
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        cp = Path(d) / "cut.png"
        cut.save(cp)
        py_img = py_compose(backdrop, None, [cp], layout="single", spotlight=True, canvas_size=(500, 500))
    assert mean_abs_diff(core_img, py_img) < 2.0


def test_glow_matches_python():
    from lotstretcher.imaging.compose.hero import compose_hero as py_compose
    cut = synthetic_cutout()
    blank = Image.new("RGBA", (10, 10), (0, 0, 0, 0))
    backdrop = core.compose_hero([blank], 500, 500, {"kind": "generic", "seed": "g"}, spotlight=False)
    core_img = core.compose_hero([cut], 500, 500, {"kind": "generic", "seed": "g"}, spotlight=False,
                                 glow=True, glow_color="gold", glow_radius=24, glow_intensity=0.75)
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        cp = Path(d) / "cut.png"
        cut.save(cp)
        py_img = py_compose(backdrop, None, [cp], layout="single", spotlight=False, glow=True,
                            glow_color="gold", glow_radius=24, glow_intensity=0.75, canvas_size=(500, 500))
    assert mean_abs_diff(core_img, py_img) < 3.0


@pytest.mark.parametrize("layout", ["single", "corners", "quad", "conveyor", "conveyor_stack"])
def test_layouts_match_python(layout):
    from lotstretcher.imaging.compose.layout import LAYOUTS, conveyor_for_window
    window = (0, 0, 1254, 1254) if layout != "conveyor_stack" else (0, 0, 1080, 1920)
    fn = conveyor_for_window(window) if layout == "conveyor" else LAYOUTS[layout]
    expected = fn(window, 3)
    # The core's boxes are observed through composition: every slot that
    # Python defines must receive a car at the same place.
    cars = [synthetic_cutout(300, 160), synthetic_cutout(200, 120), synthetic_cutout(200, 120), synthetic_cutout(260, 100)]
    img = core.compose_hero(cars[:len(expected)], window[2], window[3], {"kind": "generic", "seed": "L"},
                            layout=layout, spotlight=False)
    arr = np.asarray(img)
    from lotstretcher.imaging.compose.layout import compute_placement
    for car, (bx, anchor) in zip(cars, expected):
        x, y, resized = compute_placement(car, bx, margin_frac=0.06, anchor=anchor)
        cx, cy = x + resized.width // 2, y + resized.height // 2
        # The car is red; the backdrop is not. The centre pixel of each
        # slot must be car-coloured.
        r, g, b = arr[cy, cx]
        assert r > g + 40 and r > b + 40, f"{layout}: no car at slot centre ({cx},{cy}) got {(r, g, b)}"


BORDER = REPO / "assets" / "borders" / "tomball-ford-frame.png"


@pytest.mark.skipif(not BORDER.is_file(), reason="no border asset checked out")
def test_window_detection_matches_python():
    from lotstretcher.imaging.compose.window import detect_window
    border = Image.open(BORDER).convert("RGBA")
    assert core.detect_window(border) == detect_window(border)


@pytest.mark.skipif(not BORDER.is_file(), reason="no border asset checked out")
def test_bordered_compose_keeps_the_frame_on_top_and_the_car_in_the_window():
    from lotstretcher.imaging.compose.window import alpha_mask, detect_window, resolve_collision
    from lotstretcher.imaging.compose.layout import compute_placement
    border = Image.open(BORDER).convert("RGBA")
    cut = synthetic_cutout(600, 300)
    img = core.compose_hero([cut], 10, 10, {"kind": "generic", "seed": "b"}, border=border, spotlight=False)
    assert img.size == border.size, "the border decides the canvas size"
    arr = np.asarray(img)
    barr = np.asarray(border)
    # Every fully opaque border pixel shows the border's own colour.
    opaque = barr[..., 3] == 255
    assert np.array_equal(arr[opaque], barr[..., :3][opaque])
    # The car sits where Python's window + placement + collision nudge would put it.
    window = detect_window(border)
    x, y, resized = compute_placement(cut, window, margin_frac=0.06, anchor="center")
    y = resolve_collision(alpha_mask(border), resized, x, y)
    cx, cy = x + resized.width // 2, y + resized.height // 2
    r, g, b = arr[cy, cx]
    assert r > g + 40 and r > b + 40, f"no car at ({cx},{cy}): {(r, g, b)}"
