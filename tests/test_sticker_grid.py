"""The standard-equipment grid, and the row-scoping bug it had.

Rows are grouped globally by y, so the row carrying the SAFETY/SECURITY
column's WARRANTY header also carries whatever the other three columns
print at that height. Searching the whole row for "WARRANTY" therefore
truncated EVERY column at the safety column's header.

Measured on a real Ford Maverick sticker before the fix: 14 exterior
items reported as 7, and the same shape of loss in interior and
functional. Found by the browser port, which bounds each column
separately and disagreed with the CLI.

Synthetic rows rather than a PDF fixture: the failure is purely about
geometry, and building it directly says what matters instead of hiding
it inside a 1.2MB binary.
"""
from __future__ import annotations

import pytest

from lotstretcher.imaging.sticker import _parse_equipment_grid
from lotstretcher.imaging.sticker import Word

# Column x positions from a real sticker.
COLS = {"EXTERIOR": 36.0, "INTERIOR": 203.0, "FUNCTIONAL": 369.0, "SAFETY/SECURITY": 527.0}
ROW_PITCH = 9.0
HEADER_Y = 160.0


def word(text: str, x: float, y: float, width: float = 120.0) -> Word:
    """A Word with the bbox the real extractor supplies. Height is a
    nominal 8pt; only x0/y0 drive the column and row logic."""
    return Word(x0=x, y0=y, x1=x + width, y1=y + 8.0, text=text)


def build_rows() -> list[list[Word]]:
    """A grid where the safety column ends early and starts a WARRANTY
    block, while the other three keep going. This is the real layout."""
    rows: list[list[Word]] = []

    header = [word(label, x, HEADER_Y) for label, x in COLS.items()]
    rows.append(header)

    long_cols = ["EXTERIOR", "INTERIOR", "FUNCTIONAL"]
    for i in range(14):
        y = HEADER_Y + ROW_PITCH * (i + 1)
        words = [word(f"{label[:3]} ITEM {i}", COLS[label] + 6, y)
                 for label in long_cols]

        # The safety column: six items, then WARRANTY, then its terms.
        if i < 6:
            words.append(word(f"SAFETY ITEM {i}", COLS["SAFETY/SECURITY"] + 6, y))
        elif i == 7:
            words.append(word("WARRANTY", COLS["SAFETY/SECURITY"], y))
        elif i > 7:
            words.append(word(f"{i}YR/10,000 TERM", COLS["SAFETY/SECURITY"] + 6, y))

        rows.append(words)

    rows.append([word(w, 36.0 + n * 40, HEADER_Y + ROW_PITCH * 20)
                 for n, w in enumerate(["INCLUDED", "ON", "THIS", "VEHICLE"])])
    return rows


@pytest.fixture(scope="module")
def parsed():
    return _parse_equipment_grid(build_rows())


def test_safety_column_stops_at_its_warranty_header(parsed):
    grid, _warranty = parsed
    assert len(grid["safety_security"]) == 6


def test_other_columns_are_not_truncated_by_it(parsed):
    """The regression. Each of these has 14 items; the bug reported 7,
    cutting them off at the safety column's WARRANTY row."""
    grid, _warranty = parsed
    for key in ("exterior", "interior", "functional_tech"):
        assert len(grid[key]) == 14, (
            f"{key} was truncated at another column's section header: "
            f"got {len(grid[key])} of 14"
        )


def test_warranty_lines_still_come_out(parsed):
    """Scoping the search must not cost us the warranty block itself."""
    _grid, warranty = parsed
    assert warranty, "warranty lines were lost"
    assert any("YR/10,000" in line.upper() for line in warranty)
