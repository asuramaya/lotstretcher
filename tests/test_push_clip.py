"""A clip of one or two shots is the core's push mode (carousel.rs),
for both surfaces: the conveyor needs three, and below that the CLI used
to render no clip at all while the browser drew its own push. Each shot
holds the window on the still's floor line for an equal share of one
loop, pushes in by `push` across its dwell, and the next crossfades in
over `crossfade` seconds (not before the very first shot)."""
from __future__ import annotations

import pytest
from PIL import Image, ImageDraw

from lotstretcher import core

pytestmark = pytest.mark.skipif(not core.available(), reason=f"core not built: {core.why_unavailable()}")


def _car(w, h, colour):
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(img).rounded_rectangle((0, h // 4, w - 1, h - 1), 12, fill=colour)
    return img


def _plan(n, push=None, crossfade=None):
    cars = [_car(400, 220, (200, 30, 30, 255)), _car(300, 240, (30, 30, 200, 255))][:n]
    backdrop = Image.new("RGB", (800, 800), (90, 90, 90))
    return core.call({"op": "carousel_plan", "width": 800, "height": 800, "backdrop": {"$image": 0},
                      "shots": [{"image": {"$image": i + 1}} for i in range(n)], "audio_loop_s": 9.6,
                      "push": push, "crossfade": crossfade}, [backdrop, *cars])


def test_one_or_two_shots_plan_a_push_and_three_a_conveyor():
    assert _plan(1)["mode"] == "push" and _plan(2)["mode"] == "push"
    two = _plan(2)
    assert two["period"] == pytest.approx(9.6) and [d for _s, d in two["schedule"]] == pytest.approx([4.8, 4.8])
    assert two["push"] == 0.06 and two["crossfade"] == 0.5          # the spec's control defaults


def test_the_shot_pushes_in_and_the_next_crossfades():
    plan = _plan(2, push=0.1, crossfade=0.5)
    frame = lambda t: core.call({"op": "carousel_frame", "plan": plan, "t": t})  # noqa: E731
    start, mid, end = frame(0.0), frame(2.4), frame(4.79)
    assert [c["alpha"] for c in start["cars"]] == [1.0]               # nothing to fade from at the very start
    assert start["cars"][0]["rect"][2] < mid["cars"][0]["rect"][2] < end["cars"][0]["rect"][2]
    assert end["cars"][0]["rect"][2] == pytest.approx(plan["shots"][0]["hero_fit_rect"][2] * 1.1, rel=1e-3)
    fade = frame(4.8 + 0.25)
    assert [c["shot"] for c in fade["cars"]] == [0, 1] and fade["hero"] == 1
    assert [c["alpha"] for c in fade["cars"]] == pytest.approx([0.5, 0.5])
    looped = frame(9.6 + 0.1)                                         # the loop fades the last shot back out
    assert [c["shot"] for c in looped["cars"]] == [1, 0]


def test_no_push_and_no_crossfade_hold_still():
    plan = _plan(2, push=0.0, crossfade=0.0)
    a = core.call({"op": "carousel_frame", "plan": plan, "t": 0.1})
    b = core.call({"op": "carousel_frame", "plan": plan, "t": 4.7})
    c = core.call({"op": "carousel_frame", "plan": plan, "t": 4.81})
    assert a["cars"] == b["cars"] and len(c["cars"]) == 1 and c["hero"] == 1
