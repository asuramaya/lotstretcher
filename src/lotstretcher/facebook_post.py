"""
Build the ready-to-paste Facebook post for a vehicle.

The text is the core's (core/src/copy.rs), the same code the browser's
copy.js calls, so both surfaces post the same words. This module is the
CLI's host: it hands the core the vehicle record and the dealer's own
boilerplate from dealer_config, and hands back the post, the short-form
copy (see social_post.py) and the audit trail of which branch fired.

What the post is, and why, in brief -- the reasoning that used to sit
next to each line of Python and now sits next to each line of Rust:

  * The fixed dealer/salesperson greeting and address go FIRST and THIRD
    (sandwiching the vehicle headline), not last: Facebook's feed preview
    shows a post's first ~3 lines before "See more", and that is what
    should be visible without a click. No phone number: Facebook hides
    phone numbers typed into post text.
  * New vehicles are always priced at MSRP (the window sticker's own
    Total MSRP, then the site's MSRP pricing row, then the site's display
    price as a last resort); used vehicles show the listed price, with
    the sticker's original MSRP alongside when it is higher.
  * Dealer-incentive language ("price includes ... rebate") is dropped
    from a NEW vehicle's description, since incentives are not advertised
    in the post itself.
  * Sticker equipment leads when a sticker exists; a feature is listed
    once even when the sticker names it in two categories. Ford's factory
    warranties are shown for any Ford, new or used, since they transfer.
  * "More details" links to the manufacturer's own site (Ford's QR
    short-link) and never back to the dealership.
"""
from __future__ import annotations

from lotstretcher import core
from lotstretcher.dealer_config import get as _get_dealer_config
from lotstretcher.scrape import Vehicle


def _record(v: Vehicle) -> dict:
    import dataclasses
    return dataclasses.asdict(v) if dataclasses.is_dataclass(v) else dict(v)


def posts_for(v: Vehicle) -> dict:
    """Every platform's post, the hashtags and the notes, from the core,
    with the dealer boilerplate dealer_config supplies."""
    cfg = _get_dealer_config()
    return core.call({
        "op": "build_posts",
        "vehicle": _record(v),
        "dealer": {"greeting": cfg.dealer_greeting, "address": cfg.dealer_address, "city_tags": list(cfg.city_tags)},
    })


def ford_qr_link(vin: str) -> str:
    """Ford's own short-link redirector for the QR code printed on every
    Monroney window sticker -- format confirmed from a real scanned QR
    (http://v.ford.com/?v=<VIN>&c=1&s=1). c=1&s=1 look like fixed template
    constants, not per-VIN, based on the one real sample seen; treat this
    as a best-effort bonus link for the post, not verified data."""
    return f"http://v.ford.com/?v={vin}&c=1&s=1"


def build_facebook_post(v: Vehicle) -> str:
    return posts_for(v)["facebook"]


def resolve_display_price(v: Vehicle) -> str | None:
    """The price the post shows: the listed price for anything used, and
    for a new vehicle the sticker's Total MSRP, then the site's MSRP
    pricing row, then the site's display price."""
    return posts_for(v)["explain"]["resolved_price"]


def resolve_original_msrp_comparison(v: Vehicle) -> str | None:
    """A used/CPO vehicle's original sticker MSRP, formatted, when it is
    higher than the current price; None for a new vehicle (its primary
    price already is the MSRP) or when the comparison would not read."""
    return posts_for(v)["explain"]["original_msrp_comparison"]


def resolve_more_details_link(v: Vehicle) -> str | None:
    """The manufacturer's own link for the post (Ford's QR short-link,
    only with a parsed sticker and a VIN); never the dealership's."""
    return posts_for(v)["explain"]["more_details_link"]


def check_pricing_consistency(v: Vehicle) -> list[str]:
    """Lightweight sanity checks on the site's own pricing data -- flags a
    mismatch as a warning, never blocks anything, so a bad/inconsistent
    listing gets caught before posting instead of after."""
    return list(posts_for(v)["explain"]["pricing_consistency_issues"])


def explain_facebook_post(v: Vehicle) -> dict:
    """Small audit trail of which condition-dependent branch fired for
    this vehicle's post -- saved into details.json, never shown to the
    customer, so "why does this one look different" is a five-second
    read of details.json rather than a re-derivation of the logic."""
    return dict(posts_for(v)["explain"])
