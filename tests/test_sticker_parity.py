"""The sticker parser in the core against the Python it replaced, on
every real Monroney sticker in the operator's library.

tests/fixtures/sticker-reference.json is what imaging/sticker.py
produced for each window-sticker.pdf before the eighth core slice
(114 stickers, including two non-template PDFs that parse to nothing
and must keep doing so). The PDFs themselves stay in ~/Documents; the
test skips when they are absent, and a fixture with no PDF is skipped
individually.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from lotstretcher import core

pytestmark = pytest.mark.skipif(not core.available(), reason=f"core not built: {core.why_unavailable()}")

REPO = Path(__file__).resolve().parents[1]
REFERENCE = json.loads((REPO / "tests" / "fixtures" / "sticker-reference.json").read_text())
LIBRARY = Path.home() / "Documents" / "listings"
PDFS = {p.parent.name: p for p in LIBRARY.glob("*/*/window-sticker.pdf")} if LIBRARY.is_dir() else {}
NAMES = sorted(n for n in REFERENCE if n in PDFS)


@pytest.mark.skipif(not NAMES, reason="no window-sticker.pdf files under ~/Documents/listings")
@pytest.mark.parametrize("name", NAMES)
def test_real_sticker_parses_as_before(name):
    from lotstretcher.imaging.sticker import find_panel_split_x, parse_sticker

    expected = dict(REFERENCE[name])
    split = expected.pop("_panel_split_x")
    got = parse_sticker(PDFS[name])
    got.pop("placeholder")
    got.pop("make", None)
    # Added after the reference was taken: the identity split (see
    # test_sticker_identity.py), checked there against each listing.
    for k in ("trim", "body_style", "drivetrain", "model_name"):
        got["overview"].pop(k, None)
    assert got == expected
    assert find_panel_split_x(PDFS[name]) == pytest.approx(split)


@pytest.mark.skipif(not NAMES, reason="no window-sticker.pdf files under ~/Documents/listings")
def test_real_stickers_are_not_placeholders_and_name_their_make():
    from lotstretcher.imaging.sticker import parse_sticker

    seen = set()
    for name in NAMES[:12]:
        got = parse_sticker(PDFS[name])
        assert got["placeholder"] is False
        if got["equipment"]:
            assert got["make"] in ("Ford", "Lincoln"), name
            seen.add(got["make"])
    assert seen


def test_placeholder_page_is_flagged():
    from lotstretcher.imaging.sticker import Word, parse_words

    words = [Word(40 + i * 60, 100, 90 + i * 60, 110, t) for i, t in enumerate("Please check back later".split())]
    got = parse_words(words)
    assert got["placeholder"] is True and got["equipment"] == {}
