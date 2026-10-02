"""
Fetching and normalizing one Tomball Ford vehicle detail page (VDP) into a
Vehicle record.

The site fronts every page with a Cloudflare JS challenge, so we drive a
real (headless) Chromium via Playwright to load the page, then pull the
vehicle's full data out of an inline JSON blob the page already embeds for
its own analytics (window.jzlAnalyticsObject / vdp_gtm_payload).

Recipe / irregularity notes (read before changing extraction logic):
  - Not every vehicle has every field (used vs. new, in-transit vs. on-lot,
    EVs vs. ICE, trucks with bed length, etc). Every extraction is best-effort
    and missing data is simply omitted from the output, never a crash.
  - The embedded blob's key layout has been stable across new/used/EV/truck
    VDPs tested so far; if a future page redesign changes the variable name,
    `extract_analytics_object()` is the one place to add a fallback pattern.

Reading the page into a Vehicle is the core's (core/src/listing.rs), the
same code the app's saved-page reader calls; this module fetches the page,
keeps the CMS extractor registry (a validator is Python) and hands the core
the blob it found.
"""
from __future__ import annotations

import dataclasses
import re
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

import requests
# Playwright is imported lazily inside fetch_rendered_html()

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
)

# The vehicle blob is embedded as the default-parameter value of a JS
# function call: `jzlGa4AttachListenersToForms(jzlAnalyticsObject = {...})`.
JAZEL_VAR_MARKER = "jzlAnalyticsObject = "


# --------------------------------------------------------------------------
# Fetching
# --------------------------------------------------------------------------

CARFAX_WAIT_MS = 12000


def fetch_rendered_html(page, url: str, retries: int = 4) -> str:
    """Load a URL in the given Playwright page and return the rendered HTML.

    Cloudflare's managed challenge usually auto-resolves in a couple seconds
    for a real (even headless) Chromium with a normal UA -- no click/captcha
    needed -- but back-to-back navigations in the same session sometimes draw
    a harder/slower challenge. We poll the title and retry with backoff
    rather than assume a fixed resolve time.

    Once past that, on a used/CPO vehicle, the Carfax badge widget's actual
    report link isn't in the initial render -- its JS controller fills in
    the <a href> after an async lookup, confirmed by watching a real fetch:
    the container div (with data-vin/data-event-details) is present
    immediately, but empty, and the link only appears ~1-3s later.
    Capturing HTML right away silently drops the link (confirmed real case:
    extract_carfax_url() found nothing on a CPO Raptor that visibly has a
    working Carfax badge in a browser).

    The wait is gated on "used" appearing in the URL slug itself (e.g.
    .../vehicle/VIN/Used-2023-Ford-F--150-.../ vs .../vehicle/VIN/2026-Ford-
    Mustang-.../ for a new one) -- NOT on the ".carfax-logo" div existing:
    confirmed real case, that container renders on EVERY vehicle page, new
    or used, with data-vin already filled in either way, so it can't tell
    "used, report pending" apart from "new, no report will ever come."
    Gating on the div alone meant paying the full CARFAX_WAIT_MS timeout on
    every single new-vehicle fetch (the majority of the inventory) for a
    link that was never going to appear. The URL slug's used/new marker
    matched every vehicle's real condition across all 17 already on disk
    (Certified Pre-Owned and Used both carry it, New never does) -- cheaper
    to check than parsing the page for the same fact, since it costs
    nothing to look at before the page even loads.
    """
    from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

    is_used = "used" in url.lower()
    last_err = None
    for attempt in range(retries + 1):
        try:
            page.goto(url, timeout=30000, wait_until="domcontentloaded")
            for _ in range(20):
                if "Just a moment" not in page.title():
                    if is_used:
                        try:
                            page.wait_for_selector(".carfax-logo a", timeout=CARFAX_WAIT_MS)
                        except PlaywrightTimeoutError:
                            pass
                    return page.content()
                time.sleep(1)
            last_err = RuntimeError("Cloudflare challenge did not clear in time")
        except PlaywrightTimeoutError as e:
            last_err = e
        time.sleep(2 + 2 * attempt)
    raise RuntimeError(f"Failed to load {url}: {last_err}")


def extract_balanced_json(html: str, marker: str) -> dict | None:
    """The JSON object embedded at `marker`, by matching balanced braces
    from the first '{' after it (the core's listing.rs::extract_balanced_json;
    regex can't match nested JSON)."""
    from lotstretcher import core

    return core.call({"op": "balanced_json", "text": html, "marker": marker})


# --------------------------------------------------------------------------
# CMS extractor registry
# --------------------------------------------------------------------------
# Each extractor is a (marker, validator) pair.  marker is the JS variable
# name to search for in the page HTML; validator checks that the extracted
# JSON is a real vehicle blob (not a JS function wrapper or unrelated data).
# Add new CMS platforms by appending to this list.
#
# Extractor functions take (html) -> dict|None and are tried in order until
# one returns a truthy result.

_EXTRACTORS: list[tuple[str, str, callable]] = []


def register_extractor(name: str, marker: str, validator: callable) -> None:
    """Register a CMS-specific extractor for the analytics blob.

    Args:
        name: Human-readable CMS name (e.g. "jazel").
        marker: The JS variable marker string to search for in the HTML.
        validator: A callable(raw_dict) -> bool that returns True if the
                   extracted JSON looks like a real vehicle blob for this CMS.
    """
    _EXTRACTORS.append((name, marker, validator))


