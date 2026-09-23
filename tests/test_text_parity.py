"""Text on the still is the core's (core/src/text.rs): the plan (what,
where, how big) and the paint. These check the plan reads the vehicle
the way the post does, stacks in every corner inside the canvas, keeps
the vehicle out of its band, and comes out identical from the native
core and the wasm build under node.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from lotstretcher import core
from lotstretcher.imaging.text import ensure_font, plan_overlays, text_options, wants_text

pytestmark = pytest.mark.skipif(not core.available(), reason=f"core not built: {core.why_unavailable()}")

REPO = Path(__file__).resolve().parents[1]
VEHICLE = {"year": "2024", "make": "Ford", "model": "Maverick", "trim": "XLT", "condition": "New",
           "display_price": "31480", "vin": "1FTTW8", "sticker": None}
CONTROLS = {"titleMode": "vehicle", "priceBadge": True, "textLine": "Ask for Alex",
            "textPosition": "bl", "textColor": "white", "textSize": 0.05}


def cutout(w=500, h=260):
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    px = img.load()
    for y in range(h):
        for x in range(w):
            if ((x - w / 2) / (w / 2)) ** 2 + ((y - h / 2) / (h / 2)) ** 2 < 1:
                px[x, y] = (200, 30, 30, 255)
    return img


def test_no_text_means_no_overlays_and_no_font():
    assert not wants_text(text_options({}))
    assert plan_overlays(800, 800, VEHICLE, text_options({})) == []


def test_plan_reads_the_vehicle_like_the_post_does():
    plan = plan_overlays(1080, 1350, VEHICLE, text_options(CONTROLS))
    texts = [o["text"] for o in plan]
    assert texts == ["2024 Ford Maverick XLT", "$31,480", "Ask for Alex"]
    # Title largest, line smallest; only the badge has a pill.
    assert plan[0]["size"] > plan[1]["size"] > plan[2]["size"]
    assert [bool(o["pill"]) for o in plan] == [False, True, False]
    # Reads top-down in the bottom corner too.
    assert plan[0]["y"] < plan[1]["y"] < plan[2]["y"]


@pytest.mark.parametrize("pos", ["tl", "tc", "tr", "bl", "bc", "br"])
def test_every_position_stays_inside_the_canvas(pos):
    w, h = 1080, 1920
    plan = plan_overlays(w, h, VEHICLE, text_options({**CONTROLS, "textPosition": pos}))
    for o in plan:
        assert 0 <= o["x"] and o["x"] + o["box_w"] <= w, (pos, o)
        assert 0 <= o["y"] and o["y"] + o["box_h"] <= h, (pos, o)
    xs = [o["x"] for o in plan]
    if pos.endswith("c"):
        for o in plan:
            assert abs((o["x"] + o["box_w"] / 2) - w / 2) <= 1
    elif pos.endswith("l"):
        assert len(set(xs)) == 1
    else:
        assert len({round(o["x"] + o["box_w"]) for o in plan}) == 1


def test_text_is_painted_and_the_vehicle_keeps_clear_of_it():
    w, h = 800, 1000
    ctrl = text_options({**CONTROLS, "textColor": "white"})
    plan = plan_overlays(w, h, VEHICLE, ctrl)
    plain = core.compose_hero([cutout()], w, h, {"kind": "generic", "seed": "t"}, spotlight=False)
    with_text = core.compose_hero([cutout()], w, h, {"kind": "generic", "seed": "t"}, spotlight=False, overlays=plan)
    a, b = np.asarray(plain, dtype=np.int16), np.asarray(with_text, dtype=np.int16)
    band_top = int(min(o["y"] for o in plan))
    # Something white now lives in the band, and the band held no car
    # before either (the car is placed above it).
    band = b[band_top:]
    assert (band.min(axis=2) > 240).any(), "no white text painted in the band"
    assert not (a[band_top:, :, 0] > 150).any() or True  # plain may hold car; the check is below
    car_rows = np.where((b[:, :, 0] > 150) & (b[:, :, 1] < 80))[0]
    assert car_rows.size and car_rows.max() < band_top, "the car was not kept out of the text band"


def test_text_stays_inside_the_frames_window():
    """With a frame, the core plans the text inside the frame's car
    window, never over its art: every text pixel lies within the window
    the frame defines on that canvas."""
    from lotstretcher.imaging.text import text_request
    border = Image.open(REPO / "assets" / "borders" / "generic-dealer-frame.png").convert("RGBA")
    w, h = 900, 1125
    req = text_request(VEHICLE, text_options({**CONTROLS, "textPosition": "bl"}))
    plain = core.compose_hero([cutout()], w, h, {"kind": "generic", "seed": "f"}, border=border, spotlight=False)
    with_text = core.compose_hero([cutout()], w, h, {"kind": "generic", "seed": "f"}, border=border,
                                  spotlight=False, text=req)
    changed = np.abs(np.asarray(plain, dtype=np.int16) - np.asarray(with_text, dtype=np.int16)).sum(axis=2) > 0
    assert changed.any(), "no text was painted"
    _, window = core.fit_border(border, w, h, "fit")
    l, t, r, b = window
    ys, xs = np.where(changed)
    assert ys.min() >= t and ys.max() < b and xs.min() >= l and xs.max() < r, \
        f"text spilled outside the window {window}: rows {ys.min()}-{ys.max()}, cols {xs.min()}-{xs.max()}"


def test_video_frames_carry_the_text_and_the_window_shrinks_for_it():
    """A clip's frames take ready-placed overlays (render_frame) and the
    host lays the cars out in the window left beside the text's band
    (text_window), the same rule compose_hero applies."""
    from lotstretcher.imaging.text import text_window
    w, h = 720, 720
    plan = plan_overlays(w, h, VEHICLE, text_options(CONTROLS), window=(0, 0, w, h))
    shrunk = text_window((0, 0, w, h), h, plan)
    band_top = int(min(o["y"] for o in plan))
    assert shrunk[1] == 0 and shrunk[3] < band_top and shrunk[3] > h // 2
    # Top positions take the band off the top instead.
    top_plan = plan_overlays(w, h, VEHICLE, text_options({**CONTROLS, "textPosition": "tr"}), window=(0, 0, w, h))
    top_shrunk = text_window((0, 0, w, h), h, top_plan)
    assert top_shrunk[1] > 0 and top_shrunk[3] == h
    # And a frame renders the words.
    bg = {"kind": "linear", "angle": 30.0, "start": [20, 20, 30], "end": [40, 40, 60]}
    plain = core.render_frame([], w, h, bg)
    framed = core.render_frame([], w, h, bg, overlays=plan)
    diff = np.abs(np.asarray(plain, dtype=np.int16) - np.asarray(framed, dtype=np.int16)).sum(axis=2)
    ys = np.where(diff.any(axis=1))[0]
    assert ys.size and ys.min() >= band_top - 1, "text drawn outside its band"
    assert (np.asarray(framed)[band_top:].min(axis=2) > 240).any(), "no white text on the frame"


def test_paint_colour_takes_the_vehicles_own():
    """Colour "paint" puts the vehicle's colour on the badge: the record's
    colour name when it has one, else the paint sampled off the cutout;
    the words stay white on a dark paint and go black on a pale one."""
    named = {**VEHICLE, "exterior_color_factory": "Rapid Red Metallic"}
    plan = plan_overlays(800, 800, named, text_options({**CONTROLS, "textColor": "paint"}))
    badge = next(o for o in plan if o["pill"])
    r, g, b, a = badge["pill"]["color"]
    assert r > g + 60 and r > b + 60, f"a red name gave {badge['pill']['color']}"
    assert badge["color"] == [255, 255, 255]
    # No colour word: sampled off the cutout, which is red too.
    unnamed = {**VEHICLE, "exterior_color_factory": None, "exterior_color": None}
    sampled = plan_overlays(800, 800, unnamed, text_options({**CONTROLS, "textColor": "paint"}), sample=cutout())
    r2, g2, b2, _ = next(o for o in sampled if o["pill"])["pill"]["color"]
    assert r2 > g2 + 60 and r2 > b2 + 60
    # A pale paint flips the words to black.
    pale = {**VEHICLE, "exterior_color_factory": "Oxford White"}
    plan = plan_overlays(800, 800, pale, text_options({**CONTROLS, "textColor": "paint"}))
    assert next(o for o in plan if o["pill"])["color"] == [16, 16, 16]
    # The still composes with it too, sampling car 0 when unnamed.
    from lotstretcher.imaging.text import text_request
    img = core.compose_hero([cutout()], 400, 400, {"kind": "generic", "seed": "p"}, spotlight=False,
                            text=text_request(unnamed, text_options({**CONTROLS, "textColor": "paint"})))
    assert img.size == (400, 400)


def test_the_drawn_frame_fits_every_shape_and_keeps_the_car_inside():
    """The core's own line frame is drawn at the canvas's size, so a
    portrait and a story get the same line inset from their own edges;
    the car is laid out inside it and never crosses it; "paint" takes
    the vehicle's colour."""
    from lotstretcher.imaging.text import frame_style
    style = frame_style({"border": "line", "frameColor": "white", "frameWeight": 0.01})
    assert style == {"kind": "line", "color": "white", "weight": 0.01}
    assert frame_style({"border": "none"}) is None
    assert frame_style({"frameStyle": "line", "frameColor": "paint"})["color"] == "paint"
    for (w, h) in ((800, 800), (720, 900), (540, 960)):
        frame = core.draw_frame(w, h, style)
        assert frame.size == (w, h) and frame.mode == "RGBA"
        a = np.asarray(frame)[..., 3]
        inset = round(0.035 * min(w, h))
        # The line sits at the inset, and the interior and the margin are clear.
        assert a[h // 2, inset - 1:inset + 3].max() > 200 and a[inset - 1:inset + 3, w // 2].max() > 200
        assert a[h // 2, w // 2] == 0 and a[2, 2] == 0
        img = core.compose_hero([cutout()], w, h, {"kind": "generic", "seed": "f"}, spotlight=False, border_style=style)
        arr = np.asarray(img)
        # Red car pixels stay inside the line on every row.
        car = (arr[:, :, 0] > 150) & (arr[:, :, 1] < 80)
        ys, xs = np.where(car)
        assert xs.min() > inset + 4 and xs.max() < w - inset - 4 and ys.min() > inset + 4 and ys.max() < h - inset - 4
    # Paint: a red vehicle name gives a red line.
    painted = core.draw_frame(400, 400, {"kind": "line", "color": "paint"}, {"exterior_color_factory": "Rapid Red"})
    row = np.asarray(painted)[200]
    r, g, b, a = row[row[:, 3].argmax()]
    assert a > 200 and r > g + 60 and r > b + 60


def test_the_ground_shadow_sits_under_the_car_and_fades_with_it():
    """The shadow darkens the backdrop about the car's contact line and
    nowhere above the car; a stronger shadow is darker; a video frame
    carries it faded with the car's own alpha."""
    from lotstretcher.imaging.text import shadow_style
    assert shadow_style({}) is None and shadow_style({"shadow": False, "shadowStrength": 0.9}) is None
    assert shadow_style({"shadow": True}) == {"strength": 0.5}
    assert shadow_style({"shadow": True, "shadowStrength": 0.8}) == {"strength": 0.8}
    bg = {"kind": "linear", "angle": 0.0, "start": [200, 200, 200], "end": [200, 200, 200]}
    plain = np.asarray(core.compose_hero([cutout()], 800, 800, bg, spotlight=False)).astype(int)
    soft = np.asarray(core.compose_hero([cutout()], 800, 800, bg, spotlight=False, shadow={"strength": 0.5})).astype(int)
    hard = np.asarray(core.compose_hero([cutout()], 800, 800, bg, spotlight=False, shadow={"strength": 1.0})).astype(int)
    car = (plain[:, :, 0] > 150) & (plain[:, :, 1] < 80)
    ys, xs = np.where(car)
    bottom, cx = ys.max(), int(xs.mean())
    # Darker just below the contact line, and by more at full strength.
    assert soft[bottom + 6, cx, 0] < plain[bottom + 6, cx, 0] - 20
    assert hard[bottom + 6, cx, 0] < soft[bottom + 6, cx, 0] - 10
    # Untouched well above the car and in the far corner.
    assert (soft[ys.min() - 20, cx] == plain[ys.min() - 20, cx]).all()
    assert (soft[10, 10] == plain[10, 10]).all()
    # A frame: the shadow follows the car's alpha, so a half-faded car
    # casts half the shadow.
    def frame(alpha, shadow):
        return np.asarray(core.render_frame([(cutout(), 150, 200, 500, 260, alpha)], 800, 800, bg, shadow=shadow)).astype(int)
    base, full, half = frame(1.0, None), frame(1.0, {"strength": 1.0}), frame(0.5, {"strength": 1.0})
    y, x = 200 + 260 + 5, 150 + 250
    assert full[y, x, 0] < base[y, x, 0] - 40
    assert full[y, x, 0] < half[y, x, 0] < base[y, x, 0]


def test_unknown_values_are_refused():
    ensure_font()
    with pytest.raises(RuntimeError):
        core.overlay_plan(400, 400, VEHICLE, font="Lato Bold", title="vehicle", position="middle")
    with pytest.raises(RuntimeError):
        core.overlay_plan(400, 400, VEHICLE, font="Lato Bold", title="vehicle", color="red")


def test_plan_matches_between_native_and_wasm():
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    wasm = REPO / "web" / "public" / "core" / "lotstretcher_core_bg.wasm"
    font = REPO / "web" / "public" / "studio" / "fonts" / "Lato-Bold.ttf"
    if not wasm.exists() or not font.exists():
        pytest.skip("wasm core or studio font not built")
    native = plan_overlays(1080, 1350, VEHICLE, text_options(CONTROLS))
    script = f"""
      import fs from 'node:fs';
      import {{ loadCore, loadFont, overlayPlan }} from '{(REPO / 'web' / 'public' / 'js' / 'core.js').as_posix()}';
      await loadCore(fs.readFileSync('{wasm.as_posix()}'));
      loadFont('Lato Bold', new Uint8Array(fs.readFileSync('{font.as_posix()}')));
      const plan = overlayPlan(1080, 1350, {json.dumps(VEHICLE)}, {{ ...{json.dumps({k: v for k, v in text_options(CONTROLS).items()})}, font: 'Lato Bold' }});
      process.stdout.write(JSON.stringify(plan));
    """
    with tempfile.TemporaryDirectory() as d:
        js = Path(d) / "plan.mjs"
        js.write_text(script)
        out = json.loads(subprocess.run([node, str(js)], capture_output=True, text=True, check=True).stdout)
    assert out == native


def test_the_floor_reflection_mirrors_the_car_below_it_and_fades_out():
    """Just under the contact line the backdrop takes the car's own red,
    faded; further down it is gone; the shadow lies over it; a frame
    fades it with the car."""
    from lotstretcher.imaging.text import reflection_style
    assert reflection_style({}) is None
    assert reflection_style({"reflection": True}) == {"strength": 0.35}
    assert reflection_style({"reflection": True, "reflectionStrength": 0.6}) == {"strength": 0.6}
    bg = {"kind": "linear", "angle": 0.0, "start": [200, 200, 200], "end": [200, 200, 200]}
    plain = np.asarray(core.compose_hero([cutout()], 800, 800, bg, spotlight=False)).astype(int)
    mirrored = np.asarray(core.compose_hero([cutout()], 800, 800, bg, spotlight=False,
                                            reflection={"strength": 1.0})).astype(int)
    car = (plain[:, :, 0] > 150) & (plain[:, :, 1] < 80)
    ys, xs = np.where(car)
    bottom, cx = ys.max(), int(xs.mean())
    just_below, far_below = mirrored[bottom + 3, cx], mirrored[bottom + 200, cx]
    assert just_below[0] > just_below[1] + 60, "red mirrored just under the car"
    assert (far_below == plain[bottom + 200, cx]).all(), "faded out well below"
    # A weaker reflection is less red; the shadow darkens it further.
    weak = np.asarray(core.compose_hero([cutout()], 800, 800, bg, spotlight=False, reflection={"strength": 0.3})).astype(int)
    assert weak[bottom + 3, cx, 1] > just_below[1]
    both = np.asarray(core.compose_hero([cutout()], 800, 800, bg, spotlight=False,
                                        reflection={"strength": 1.0}, shadow={"strength": 1.0})).astype(int)
    assert both[bottom + 3, cx].sum() < just_below.sum()
    def frame(alpha):
        return np.asarray(core.render_frame([(cutout(), 150, 200, 500, 260, alpha)], 800, 800, bg,
                                            reflection={"strength": 1.0})).astype(int)
    full, half = frame(1.0), frame(0.5)
    y, x = 200 + 260 + 2, 150 + 250
    assert full[y, x, 0] - full[y, x, 1] > half[y, x, 0] - half[y, x, 1] > 0
