"""The listing hand-off produces what the scraper would have.

web/public/js/pipeline/listing.js ports scrape.normalize_vehicle so a
bookmarklet-collected record fills the app the way `lotstretcher <url>`
fills the CLI. Two things keep that true:

1. The bookmarklet ships the spec's `listing.payloadKeys`, so that list
   must cover every key normalize_vehicle reads. Checked against the
   Python source, not a hand-written list.
2. Both normalisers are run on ONE synthetic payload and compared field
   by field (needs `node`; skipped without it, and says so).

The fixture is synthetic but shaped like a real DealerInspire blob,
including the traps normalize_vehicle handles on purpose: "0" MPG
meaning unrated, marketing badges in conditions_array, a price of 0,
HTML in the description, and a resize URL to upsize.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from lotstretcher.scrape import DEALERINSPIRE_VAR_MARKER, Vehicle, normalize_vehicle

REPO = Path(__file__).resolve().parents[1]
SPEC = json.loads((REPO / "shared" / "pipeline-spec.json").read_text())
SCRAPE_SOURCE = (REPO / "src" / "lotstretcher" / "scrape.py").read_text()

PAYLOAD = {
    "vin": "1FTVW1EL0PWG12345", "stockNumber": "T12345", "year": 2024, "make": "Ford",
    "model": "Maverick", "trim": "Lariat", "used": True,
    "certifications": {"certifiedByManufacturer": False, "certifiedByDealer": True},
    "conditions_array": ["Blue Certified", "Certified", "Used"],
    "vehicleStatus": "On Lot", "mileage": 12345,
    "visual": {
        "colors": {"exterior": {"factory": "Area 51", "generic": "Blue"},
                   "interior": {"factory": "Navy Pier"}},
        "image": {"source": "https://pictures.dealer.com/x/resize/320x240/main.jpg"},
        "combinedPhotos": [
            {"source": "https://pictures.dealer.com/x/resize/640x480/0001.jpg"},
            {"source": "https://pictures.dealer.com/x/resize/640x480/0002.jpg"},
            {"source": "https://pictures.dealer.com/x/resize/640x480/0001.jpg"},
        ],
        "dealerVideos": [{"source": "https://cdn.example/v.mp4"}, "https://cdn.example/w.mp4"],
    },
    "specifications": {
        "engine": "2.0L EcoBoost", "transmission_new": " 8-Speed Automatic ", "drivetrain": "AWD",
        "fuelType": "Gasoline", "mpgCityLow": "0", "mpgCityHigh": "0",
        "mpgHighwayLow": 28, "mpgHighwayHigh": 30, "vehicleType": ["Truck", "Crew Cab"],
    },
    "evBatteryRange": None, "evMpgCombined": None, "cabStyle": "", "boxLength": "4.5 ft",
    "displayPrice": 0, "price": 34999,
    "flattened_pricing": [{"pricing": {"Label": "MSRP", "Text": "$36,000"}},
                          {"pricing": {"Label": "", "Text": "$1"}}],
    "dealerDescription": "Great truck.<br><br>One &amp; only <b>owner</b>.   Call!",
    "dealerComments": "",
    "features": {"mainFeatures": ["CLEAN CARFAX", "1 OWNER"],
                 "featuresStructured": {"Safety": ["Lane Keeping"]}},
    "options": ["Tow package"], "tags": ["hot"],
    "location": {"name": "Tomball Ford", "address1": "22702 State Hwy 249", "address2": "",
                 "city": "Tomball", "state": "TX", "zipCode": "77375",
                 "contactNumber": "(281) 555-0100"},
    "expando": {"WindowStickerUrl": "https://www.windowsticker.forddirect.com/x.pdf"},
}
URL = "https://www.tomballford.com/inventory/used-2024-ford-maverick-lariat-1FTVW1EL0PWG12345/"


def normalize_vehicle_keys() -> set[str]:
    body = SCRAPE_SOURCE[SCRAPE_SOURCE.index("def normalize_vehicle"):]
    body = body[:body.index("# Output folder naming")]
    return set(re.findall(r'payload\.get\("(\w+)"', body)) | set(re.findall(r'g\(payload, "(\w+)"', body))


def test_payload_keys_cover_normalize_vehicle():
    """The bookmarklet ships only these keys. A key normalize_vehicle
    reads but the spec omits would be silently empty after a hand-off."""
    missing = normalize_vehicle_keys() - set(SPEC["listing"]["payloadKeys"])
    assert not missing, f"normalize_vehicle reads {sorted(missing)}; add them to spec.listing.payloadKeys"


def test_analytics_global_matches_the_marker():
    """scrape.py finds the blob by its assignment text; the bookmarklet
    and the saved-page reader scan for the same text, from the spec."""
    assert DEALERINSPIRE_VAR_MARKER.strip().rstrip("=").strip() == SPEC["listing"]["analyticsGlobal"]
    assert SPEC["listing"]["analyticsMarker"] == DEALERINSPIRE_VAR_MARKER


TRICKY_HTML = (
    '<html><script>jzlGa4AttachListenersToForms(jzlAnalyticsObject = '
    + json.dumps({"vdp_gtm_payload": {"vin": "1FTEW1EP0PKD71397", "dealerDescription": "a } in \"quotes\" {",
                                      "visual": {"dealerPhotos": [{"source": "https://p/1.jpg", "junk": 1}]},
                                      "unlisted": True},
                  "other": {"brace": "}"}})
    + ');</script><script type="application/ld+json">{"@type":"Car","name":"X"}</script></html>'
)


def test_js_extractor_matches_the_python_brace_matcher():
    """The bookmarklet and the saved-page reader must find the same
    object scrape.py finds, through braces and quotes inside strings."""
    from lotstretcher.scrape import extract_balanced_json

    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    script = f"""
      import {{ loadSpecFrom }} from '{(REPO / 'web' / 'public' / 'js' / 'spec.js').as_posix()}';
      import {{ extractBalancedJson, recordFromHtml }} from '{(REPO / 'web' / 'public' / 'js' / 'pipeline' / 'listing.js').as_posix()}';
      import fs from 'node:fs';
      loadSpecFrom(JSON.parse(fs.readFileSync('{(REPO / 'shared' / 'pipeline-spec.json').as_posix()}', 'utf8')));
      const html = fs.readFileSync(0, 'utf8');
      process.stdout.write(JSON.stringify({{ whole: extractBalancedJson(html, {json.dumps(DEALERINSPIRE_VAR_MARKER)}), record: recordFromHtml(html, 'https://x') }}));
    """
    run = subprocess.run([node, "--input-type=module", "-e", script], input=TRICKY_HTML,
                         capture_output=True, text=True, check=True)
    out = json.loads(run.stdout)
    assert out["whole"] == extract_balanced_json(TRICKY_HTML, DEALERINSPIRE_VAR_MARKER)
    payload = out["record"]["payload"]
    assert payload["vin"] == "1FTEW1EP0PKD71397"
    assert "unlisted" not in payload                      # only the spec's keys travel
    assert payload["visual"]["dealerPhotos"] == [{"source": "https://p/1.jpg"}]


def python_record() -> Vehicle:
    html = f"<html><script>{DEALERINSPIRE_VAR_MARKER}{json.dumps({'vdp_gtm_payload': PAYLOAD})};</script>" \
           f'<div class="carfax-logo"><a href="https://carfax.example/r">Carfax</a></div></html>'
    return normalize_vehicle(URL, html)


def js_record() -> dict:
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed; the JS side of the parity check cannot run")
    script = f"""
      import {{ loadSpecFrom }} from '{(REPO / 'web' / 'public' / 'js' / 'spec.js').as_posix()}';
      import {{ normalizeListing }} from '{(REPO / 'web' / 'public' / 'js' / 'pipeline' / 'listing.js').as_posix()}';
      import fs from 'node:fs';
      loadSpecFrom(JSON.parse(fs.readFileSync('{(REPO / 'shared' / 'pipeline-spec.json').as_posix()}', 'utf8')));
      const raw = JSON.parse(fs.readFileSync(0, 'utf8'));
      process.stdout.write(JSON.stringify(normalizeListing(raw)));
    """
    run = subprocess.run(
        [node, "--input-type=module", "-e", script],
        input=json.dumps({"url": URL, "payload": PAYLOAD, "ldCar": None,
                          "carfaxUrl": "https://carfax.example/r"}),
        capture_output=True, text=True, check=True)
    return json.loads(run.stdout)


# Every Vehicle field that both sides populate from the payload.
COMPARED = [
    "vin", "stock_number", "year", "make", "model", "trim", "condition", "vehicle_status",
    "mileage", "title", "exterior_color_factory", "exterior_color_generic", "interior_color",
    "engine", "transmission", "drivetrain", "fuel_type", "mpg_city", "mpg_highway", "body_type",
    "ev_battery_range", "ev_mpge_combined", "cab_style", "box_length", "display_price",
    "pricing_rows", "dealer_description", "dealer_comments", "main_features",
    "features_structured", "options", "tags", "dealer_name", "dealer_address", "dealer_phone",
    "photo_urls", "video_urls", "window_sticker_url", "carfax_url", "carfax_one_owner", "warnings",
]


@pytest.fixture(scope="module")
def both():
    return python_record(), js_record()


@pytest.mark.parametrize("field", COMPARED)
def test_field_matches(both, field):
    py, js = both
    assert js.get(field) == getattr(py, field), f"{field}: JS {js.get(field)!r} != Python {getattr(py, field)!r}"


def test_fixture_exercises_the_traps(both):
    """If a refactor hollowed the fixture out, every field would match
    trivially. Pin the behaviours the fixture exists to check."""
    py, _ = both
    assert py.condition == "Certified Pre-Owned"      # flags, not the badge string
    assert py.mpg_city is None and py.mpg_highway == "28-30"  # "0" means unrated
    assert py.display_price == 34999                  # displayPrice 0 falls to price
    assert py.dealer_description == "Great truck.\n\nOne & only owner. Call!"
    assert py.photo_urls == [
        "https://pictures.dealer.com/x/resize/2048x2048/0001.jpg",
        "https://pictures.dealer.com/x/resize/2048x2048/0002.jpg",
    ]
    assert py.carfax_one_owner is True
