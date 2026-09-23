"""The address and the VIN, decoded on the device from the spec's
tables, the same in Python and JavaScript. When the local listings
library is present, every address in it must decode to the year, make,
model and VIN the scraper recorded, since that is the promise the field
makes with no fetch."""
from __future__ import annotations

import glob
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

from lotstretcher import vin

REPO = Path(__file__).resolve().parents[1]
CASES = [
    "3FTTW8HA3TRB41981",
    "1C4RJGAGXRC105682",
    "19XFL2H83TE000559",
    "3ftt w8ha3trb41981",
    "3FTTW8HA4TRB41981",
    "3FTTW8HA3TRB4198",
    "2C3CDXBG5NH123456",
    "https://www.tomballford.com/vehicle/3FTTW8HA3TRB41981/2026-Ford-Maverick-Tomball-TX/",
    "https://www.tomballford.com/vehicle/1FT8W2BT2REC59903/Used-2024-Ford-F--250SD-Tomball-TX/",
    "https://www.tomballford.com/vehicle/7SVAAABAXSX056413/Used-2026-Toyota-Grand_Highlander_Hybrid-Tomball-TX/",
    "https://www.tomballford.com/vehicle/JTJAAAAA1SX000000/Used-2024-Lexus-NX-Tomball-TX/",
    "https://dealer.example/inventory/new-2025-honda-civic-sport-houston-tx/",
    "https://dealer.example/used/",
    "not a vin at all",
]


def test_decode_reads_year_make_and_the_check_digit():
    d = vin.decode("3FTTW8HA3TRB41981")
    assert d["valid"] and d["year"] == 2026 and d["make"] == "Ford" and d["country"] == "Mexico" and not d["warnings"]
    assert vin.decode("1C4RJGAGXRC105682")["year"] == 2024 and vin.decode("1C4RJGAGXRC105682")["make"] == "Jeep"
    assert vin.decode("19XFL2H83TE000559")["make"] == "Honda"
    typo = vin.decode("3FTTW8HA4TRB41981")
    assert not typo["valid"] and "check digit" in typo["warnings"][0] and typo["year"] == 2026
    short = vin.decode("3FTTW8HA3TRB4198")
    assert not short["valid"] and short["year"] is None
    shared = vin.decode("2C3CDXBG5NH123456")
    assert shared["make"] is None and shared["makes"] == ["Chrysler", "Dodge"]
    # Lower case and spaces are tolerated; I/O/Q are read as 1/0/0.
    assert vin.normalize("3ftt w8ha3trb41981") == "3FTTW8HA3TRB41981"


def test_the_address_gives_year_make_model_and_vin():
    r = vin.record_from_text("https://www.tomballford.com/vehicle/1FT8W2BT2REC59903/Used-2024-Ford-F--250SD-Tomball-TX/")
    assert (r["vin"], r["year"], r["make"], r["model"]) == ("1FT8W2BT2REC59903", 2024, "Ford", "F-250SD")
    assert r["title"] == "2024 Ford F-250SD" and r["warnings"] == [] and r["photo_urls"] == []
    r = vin.record_from_text("https://dealer.example/inventory/new-2025-honda-civic-sport-houston-tx/")
    assert (r["year"], r["make"], r["model"]) == (2025, "Honda", "Civic Sport") and r["vin"] is None
    assert any("No VIN" in w for w in r["warnings"])
    r = vin.record_from_text("3FTTW8HA3TRB41981")
    assert r["url"] is None and r["title"] == "2026 Ford"
    r = vin.record_from_text("https://dealer.example/used/")
    assert r["vin"] is None and r["year"] is None and r["title"] is None


def test_every_address_in_the_local_library_decodes_to_what_the_scraper_saw():
    files = glob.glob(str(Path.home() / "Documents" / "listings" / "*" / "*" / "details.json"))
    if len(files) < 5:
        pytest.skip("no local listings library")
    for f in files:
        d = json.load(open(f))
        if not d.get("url") or not d.get("vin"):
            continue
        r = vin.record_from_text(d["url"])
        assert r["vin"] == d["vin"], d["url"]
        assert str(r["year"]) == str(d["year"]), d["url"]
        assert (r["make"] or "").lower() == (d["make"] or "").lower(), d["url"]
        assert (r["model"] or "").lower() == (d["model"] or "").lower(), d["url"]


def test_js_decoder_matches_python():
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    spec = REPO / "web" / "public" / "spec" / "pipeline-spec.json"
    script = f"""
      import fs from 'node:fs';
      import {{ loadSpecFrom }} from '{(REPO / 'web' / 'public' / 'js' / 'spec.js').as_posix()}';
      import {{ recordFromText, decode }} from '{(REPO / 'web' / 'public' / 'js' / 'pipeline' / 'vin.js').as_posix()}';
      loadSpecFrom(JSON.parse(fs.readFileSync('{spec.as_posix()}', 'utf8')));
      const cases = {json.dumps(CASES)};
      process.stdout.write(JSON.stringify(cases.map((c) => [recordFromText(c), decode(c)])));
    """
    with tempfile.TemporaryDirectory() as d:
        js = Path(d) / "vin.mjs"
        js.write_text(script)
        out = json.loads(subprocess.run([node, str(js)], capture_output=True, text=True, check=True).stdout)
    for case, (js_record, js_decode) in zip(CASES, out):
        py_record = vin.record_from_text(case)
        py_decode = vin.decode(case)
        assert js_record == py_record, case
        assert js_decode == py_decode, case
