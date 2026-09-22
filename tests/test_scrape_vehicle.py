"""scrape_vehicle(): the one fetch-and-validate path behind both
`lotstretcher <url>` and the server's POST /scrape.

The two sanity checks were each added after a real mistake produced a
convincing-looking empty result. They must hold for both callers, which
is why the function exists rather than being inlined in either.
"""
from __future__ import annotations

import json

import pytest

from lotstretcher import vehicle_pipeline
from lotstretcher.scrape import DEALERINSPIRE_VAR_MARKER

VIN = "1FTVW1EL0PWG12345"


def page_with(payload: dict) -> str:
    return f"<html><script>{DEALERINSPIRE_VAR_MARKER}{json.dumps({'vdp_gtm_payload': payload})};</script></html>"


@pytest.fixture
def fake_browser(monkeypatch):
    """Stand in for Playwright: new_page() returns a closable browser and
    fetch_rendered_html() returns whatever the test set."""
    holder = {"html": ""}

    class Browser:
        closed = False

        def close(self):
            self.closed = True

    browser = Browser()
    monkeypatch.setattr(vehicle_pipeline, "new_page", lambda pw, headed: (browser, object()))
    monkeypatch.setattr(vehicle_pipeline, "fetch_rendered_html", lambda page, url: holder["html"])
    holder["browser"] = browser
    return holder


def test_returns_the_normalised_record(fake_browser):
    fake_browser["html"] = page_with({"vin": VIN, "make": "Ford", "price": 1})
    v = vehicle_pipeline.scrape_vehicle(None, f"https://d.example/vehicle/{VIN}/x/")
    assert v.vin == VIN and v.make == "Ford"
    assert fake_browser["browser"].closed, "the throwaway browser must be closed"


def test_browser_closed_even_when_fetch_raises(fake_browser, monkeypatch):
    def boom(page, url):
        raise TimeoutError("challenge never resolved")
    monkeypatch.setattr(vehicle_pipeline, "fetch_rendered_html", boom)
    with pytest.raises(TimeoutError):
        vehicle_pipeline.scrape_vehicle(None, "https://d.example/vehicle/x/")
    assert fake_browser["browser"].closed


def test_listing_page_is_refused(fake_browser):
    """No VIN, no price, no photos: this was a search page, not a car."""
    fake_browser["html"] = "<html>no blob</html>"
    with pytest.raises(RuntimeError, match="doesn't look like a single"):
        vehicle_pipeline.scrape_vehicle(None, "https://d.example/inventory/")


def test_redirect_to_another_vehicle_is_refused(fake_browser):
    """The URL names one VIN; the page carries another. A 404 page with a
    'similar vehicles' widget does exactly this."""
    fake_browser["html"] = page_with({"vin": "1FTOTHER000000000", "price": 1})
    with pytest.raises(RuntimeError, match="does not match the VIN in the requested URL"):
        vehicle_pipeline.scrape_vehicle(None, f"https://d.example/vehicle/{VIN}/x/")


def test_scrape_endpoint_rejects_non_http(monkeypatch):
    from fastapi.testclient import TestClient
    from lotstretcher.server import app as server_app
    client = TestClient(server_app.app)
    r = client.post("/scrape", json={"url": "file:///etc/hostname"})
    assert r.status_code == 422


def test_scrape_endpoint_returns_the_record(monkeypatch):
    """The endpoint is a thin shell over scrape_vehicle: whatever the
    shared function returns comes back as JSON, dataclass keys intact."""
    from fastapi.testclient import TestClient
    from lotstretcher.scrape import Vehicle
    from lotstretcher.server import app as server_app

    monkeypatch.setattr(vehicle_pipeline, "scrape_vehicle",
                        lambda pw, url, headed=False: Vehicle(url=url, vin=VIN, make="Ford"))

    class FakePW:
        def __enter__(self): return self
        def __exit__(self, *a): return False
    import types, sys
    fake_mod = types.ModuleType("playwright.sync_api")
    fake_mod.sync_playwright = lambda: FakePW()
    monkeypatch.setitem(sys.modules, "playwright.sync_api", fake_mod)

    client = TestClient(server_app.app)
    r = client.post("/scrape", json={"url": f"https://d.example/vehicle/{VIN}/x/"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["vin"] == VIN and body["make"] == "Ford"
    assert "photo_urls" in body and "window_sticker_url" in body
