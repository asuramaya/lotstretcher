"""The layouts and a car's placement in its box are the core's
(core/src/layout.rs), and compose/layout.py is a wrapper over the ops
`layout` and `placement`.

compose/layout.py used to be a Python mirror of the core's layouts, held
to it by compositing and looking for the car. tests/fixtures/
layout-reference.json holds what that mirror returned for 120 random
windows, every named layout and the shape-chosen conveyor, and 472
placements, before it was deleted. Placements whose size landed on an
exact half pixel are left out: there the mirror rounded half to even and
the core, which does the compositing, rounds half away from zero, so the
mirror was the one that was wrong (12 of 9,000 in a sweep).
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from PIL import Image

from lotstretcher import core
from lotstretcher.imaging.compose import layout

pytestmark = pytest.mark.skipif(not core.available(), reason=f"core not built: {core.why_unavailable()}")

REF = json.loads((Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "layout-reference.json").read_text())


@pytest.mark.parametrize("k", range(len(REF)))
def test_layouts_and_placements_match_the_mirror_they_replaced(k):
    case = REF[k]
    win, n = tuple(case["window"]), case["n_extra"]
    for name, fn in layout.LAYOUTS.items():
        assert [[list(b), a] for b, a in fn(win, n)] == case["layouts"][name], name
    assert [[list(b), a] for b, a in layout.conveyor_for_window(win)(win, n)] == case["layouts"]["$for_window"]
    for p in case["placements"]:
        x, y, car = layout.compute_placement(Image.new("RGBA", tuple(p["size"])), win, margin_frac=p["margin"], anchor=p["anchor"])
        assert [x, y, car.width, car.height] == p["expect"], p


def test_the_reference_covers_every_arrangement():
    shapes = {json.dumps(c["layouts"]["$for_window"]) == json.dumps(c["layouts"][name])
              for c in REF for name in ("conveyor", "conveyor_stack", "conveyor_wide")}
    assert shapes == {True, False}
    anchors = {a for c in REF for slots in c["layouts"].values() for _b, a in slots}
    assert anchors == {"center", "bottom"}
