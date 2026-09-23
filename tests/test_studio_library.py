"""The studio library the site ships is the CLI's own asset manifest,
exported: every entry tagged `studio` is present under web/public/studio
with its file, nothing untagged leaks (a dealer's private frames stay on
the server), and the whole library stays small enough for free hosting.

If this fails after editing assets/manifest.json, run

    python3 web/build-studio.py

and commit its output.
"""
from __future__ import annotations

import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SOURCE = json.loads((REPO / "assets" / "manifest.json").read_text())
STUDIO_DIR = REPO / "web" / "public" / "studio"
STUDIO = json.loads((STUDIO_DIR / "manifest.json").read_text())
SPEC = json.loads((REPO / "shared" / "pipeline-spec.json").read_text())
KINDS = ("backgrounds", "borders")


def test_every_studio_tagged_asset_is_exported_and_nothing_else():
    for kind in KINDS:
        tagged = {e["name"] for e in SOURCE.get(kind, []) if e.get("studio")}
        exported = {e["name"] for e in STUDIO.get(kind, [])}
        assert exported == tagged, f"{kind}: exported {exported} but the manifest tags {tagged}"


def test_exported_files_exist_and_are_small():
    total = 0
    for kind in KINDS:
        for e in STUDIO.get(kind, []):
            f = STUDIO_DIR / e["file"]
            assert f.is_file(), f"{e['name']}: {e['file']} is missing; run web/build-studio.py"
            assert f.stat().st_size == e["bytes"]
            assert max(e["width"], e["height"]) <= 2048
            total += e["bytes"]
    assert total < 4 * 1024 * 1024, f"the studio library is {total / 1024 / 1024:.1f} MB; hosting must stay free"


def test_no_stray_files_ship():
    listed = {STUDIO_DIR / e["file"] for k in KINDS for e in STUDIO.get(k, [])}
    for p in STUDIO_DIR.rglob("*"):
        if p.is_file() and p.name != "manifest.json":
            assert p in listed, f"{p.relative_to(STUDIO_DIR)} is not in the studio manifest"


def test_stock_choices_are_offered_in_the_browser():
    """The Stock tiles compose on the visitor's machine now, so they must
    not be gated on a server capability or excluded from the browser."""
    controls = [c for g in SPEC["controls"]["groups"] for c in g["controls"]]
    for c in controls:
        for ch in c.get("choices", []):
            if ch.get("expand") in KINDS:
                assert "requires" not in ch, f"{c['key']}={ch['value']} is still gated on {ch['requires']}"
        if c.get("dynamic") in KINDS:
            assert "browser" in c.get("surfaces", ["browser"]), f"{c['key']} is not offered in the browser"
            assert "requires" not in c
