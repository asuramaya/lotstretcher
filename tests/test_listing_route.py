"""The site's /api/vdp route (web/src/worker.js) reads only listed dealer
hosts and only their vehicle pages; the table and the path rule are the
spec's, so the browser (pipeline/listing.js) asks only for what the route
will serve. Checked against every listing address in the operator's
library when it is present."""
from __future__ import annotations

import glob
import json
import re
from pathlib import Path
from urllib.parse import urlparse

REPO = Path(__file__).resolve().parents[1]
DEALERS = json.loads((REPO / "shared" / "pipeline-spec.json").read_text())["listing"]["dealers"]
VDP = re.compile(DEALERS["vdpPath"])


def test_every_listed_host_maps_to_an_origin_host():
    assert DEALERS["hosts"] and all(o and "." in o for o in DEALERS["hosts"].values())
    assert all(h == h.lower() for h in DEALERS["hosts"])


def test_the_route_takes_vehicle_pages_and_nothing_else():
    assert VDP.match("/vehicle/1G1ZB5ST9KF197832/Used-2019-Chevrolet-Malibu-Tomball-TX/")
    for path in ("/wp-admin/", "/wp-json/jazel-auto5/v1/vehicle/1G1ZB5ST9KF197832", "/vehicle/../wp-admin/",
                 "/vehicle/1G1ZB5ST9KF197832/a/b/", "/vehicle/SHORT/x/", "/"):
        assert not VDP.match(path), path


def test_every_real_listing_address_is_one_it_reads():
    for f in glob.glob(str(Path.home() / "Documents" / "listings" / "*" / "*" / "details.json")):
        data = json.loads(Path(f).read_text())
        url = data.get("url") or data.get("vehicle", {}).get("url")
        if url:
            page = urlparse(url)
            assert page.hostname in DEALERS["hosts"] and VDP.match(page.path), url


def test_the_worker_and_the_browser_read_the_same_table():
    worker = (REPO / "web" / "src" / "worker.js").read_text()
    listing = (REPO / "web" / "public" / "js" / "pipeline" / "listing.js").read_text()
    assert "spec.listing.dealers" in worker and "DEALERS.vdpPath" in worker
    assert "specGet('listing', 'dealers')" in listing
    # The dealer's page is text on this site, never a page of it.
    assert "'content-type': 'text/plain; charset=utf-8'" in worker and "sandbox" in worker
