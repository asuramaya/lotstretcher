#!/usr/bin/env python3
"""
Rebuild the composed images (bundle/hero.png + bundle/framed/*.png) for
vehicles already on disk, WITHOUT re-scraping or re-cutting anything.

    recompose_cli.py ~/Documents/listings                 # every vehicle
    recompose_cli.py ~/Documents/listings/2023-Ford-...   # just one

Composition depends on assets that change independently of the vehicle
data -- swap the border, retune a layout, and every bundle on disk is
suddenly stale while the expensive parts (scrape, cutouts, wheel
segmentation, upscaling) are still perfectly good. lotstretcher.py can only
recompose by re-running the whole pipeline against the live site, which
re-downloads photos and re-runs the models for a change that touches
neither. This runs the exact same compose_vehicle()/compose_wheel_shots()
the pipeline calls, against the cutouts already sitting in the folder.

A vehicle folder is anything containing images/exterior/cutout/; anything
else under the given root is skipped, so pointing this at the listings
root is safe.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from lotstretcher.imaging import assets
# The rebuild itself lives in library_ops so the server's
# POST /library/.../recompose runs the identical path.
from lotstretcher.library_ops import (find_vehicle_folders, recompose_folder,  # noqa: F401
                                      resolve_recompose_options, vehicle_colors, vehicle_record)


def resolve_asset_arg(category: str, value: str | None, default_name: str | None = None) -> Path:
    try:
        return assets.resolve_arg(category, value, default_name=default_name)
    except ValueError as e:
        sys.exit(str(e))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("root", help="A listings root, or a single vehicle folder")
    parser.add_argument("--background", help="Background name or tag (default: American Flag)")
    parser.add_argument("--border", help="Border name or tag (default: first in the manifest)")
    parser.add_argument("--no-glow", action="store_true")
    parser.add_argument("--glow-color", default="white", choices=["white", "blue", "gold", "red"])
    parser.add_argument("--glow-radius", type=int, default=24)
    parser.add_argument("--glow-intensity", type=float, default=0.75)
    parser.add_argument("--photo-background", action="store_true",
                         help="Use the shared background photo asset instead of the default per-image gradient. "
                              "A single shared backdrop across every post is what got flagged, so this is "
                              "opt-in now.")
    parser.add_argument("--frame", action="store_true",
                         help="Composite the dealer frame back on (frameless is the default).")
    parser.add_argument("--frame-fit", default="fit", choices=["fit", "fill", "stretch"],
                         help="How the frame meets a format of another shape: fit (whole frame, centred), "
                              "fill (edges cropped) or stretch. The format decides the canvas.")
    parser.add_argument("--hero-format", action="append", metavar="FORMAT",
                         help="Shape(s) for the hero still; repeatable, or 'all'. square 1254x1254 "
                              "(Marketplace), portrait 1080x1350 (4:5 Instagram/Facebook feed), "
                              "vertical 1080x1920 (Stories). Default: square. framed/ is always "
                              "square.")
    parser.add_argument("--interiors", action="store_true",
                         help="Also rebuild bundle/interior/ (white balance + exposure correction). "
                              "Off by default here so the tool stays a pure recompose.")
    parser.add_argument("--interior-captions", action="store_true",
                         help="With --interiors, also print confirmed feature names onto the photos. "
                              "Loads a CLIP model; off by default. See imaging/interior.py.")
    parser.add_argument("--prune-foreign", action="store_true",
                         help="Before recomposing, drop any cutout the rest of the vehicle's gallery "
                              "doesn't vouch for and move its photo to images/interior/. Applies the "
                              "same check lotstretcher.py now runs during a scrape to folders captured before "
                              "it existed. See imaging/gallery.py.")
    parser.add_argument("--resweep", action="store_true",
                         help="Before recomposing, re-run current classification against every photo "
                              "in images/interior/ and promote any the CURRENT pipeline now calls "
                              "exterior (self-heals photos misfiled under an older classifier/threshold "
                              "-- see imaging/gallery.py::resweep_interior_gallery). Conservative: only "
                              "promotes a photo that also produces a valid cutout AND survives the "
                              "gallery-consensus check (--prune-foreign's own check, run in reverse). "
                              "Pass --interiors too so bundle/interior/ picks up the removal, and "
                              "regenerate hero videos afterward for any vehicle this changes.")
    parser.add_argument("--calibrate", action="store_true",
                         help="Re-derive the cutout-consensus threshold from the galleries on disk and "
                              "write <root>/cutout-calibration.json, which --prune-foreign and lotstretcher.py "
                              "then use instead of the built-in default. Worth re-running after the "
                              "photo vendor changes. See imaging/gallery.py::calibrate.")
    parser.add_argument("--dry-run", action="store_true", help="List what would be rebuilt and exit")
    args = parser.parse_args()

    root = Path(args.root).expanduser()
    if not root.is_dir():
        sys.exit(f"Not a directory: {root}")

    folders = find_vehicle_folders(root)
    if not folders:
        sys.exit(f"No vehicle folders (with images/exterior/cutout/) found under {root}")

    gradient = not args.photo_background
    background_path = None if gradient else resolve_asset_arg(
        "backgrounds", args.background, default_name="American Flag")
    border_path = resolve_asset_arg("borders", args.border) if args.frame else None
    print(f"background: {'per-image vehicle-color gradient' if gradient else background_path.name}")
    print(f"border: {'none (frameless)' if border_path is None else border_path.name}")
    print(f"{len(folders)} vehicle(s)\n")

    if args.calibrate:
        from lotstretcher.imaging.classify import default_backbone
        from lotstretcher.imaging.gallery import CERTAIN_SIMILARITY, calibrate

        record = calibrate(root, backbone=default_backbone())
        if record is None:
            print(f"Not enough galleries under {root} to calibrate; "
                  f"keeping the built-in default ({CERTAIN_SIMILARITY}).\n")
        else:
            print(f"Calibrated on {record['n_galleries']} galleries "
                  f"({record['n_genuine']} genuine vs {record['n_impostor']} cross-vehicle pairs):")
            print(f"  certain-similarity floor: {record['certain_similarity']} "
                  f"(built-in default {CERTAIN_SIMILARITY})")
            print(f"  bootstrap mean {record['bootstrap_mean']} sd {record['bootstrap_sd']}, "
                  f"worst genuine {record['worst_genuine_similarity']}, "
                  f"margin {record['margin_to_worst_genuine']}\n")

    if args.prune_foreign:
        from lotstretcher.imaging.classify import default_backbone
        from lotstretcher.imaging.gallery import demote_foreign_cutouts

        backbone = default_backbone()
        pruned = 0
        for folder in folders:
            for f in demote_foreign_cutouts(folder, backbone=backbone, dry_run=args.dry_run):
                pruned += 1
                verb = "would demote" if args.dry_run else "demoted"
                print(f"  {verb} {folder.name}/{f.describe()}")
        print(f"{'Would demote' if args.dry_run else 'Demoted'} {pruned} cutout(s) to interior.\n")

    resweep_changed: list[Path] = []
    if args.resweep:
        from lotstretcher.imaging.classify import (AngleClassifier, InteriorExteriorTiebreakClassifier,
                                            SceneClassifier, WheelDetailClassifier, default_backbone)
        from lotstretcher.imaging.gallery import resweep_interior_gallery

        backbone = default_backbone()
        scene_classifier = SceneClassifier(backbone=backbone)
        tiebreak_classifier = InteriorExteriorTiebreakClassifier(backbone=backbone)
        angle_classifier = AngleClassifier(backbone=backbone)
        wheel_classifier = WheelDetailClassifier(backbone=backbone)

        promoted = other = 0
        for folder in folders:
            found = resweep_interior_gallery(
                folder, scene_classifier, tiebreak_classifier, angle_classifier, wheel_classifier,
                backbone=backbone, dry_run=args.dry_run)
            if found:
                changed = any(r.outcome == "promoted" for r in found)
                if changed and not args.dry_run:
                    resweep_changed.append(folder)
                for r in found:
                    verb_note = "would promote" if (r.outcome == "promoted" and args.dry_run) else None
                    promoted += 1 if r.outcome == "promoted" else 0
                    other += 1 if r.outcome != "promoted" else 0
                    print(f"  {verb_note or r.outcome}: {folder.name}/{r.describe()}")
        print(f"{'Would promote' if args.dry_run else 'Promoted'} {promoted} photo(s) from interior to "
              f"exterior ({other} other candidate(s) inspected and correctly left in place).\n")

    if args.dry_run:
        for f in folders:
            print(f"  would rebuild {f.name}")
        return

    from lotstretcher.imaging.compose.pipeline import DEFAULT_HERO_STILL_FORMAT, HERO_STILL_FORMATS
    if not args.hero_format:
        hero_formats = (DEFAULT_HERO_STILL_FORMAT,)
    elif "all" in args.hero_format:
        hero_formats = tuple(HERO_STILL_FORMATS)
    else:
        bad = [f for f in args.hero_format if f not in HERO_STILL_FORMATS]
        if bad:
            sys.exit(f"Unknown --hero-format {bad[0]!r}; choose from "
                     f"{', '.join(HERO_STILL_FORMATS)} or 'all'")
        hero_formats = tuple(dict.fromkeys(args.hero_format))

    resolved = {
        "background_path": background_path,
        "border_path": border_path,
        "hero_formats": hero_formats,
        "style": dict(glow=not args.no_glow, glow_color=args.glow_color,
                      glow_radius=args.glow_radius, glow_intensity=args.glow_intensity,
                      gradient=gradient, border_fit=args.frame_fit),
        "interiors": args.interiors,
        "interior_captions": args.interior_captions,
    }
    interior_classifier = None
    if args.interiors and args.interior_captions:
        from lotstretcher.imaging.interior import InteriorSubjectClassifier
        interior_classifier = InteriorSubjectClassifier()

    total_hero = total_framed = total_interior = 0
    for folder in folders:
        r = recompose_folder(folder, resolved, interior_classifier)
        total_hero += 1 if r["hero"] else 0
        total_framed += r["framed"]
        total_interior += r["interior"]
        hero_note = (f"hero x{len(r['heroes'])}" if len(r["heroes"]) > 1
                      else "hero" if r["hero"] else "no hero (no usable cutouts)")
        wheel_note = f" (+{r['wheels']} wheel)" if r["wheels"] else ""
        interior_note = ""
        if args.interiors:
            cap_note = f" ({r['interior_captioned']} captioned)" if args.interior_captions else ""
            interior_note = f", {r['interior']} interior{cap_note}"
        print(f"  {folder.parent.name}/{folder.name}: {hero_note}, {r['framed']} framed{wheel_note}{interior_note}")

    interior_total = f" and {total_interior} interior image(s)" if args.interiors else ""
    print(f"\nRebuilt {total_hero} hero image(s), {total_framed} framed image(s){interior_total}.")

    if resweep_changed:
        print(f"\n{len(resweep_changed)} vehicle(s) gained a reclaimed angle -- their hero videos are "
              "now stale (this tool never touches video, see hero_video_cli.py). Regenerate with:")
        for folder in resweep_changed:
            print(f"  hero-video {folder} --format all")


if __name__ == "__main__":
    main()
