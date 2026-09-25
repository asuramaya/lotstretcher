"""The sticker's year line split into trim, body and drivetrain.

The year line reads "2021 2-DOOR ADVANCED 4X4" or "2023 F-150 4X4
SUPERCREW": taking its second word as the trim gave "2-Door", "F-150",
"Supercrew" or "Explorer" on most of the library. The core now drops the
model, body and drivetrain words and falls back to the series ("BADLANDS -
4 PASSENGER", "XLT SERIES", "LARIAT 176\" WB STYLESIDE"). Synthetic pages
here run in CI; the library sweep checks every real sticker against the
listing's own trim when the PDFs are present.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from lotstretcher import core

pytestmark = pytest.mark.skipif(not core.available(), reason=f"core not built: {core.why_unavailable()}")


def _page(model_line: str, lines: list[str], extra_rows: list[str] = ()):
    from lotstretcher.imaging.sticker import Word

    words, y = [], 100.0

    def row(text: str, x: float = 60.0):
        nonlocal y
        for i, t in enumerate(text.split()):
            words.append(Word(x + i * 45, y, x + i * 45 + 40, y + 9, t))
        y += 14

    row("VEHICLE DESCRIPTION")
    row(model_line)
    for line in lines:
        row(line)
    row("STANDARD EQUIPMENT INCLUDED AT NO EXTRA CHARGE")
    for line in extra_rows:
        row(line)
    return words


def _overview(model_line, lines, extra_rows=()):
    from lotstretcher.imaging.sticker import parse_words

    return parse_words(_page(model_line, lines, extra_rows))["overview"]


@pytest.mark.parametrize("model_line,lines,extra,want", [
    ("BRONCO", ["2021 2-DOOR ADVANCED 4X4", "BADLANDS - 4 PASSENGER"], [],
     {"trim": "Badlands", "body_style": "2-Door", "drivetrain": "4X4", "model_name": "Bronco"}),
    ("MAVERICK", ["2026 XLT FWD"], [], {"trim": "XLT", "drivetrain": "FWD"}),
    ("EXPLORER", ["2023 EXPLORER KNG RANCH RWD"], [], {"trim": "King Ranch", "drivetrain": "RWD"}),
    ("EDGE", ["2024 EDGE ST-LINE-AWD"], [], {"trim": "ST-Line", "drivetrain": "AWD"}),
    ("ESCAPE FWD", ["2023 ST LINE FWD"], [], {"trim": "ST-Line", "model_name": "Escape"}),
    ("MUSTANG", ["2024 GT COUPE PREMIUM"], [], {"trim": "GT Premium", "body_style": "Coupe"}),
    ("F-150", ["2023 F-150 4X4 SUPERCREW"], ["EQUIPMENT GROUP 300A", "XLT SERIES"],
     {"trim": "XLT", "body_style": "SuperCrew", "model_name": "F-150"}),
    ("SUPER DUTY", ["2024 F350 DRW 4X4 CREW CAB", 'LARIAT 176" WB STYLESIDE'], [],
     {"trim": "Lariat", "body_style": "Crew Cab", "model_name": "F-350 Super Duty"}),
    ("F-150 RAPTOR", ["2023 RAPTOR 4X4 SUPERCREW"], [], {"trim": None, "model_name": "F-150 Raptor"}),
    ("LINCOLN NAUTILUS", ["2024 AWD PREMIERE I"], [], {"trim": "Premiere I", "model_name": "Nautilus"}),
])
def test_identity_split(model_line, lines, extra, want):
    o = _overview(model_line, lines, extra)
    for k, v in want.items():
        assert o.get(k) == v, (k, o)


LIBRARY = Path.home() / "Documents" / "listings"
PDFS = sorted(LIBRARY.glob("*/*/window-sticker.pdf")) if LIBRARY.is_dir() else []


@pytest.mark.skipif(not PDFS, reason="no window-sticker.pdf files under ~/Documents/listings")
def test_library_trims_agree_with_listings():
    from lotstretcher.imaging.sticker import parse_sticker

    def norm(s):
        return re.sub(r"[^a-z0-9]", "", (s or "").lower())

    wrong = []
    for p in PDFS:
        try:
            want = json.loads((p.parent / "details.json").read_text()).get("trim") or ""
        except (OSError, ValueError):
            continue
        got = parse_sticker(p)["overview"].get("trim") or ""
        if got and norm(want) and not (norm(got) in norm(want) or norm(want) in norm(got)):
            wrong.append((p.parent.name, got, want))
    assert not wrong
