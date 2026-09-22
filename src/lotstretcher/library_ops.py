"""Operations on a vehicle folder that is already on disk.

Shared by the `recompose` CLI and the server's POST /library/.../recompose
so that "rebuild this vehicle's bundle with these options" is one path
whichever surface asks for it. The options vocabulary is the app's
control values (shared/pipeline-spec.json's controls block), the same
keys server/delegate.py reads, so a self-hosted user's Options pane and
the CLI flags describe the same rebuild.

Nothing here scrapes or re-cuts: the cutouts, wheel shots and interiors
already sitting in the folder are the input, exactly as recompose_cli
has always worked.
"""
from __future__ import annotations

import json
from pathlib import Path

from lotstretcher.imaging import assets
from lotstretcher.imaging.compose import compose_interiors, compose_vehicle, compose_wheel_shots


def find_vehicle_folders(root: Path) -> list[Path]:
    """Every vehicle folder at or under `root`, at any depth -- listings
    are bucketed into new/ and used/, so a fixed one-level scan would
    silently find nothing when pointed at the root."""
    if (root / "images" / "exterior" / "cutout").is_dir():
        return [root]
    return sorted(p.parent.parent.parent for p in root.glob("*/**/images/exterior/cutout")
                  if p.is_dir())


def vehicle_record(folder: Path) -> dict:
    """The scraped Vehicle record as a plain dict; {} if unreadable."""
    try:
        data = json.loads((folder / "details.json").read_text())
    except (OSError, ValueError):
        return {}
    return data.get("vehicle", data)


def vehicle_colors(folder: Path) -> dict:
    """{exterior_color, interior_color} from details.json. Nones mean
    "measure the paint off the cutout instead"."""
    v = vehicle_record(folder)
    return {"exterior_color": v.get("exterior_color_factory") or v.get("exterior_color"),
            "interior_color": v.get("interior_color")}


def resolve_recompose_options(options: dict) -> dict:
    """App control values -> keyword arguments for the composers.

    Raises ValueError for an asset that does not exist, so a caller can
    refuse before touching the folder rather than composing something
    other than what was asked for.
    """
    from lotstretcher.imaging.compose.pipeline import DEFAULT_HERO_STILL_FORMAT, HERO_STILL_FORMATS

    wants_photo = options.get("backdrop") == "asset" or bool(options.get("photoBackground"))
    background_path = None
    if wants_photo:
        background_path = assets.resolve_arg("backgrounds", options.get("background") or None,
                                             default_name="American Flag")
    border_path = None
    if options.get("frame"):
        border_path = assets.resolve_arg("borders", options.get("border") or None)

    formats = options.get("heroFormats") or [DEFAULT_HERO_STILL_FORMAT]
    if "all" in formats:
        formats = list(HERO_STILL_FORMATS)
    bad = [f for f in formats if f not in HERO_STILL_FORMATS]
    if bad:
        raise ValueError(f"unknown hero format {bad[0]!r}; choose from {', '.join(HERO_STILL_FORMATS)}")

    return {
        "background_path": background_path,
        "border_path": border_path,
        "hero_formats": tuple(dict.fromkeys(formats)),
        "style": {
            "glow": bool(options.get("glow", True)),
            "glow_color": options.get("glowColor") or "white",
            "glow_radius": int(options.get("glowRadius") or 24),
            "glow_intensity": float(options.get("glowIntensity") or 0.75),
            "gradient": not wants_photo,
        },
        "interiors": bool(options.get("interiors", False)),
        "interior_captions": bool(options.get("interiorCaptions", False)),
    }


def recompose_folder(folder: Path, resolved: dict, interior_classifier=None) -> dict:
    """Rebuild one vehicle's bundle from its existing cutouts.

    `resolved` is resolve_recompose_options()'s result. Returns a small
    report: what was produced, by count, so both the CLI's printout and
    the server's job record come from the same numbers.
    """
    images = folder / "images" / "exterior"
    bundle = folder / "bundle"
    colors = vehicle_colors(folder)
    style = resolved["style"]

    result = compose_vehicle(images / "cutout", bundle, resolved["background_path"], resolved["border_path"],
                             hero_formats=resolved["hero_formats"], **style, **colors)
    wheels = compose_wheel_shots(images / "wheels", bundle, resolved["background_path"], resolved["border_path"],
                                 **style, **colors)
    report = {
        "folder": folder.name,
        "hero": bool(result["hero"]),
        "heroes": sorted(result["heroes"]) if result.get("heroes") else [],
        "framed": len(result["framed"]) + len(wheels),
        "wheels": len(wheels),
        "interior": 0,
        "interior_captioned": 0,
    }
    if resolved["interiors"]:
        processed = compose_interiors(folder / "images" / "interior", bundle, vehicle_record(folder),
                                      interior_classifier, resolved["interior_captions"])
        report["interior"] = len(processed)
        report["interior_captioned"] = sum(1 for p in processed if p["callout"])
    return report
