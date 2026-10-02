#!/usr/bin/env python3
"""
Turn a scraped vehicle's cutouts into an animated hero video: a looping
flag-video background plus a 3-slot conveyor (left accent / hero / right
accent) that cycles through the vehicle's WHOLE shot library, timed to N
loops of an audio track.

    hero_video_cli.py ~/Documents/listings/2023-Ford-F-150-Raptor-PFA15687

The moving backdrop (--video-backdrop) and the music (--video-music) come
from assets/manifest.json, same as backgrounds and borders -- name another
with --video-clip / --video-track by manifest name, tag, or a one-off path.
Every --video-* flag is the lotstretcher command's own.

See compose_cli.py for the equivalent still-image tool this mirrors.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from lotstretcher import core
from lotstretcher.imaging import assets
from lotstretcher.imaging.compose import render_hero_video
from lotstretcher.imaging.compose.hero_video import (BARS_PER_LOOP, DEFAULT_BPM, DEFAULT_VIDEO_FORMAT,
                                          VIDEO_FORMATS)
from lotstretcher.imaging.select import order_for_conveyor_start, pick_all_for_carousel
from lotstretcher.imaging.text import (add_glow_args, add_video_args, add_backdrop_arg, add_frame_style_args, add_reflection_args, add_shadow_args, add_spotlight_args, add_text_args,
                                       controls_from_frame_style_args, controls_from_reflection_args,
                                       controls_from_shadow_args, controls_from_text_args, frame_style,
                                       reflection_style, shadow_style, spotlight_style, controls_from_spotlight_args, text_options)
from lotstretcher.library_ops import vehicle_record
from lotstretcher.looks import add_look_arg, apply_look


def resolve_asset_arg(category: str, value: str | None, default_name: str | None = None) -> Path:
    """Manifest lookup, with a plain filesystem path accepted as an escape
    hatch so a one-off clip can be tried without registering it first."""
    if value and Path(value).exists():
        return Path(value)
    try:
        return assets.resolve_arg(category, value, default_name=default_name)
    except ValueError as e:
        sys.exit(str(e))


def resolve_audio(value: str | None) -> tuple[Path, int]:
    """(path, bars_per_loop). An unregistered path can't carry its bar
    count, so it falls back to the 4-bar assumption the module documents
    -- registering it in the manifest is how you say otherwise."""
    if value and Path(value).exists():
        return Path(value), BARS_PER_LOOP
    try:
        entry = assets.entry_for("audio", value, default_name="Its Mine")
    except ValueError as e:
        sys.exit(str(e))
    return assets.resolve(entry), int(entry.get("bars", BARS_PER_LOOP))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("vehicle_folder", help="A folder the lotstretcher command produced (contains images/exterior/cutout/)")
    parser.add_argument("--border", help="Border name or tag (default: first available)")
    add_video_args(parser)
    add_glow_args(parser)
    parser.add_argument("--frame", action="store_true",
                         help="Composite the dealer frame back on (frameless is the default).")
    parser.add_argument("--frame-fit", default="slice", choices=["fit", "fill", "stretch", "slice"],
                         help="How the frame meets a format of another shape: slice (default; corners kept, edges stretched), fit, fill or stretch.")
    parser.add_argument("--photo-background", action="store_true",
                         help="A still photo from the asset library behind the clip (the stills' backdrop), "
                              "instead of the rotating gradient. --video-backdrop wins when both are given.")
    parser.add_argument("--background", help="Background name or tag for --photo-background (default: the library's).")
    add_text_args(parser)
    add_frame_style_args(parser)
    add_shadow_args(parser)
    add_spotlight_args(parser)
    add_reflection_args(parser)
    add_backdrop_arg(parser)
    add_look_arg(parser)
    parser.add_argument("--out", help="Output path (default: <vehicle_folder>/bundle/hero-video.mp4)")
    args = parser.parse_args()
    apply_look(args, parser)

    vehicle_folder = Path(args.vehicle_folder)
    cutout_dir = vehicle_folder / "images" / "exterior" / "cutout"
    wheel_dir = vehicle_folder / "images" / "exterior" / "wheels"
    if not cutout_dir.is_dir():
        sys.exit(f"No cutouts found at {cutout_dir} -- did you run lotstretcher on this vehicle yet?")

    border_path = resolve_asset_arg("borders", args.border) if args.frame else None
    background_video = resolve_asset_arg(
        "videos", args.video_clip, default_name="American Flag Waving") if (args.video_backdrop or args.video_clip) else None

    background_image = (resolve_asset_arg("backgrounds", args.background, default_name="American Flag")
                        if args.photo_background and background_video is None else None)
    def gradient_for(fmt):
        """(base_angle, start, end) and the held backdrop for one shape, seeded
        as the pipeline and the browser seed a clip (compose.seeds.clip). The
        renderer spins base_angle over the run, so only the start is decided."""
        if background_video is not None:
            return None, None
        from lotstretcher.imaging.palette import colors_from_details
        from lotstretcher.imaging.text import backdrop_spec, gradient_stops, piece_seed
        from lotstretcher.manifest import vehicle_record
        ext, inr = colors_from_details(vehicle_folder)
        sample = next(iter(sorted(cutout_dir.glob("*.png"))), None)
        start, end = gradient_stops(args.backdrop, ext, inr, args.backdrop_color, args.backdrop_color2, sample)
        seed = piece_seed("clip", vehicle_record(vehicle_folder), vehicle_folder.name, fmt=fmt)
        held = (backdrop_spec(args.backdrop, f"{seed}:{args.backdrop}", ext, inr, args.backdrop_color,
                              args.backdrop_color2, args.backdrop_angle)
                if args.backdrop != "vehicle" and background_image is None else None)
        return (core.call({"op": "seeded_angle", "seed": seed}), start, end), held

    if args.video_music or args.video_track:
        audio_path, bars_per_loop = resolve_audio(args.video_track)
    else:
        audio_path, bars_per_loop = None, BARS_PER_LOOP

    carousel = pick_all_for_carousel(cutout_dir, wheel_dir=wheel_dir)
    if not carousel:
        sys.exit(f"No usable cutouts to animate in {cutout_dir}")
    carousel = order_for_conveyor_start(carousel, cutout_dir)
    carousel_paths = [p for p, _label in carousel]
    carousel_labels = [label for _p, label in carousel]

    # One shape unless more are asked for; 'all' is every one.
    asked = args.video_format or [DEFAULT_VIDEO_FORMAT]
    formats = list(VIDEO_FORMATS) if "all" in asked else list(dict.fromkeys(asked))
    unknown = [f for f in formats if f not in VIDEO_FORMATS]
    if unknown:
        parser.error(f"unknown --video-format {unknown[0]!r}; choose from {', '.join(VIDEO_FORMATS)} or 'all'")
    for fmt in formats:
        gradient_colors, args.backdrop_spec = gradient_for(fmt)
        render_one(fmt, args, vehicle_folder, border_path, background_video, gradient_colors,
                    audio_path, bars_per_loop, carousel_paths, carousel_labels, background_image)


def render_one(fmt, args, vehicle_folder, border_path, background_video, gradient_colors,
                audio_path, bars_per_loop, carousel_paths, carousel_labels, background_image=None):
    from lotstretcher.vehicle_pipeline import video_output_path

    spec = VIDEO_FORMATS[fmt]
    out_path = Path(args.out) if args.out else video_output_path(vehicle_folder, fmt)

    report = render_hero_video(
        background_video=background_video,
        border_path=border_path,
        carousel_paths=carousel_paths,
        carousel_labels=carousel_labels,
        audio_path=audio_path,
        bars_per_loop=bars_per_loop,
        gradient_colors=gradient_colors,
        bpm=args.video_bpm or DEFAULT_BPM,
        **({"fps": args.video_fps} if args.video_fps else {}),
        out_path=out_path,
        canvas_size=spec["canvas"],
        budget_mb=args.video_budget_mb if args.video_budget_mb is not None else spec["budget_mb"],
        bitrate_kbps=round(args.video_bitrate * 1000) if args.video_bitrate else None,
        glow=args.glow,
        glow_color=args.glow_color,
        glow_radius=args.glow_radius,
        glow_intensity=args.glow_intensity,
        spotlight=spotlight_style(controls_from_spotlight_args(args)),
        border_fit=args.frame_fit,
        text=text_options(controls_from_text_args(args)),
        vehicle=vehicle_record(vehicle_folder),
        background_image=background_image,
        border_style=frame_style(controls_from_frame_style_args(args)),
        shadow=shadow_style(controls_from_shadow_args(args)),
        reflection=reflection_style(controls_from_reflection_args(args)),
        backdrop_spec=getattr(args, "backdrop_spec", None),
        encoder="h264_nvenc" if args.nvenc else "libx264",
        push=args.video_push,
        crossfade=args.video_crossfade,
    )

    print(f"Saved [{fmt} {spec['canvas'][0]}x{spec['canvas'][1]}]: "
          f"{report['out_path']} ({report['file_size_mb']} MB)")
    print(f"  duration: {report['duration_s']}s @ {report['fps']}fps ({report['total_frames']} frames)")
    if report.get("mode") == "push":
        print(f"  push: {report['n_shots']} shot(s) over {report['carousel_period_s']}s/pass, "
              f"push {report['push']:g}, crossfade {report['crossfade_s']:g}s")
    else:
        print(f"  conveyor: {report['n_shots']} shots over {report['carousel_period_s']}s/pass, "
              f"bar={report['bar_dwell_s']}s (audio loop {report['audio_loop_s']}s / {report['bars_per_loop']} bars), "
              f"beat={report['beat_s']}s, transition={report['transition_s']}s")
    print(f"  backdrop: {report['backdrop']}, frame: {'yes' if report['framed'] else 'none'}, "
          f"clock: {report['clock']}")
    print(f"  shot order: {', '.join(report['shot_order'])}")
    for name, how in report["pan_shots"].items():
        print(f"  pan: {name} -- {how}")
    audio_note = f" + {128}kbps audio" if report["clock"] == "audio" else " (silent)"
    print(f"  bitrate: {report['bitrate_kbps']}kbps video{audio_note}")


if __name__ == "__main__":
    main()
