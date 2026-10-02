"""A generated backdrop is seeded by the vehicle, the photo and the shape,
from one template in the spec (compose.seeds), so the CLI and the browser
give the same photo of the same vehicle the same gradient. They once
seeded by folder name and by VIN, and never agreed."""
from __future__ import annotations

from pathlib import Path

from lotstretcher.imaging.text import piece_seed

REPO = Path(__file__).resolve().parents[1]
CAR = {"vin": "1FA6P8JZ9G5522288", "stock_number": "G522288"}


def test_the_vin_names_the_vehicle_and_the_extension_is_dropped():
    # The CLI's cutout is 01.png; the browser's photo is 01.jpg.
    assert piece_seed("still", CAR, "folder", "01.png") == piece_seed("still", CAR, "folder", "01.jpg")
    assert piece_seed("still", CAR, "folder", "01.png", "portrait") == "1FA6P8JZ9G5522288/01/portrait"


def test_without_a_vin_the_stock_number_then_the_folder():
    assert piece_seed("hero", {"stock_number": "G1"}, "folder", fmt="square") == "G1/hero/square"
    assert piece_seed("clip", {}, "folder", fmt="square") == "folder/clip/square"


def test_every_piece_is_seeded_apart():
    seeds = {piece_seed(k, CAR, "f", "01.png", "square") for k in ("still", "hero", "clip")}
    assert len(seeds) == 3


def test_the_browser_fills_the_same_template():
    js = (REPO / "web" / "public" / "js" / "lib" / "text.js").read_text()
    app = (REPO / "web" / "public" / "js" / "app.js").read_text()
    assert "specGet('compose', 'seeds', kind)" in js and "vehicle?.vin || vehicle?.stock_number" in js
    assert "pieceSeed('still', state.vehicle, p.name, fmt)" in app and "pieceSeed('clip'" in app
