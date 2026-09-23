"""The spin's choreography in the core against the Pillow path it
replaced (compose/spin.py before the fifth core slice).

The reference below is that Python, kept as the documented contract:
every anchor scaled to spin.heightFrac of the canvas and set on the
spin.groundFrac ground line, held for spin.holdSeconds, cross-dissolved
over spin.transitionSeconds with Image.blend, on a spotlit gradient.
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
SPIN = json.loads((REPO / "shared" / "pipeline-spec.json").read_text())["spin"]


def blob(w, h, color):
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    px = img.load()
    for y in range(h):
        for x in range(w):
            d = ((x - w / 2) / (w / 2)) ** 2 + ((y - h / 2) / (h / 2)) ** 2
            if d < 1.0:
                px[x, y] = (*color, int(255 * min(1.0, (1.0 - d) * 6)))
    return img


def reference_fit_and_anchor(cutout, size):
    cw, ch = size
    target_h = round(ch * SPIN["heightFrac"])
    scale = target_h / cutout.height
    resized = cutout.resize((round(cutout.width * scale), target_h), Image.LANCZOS, reducing_gap=2.0)
    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    x = (cw - resized.width) // 2
    y = round(ch * SPIN["groundFrac"]) - resized.height
    layer.alpha_composite(resized, (x, y))
    return layer, (x, y, resized.width, resized.height)


ANCHORS = [blob(420, 240, (180, 40, 40)), blob(300, 260, (40, 90, 200)), blob(500, 220, (30, 160, 60))]
SIZE = (320, 320)


def test_plan_matches_the_reference_placement_and_schedule():
    plan = core.call({"op": "spin_plan", "width": SIZE[0], "height": SIZE[1],
                      "anchors": [{"width": a.width, "height": a.height} for a in ANCHORS]})
    for a, rect in zip(ANCHORS, plan["rects"]):
        _, ref = reference_fit_and_anchor(a, SIZE)
        assert tuple(rect) == ref
    fps = SPIN["fps"]
    hold, trans = round(SPIN["holdSeconds"] * fps), round(SPIN["transitionSeconds"] * fps)
    n = len(ANCHORS)
    assert (plan["hold_frames"], plan["trans_frames"]) == (hold, trans)
    assert plan["total_frames"] == n * hold + (n - 1) * trans
    assert plan["total_seconds"] == pytest.approx(plan["total_frames"] / fps)
    assert plan["spotlight"] == [SIZE[0] / 2, SIZE[1] * SPIN["groundFrac"], SPIN["spotlightDim"]]


def test_frame_schedule_matches_the_reference():
    plan = core.call({"op": "spin_plan", "width": SIZE[0], "height": SIZE[1],
                      "anchors": [{"width": a.width, "height": a.height} for a in ANCHORS]})
    hold, trans, n = plan["hold_frames"], plan["trans_frames"], len(ANCHORS)
    for f in range(plan["total_frames"]):
        idx, within = divmod(f, hold + trans)
        if idx >= n - 1 or within < hold:
            expect = (min(idx, n - 1), None, 0.0)
        else:
            expect = (idx, idx + 1, (within - hold) / trans)
        got = core.call({"op": "spin_frame", "plan": plan, "frame": f})
        assert (got["index"], got["next"], got["tau"]) == pytest.approx(expect), f
    # The last real anchor holds to the end; no dissolve trails off it.
    last = core.call({"op": "spin_frame", "plan": plan, "frame": plan["total_frames"] - 1})
    assert last["index"] == n - 1 and last["next"] is None


def mean_abs(a, b):
    return float(np.abs(np.asarray(a, dtype=np.int16) - np.asarray(b, dtype=np.int16)).mean())


def test_layers_and_dissolve_match_pillow():
    plan = core.call({"op": "spin_plan", "width": SIZE[0], "height": SIZE[1],
                      "anchors": [{"width": a.width, "height": a.height} for a in ANCHORS]})
    layers = [core.call({"op": "place_layer", "image": {"$image": 0}, "width": SIZE[0], "height": SIZE[1],
                         "rect": r}, [a]) for a, r in zip(ANCHORS, plan["rects"])]
    refs = [reference_fit_and_anchor(a, SIZE)[0] for a in ANCHORS]
    for got, ref in zip(layers, refs):
        assert got.mode == "RGBA" and got.size == SIZE
        assert mean_abs(got, ref) < 0.6  # two Lanczos implementations
    mixed = core.call({"op": "blend", "a": {"$image": 0}, "b": {"$image": 1}, "t": 0.35}, [refs[0], refs[1]])
    assert mean_abs(mixed, Image.blend(refs[0], refs[1], 0.35)) < 0.02


def test_rendered_frame_matches_the_pillow_composite():
    from lotstretcher.imaging.compose.spin import render_spin_frames

    plan = core.call({"op": "spin_plan", "width": SIZE[0], "height": SIZE[1],
                      "anchors": [{"width": a.width, "height": a.height} for a in ANCHORS]})
    grad = core.linear_gradient(SIZE[0], SIZE[1], 137.0, (20, 30, 90), (200, 210, 230))
    spot = plan["spotlight"]
    backdrop = core.render_frame([], SIZE[0], SIZE[1], {"kind": "image"}, background_image=grad,
                                 spotlight=tuple(spot)).convert("RGBA")
    refs = [reference_fit_and_anchor(a, SIZE)[0] for a in ANCHORS]

    frames = list(render_spin_frames(ANCHORS, (137.0, (20, 30, 90), (200, 210, 230)), SIZE))
    assert len(frames) == plan["total_frames"]
    hold, trans = plan["hold_frames"], plan["trans_frames"]
    for f in (0, hold - 1, hold, hold + trans // 2, hold + trans, plan["total_frames"] - 1):
        idx, within = divmod(f, hold + trans)
        if idx >= len(ANCHORS) - 1 or within < hold:
            layer = refs[min(idx, len(ANCHORS) - 1)]
        else:
            layer = Image.blend(refs[idx], refs[idx + 1], (within - hold) / trans)
        canvas = backdrop.copy()
        canvas.alpha_composite(layer)
        got = frames[f]
        assert got.mode == "RGB" and got.size == SIZE
        assert mean_abs(got, canvas.convert("RGB")) < 0.6, f
