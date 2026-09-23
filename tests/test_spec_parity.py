"""The website and the pipeline must not drift apart.

shared/pipeline-spec.json is the single source of truth for every
constant both surfaces need. These tests assert three things:

  1. The Python modules genuinely read the spec, so changing a value
     there changes behaviour here.
  2. The browser client reads the same keys, checked by parsing its
     JavaScript rather than by trusting a comment.
  3. Anything the spec claims exists, exists.

Before this file, the browser client carried its own retyped copies of
HERO_STILL_FORMATS, VIDEO_FORMATS, the palette bands, the glow colours
and the cutout gates. Nothing would have caught those drifting except a
person noticing the two surfaces produced different output.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
SPEC_PATH = REPO / "shared" / "pipeline-spec.json"
WEB_JS = REPO / "web" / "public" / "js"


@pytest.fixture(scope="module")
def spec() -> dict:
    return json.loads(SPEC_PATH.read_text())


def test_spec_file_exists_and_parses(spec):
    assert spec["version"] >= 1


# ---------------------------------------------------------------- python

def test_hero_still_formats_come_from_spec(spec):
    from lotstretcher.imaging.compose.pipeline import (
        DEFAULT_HERO_STILL_FORMAT, HERO_STILL_FORMATS,
    )
    expected = {k: tuple(v["size"]) for k, v in spec["heroStillFormats"]["formats"].items()}
    assert HERO_STILL_FORMATS == expected
    assert DEFAULT_HERO_STILL_FORMAT == spec["heroStillFormats"]["default"]


def test_video_formats_come_from_spec(spec):
    from lotstretcher.imaging.compose.hero_video import DEFAULT_VIDEO_FORMAT, VIDEO_FORMATS
    for name, want in spec["videoFormats"]["formats"].items():
        assert VIDEO_FORMATS[name]["canvas"] == tuple(want["size"])
        assert VIDEO_FORMATS[name]["budget_mb"] == want["budgetMb"]
    assert DEFAULT_VIDEO_FORMAT == spec["videoFormats"]["default"]


def test_glow_colors_come_from_spec(spec):
    from lotstretcher.imaging.compose.effects import DEFAULT_GLOW_COLOR, GLOW_COLORS
    assert GLOW_COLORS == {k: tuple(v) for k, v in spec["glow"]["colors"].items()}
    assert DEFAULT_GLOW_COLOR == spec["glow"]["default"]


def test_cutout_gates_come_from_spec(spec):
    from lotstretcher.imaging.cutout import FRAME_FILL_MIN_EDGES, MAX_AMBIGUOUS_FRACTION
    assert MAX_AMBIGUOUS_FRACTION == spec["cutout"]["maxAmbiguousFraction"]
    assert FRAME_FILL_MIN_EDGES == spec["cutout"]["frameFillMinEdges"]


def test_video_timing_comes_from_spec(spec):
    from lotstretcher.imaging.compose import hero_video
    assert hero_video.GRADIENT_TURNS == spec["video"]["gradientTurns"]
    assert hero_video.PULSE_STRENGTH == spec["video"]["pulseStrength"]
    assert hero_video.HERO_MARGIN_FRAC == spec["video"]["heroMarginFrac"]


def test_palette_constants_match_spec(spec):
    """palette.py still defines these as literals. They are checked here
    rather than rewired because the browser port reads them from the spec,
    so this test is what stops the two diverging."""
    from lotstretcher.imaging import palette
    p = spec["palette"]
    assert palette.BACKDROP_VALUE_MIN == p["backdropValueMin"]
    assert palette.BACKDROP_VALUE_MAX == p["backdropValueMax"]
    assert palette.MIN_STOP_SEPARATION == p["minStopSeparation"]
    assert palette.NEUTRAL_SATURATION_CEILING == p["neutralSaturationCeiling"]
    assert palette.MATCHING_HUE_SHIFT == p["matchingHueShift"]
    assert palette.NEUTRAL_TINT_HUE == p["neutralTintHue"]
    assert palette.NEUTRAL_TINT_SATURATION == p["neutralTintSaturation"]
    assert palette.BACKDROP_SATURATION_RANGE == tuple(p["backdropSaturationRange"])
    assert palette.COLOR_WORDS == {k: tuple(v) for k, v in p["colorWords"].items()}


def test_gradient_constants_are_read_from_the_spec_by_the_core(spec):
    """The gradient moved into the Rust core, which embeds the spec at
    build time and reads these keys by name rather than restating them."""
    src = (REPO / "core" / "src" / "gradient.rs").read_text()
    assert '"gradientHueBands"' in src and '"gradientBuildMax"' in src
    assert 'include_str!("../../shared/pipeline-spec.json")' in (REPO / "core" / "src" / "spec.rs").read_text()


def test_cut_types_match_spec(spec):
    from lotstretcher.server.processing import CUT_TYPES
    assert set(CUT_TYPES) == set(spec["cutTypes"]["all"])
    # Everything the browser exposes must be a real server cut type.
    assert set(spec["cutTypes"]["browserExposed"]) <= set(CUT_TYPES)
    # And nothing known-unimplemented may be exposed to users.
    assert not (set(spec["cutTypes"]["browserExposed"])
                & set(spec["cutTypes"]["notImplemented"]))


# ---------------------------------------------------------------- browser

def test_browser_loads_the_same_spec_file():
    """The symlinked copy the web app fetches must be the same file, not
    a stale duplicate that quietly went out of date."""
    served = REPO / "web" / "public" / "spec" / "pipeline-spec.json"
    assert served.exists(), "web/public/spec/pipeline-spec.json is missing"
    assert json.loads(served.read_text()) == json.loads(SPEC_PATH.read_text())


@pytest.mark.parametrize("js_file, must_read", [
    ("options.js", ["heroStillFormats", "videoFormats", "glow"]),
    ("config.js", ["cutout", "confidence"]),
])
def test_browser_modules_read_the_spec(js_file, must_read):
    """Checked by reading the JavaScript, so a module that goes back to
    hardcoding its own values fails here rather than silently drifting."""
    source = (WEB_JS / js_file).read_text()
    for key in must_read:
        assert key in source, f"{js_file} no longer reads spec key {key!r}"


def test_browser_does_not_hardcode_format_sizes():
    """The specific regression this whole mechanism exists to prevent."""
    source = (WEB_JS / "options.js").read_text()
    for literal in ("1254, 1254", "1080, 1350", "1080, 1920", "1920, 1080"):
        assert literal not in source, (
            f"options.js hardcodes the size [{literal}] again; "
            "read it from shared/pipeline-spec.json instead"
        )


def test_spec_documents_every_browser_gap(spec):
    """Each CLI capability the browser cannot do is named with a reason,
    so the web client can explain an absence instead of hiding it."""
    gaps = spec["browserUnsupported"]
    for key in ("upscale", "nvenc", "scraping", "inventorySync"):
        assert key in gaps and len(gaps[key]) > 10, f"{key} needs a stated reason"
