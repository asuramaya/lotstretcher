#!/usr/bin/env python3
"""Export the studio library: the stock backgrounds and frames the site
ships, so "Stock" in the app composes on the visitor's own machine on
lotstretcher.org, with no server behind it.

    python3 web/build-studio.py [--hosted-base https://cdn.example.com/studio]

An entry carrying `"hosted": true` is not copied into web/public/studio/;
its manifest entry names an absolute `url` under --hosted-base instead,
where the file lives on a CDN (an R2 bucket with a public domain and a
CORS policy allowing GET from the site). The file is exported next to
the others under web/public/studio-hosted/ so `wrangler r2 object put`
(printed at the end) can upload exactly what the manifest names.

Source of truth is assets/manifest.json, the CLI's own library. An entry
carrying `"studio": true` is exported; the rest (a dealer's private
frames, say) stay on the server and remain server-only choices in the
app. Backgrounds are re-encoded as WebP at most 2048 px on the long
side, which turns a 7 MB print-size JPEG into a few hundred KB; frames
keep their alpha (lossless WebP) at the same cap. The output under
web/public/studio/ is committed, like the wasm core, so a deploy is a
copy of the tree.

The names are the manifest's names: `--background "American Flag"` on
the command line and the "American Flag" tile in the app are the same
file, found by the same string.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image

REPO = Path(__file__).resolve().parents[1]
MANIFEST = REPO / "assets" / "manifest.json"
OUT = REPO / "web" / "public" / "studio"
HOSTED_OUT = REPO / "web" / "public" / "studio-hosted"   # gitignored: what to upload
MAX_SIDE = 2048
KINDS = {"backgrounds": ("RGB", "webp", {"quality": 82, "method": 6}),
         "borders": ("RGBA", "webp", {"lossless": True, "method": 6})}


def export(kind: str, entry: dict, hosted_base: str | None = None) -> dict:
    mode, ext, save_kw = KINDS[kind]
    src = REPO / "assets" / entry["file"]
    img = Image.open(src).convert(mode)
    k = min(1.0, MAX_SIDE / max(img.size))
    if k < 1.0:
        img = img.resize((round(img.width * k), round(img.height * k)), Image.LANCZOS)
    stem = Path(entry["file"]).stem
    hosted = bool(entry.get("hosted")) and hosted_base
    root = HOSTED_OUT if hosted else OUT
    dst = root / kind / f"{stem}.{ext}"
    dst.parent.mkdir(parents=True, exist_ok=True)
    img.save(dst, **save_kw)
    out = {
        "name": entry["name"],
        "file": f"{kind}/{dst.name}",
        "tags": entry.get("tags", []),
        "width": img.width,
        "height": img.height,
        "bytes": dst.stat().st_size,
    }
    if entry.get("category"):
        out["category"] = entry["category"]
    if hosted:
        out["url"] = f"{hosted_base.rstrip('/')}/{kind}/{dst.name}"
    return out


def export_font(entry: dict) -> dict:
    """A font ships as is (a TTF is already compact) with its licence."""
    src = REPO / "assets" / entry["file"]
    dst = OUT / "fonts" / src.name
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(src.read_bytes())
    out = {"name": entry["name"], "file": f"fonts/{src.name}", "bytes": dst.stat().st_size}
    if entry.get("license"):
        lic = REPO / "assets" / entry["license"]
        (OUT / "fonts" / lic.name).write_bytes(lic.read_bytes())
        out["license"] = f"fonts/{lic.name}"
    return out


def main() -> None:
    hosted_base = None
    if "--hosted-base" in sys.argv:
        hosted_base = sys.argv[sys.argv.index("--hosted-base") + 1]
    manifest = json.loads(MANIFEST.read_text())
    out = {kind: [] for kind in KINDS}
    for kind in KINDS:
        for entry in manifest.get(kind, []):
            if entry.get("studio"):
                out[kind].append(export(kind, entry, hosted_base))
    out["fonts"] = [export_font(e) for e in manifest.get("fonts", []) if e.get("studio")]
    # Stale files from an entry that lost its studio tag are removed, so
    # the tree never ships an asset the manifest no longer offers.
    keep = {OUT / e["file"] for k in out for e in out[k]} | {OUT / e["license"] for e in out["fonts"] if e.get("license")}
    for p in OUT.rglob("*"):
        if p.is_file() and p.name != "manifest.json" and p not in keep:
            p.unlink()
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "manifest.json").write_text(json.dumps(out, indent=2) + "\n")
    total = sum(e["bytes"] for k in out for e in out[k])
    for kind in out:
        for e in out[kind]:
            size = f"{e['width']}x{e['height']}, " if "width" in e else ""
            print(f"{kind}/{Path(e['file']).name}: {size}{e['bytes'] / 1024:.0f} KB")
    print(f"studio library: {total / 1024:.0f} KB -> {OUT.relative_to(REPO)}")
    hosted = [e for k in out for e in out[k] if e.get("url")]
    if hosted:
        bucket = "<bucket>"
        print(f"{len(hosted)} hosted file(s) under {HOSTED_OUT.relative_to(REPO)}; upload with:")
        for e in hosted:
            print(f"  wrangler r2 object put {bucket}/{e['file']} --file {HOSTED_OUT.relative_to(REPO)}/{e['file']}")


if __name__ == "__main__":
    main()
