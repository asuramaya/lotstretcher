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

from lotstretcher import spec as _spec
from lotstretcher.manifest import vehicle_colors as _vehicle_colors, vehicle_record  # noqa: F401 (re-exported)
from lotstretcher.imaging import assets
from lotstretcher.imaging.compose import compose_interiors, compose_vehicle, compose_wheel_shots
from lotstretcher.imaging.text import (BACKDROPS, backdrop_angle, backdrop_color, backdrop_color2, frame_style, reflection_style,
                                       shadow_style, spotlight_style, text_options)


def generated_backdrop(options: dict) -> str:
    """The generated backdrop's kind from the app's backdrop select:
    vehicle unless generic or sweep was picked (a photo is `gradient`)."""
    kind = options.get("backdrop")
    return kind if kind in BACKDROPS else "vehicle"


def _num(options: dict, key: str, cast=float):
    """A number lever's value, or its control's default when unset; 0 is a value."""
    v = options.get(key)
    return cast(v if v not in (None, "") else _spec.control_default(key))


def look_kwargs(options: dict) -> dict:
    """The glow, margin and frame fit the app's controls ask for, as the
    compositor's keyword arguments, with the Studio's defaults: one mapping
    for the server's still, recompose and a re-scrape."""
    return {
        "glow": bool(options.get("glow", _spec.control_default("glow"))),
        "glow_color": options.get("glowColor") or _spec.control_default("glowColor"),
        "glow_radius": _num(options, "glowRadius", int),
        "glow_intensity": _num(options, "glowIntensity"),
        "margin_frac": _num(options, "margin"),
        "border_fit": options.get("frameFit") or _spec.control_default("frameFit"),
    }


def find_vehicle_folders(root: Path) -> list[Path]:
    """Every vehicle folder at or under `root`, at any depth -- listings
    are bucketed into new/ and used/, so a fixed one-level scan would
    silently find nothing when pointed at the root."""
    if (root / "images" / "exterior" / "cutout").is_dir():
        return [root]
    return sorted(p.parent.parent.parent for p in root.glob("*/**/images/exterior/cutout")
                  if p.is_dir())


def vehicle_colors(folder: Path) -> dict:
    """{exterior_color, interior_color} from details.json (manifest.vehicle_colors)."""
    exterior, interior = _vehicle_colors(folder)
    return {"exterior_color": exterior, "interior_color": interior}


def stock_border(options: dict) -> str | None:
    """The named stock border the app's Frame picker chose, or None: its
    "none" and "custom" values are the app's own (no frame; the user's
    own PNG, which never reaches a server), not library names."""
    name = options.get("border")
    if name in (None, "", "none", "custom", "line"):
        return None
    return str(name)


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
    if options.get("frame") or stock_border(options):
        border_path = assets.resolve_arg("borders", stock_border(options))

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
            **{k: v for k, v in look_kwargs(options).items() if k != "margin_frac"},
            "gradient": not wants_photo,
            "text": text_options(options),
            "border_style": frame_style(options),
            "shadow": shadow_style(options),
            "reflection": reflection_style(options),
            "backdrop": generated_backdrop(options),
            "backdrop_color": backdrop_color(options),
            "backdrop_color2": backdrop_color2(options),
            "backdrop_angle": backdrop_angle(options),
        },
        "interiors": bool(options.get("interiors", False)),
        "interior_captions": bool(options.get("interiorCaptions", False)),
    }


