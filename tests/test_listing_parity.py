"""A vehicle page is read by the core (core/src/listing.rs) on both
surfaces: the CLI's scrape.normalize_vehicle and the app's saved-page
reader (web/public/js/pipeline/listing.js) are hosts over it.

The two used to be separate normalisers, the JS a port of the Python,
held together field by field here, and they had drifted (the JS kept
the last schema.org Car node, capped the description and treated an
empty list as present). tests/fixtures/listing-reference.json holds
what the Python normalize_vehicle returned before its body was deleted,
for the six real pages in scrape_fixtures/, a synthetic page shaped
like a real Jazel blob with the traps the rules exist for ("0"
MPG meaning unrated, badges in conditions_array, a price of 0, HTML and
entities in the description, resize URLs to upsize), and sixty mutations
of it. This test holds the Python host and the wasm build under node to
every field of every record, types included.
"""
from __future__ import annotations

import dataclasses
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from lotstretcher import core
from lotstretcher.scrape import JAZEL_VAR_MARKER, extract_balanced_json, normalize_vehicle

pytestmark = pytest.mark.skipif(not core.available(), reason=f"core not built: {core.why_unavailable()}")

REPO = Path(__file__).resolve().parents[1]
SPEC = json.loads((REPO / "shared" / "pipeline-spec.json").read_text())
REF = json.loads((REPO / "tests" / "fixtures" / "listing-reference.json").read_text())


def _html(case: dict) -> str:
    return (REPO / case["page"]).read_text() if "page" in case else case["html"]


def _typed(v):
    """JSON with each value's type spelled out, so 28 and "28" differ."""
    if isinstance(v, dict):
        return {k: _typed(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_typed(x) for x in v]
    return [type(v).__name__, v]


@pytest.mark.parametrize("k", range(len(REF)), ids=[c["name"] for c in REF])
def test_the_python_host_matches_the_normaliser_it_replaced(k):
    case = REF[k]
    got = json.loads(json.dumps(dataclasses.asdict(normalize_vehicle(case["url"], _html(case)))))
    assert _typed(got) == _typed(case["expected"])


def test_wasm_matches():
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed; the wasm side of the parity check cannot run")
    wasm = REPO / "web" / "public" / "core" / "lotstretcher_core_bg.wasm"
    script = f"""
      import fs from 'node:fs';
      import {{ loadCore }} from '{(REPO / 'web' / 'public' / 'js' / 'core.js').as_posix()}';
      import {{ recordFromHtml, describesVehicle }} from '{(REPO / 'web' / 'public' / 'js' / 'pipeline' / 'listing.js').as_posix()}';
      await loadCore(fs.readFileSync('{wasm.as_posix()}'));
      const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
      const out = cases.map((c) => recordFromHtml(c.html, c.url));
      out.push(recordFromHtml('<html><head><link href="https://d.test/v/1/" rel="canonical"></head></html>'));
      out.push(describesVehicle(recordFromHtml('<html>nothing</html>', 'https://x')));
      process.stdout.write(JSON.stringify(out));
    """
    cases = [{"html": _html(c), "url": c["url"]} for c in REF]
    run = subprocess.run([node, "--input-type=module", "-e", script], input=json.dumps(cases),
                         capture_output=True, text=True, check=True)
    out = json.loads(run.stdout)
    assert out.pop() is False
    assert out.pop()["url"] == "https://d.test/v/1/"          # a saved page names itself
    for case, got in zip(REF, out):
        assert _typed(got) == _typed(case["expected"]), case["name"]


def test_analytics_global_matches_the_marker():
    """scrape.py's registry finds the blob by its assignment text; the
    core's own reader scans for the same text, from the spec."""
    assert JAZEL_VAR_MARKER.strip().rstrip("=").strip() == SPEC["listing"]["analyticsGlobal"]
    assert SPEC["listing"]["analyticsMarker"] == JAZEL_VAR_MARKER


def test_braces_and_quotes_inside_strings_do_not_end_the_blob():
    blob = {"vdp_gtm_payload": {"vin": "1FTEW1EP0PKD71397", "dealerDescription": "a } in \"quotes\" {"},
            "other": {"brace": "}"}}
    html = f"<script>f(jzlAnalyticsObject = {json.dumps(blob)});</script>"
    assert extract_balanced_json(html, JAZEL_VAR_MARKER) == blob
    assert extract_balanced_json(html, "nothing") is None


def test_the_reference_exercises_the_traps():
    """If the fixture were hollowed out, every field would match
    trivially. Pin the behaviours it exists to check."""
    by = {c["name"]: c["expected"] for c in REF}
    py = by["synthetic"]
    assert py["condition"] == "Certified Pre-Owned"          # flags, not the badge string
    assert py["mpg_city"] is None and py["mpg_highway"] == "28-30"  # "0" means unrated
    assert py["display_price"] == 34999                      # displayPrice 0 falls to price
    assert py["dealer_description"] == "Great truck.\n\nOne & only owner. Call!"
    assert py["photo_urls"] == ["https://pictures.dealer.com/x/resize/2048x2048/0001.jpg",
                                "https://pictures.dealer.com/x/resize/2048x2048/0002.jpg"]
    assert py["carfax_one_owner"] is True and py["carfax_url"] == "https://carfax.test/r?v=1"
    assert py["title"] == "2024 Ford Maverick Lariat"
    assert by["no-blob"]["title"] == "LD name" and by["no-blob"]["vin"] == "LDVIN"   # the first Car node
    descriptions = {c["expected"]["dealer_description"] for c in REF}
    assert any("–" in (d or "") for d in descriptions)   # &#150; is the C1 dash, as browsers read it
    assert any(c["expected"]["condition"] is None for c in REF)  # no used flag and no conditions: unknown
    assert sum(bool(c["expected"]["carfax_url"]) for c in REF if "page" in c) >= 1
