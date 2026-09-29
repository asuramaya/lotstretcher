"""
What a VIN says on its own, decoded from the spec's tables with no
database and no call to anyone: whether it is well formed (the check
digit), the model year, the manufacturer (the first three characters)
and the country. Model and trim are encoded per manufacturer and are
not here; a listing address carries them in its slug.

The decoder is the core's (core/src/vin.rs), the same code the browser's
web/public/js/pipeline/vin.js calls; tests/test_vin_parity.py holds both
builds to the answers the Python it replaced gave.
"""
from __future__ import annotations

from lotstretcher import core


def decode(text: str) -> dict:
    """{vin, valid, year, make, country, warnings}, plus `makes` when one
    manufacturer code spans brands. A VIN that fails the check digit is
    still returned, flagged, since a typo is the common case."""
    return core.call({"op": "vin_decode", "text": text or ""})


def normalize(text: str) -> str:
    """Upper case, I/O/Q read as 1/0/0, anything else dropped."""
    return decode(text)["vin"]


def record_from_text(text: str) -> dict:
    """What the app fills from a pasted address or VIN, in the
    scrape.Vehicle shape: the decoded VIN plus the slug's words. Nothing
    is fetched."""
    return core.call({"op": "vin_record", "text": text or ""})