def _jazel_validator(data: dict) -> bool:
    """Jazel sites (FordDirect's dealer platform) embed a blob with a vdp_gtm_payload key."""
    return bool(data and "vdp_gtm_payload" in data)


register_extractor("jazel", JAZEL_VAR_MARKER, _jazel_validator)


def extract_analytics_object(html: str) -> tuple[dict | None, str | None]:
    """Try every registered CMS extractor, return the first match.

    Returns:
        (data, cms_name) where data is the parsed JSON dict and cms_name is
        the name of the extractor that matched (e.g. "jazel").
        (None, None) if no extractor matched.
    """
    for name, marker, validator in _EXTRACTORS:
        data = extract_balanced_json(html, marker)
        if data and validator(data):
            return data, name
    return None, None


# --------------------------------------------------------------------------
# Normalization
# --------------------------------------------------------------------------

@dataclasses.dataclass
class Vehicle:
    url: str
    vin: str | None = None
    stock_number: str | None = None
    year: str | None = None
    make: str | None = None
    model: str | None = None
    trim: str | None = None
    condition: str | None = None  # New / Used / Certified
    vehicle_status: str | None = None  # On Lot / In Transit / etc
    mileage: int | None = None
    title: str | None = None

    exterior_color_factory: str | None = None
    exterior_color_generic: str | None = None
    interior_color: str | None = None

    engine: str | None = None
    transmission: str | None = None
    drivetrain: str | None = None
    fuel_type: str | None = None
    mpg_city: str | None = None
    mpg_highway: str | None = None
    body_type: str | None = None
    ev_battery_range: str | None = None
    ev_mpge_combined: str | None = None
    cab_style: str | None = None
    box_length: str | None = None

    display_price: str | None = None
    pricing_rows: list = dataclasses.field(default_factory=list)

    dealer_description: str | None = None
    dealer_comments: str | None = None

    main_features: list = dataclasses.field(default_factory=list)
    features_structured: dict = dataclasses.field(default_factory=dict)
    options: list = dataclasses.field(default_factory=list)
    tags: list = dataclasses.field(default_factory=list)

    dealer_name: str | None = None
    dealer_address: str | None = None
    dealer_phone: str | None = None

    photo_urls: list = dataclasses.field(default_factory=list)
    video_urls: list = dataclasses.field(default_factory=list)
    window_sticker_url: str | None = None
    sticker: dict | None = None  # structured data from imaging/sticker.py,
    # when a real window sticker was available and parsed successfully --
    # build_facebook_post() prefers this over main_features/features_structured
    # when present. None means fall back (used vehicles, unpublished stickers,
    # or a parse failure all leave this None -- see window_sticker.py).

    carfax_url: str | None = None
    carfax_one_owner: bool | None = None

    warnings: list = dataclasses.field(default_factory=list)


def vin_from_url(url: str) -> str | None:
    """The VIN segment of a .../vehicle/<VIN>/... VDP URL, or None if the
    URL isn't shaped like one. Used to catch the case where the page we
    actually landed on isn't the vehicle the URL named -- see
    vehicle_pipeline.py::process_vehicle()."""
    parts = urlparse(url).path.strip("/").split("/")
    for i, part in enumerate(parts[:-1]):
        if part.lower() == "vehicle":
            return parts[i + 1]
    return None


def normalize_vehicle(url: str, html: str) -> Vehicle:
    """The Vehicle a rendered page describes: the analytics blob a
    registered extractor finds, the schema.org Car node and the Carfax
    widget, read by the core (core/src/listing.rs), which documents each
    field's rule and the page quirks behind them."""
    from lotstretcher import core

    analytics, _cms_name = extract_analytics_object(html)
    record = core.call({"op": "listing_record", "html": html, "url": url, "analytics": analytics, "extract": False})
    return Vehicle(**record)


# --------------------------------------------------------------------------
# Output folder naming
# --------------------------------------------------------------------------

def library_place(v: "Vehicle", url: str | None = None) -> dict:
    """{bucket, folder}: where this vehicle lives in a listings library,
    decided by the core (library_place.rs) so the browser's Save to
    library files a run in the same folder the CLI does.

    The bucket is "new" or "used". CPO counts as used: a certified vehicle
    is a used vehicle with a warranty, priced, posted and shopped as used.
    Without a scraped condition the URL slug decides ("/Used-2023-Ford-...",
    validated 17/17 against real conditions), and unknown sorts to used,
    since filing a used vehicle as new puts factory-warranty language on
    the wrong post. The folder is year, make, model, trim and the last
    eight characters of the stock number (else the VIN)."""
    from lotstretcher import core
    record = {k: getattr(v, k, None) for k in ("year", "make", "model", "trim", "stock_number", "vin", "condition")}
    return core.call({"op": "library_place", "record": record, "url": url or ""})


def condition_bucket(v: "Vehicle", url: str | None = None) -> str:
    """"new" or "used" -- the top-level split of the listings folder."""
    return library_place(v, url)["bucket"]


def vehicle_folder_name(v: Vehicle) -> str:
    return library_place(v)["folder"]


# --------------------------------------------------------------------------
# Generic download helper (shared by photos.py and window_sticker.py)
# --------------------------------------------------------------------------

def download_file(session: requests.Session, url: str, dest: Path, timeout=30) -> bool:
    try:
        resp = session.get(url, timeout=timeout)
        resp.raise_for_status()
        dest.write_bytes(resp.content)
        return True
    except requests.RequestException as e:
        print(f"    ! download failed ({url}): {e}", file=sys.stderr)
        return False
