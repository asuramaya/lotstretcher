"""
What a VIN says on its own, decoded from the spec's tables with no
database and no call to anyone: whether it is well formed (the check
digit), the model year, the manufacturer (the first three characters)
and the country. Model and trim are encoded per manufacturer and are
not here; a listing address carries them in its slug, which
`from_url` reads.

The twin of web/public/js/pipeline/vin.js; tests/test_vin_parity.py
holds the two to the same answers.
"""
from __future__ import annotations

import re
from urllib.parse import unquote, urlparse

from lotstretcher import spec

VIN_RE = re.compile(r"\b([A-HJ-NPR-Z0-9]{17})\b")


def normalize(text: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (text or "").upper().replace("O", "0").replace("I", "1").replace("Q", "0"))


def check_digit(vin: str) -> str | None:
    """The check character position 9 should hold, or None when a
    character is not a VIN character."""
    table = spec.get("vin", "transliteration")
    weights = spec.get("vin", "weights")
    total = 0
    for ch, w in zip(vin, weights):
        if ch.isdigit():
            v = int(ch)
        elif ch in table:
            v = table[ch]
        else:
            return None
        total += v * w
    r = total % 11
    return "X" if r == 10 else str(r)


def model_year(vin: str) -> int | None:
    """Position 10 names the year in a 30-year cycle; position 7 says
    which cycle for North American VINs (a letter there means 2010 on)."""
    codes = spec.get("vin", "yearCodes")
    start = spec.get("vin", "yearCycleStart")
    i = codes.find(vin[9])
    if i < 0:
        return None
    year = start + i
    if vin[6].isalpha() or vin[0] not in "12345":
        year += 30
    return year


def decode(text: str) -> dict:
    """{vin, valid, year, make, country, warnings}. A VIN that fails the
    check digit is still returned, flagged, since a typo is the common
    case and the year and make may still be right."""
    vin = normalize(text)
    out = {"vin": vin, "valid": False, "year": None, "make": None, "country": None, "warnings": []}
    if len(vin) != 17:
        out["warnings"].append(f"A VIN has 17 characters; this has {len(vin)}.")
        return out
    expected = check_digit(vin)
    if expected is None:
        out["warnings"].append("That is not a VIN: it holds a character a VIN cannot.")
        return out
    out["valid"] = expected == vin[8]
    if not out["valid"]:
        out["warnings"].append("The VIN's check digit does not match; one character is probably mistyped.")
    out["year"] = model_year(vin)
    make = spec.get("vin", "wmi", default={}).get(vin[:3])
    out["country"] = spec.get("vin", "countries", default={}).get(vin[0])
    if make is None:
        out["warnings"].append(f"The manufacturer code {vin[:3]} is not one the app knows; type the make.")
    elif isinstance(make, list):
        # One manufacturer, several brands: the address's slug decides.
        out["makes"] = list(make)
        out["warnings"].append(f"That manufacturer code is {' or '.join(make)}; pick the make.")
    else:
        out["make"] = make
    return out


def from_url(url: str) -> dict:
    """A listing address read on the device: the VIN in its path and
    the year-make-model words of its slug. {url, vin, year, make, model,
    slug}; None where the address does not say."""
    out = {"url": url, "vin": None, "year": None, "make": None, "model": None, "slug": None}
    path = unquote(urlparse(url).path)
    parts = [p for p in path.split("/") if p]
    for i, part in enumerate(parts):
        if VIN_RE.fullmatch(part.upper()) and check_digit(part.upper()) is not None:
            out["vin"] = part.upper()
            if i + 1 < len(parts):
                out["slug"] = parts[i + 1]
            break
    if out["slug"] is None:
        # No VIN segment: the last path word with a year in it.
        for part in reversed(parts):
            if re.search(r"\b(19|20)\d\d\b", part.replace("-", " ")):
                out["slug"] = part
                break
    if out["slug"]:
        out.update(parse_slug(out["slug"]))
    return out


CONDITION_WORDS = ("new", "used", "certified", "pre", "owned", "preowned", "cpo")


def parse_slug(slug: str) -> dict:
    """year, make, model from a slug like Used-2024-Ford-F--250SD-Tomball-TX:
    a doubled dash is a literal hyphen in a name, a leading condition
    word is skipped, and the city before a two-letter state is dropped."""
    words = [w.replace("\0", "-").replace("_", " ") for w in slug.replace("--", "\0").split("-") if w]
    while words and words[0].lower() in CONDITION_WORDS:
        words = words[1:]
    out = {"year": None, "make": None, "model": None}
    if words and re.fullmatch(r"(19|20)\d\d", words[0]):
        out["year"] = int(words[0])
        words = words[1:]
    if not words:
        return out
    out["make"] = words[0].capitalize() if len(words[0]) > 3 else words[0].upper()
    rest = words[1:]
    # A dealer's slug ends in its city and state: drop both when the last
    # word is a state code (a two-letter model such as NX sits earlier).
    if len(rest) >= 3 and re.fullmatch(r"[A-Za-z]{2}", rest[-1]):
        rest = rest[:-2]
    if rest:
        # An all-lower-case slug is capitalised word by word.
        out["model"] = " ".join(w.capitalize() if w.islower() else w for w in rest)
    return out


def record_from_text(text: str) -> dict:
    """What the app fills from a pasted address or VIN, in the
    scrape.Vehicle shape: the decoded VIN plus the slug's words. Nothing
    is fetched."""
    text = (text or "").strip()
    is_url = bool(re.match(r"https?://", text, re.I))
    u = from_url(text) if is_url else {"url": None, "vin": None, "year": None, "make": None, "model": None}
    d = decode(u["vin"] or text) if (u["vin"] or not is_url) else None
    v = {"url": u["url"], "vin": (d or {}).get("vin") if d and len((d or {}).get("vin", "")) == 17 else None,
         "year": u["year"] or (d or {}).get("year"), "make": u["make"] or (d or {}).get("make"),
         "model": u["model"], "trim": None, "warnings": [], "photo_urls": [], "video_urls": [], "pricing_rows": []}
    if d:
        v["warnings"].extend(d["warnings"])
        if d.get("make") and u["make"] and d["make"].lower() != u["make"].lower():
            v["warnings"].append(f"The VIN says {d['make']}; the address says {u['make']}.")
    if is_url and not u["vin"]:
        v["warnings"].append("No VIN in that address; only what its words say was read.")
    v["title"] = " ".join(str(x) for x in (v["year"], v["make"], v["model"]) if x) or None
    return v