def hero_options_from_controls(options: dict, interior_classifier=None):
    """App control values -> HeroOptions, the pipeline's composition knobs.

    ONE builder for both surfaces: cli.py converts its argparse flags to
    this same dict (controls_from_args) and calls this, and the server's
    re-scrape route passes the app's options straight in. Defaults here
    are the CLI's defaults; the app's spec defaults are what the app
    sends, so a control changed in the Options pane reaches the pipeline
    the same way the flag would.

    Raises ValueError for an asset or format that does not exist, before
    any work starts.
    """
    from lotstretcher.imaging.compose.hero_video import VIDEO_FORMATS
    from lotstretcher.imaging.compose.pipeline import HERO_STILL_FORMATS
    from lotstretcher.vehicle_pipeline import HeroOptions

    def formats(value, allowed, default, flag):
        if value is None:
            return tuple(default)
        if "all" in value:
            return tuple(allowed)
        bad = [f for f in value if f not in allowed]
        if bad:
            raise ValueError(f"unknown {flag} {bad[0]!r}; choose from {', '.join(allowed)} or 'all'")
        return tuple(dict.fromkeys(value))

    video_formats = options.get("videoFormats")
    video_on = video_formats is None or len(video_formats) > 0
    wants_photo = options.get("backdrop") == "asset" or bool(options.get("photoBackground")) \
        or bool(options.get("background"))
    frame = bool(options.get("frame")) or stock_border(options) is not None

    opts = HeroOptions(
        enabled=bool(options.get("hero", True)),
        **look_kwargs(options),
        spotlight=spotlight_style(options),
        text=text_options(options),
        border_style=frame_style(options),
        shadow=shadow_style(options),
        reflection=reflection_style(options),
        backdrop=generated_backdrop(options),
        backdrop_color=backdrop_color(options),
        backdrop_color2=backdrop_color2(options),
        backdrop_angle=backdrop_angle(options),
        gradient=not wants_photo,
        video=video_on,
        video_encoder="h264_nvenc" if options.get("nvenc") else "libx264",
        video_formats=formats(video_formats if video_on else None, VIDEO_FORMATS, VIDEO_FORMATS, "--video-format"),
        hero_formats=formats(options.get("heroFormats"), HERO_STILL_FORMATS, ("square", "portrait"), "--hero-format"),
        interiors=bool(options.get("interiors", True)),
        interior_captions=bool(options.get("interiorCaptions", False)),
        interior_classifier=interior_classifier,
        vision_seat_check=bool(options.get("visionSeatCheck", False)),
        video_fps=float(options["videoFps"]) if options.get("videoFps") else None,
        video_bpm=float(options["videoBpm"]) if options.get("videoBpm") else None,
        video_budget_mb=float(options["videoBudgetMb"]) if options.get("videoBudgetMb") else None,
        video_bitrate_mbps=float(options["videoBitrate"]) if options.get("videoBitrate") else None,
        video_push=float(options["videoPush"]) if options.get("videoPush") not in (None, "") else None,
        video_crossfade=float(options["videoCrossfade"]) if options.get("videoCrossfade") not in (None, "") else None,
    )
    if opts.enabled:
        if wants_photo:
            opts.background_path = assets.resolve_arg("backgrounds", options.get("background") or None,
                                                      default_name="American Flag")
        if frame:
            opts.border_path = assets.resolve_arg("borders", stock_border(options))
        # The moving backdrop and the music: the library's own unless a clip
        # or a track is named (videoFlagBackground is the backdrop's old key).
        clip, track = options.get("videoClip") or None, options.get("videoTrack") or None
        if options.get("videoBackdrop") or options.get("videoFlagBackground") or clip:
            opts.video_background = Path(clip) if clip and Path(clip).exists() else \
                assets.resolve_arg("videos", clip, default_name="American Flag Waving")
        if options.get("videoMusic") or track:
            # A file of one's own cannot say its bar count: four, as the
            # renderer assumes; a library track carries its own.
            if track and Path(track).exists():
                opts.video_audio, opts.video_bars_per_loop = Path(track), 4
            else:
                entry = assets.entry_for("audio", track, default_name="Its Mine")
                opts.video_audio = assets.resolve(entry)
                opts.video_bars_per_loop = int(entry.get("bars", 4))
    return opts


class Models:
    """The classifier set process_vehicle() needs, built once and shared.

    They share one CLIP backbone (see imaging/classify.py), so building
    them is one model load. The server keeps one of these for its whole
    life; the CLI builds one per run. `photo_sort=False` is --no-photo-sort:
    no models at all.
    """

    def __init__(self, photo_sort: bool = True, interior_captions: bool = False,
                 vision_seat_check: bool = False, junk_filter: bool = True):
        from lotstretcher.imaging.dedupe import DEFAULT_TEMPLATES_DIR, JunkFilter
        self.junk_filter = JunkFilter(Path(DEFAULT_TEMPLATES_DIR)) if junk_filter else None
        self.classifier = self.angle = self.wheel = self.spare = self.tiebreak = None
        self.interior = None
        if photo_sort:
            from lotstretcher.imaging.classify import (AngleClassifier, InteriorExteriorTiebreakClassifier,
                                                       SceneClassifier, SpareTireClassifier,
                                                       WheelDetailClassifier)
            self.classifier = SceneClassifier()
            self.angle = AngleClassifier()
            self.wheel = WheelDetailClassifier()
            self.spare = SpareTireClassifier()
            self.tiebreak = InteriorExteriorTiebreakClassifier()
            if interior_captions or vision_seat_check:
                from lotstretcher.imaging.interior import InteriorSubjectClassifier
                self.interior = InteriorSubjectClassifier()


