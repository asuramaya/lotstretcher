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


def reference_detect_window(border: Image.Image, min_width_frac: float = 0.5):
    """The documented behaviour, kept here as the test's own reference
    now that window.py is gone: the widest near-transparent run across
    rows through the middle, then down columns."""
    alpha = np.array(border.split()[-1])
    h, w = alpha.shape
    transparent = alpha < 10

    def widest_run(mask_1d):
        idx = np.where(mask_1d)[0]
        if len(idx) == 0:
            return None
        breaks = np.where(np.diff(idx) != 1)[0]
        starts = np.r_[0, breaks + 1]
        ends = np.r_[breaks, len(idx) - 1]
        return max(((idx[s], idx[e]) for s, e in zip(starts, ends)), key=lambda r: r[1] - r[0])

    left = right = top = bottom = None
    for y in range(h // 4, 3 * h // 4, max(1, h // 40)):
        run = widest_run(transparent[y])
        if run and (right is None or run[1] - run[0] > right - left) and run[1] - run[0] >= int(w * min_width_frac):
            left, right = run
    for x in range(w // 4, 3 * w // 4, max(1, w // 40)):
        run = widest_run(transparent[:, x])
        if run and (bottom is None or run[1] - run[0] > bottom - top) and run[1] - run[0] >= int(h * min_width_frac):
            top, bottom = run
    return (int(left), int(top), int(right), int(bottom))


def reference_resolve_collision(border: Image.Image, car: Image.Image, x: int, y: int,
                                max_shift=300, step=3, margin_frac=0.04) -> int:
    border_mask = np.array(border.split()[-1]) >= 10
    car_mask = np.array(car.split()[-1]) >= 10
    ch, cw = car_mask.shape
    bh, bw = border_mask.shape

    def overlap_at(yy):
        if yy < 0 or yy + ch > bh or x < 0 or x + cw > bw:
            return None
        return int(np.count_nonzero(border_mask[yy:yy + ch, x:x + cw] & car_mask))

    best_y, best_overlap = y, None
    for shift in range(0, max_shift + 1, step):
        yy = y + shift
        overlap = overlap_at(yy)
        if overlap is None:
            break
        if overlap == 0:
            padded = yy + max(1, round(ch * margin_frac))
            return padded if overlap_at(padded) == 0 else yy
        if best_overlap is None or overlap < best_overlap:
            best_y, best_overlap = yy, overlap
    return best_y


@pytest.mark.skipif(not BORDER.is_file(), reason="no border asset checked out")
def test_window_detection_matches_the_reference():
    border = Image.open(BORDER).convert("RGBA")
    assert core.detect_window(border) == reference_detect_window(border)


@pytest.mark.skipif(not BORDER.is_file(), reason="no border asset checked out")
def test_collision_matches_the_reference():
    border = Image.open(BORDER).convert("RGBA")
    cut = synthetic_cutout(600, 300)
    l, t, r, b = core.detect_window(border)
    x, y = l + 20, t - 40   # start overlapping the header art
    assert core.resolve_collision(border, cut, x, y) == reference_resolve_collision(border, cut, x, y)


@pytest.mark.skipif(not BORDER.is_file(), reason="no border asset checked out")
def test_bordered_compose_keeps_the_frame_on_top_and_the_car_in_the_window():
    from lotstretcher.imaging.compose.layout import compute_placement
    border = Image.open(BORDER).convert("RGBA")
    cut = synthetic_cutout(600, 300)
    img = core.compose_hero([cut], border.width, border.height, {"kind": "generic", "seed": "b"},
                            border=border, spotlight=False)
    assert img.size == border.size, "a border of the canvas's own size is used as is"
    arr = np.asarray(img)
    barr = np.asarray(border)
    # Every fully opaque border pixel shows the border's own colour.
    opaque = barr[..., 3] == 255
    assert np.array_equal(arr[opaque], barr[..., :3][opaque])
    # The car sits where Python's window + placement + collision nudge would put it.
    window = reference_detect_window(border)
    x, y, resized = compute_placement(cut, window, margin_frac=0.06, anchor="center")
    y = reference_resolve_collision(border, resized, x, y)
    cx, cy = x + resized.width // 2, y + resized.height // 2
    r, g, b = arr[cy, cx]
    assert r > g + 40 and r > b + 40, f"no car at ({cx},{cy}): {(r, g, b)}"


def test_the_format_decides_the_canvas_and_the_frame_is_fitted_to_it():
    """A square dealer frame on a 4:5 post: the still is 4:5, never the
    frame's own square. `fit` keeps the whole frame centred with the
    backdrop above and below; `fill` covers the canvas; `stretch` pulls
    it to the shape. The car window follows the fit."""
    border = Image.open(BORDER).convert("RGBA")
    cut = synthetic_cutout(600, 300)
    w, h = 400, 500
    for fit in ("fit", "fill", "stretch"):
        img = core.compose_hero([cut], w, h, {"kind": "generic", "seed": "b"}, border=border,
                                spotlight=False, border_fit=fit)
        assert img.size == (w, h), f"{fit}: the format decides the canvas"
        fitted, window = core.fit_border(border, w, h, fit)
        assert fitted.size == (w, h)
        farr = np.asarray(fitted)
        l, t, r, b = window
        assert 0 <= l < r <= w and 0 <= t < b <= h, f"{fit}: window {window} is off the canvas"
        # The frame's own opaque art shows through wherever the fitted
        # frame is opaque, whichever way it was fitted.
        opaque = farr[..., 3] == 255
        assert opaque.any()
        assert np.array_equal(np.asarray(img)[opaque], farr[..., :3][opaque])
        if fit == "fit":
            # A square frame in a portrait canvas leaves transparent bands
            # above and below it, where the backdrop shows.
            assert not opaque[0].any() and not opaque[-1].any()
            assert opaque[h // 2].any()
        if fit in ("fill", "stretch"):
            # The frame reaches every edge.
            assert opaque[0].any() and opaque[-1].any()
            assert opaque[:, 0].any() and opaque[:, -1].any()
    # An unknown fit is refused, not silently squared.
    with pytest.raises(RuntimeError):
        core.compose_hero([cut], w, h, {"kind": "generic", "seed": "b"}, border=border, border_fit="tile")


def test_fit_border_matches_between_native_and_wasm():
    """The same frame fitted to the same canvas gives the same bytes from
    the native core and the wasm build, so the browser's preview of a
    fitted frame is the CLI's still."""
    import shutil
    import subprocess
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    wasm = REPO / "web" / "public" / "core" / "lotstretcher_core_bg.wasm"
    if not wasm.exists():
        pytest.skip("wasm core not built")
    border = Image.open(BORDER).convert("RGBA")
    w, h = 300, 375
    native, window = core.fit_border(border, w, h, "fit")
    raw = border.tobytes()
    script = f"""
      import fs from 'node:fs';
      import {{ loadCore, call }} from '{(REPO / 'web' / 'public' / 'js' / 'core.js').as_posix()}';
      await loadCore(fs.readFileSync('{wasm.as_posix()}'));
      const data = new Uint8ClampedArray(fs.readFileSync('{{RAW}}'));
      const img = {{ width: {border.width}, height: {border.height}, data }};
      const fitted = call({{ op: 'fit_border', border: {{ $image: 0 }}, width: {w}, height: {h}, fit: 'fit' }}, [img]);
      const win = call({{ op: 'fit_window', border: {{ $image: 0 }}, width: {w}, height: {h}, fit: 'fit' }}, [img]);
      process.stdout.write(JSON.stringify({{ win, w: fitted.width, h: fitted.height, sum: fitted.data.reduce((a, b) => a + b, 0) }}));
    """
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        rawp = Path(d) / "border.raw"
        rawp.write_bytes(raw)
        js = Path(d) / "fit.mjs"
        js.write_text(script.replace("{RAW}", rawp.as_posix()))
        out = json.loads(subprocess.run([node, str(js)], capture_output=True, text=True, check=True).stdout)
    assert tuple(out["win"]) == tuple(window)
    assert (out["w"], out["h"]) == (w, h)
    assert out["sum"] == int(np.asarray(native, dtype=np.int64).sum())


def test_render_frame_with_placed_car_equals_compose_hero():
    """A frame is a composition with the placement made explicit: the
    same car at the rectangle compose_hero would choose, alpha 1, must be
    the same bytes. This is what lets the video hosts hand every frame
    to the core without a second compositing path."""
    from lotstretcher.imaging.compose.layout import compute_placement
    cut = synthetic_cutout()
    still = core.compose_hero([cut], 500, 400, {"kind": "generic", "seed": "f"}, spotlight=False)
    x, y, resized = compute_placement(cut, (0, 0, 500, 400), margin_frac=0.06, anchor="center")
    scaled = core.resize(cut, resized.width, resized.height)
    frame = core.render_frame([(scaled, x, y, scaled.width, scaled.height, 1.0)], 500, 400,
                              {"kind": "generic", "seed": "f"})
    assert frame.tobytes() == still.tobytes()


def test_render_frame_alpha_and_helpers():
    cut = synthetic_cutout()
    full = core.render_frame([(cut, 10, 10, cut.width, cut.height, 1.0)], 500, 400, {"kind": "generic", "seed": "a"})
    half = core.render_frame([(cut, 10, 10, cut.width, cut.height, 0.5)], 500, 400, {"kind": "generic", "seed": "a"})
    none = core.render_frame([], 500, 400, {"kind": "generic", "seed": "a"})
    f, h, n = (np.asarray(i, dtype=np.int16) for i in (full, half, none))
    assert np.abs(h - (f + n) / 2).mean() < 1.5, "alpha 0.5 sits halfway between drawn and undrawn"
    g = core.linear_gradient(200, 100, 30.0, (10, 20, 30), (200, 210, 220))
    assert g.size == (200, 100) and g.getpixel((0, 99)) != g.getpixel((199, 0))
    assert 0.35 <= core.dim_strength(none.crop((10, 10, 110, 110)), cut.resize((100, 100))) <= 1.0


def test_carousel_plan_and_frames_hold_the_documented_contract():
    """The conveyor choreography lives only in the core now. Its contract,
    as hero_video.py's docstrings state it: cuts on whole bars, a pan shot
    holds two bars and slides the full overflow, accents sit inside
    their boxes, transitions cross-fade the outgoing and incoming accents
    with alphas summing to one, and the hero is always drawn last."""
    W = H = 600
    backdrop = core.linear_gradient(W, H, 20.0, (30, 30, 40), (90, 90, 120))
    cuts = [synthetic_cutout(500, 200), synthetic_cutout(300, 200), synthetic_cutout(420, 180)]
    plan = core.call({"op": "carousel_plan", "width": W, "height": H, "backdrop": {"$image": 0},
                      "shots": [{"image": {"$image": i + 1}, "pannable": i == 0, "hood_side": "right"} for i in range(3)],
                      "audio_loop_s": 9.6}, [backdrop, *cuts])
    dwell = 9.6 / SPEC["video"]["barsPerLoop"]
    assert abs(plan["dwell"] - dwell) < 1e-9
    assert plan["beat_s"] == pytest.approx(dwell / SPEC["video"]["beatsPerBar"])
    assert plan["shots"][0]["is_pan"] and plan["shots"][0]["bars"] == SPEC["video"]["panBars"]
    assert not plan["shots"][1]["is_pan"] and plan["shots"][1]["bars"] == 1
    s0 = plan["shots"][0]
    assert s0["pan_x_end"] > s0["pan_x_start"], "hood right slides right"
    assert abs((s0["pan_x_end"] - s0["pan_x_start"]) - s0["pan_draw_w"]) < 1e-6, "slides its whole overflow"
    assert [tuple(x) for x in plan["schedule"]] == [(0.0, 2 * dwell), (2 * dwell, dwell), (3 * dwell, dwell)]
    assert plan["period"] == pytest.approx(4 * dwell)
    for sp in plan["shots"]:
        for r in (sp["left_rect"], sp["right_rect"], sp["hero_fit_rect"]):
            assert 0 <= r[0] and r[0] + r[2] <= W + 1e-6 and 0 <= r[1] and r[1] + r[3] <= H + 1e-6
        assert 0.35 <= sp["dim"] <= 1.0
    steady = core.call({"op": "carousel_frame", "plan": plan, "t": 0.2})
    assert steady["hero"] == 0 and [c["shot"] for c in steady["cars"]] == [2, 1, 0]
    assert all(c["alpha"] == 1.0 for c in steady["cars"])
    mid = core.call({"op": "carousel_frame", "plan": plan, "t": 2 * dwell - plan["transition_s"] * 0.5})
    assert mid["hero"] == 0 and len(mid["cars"]) == 4
    assert mid["cars"][0]["alpha"] + mid["cars"][1]["alpha"] == pytest.approx(1.0)
    later = core.call({"op": "carousel_frame", "plan": plan, "t": 2 * dwell + 0.1})
    assert later["hero"] == 1


def test_retained_images_render_identically_and_release():
    """A host may keep an image inside the core and name it by id: the
    result is byte-identical to passing the bytes, and a released id
    is refused rather than silently wrong."""
    car = synthetic_cutout()
    by_bytes = core.render_frame([(car, 40, 30, 300, 170, 1.0)], 400, 300, {"kind": "generic", "seed": "r"})
    held = core.retain(car)
    by_id = core.render_frame([(held, 40, 30, 300, 170, 1.0)], 400, 300, {"kind": "generic", "seed": "r"})
    assert by_id.tobytes() == by_bytes.tobytes()
    # A retained result of an op works too (a scaled car kept for a clip).
    scaled = core.retain(core.resize(held, 300, 170))
    by_scaled = core.render_frame([(scaled, 40, 30, 300, 170, 1.0)], 400, 300, {"kind": "generic", "seed": "r"})
    assert by_scaled.tobytes() == by_bytes.tobytes()
    assert core.release(held) and core.release(scaled)
    assert not core.release(held)
    with pytest.raises(RuntimeError, match="no retained image"):
        core.render_frame([(held, 40, 30, 300, 170, 1.0)], 400, 300, {"kind": "generic", "seed": "r"})
    assert core.release_all() == 0
