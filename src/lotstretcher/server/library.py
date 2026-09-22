"""The listings library, read from disk for the browser client.

WHY: the CLI writes a folder per vehicle under <root>/<bucket>/ (new,
used), each with details.json and a bundle/ of finished output. Until
now the only way to look at that library was a file manager. The app's
Library pane reads it through these two routes on a self-hosted install,
and through a folder picker on lotstretcher.org, using ONE JavaScript
reader for both: the layout it reads is spec.library, the same names
vehicle_pipeline writes and this module lists.

WHAT THIS IS NOT: a database. The folder is the record. Nothing here
writes, so there is no index to fall out of date, and a vehicle dropped
in by hand shows up on the next load.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from .. import spec

# Subtrees under images/ that hold derived files, not the originals the
# app would reprocess. Skipped from the listing to keep it small.
DERIVED_IMAGE_DIRS = {"cutout", "wheels", "upscaled", "rejected"}


def _layout() -> dict:
    return spec.get("library")


def _vehicle_entry(root: Path, bucket: str, folder: Path) -> dict | None:
    layout = _layout()
    details_path = folder / layout["details"]
    if not details_path.is_file():
        return None
    try:
        details = json.loads(details_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        details = {"warnings": ["details.json could not be read"]}

    files: list[str] = []
    images: list[str] = []
    for dirpath, dirnames, filenames in os.walk(folder):
        rel_dir = Path(dirpath).relative_to(folder)
        parts = rel_dir.parts
        if parts and parts[0] == layout["images"]:
            # Originals only: skip derived subtrees, list the rest.
            dirnames[:] = [d for d in dirnames if d not in DERIVED_IMAGE_DIRS]
            for name in sorted(filenames):
                if name.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
                    images.append(str(rel_dir / name))
            continue
        for name in sorted(filenames):
            if name == layout["details"]:
                continue
            files.append(str(rel_dir / name) if parts else name)

    # Walk order is filesystem order, which means nothing; the browser's
    # reader sorts, so this does too, and the two indexes compare equal.
    files.sort()
    images.sort()

    # A compact card record: the grid must not need every details.json
    # in full to draw 237 cards.
    card_keys = ("vin", "stock_number", "year", "make", "model", "trim", "title",
                 "condition", "mileage", "display_price", "exterior_color_factory")
    record = details.get("vehicle", details) if isinstance(details, dict) else {}
    return {
        "bucket": bucket,
        "folder": folder.name,
        "modified": int(folder.stat().st_mtime),
        "card": {k: details.get(k) for k in card_keys},
        # inventory_sync's mark, or the pane's: the vehicle is still on
        # disk but no longer on the lot.
        "delisted": record.get("delisted_at") or None,
        "files": files,
        "images": images,
    }


def index(root: Path) -> dict:
    """Every vehicle folder under the library root, newest first."""
    layout = _layout()
    vehicles = []
    for bucket in layout["buckets"]:
        bucket_dir = root / bucket
        if not bucket_dir.is_dir():
            continue
        for folder in sorted(p for p in bucket_dir.iterdir() if p.is_dir()):
            entry = _vehicle_entry(root, bucket, folder)
            if entry:
                vehicles.append(entry)
    vehicles.sort(key=lambda e: -e["modified"])

    summary = None
    summary_path = root / layout["rootFiles"]["runSummary"]
    if summary_path.is_file():
        try:
            summary = json.loads(summary_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            summary = None

    return {"root": str(root), "buckets": layout["buckets"], "vehicles": vehicles, "summary": summary}


def status(root: Path, recent_runs: int = 20) -> dict:
    """What the sync and batch runs have recorded at the library root.

    run-summary.json is the last run; runs.jsonl is the append-only
    history (cli.py writes both). The manifest counts what has ever been
    fetched; delisted vehicles are the ones whose details.json carries
    delisted_at, which is how inventory_sync marks them.
    """
    layout = _layout()
    files = layout["rootFiles"]

    def read_json(name):
        p = root / name
        if not p.is_file():
            return None
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    runs: list[dict] = []
    log = root / files["runs"]
    if log.is_file():
        try:
            lines = log.read_text(encoding="utf-8").splitlines()
        except OSError:
            lines = []
        for line in lines[-recent_runs:]:
            try:
                runs.append(json.loads(line))
            except ValueError:
                continue
        runs.reverse()

    manifest = read_json(files["manifest"]) or {}
    fetched = sum(1 for k in manifest if str(k).startswith("vin:"))

    delisted = 0
    for bucket in layout["buckets"]:
        bucket_dir = root / bucket
        if not bucket_dir.is_dir():
            continue
        for folder in bucket_dir.iterdir():
            d = read_json(f"{bucket}/{folder.name}/{layout['details']}") if folder.is_dir() else None
            if d and (d.get("vehicle", d)).get("delisted_at"):
                delisted += 1

    return {
        "root": str(root),
        "lastRun": read_json(files["runSummary"]),
        "runs": runs,
        "fetched": fetched,
        "delisted": delisted,
    }


def resolve_file(root: Path, bucket: str, folder: str, rel: str) -> Path:
    """A file inside one vehicle folder, or ValueError.

    The three path pieces come from the URL. Resolving and then checking
    the result is still under the vehicle folder is what stops
    ../../.ssh/id_rsa from being a valid library file.
    """
    if bucket not in _layout()["buckets"]:
        raise ValueError("unknown bucket")
    base = (root / bucket / folder).resolve()
    if base.parent != (root / bucket).resolve():
        raise ValueError("bad folder")
    target = (base / rel).resolve()
    if base != target and base not in target.parents:
        raise ValueError("path escapes the vehicle folder")
    if not target.is_file():
        raise FileNotFoundError(rel)
    return target