def rescrape(url: str, out_root: Path, options: dict, models: Models) -> dict:
    """Fetch one vehicle page and run the whole pipeline into the library,
    exactly as `lotstretcher <url> --force` would, then record the run in
    run-summary.json and runs.jsonl as the CLI does.

    Returns the same result row the CLI's batch summary holds.
    """
    import time

    import requests
    from playwright.sync_api import sync_playwright

    from lotstretcher.cli import _read_summary_fields, append_run_log, write_batch_summary
    from lotstretcher.scrape import USER_AGENT
    from lotstretcher.vehicle_pipeline import process_vehicle

    hero_opts = hero_options_from_controls(options, interior_classifier=models.interior)
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})
    run_at = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    try:
        with sync_playwright() as p:
            folder = process_vehicle(
                p, session, url, out_root, int(options.get("stickerDpi") or 200), False,
                models.junk_filter, models.classifier, bool(options.get("upscale")),
                options.get("upscaleModel") or "swinir", models.angle, hero_opts,
                models.wheel, models.spare, models.tiebreak,
                bool(options.get("strictCutouts", True)))
        row = {"url": url, "status": "success", "folder": folder.name, "_run_at": run_at,
               **_read_summary_fields(folder)}
    except Exception as e:
        row = {"url": url, "status": "failed", "error": str(e), "_run_at": run_at}
    write_batch_summary(out_root, [row])
    append_run_log(out_root, [row])
    if row["status"] == "failed":
        raise RuntimeError(row["error"])
    return {k: v for k, v in row.items() if not k.startswith("_")}


def mark_delisted(folder: Path, now: str | None = None) -> bool:
    """Stamp delisted_at into the folder's details.json, the way
    inventory_sync marks a vehicle the site no longer lists. Returns
    False when it was already stamped or the record is unreadable.
    Nothing is deleted: a delisted vehicle stays in the library and the
    pane can filter it."""
    from datetime import datetime, timezone
    details_path = Path(folder) / "details.json"
    try:
        data = json.loads(details_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    v = data.get("vehicle", data)
    if v.get("delisted_at"):
        return False
    v["delisted_at"] = now or datetime.now(timezone.utc).isoformat()
    details_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return True


def delete_vehicle(root: Path, bucket: str, folder_name: str) -> dict:
    """Remove a vehicle folder for good, and its manifest entry, so a
    later sync fetches it afresh rather than believing it is still on
    disk. The caller has already confirmed; this does not ask."""
    import shutil

    from lotstretcher.manifest import load_manifest, save_manifest

    root = Path(root)
    folder = (root / bucket / folder_name).resolve()
    if folder.parent != (root / bucket).resolve() or not folder.is_dir():
        raise FileNotFoundError(folder_name)
    key = f"{bucket}/{folder_name}"
    manifest = load_manifest(root)
    dropped = [k for k, e in manifest.items() if isinstance(e, dict) and e.get("folder") == key]
    for k in dropped:
        del manifest[k]
    if dropped:
        save_manifest(root, manifest)
    shutil.rmtree(folder)
    return {"folder": key, "manifest_entries_removed": len(dropped)}


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

    vehicle = vehicle_record(folder)
    result = compose_vehicle(images / "cutout", bundle, resolved["background_path"], resolved["border_path"],
                             hero_formats=resolved["hero_formats"], vehicle=vehicle, **style, **colors)
    wheels = compose_wheel_shots(images / "wheels", bundle, resolved["background_path"], resolved["border_path"],
                                 vehicle=vehicle, **style, **colors)
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
