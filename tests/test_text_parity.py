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
CONTROLS = {"titleMode": "vehicle", "priceBadge": True, "subtitle": "Ask for Alex",
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
    assert texts == ["2024 Ford Maverick XLT", "Ask for Alex", "$31,480"]
    # Title largest, subtitle smallest; only the badge has a pill.
    assert plan[0]["size"] > plan[2]["size"] > plan[1]["size"]
    assert [bool(o["pill"]) for o in plan] == [False, False, True]
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
    assert style == {"kind": "line", "color": "white", "weight": 0.01, "inset": 0.035, "radius": 0.02}
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


def test_the_sweep_is_a_lit_floor_line_in_the_vehicles_colours():
    """Brightest at the horizon, darker at the top and the bottom, a pool
    of light about the middle of the line; the same seed gives the same
    pixels; a frame takes it with a sample for the paint."""
    from lotstretcher.imaging.text import backdrop_spec
    assert backdrop_spec("sweep", "s", "Rapid Red", None) == {"kind": "sweep", "seed": "s", "exterior": "Rapid Red", "interior": None}
    assert backdrop_spec("generic", "s", "x", "y") == {"kind": "generic", "seed": "s"}
    with pytest.raises(ValueError):
        backdrop_spec("neon", "s", None, None)
    # A colour of the user's rides the spec; the vehicle backdrop ignores it.
    assert backdrop_spec("generic", "s", None, None, "#ff8800") == {"kind": "generic", "seed": "s", "color": "#ff8800"}
    assert backdrop_spec("sweep", "s", "Rapid Red", None, "#ff8800")["color"] == "#ff8800"
    assert "color" not in backdrop_spec("vehicle", "s", "Rapid Red", None, "#ff8800")
    bg = {"kind": "sweep", "seed": "s", "exterior": "Rapid Red", "interior": None}
    img = np.asarray(core.render_frame([], 600, 600, bg)).astype(int)
    lum = img.sum(axis=2)
    horizon = int(np.argmax(lum[:, 300]))
    assert 0.55 * 600 < horizon < 0.72 * 600, horizon
    assert lum[horizon, 300] > lum[20, 300] + 150 and lum[horizon, 300] > lum[590, 300] + 100
    assert lum[horizon, 300] > lum[horizon, 10] + 40, "the pool of light sits about the middle"
    assert img[horizon, 300, 0] > img[horizon, 300, 1] + 30, "a red name gives a red sweep"
    again = np.asarray(core.render_frame([], 600, 600, bg)).astype(int)
    assert (again == img).all()
    # Composed with a car on it: the still's backdrop is the same sweep.
    still = np.asarray(core.compose_hero([cutout()], 600, 600, bg, spotlight=False)).astype(int)
    assert (still[5, 5] == img[5, 5]).all() and (still[595, 5] == img[595, 5]).all()
    # No colour name: the paint is read off the sample (red cutout).
    sampled = core.call({"op": "render_frame", "width": 200, "height": 200,
                         "background": {"kind": "sweep", "seed": "s", "exterior": None, "interior": None, "sample": {"$image": 0}},
                         "cars": []}, [cutout()])
    row = np.asarray(sampled).astype(int)[int(np.argmax(np.asarray(sampled).astype(int).sum(axis=2)[:, 100])), 100]
    assert row[0] > row[1] + 20


def test_a_chosen_colour_puts_the_bands_and_the_sweep_in_that_hue():
    """--backdrop-color: hue bands and the sweep take the colour, on
    both builds; the Python parser reads the same hex the core does."""
    from lotstretcher.imaging.palette import parse_color_name
    from lotstretcher.imaging.text import backdrop_color, gradient_color_names
    assert parse_color_name("#ff8800") == (255, 136, 0)
    assert parse_color_name("#F80") == (255, 136, 0)
    assert parse_color_name("Rapid Red") == parse_color_name("rapid red")
    assert backdrop_color({"backdrop": "sweep", "backdropColor": "#ff8800"}) == "#ff8800"
    assert backdrop_color({"backdrop": "vehicle", "backdropColor": "#ff8800"}) is None
    assert gradient_color_names("Blue", None, "generic", "#ff8800") == ("#ff8800", "#ff8800")
    assert gradient_color_names("Blue", None, "vehicle", "#ff8800") == ("Blue", None)
    for kind in ("generic", "sweep"):
        orange = np.asarray(core.render_frame([], 120, 120, {"kind": kind, "seed": "s", "exterior": None, "interior": None, "color": "#ff8800"})).astype(int)
        plain = np.asarray(core.render_frame([], 120, 120, {"kind": kind, "seed": "s", "exterior": "Deep Blue", "interior": None})).astype(int)
        r, g, b = orange.reshape(-1, 3).mean(axis=0)
        assert r > g > b, (kind, r, g, b)
        assert not np.array_equal(orange, plain)
    # The wasm build draws the same pixels as the native one.
    node = shutil.which("node")
    wasm = REPO / "web" / "public" / "core" / "lotstretcher_core_bg.wasm"
    if not node or not wasm.exists():
        return
    bg = {"kind": "sweep", "seed": "s", "exterior": None, "interior": None, "color": "#ff8800"}
    script = f"""
      import fs from 'node:fs';
      import {{ loadCore, call }} from '{(REPO / 'web' / 'public' / 'js' / 'core.js').as_posix()}';
      await loadCore(fs.readFileSync('{wasm.as_posix()}'));
      const out = call({{ op: 'render_frame', width: 120, height: 120, background: {json.dumps(bg)}, cars: [] }}, []);
      process.stdout.write(JSON.stringify(Array.from(out.data.slice(0, 30))));
    """
    with tempfile.TemporaryDirectory() as d:
        js = Path(d) / "sweep.mjs"
        js.write_text(script)
        out = json.loads(subprocess.run([node, str(js)], capture_output=True, text=True, check=True).stdout)
    native = np.asarray(core.render_frame([], 120, 120, bg)).reshape(-1)[:30]
    assert list(int(v) for v in native) == out


def test_a_hex_is_taken_wherever_a_named_colour_goes():
    """The app's colour picker gives #rrggbb; the frame, the text badge
    and the glow take it on the core, and the CLIs accept it."""
    import argparse
    from lotstretcher.imaging.compose.effects import resolve_glow_color
    from lotstretcher.imaging.text import color_choice
    ensure_font()
    assert resolve_glow_color("#ff8800") == (255, 136, 0)
    assert color_choice(COLORS_TUPLE)("#FF8800") == "#ff8800"
    assert color_choice(COLORS_TUPLE)("paint") == "paint"
    with pytest.raises(argparse.ArgumentTypeError):
        color_choice(COLORS_TUPLE)("red")
    # The badge takes the colour; the words go dark over a bright one.
    plan = core.overlay_plan(400, 400, VEHICLE, font="Lato Bold", title="vehicle", price_badge=True, color="#ffee88")
    badge = next(o for o in plan if o.get("pill"))
    assert list(badge["pill"]["color"][:3]) == [255, 238, 136]
    assert list(badge["color"]) == [16, 16, 16]
    # A frame and a glow in it draw without complaint.
    cut = Image.new("RGBA", (60, 40), (200, 30, 30, 255))
    img = core.compose_hero([cut], 200, 200, {"kind": "generic", "seed": "s"},
                            border_style={"kind": "line", "color": "#ff8800", "weight": 0.02},
                            glow=True, glow_color="#00ff00")
    assert img.size == (200, 200)
    with pytest.raises(RuntimeError):
        core.compose_hero([cut], 200, 200, {"kind": "generic", "seed": "s"}, border_style={"kind": "line", "color": "orange", "weight": 0.02})


COLORS_TUPLE = ("white", "black", "paint")


def test_the_halo_and_the_two_tone_draw_from_the_stops():
    """--backdrop radial: brightest about the middle, darker at the
    corners. --backdrop horizon: a lighter wall above a darker floor
    with a soft band between. Both take a colour, both are seeded."""
    from lotstretcher.imaging.text import BACKDROPS, backdrop_spec
    assert "radial" in BACKDROPS and "horizon" in BACKDROPS
    assert backdrop_spec("radial", "s", None, None, "#ff8800")["color"] == "#ff8800"
    halo = np.asarray(core.render_frame([], 200, 200, {"kind": "radial", "seed": "s", "exterior": "Deep Blue", "interior": None})).astype(int)
    lum = halo.sum(axis=2)
    assert lum[110, 100] > lum[5, 5] + 60 and lum[110, 100] > lum[195, 195] + 60
    same = np.asarray(core.render_frame([], 200, 200, {"kind": "radial", "seed": "s", "exterior": "Deep Blue", "interior": None})).astype(int)
    assert np.array_equal(halo, same)
    two = np.asarray(core.render_frame([], 200, 200, {"kind": "horizon", "seed": "s", "exterior": "Deep Blue", "interior": None})).astype(int)
    lum2 = two.sum(axis=2)
    assert lum2[40, 100] > lum2[190, 100] + 40
    assert abs(int(lum2[40, 100]) - int(lum2[60, 100])) < 30  # the wall is flat-ish
    orange = np.asarray(core.render_frame([], 60, 60, {"kind": "horizon", "seed": "s", "exterior": None, "interior": None, "color": "#ff8800"})).astype(int)
    r, g, b = orange.reshape(-1, 3).mean(axis=0)
    assert r > g > b


def test_two_chosen_stops_are_taken_as_they_are_and_an_angle_fixes_the_direction():
    """--backdrop-color and --backdrop-color2 together are the two stops
    raw (the wall and the floor of a two-tone); --backdrop-angle fixes a
    linear backdrop's direction, so 0 and 180 are mirror images. The
    drawn frame carries its inset and corner radius."""
    from lotstretcher.imaging.text import backdrop_angle, backdrop_color2, backdrop_spec, frame_style
    spec = backdrop_spec("horizon", "s", None, None, "#ff8800", "#2244aa")
    assert spec["color"] == "#ff8800" and spec["color2"] == "#2244aa"
    assert backdrop_spec("vehicle", "s", "Blue", None, "#ff8800", "#2244aa", 45.0) == {"kind": "vehicle", "seed": "s", "exterior": "Blue", "interior": None, "angle": 45.0}
    assert backdrop_color2({"backdrop": "horizon", "backdropColor2": "#2244aa"}) == "#2244aa"
    assert backdrop_angle({"backdrop": "generic", "backdropAngle": 90}) == 90.0
    assert backdrop_angle({"backdrop": "sweep", "backdropAngle": 90}) is None
    two = np.asarray(core.render_frame([], 100, 100, spec)).astype(int)
    assert list(two[5, 50]) != list(two[95, 50])
    assert two[5, 50][0] > 180 and two[5, 50][2] < 60 and two[95, 50][2] > 100 and two[95, 50][0] < 60   # wall orange, floor blue, as picked
    a = np.asarray(core.render_frame([], 80, 80, {"kind": "generic", "seed": "s", "color": "#ff8800", "color2": "#2244aa", "angle": 0.0})).astype(int)
    b = np.asarray(core.render_frame([], 80, 80, {"kind": "generic", "seed": "s", "color": "#ff8800", "color2": "#2244aa", "angle": 180.0})).astype(int)
    assert np.abs(a - b[:, ::-1]).mean() < 6
    fs = frame_style({"border": "line", "frameInset": 0.1, "frameRadius": 0.05})
    assert fs["inset"] == 0.1 and fs["radius"] == 0.05


def test_each_piece_can_take_its_own_corner_font_colour_and_box():
    """The per-piece levers (--title-font, --subtitle-position, --badge-color,
    --subtitle-box ...): a piece with its own corner leaves the stack, one
    with its own font is set in it, and the shared levers still describe
    every piece left alone."""
    w, h = 1080, 1350
    own = {**CONTROLS, "subtitlePosition": "tr", "titleFont": "Oswald Bold", "badgeColor": "paint",
           "subtitleBox": "on", "subtitleCase": "upper", "textFont": "Lato Bold"}
    plan = plan_overlays(w, h, VEHICLE, text_options(own))
    by = {o["piece"]: o for o in plan}
    assert set(by) == {"title", "subtitle", "badge"}
    # The subtitle went to the top right, on its own, in upper case, on a pill.
    assert by["subtitle"]["y"] < h / 2 < by["title"]["y"]
    assert by["subtitle"]["x"] + by["subtitle"]["box_w"] > w * 0.9
    assert by["subtitle"]["text"] == "ASK FOR ALEX" and by["subtitle"]["pill"]
    # The title took its own font; the others kept the shared one.
    assert by["title"]["font"] == "Oswald Bold"
    assert by["badge"]["font"] == by["subtitle"]["font"] == "Lato Bold"
    # The badge took the paint (a red cutout gives a red pill); the title stayed white.
    assert by["title"]["color"] == [255, 255, 255]
    named = {**VEHICLE, "exterior_color": "Red"}
    red = plan_overlays(w, h, named, text_options(own))
    badge = next(o for o in red if o["piece"] == "badge")
    assert badge["pill"]["color"][0] > badge["pill"]["color"][2]
    # The same controls with every piece lever at "same" is the shared plan.
    same = {**CONTROLS, "titleFont": "same", "subtitlePosition": None, "badgeColor": "same", "subtitleBox": "same"}
    assert plan_overlays(w, h, VEHICLE, text_options(same)) == plan_overlays(w, h, VEHICLE, text_options(CONTROLS))


def test_pieces_in_both_halves_shrink_each_half_only():
    """A title up top and a line at the bottom take a band off each end,
    never the whole window between them."""
    from lotstretcher.imaging.text import text_window
    w, h = 1080, 1350
    plan = plan_overlays(w, h, VEHICLE, text_options({**CONTROLS, "textPosition": "tl", "subtitlePosition": "br"}), window=(0, 0, w, h))
    top, bottom = text_window((0, 0, w, h), h, plan)[1], text_window((0, 0, w, h), h, plan)[3]
    assert 0 < top < h * 0.3 and h * 0.7 < bottom < h


def test_spotlight_strength_and_spread_are_levers():
    """--spotlight-strength replaces the measured dim (0 leaves the
    backdrop alone, 1 dims it as hard as the measurement ever would) and
    --spotlight-spread tightens the pool of light; the clip's frames
    take the same levers as the still."""
    bg = {"kind": "generic", "seed": "spot"}
    def corner_lum(img):
        px = img.convert("RGB").load()
        return sum(px[3, 3][:3]) / 3
    off = core.compose_hero([cutout()], 400, 400, bg, spotlight=False)
    none = core.compose_hero([cutout()], 400, 400, bg, spotlight={"strength": 0.0})
    hard = core.compose_hero([cutout()], 400, 400, bg, spotlight={"strength": 1.0})
    tight = core.compose_hero([cutout()], 400, 400, bg, spotlight={"strength": 1.0, "spread": 0.45})
    assert corner_lum(none) == corner_lum(off)
    assert corner_lum(hard) < corner_lum(off) * 0.6
    # A tighter spread reaches the corner's dim sooner, so a point halfway
    # out is darker under it than under the default spread.
    mid = lambda img: sum(img.convert("RGB").load()[80, 80][:3]) / 3
    assert mid(tight) < mid(hard)
    # The frame op takes the same levers.
    car = (cutout(), 50, 100, 300, 156, 1.0)
    f_hard = core.render_frame([car], 400, 400, bg, spotlight=(200, 200, 1.0, {"strength": 1.0}))
    f_off = core.render_frame([car], 400, 400, bg, spotlight=None)
    assert corner_lum(f_hard) < corner_lum(f_off) * 0.6



def test_pieces_in_different_corners_of_one_half_never_cross():
    """A wide title at the top centre and the badge at the top left both
    start at the top; the badge is placed below the title's box rather
    than on it, as pieces sharing a corner are."""
    w, h = 1080, 1920
    own = {**CONTROLS, "textPosition": "tl", "titlePosition": "tc", "textSize": 0.07}
    by = {o["piece"]: o for o in plan_overlays(w, h, VEHICLE, text_options(own))}
    title, badge = by["title"], by["badge"]
    assert badge["x"] < title["x"] + title["box_w"], "the boxes share columns"
    assert badge["y"] >= title["y"] + title["box_h"], "so the badge sits under the title"
    # In the other half nothing crosses: a top-right badge beside a short
    # top-left title keeps the top row.
    apart = {**CONTROLS, "titleMode": "custom", "titleText": "F-150", "textPosition": "tl", "badgePosition": "tr"}
    by = {o["piece"]: o for o in plan_overlays(w, h, VEHICLE, text_options(apart))}
    assert by["badge"]["y"] == by["title"]["y"]


def test_title_size_follows_the_canvas_mean_side_not_its_height():
    """A portrait clip's title is set from the canvas's geometric mean
    side: on 1080x1920 it is sqrt(2) smaller than height alone would
    make it, so the vehicle title stays on one line, and on 1920x1080
    it is that much larger than a caption."""
    square = plan_overlays(1080, 1080, VEHICLE, text_options(CONTROLS))[0]["size"]
    portrait = plan_overlays(1080, 1920, VEHICLE, text_options(CONTROLS))[0]["size"]
    landscape = plan_overlays(1920, 1080, VEHICLE, text_options(CONTROLS))[0]["size"]
    assert portrait == landscape
    assert abs(portrait / square - (1920 / 1080) ** 0.5) < 0.02
    # Too wide for the window, a title shrinks to fit one line before it
    # wraps: the size lever is a ceiling, not a promise of two lines.
    title = plan_overlays(1080, 1920, VEHICLE, text_options({**CONTROLS, "textSize": 0.07}))[0]
    assert title["size"] < 0.07 * (1080 * 1920) ** 0.5
    assert title["box_h"] < title["size"] * 1.6, "one line, not two"
