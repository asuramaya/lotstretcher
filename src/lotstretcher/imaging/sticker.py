"""
Parses a Ford Monroney window-sticker PDF into structured per-vehicle data:
model/VIN/colors/drivetrain, the 4-column standard-equipment grid (exterior/
interior/functional/safety), optional equipment, pricing, and factory
warranties.

Only works when a real sticker exists -- used vehicles and pre-publish new
vehicles commonly have none (lotstretcher.py already detects and skips the
"please check back later" placeholder PDF before this module ever runs).
Callers must have a fallback to the site's own JSON feature blob for that
case; see lotstretcher.py's window-sticker download path.

Extraction is via `pdftotext -bbox` (word-level coordinates), not `-layout`
text or xml.etree: the coordinates are what let us tell the 4 equipment
columns apart, and a real sticker's barcode/QR noise text can contain a
literal unescaped '<' that breaks XML well-formedness (confirmed on a
Bronco Sport sticker, bbox line 623) -- a plain regex over the bbox output
sidesteps that entirely.

The parsing itself is the core's (core/src/sticker.rs): this module only
turns the PDF into positioned words and hands them over, exactly as the
browser hands over pdf.js's words, so both surfaces read a sticker the
same way. tests/test_sticker_parity.py holds the core to the Python
parser it replaced on every real sticker in the operator's library.
"""
from __future__ import annotations

import html
import re
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path

from .. import core
from .. import spec as _spec

_WORD_RE = re.compile(
    r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)</word>',
    re.DOTALL,
)


@dataclass
class Word:
    x0: float
    y0: float
    x1: float
    y1: float
    text: str


def extract_words(pdf_path: Path) -> list[Word]:
    """Every word on the page with its box, in document order. The core
    drops the barcode/QR symbol-font noise and sorts."""
    result = subprocess.run(
        ["pdftotext", "-bbox", str(pdf_path), "-"],
        capture_output=True, text=True, timeout=20, check=True,
    )
    return [Word(float(x0), float(y0), float(x1), float(y1), html.unescape(text))
            for x0, y0, x1, y1, text in _WORD_RE.findall(result.stdout)]


def parse_words(words: list[Word]) -> dict:
    """The structured sticker for a page's positioned words."""
    return core.call({"op": "parse_sticker", "words": [asdict(w) for w in words],
                      "y_tol": _spec.get("sticker", "rowToleranceCli")})


def parse_sticker(pdf_path: Path) -> dict:
    """Parse a Ford Monroney window-sticker PDF into structured JSON. Raises
    if pdftotext fails or the PDF has no readable text layer -- callers
    should already have filtered out the "check back later" placeholder
    case before calling this (see window_sticker.py::is_placeholder_sticker);
    the record's `placeholder` flag says so too."""
    return parse_words(extract_words(pdf_path))


def find_panel_split_x(pdf_path: Path) -> float | None:
    """Some Ford Monroney stickers print as two side-by-side panels on one
    landscape page (equipment/pricing on the left, fuel economy/safety
    ratings on the right -- confirmed on the Bronco Sport sticker, a real
    ~11pt text-free gutter around x=678 on a 1224pt-wide page) rather than
    one continuous flow. As a single wide image that's a crammed, hard-to-
    read-on-mobile shot that also survives upload recompression worse than
    two normal-proportioned panels would.

    The core detects this generically -- no fixed split coordinate -- by
    finding the widest text-free vertical gap within spec
    sticker.panelSplit.searchFrac of the page's horizontal center,
    verified against every word's actual (x0, x1) span so nothing gets
    sliced through mid-word. Returns the gap's midpoint in PDF points, or
    None if there's no clear gutter (a genuinely single-flow layout) --
    callers should leave the page unsplit in that case, not force a cut
    through real content."""
    return core.call({"op": "panel_split_x", "words": [asdict(w) for w in extract_words(pdf_path)]})
