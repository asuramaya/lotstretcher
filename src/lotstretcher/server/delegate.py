"""Composition delegated from the browser client to this server.

WHY: six controls (upscale, photo backdrop, frame, border, music, GPU
encode) are real capabilities of a self-hosted install that a browser
cannot do alone. Before this module the app rendered them disabled with
"Runs on your server. The app cannot hand off to it yet", which was true
and is the debt this closes.

THE SHAPE FELL OUT OF WORK ALREADY DONE. The app's control values
already serialise exactly as CLI flags (controls.js::controlsToFlags),
because every control in shared/pipeline-spec.json carries the flag it
maps to. So the request body is effectively that flag set, and this
module's job is to turn it back into the same keyword arguments the CLI
passes to compose_hero(). One definition of every control, three callers.

The browser sends CUTOUTS, not source photos. Matting already happened
on the device, which keeps the privacy property intact for the part that
matters: the original photograph never leaves unless the user asks for
something only this server can do, and then only the cut-out vehicle
does.
"""
from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any

from ..imaging.text import (backdrop_angle, backdrop_color, backdrop_color2, backdrop_spec, frame_style, reflection_style,
                            shadow_style, text_options, text_request)

MAX_CUTOUT_BYTES = 24 * 1024 * 1024
MAX_CANVAS = 4096


def list_assets() -> dict:
    """The asset library, for the app's background and border selects.

    These render "none available" on lotstretcher.org because a browser
    has no asset library. Against a server they become real choices.
    """
    from ..imaging import assets

    def entries(lister):
        try:
            return [{"value": e["name"], "label": e["name"], "tags": e.get("tags", [])}
                    for e in lister()]
        except Exception:
            # A missing or malformed manifest is not worth a 500: the
            # rest of the app works without an asset library.
            return []

    return {
        "backgrounds": entries(assets.list_backgrounds),
        "borders": entries(assets.list_borders),
        "videos": entries(assets.list_videos),
        "audio": entries(assets.list_audio),
    }


def _resolve_asset(category: str, name: str | None, warnings: list[str]):
    """Resolve an asset by name, RECORDING a warning when it is missing.

    Falling back is right -- an unknown name should not fail the whole
    request, matching what server/processing.py already does with an
    unknown scene_id. Falling back SILENTLY is not: the caller ticked
    "branded frame", picked a border, and would get an unframed image
    with nothing to explain why. The warning rides back on a response
    header so the app can say so.
    """
    if not name:
        return None
    from ..imaging import assets
    try:
        return assets.find_one(category, name)
    except (ValueError, KeyError, OSError):
        warnings.append(f"no {category} asset named {name!r}; used the generated backdrop instead"
                        if category == "backgrounds"
                        else f"no {category} asset named {name!r}; composed without it")
        return None


def _default_asset(category: str, default_name: str, warnings: list[str]):
    """The library's default for a category, or None with a warning when
    the library is empty. Mirrors assets.resolve_arg's fallback chain so
    the delegated run lands on the same file the CLI would."""
    from ..imaging import assets
    try:
        return assets.resolve_arg(category, None, default_name=default_name)
    except (ValueError, KeyError, OSError):
        warnings.append(f"no {category} in this host's asset library; used the generated backdrop instead")
        return None


def compose(cutout_png: bytes, options: dict[str, Any],
            out_dir: Path) -> tuple[bytes, list[str]]:
    """Compose one cutout with the server's assets and hardware.

    `options` is the app's control values, the same keys as
    shared/pipeline-spec.json's controls block.

    Returns (png_bytes, warnings). Warnings are things the caller asked
    for that could not be honoured, so they can be reported rather than
    silently dropped.
    """
    warnings: list[str] = []
    from PIL import Image

    from ..imaging.compose import compose_hero

    if len(cutout_png) > MAX_CUTOUT_BYTES:
        raise ValueError(f"cutout exceeds {MAX_CUTOUT_BYTES // (1024 * 1024)}MB")

    cutout = Image.open(io.BytesIO(cutout_png))
    if cutout.mode != "RGBA":
        cutout = cutout.convert("RGBA")

    width = int(options.get("width") or 1254)
    height = int(options.get("height") or 1254)
    if not (0 < width <= MAX_CANVAS and 0 < height <= MAX_CANVAS):
        raise ValueError(f"canvas must be within {MAX_CANVAS}x{MAX_CANVAS}")

    out_dir.mkdir(parents=True, exist_ok=True)
    cutout_path = out_dir / "delegated-cutout.png"
    cutout.save(cutout_path)

    # Upscaling, if this host has a GPU and the caller asked. Done before
    # composition so the extra detail survives into the canvas.
    if options.get("upscale"):
        try:
            from ..imaging.upscale import upscale
            upscaled = upscale(Image.open(cutout_path),
                               model_name=options.get("upscaleModel") or "swinir")
            if upscaled is not None:
                upscaled.save(cutout_path)
        except Exception as e:
            # A missing model or an out-of-memory GPU should degrade to an
            # un-upscaled composite, not fail the whole request -- but say so.
            warnings.append(f"upscaling failed ({type(e).__name__}); composed at source resolution")

    # `photoBackground` is the pre-spec key; options saved on a device
    # before the control was folded into the backdrop select still carry
    # it, and honouring it costs nothing.
    wants_photo = options.get("backdrop") == "asset" or options.get("photoBackground")
    background = None
    if wants_photo:
        name = options.get("background")
        if name:
            background = _resolve_asset("backgrounds", name, warnings)
        else:
            # Unnamed means the library's default, exactly as
            # `--photo-background` with no `--background` does in cli.py.
            background = _default_asset("backgrounds", "American Flag", warnings)
    if background is None:
        # A spec for the core rather than pixels: the same backdrop the
        # browser would have drawn for this seed, since it is the same code.
        from ..library_ops import generated_backdrop
        background = backdrop_spec(generated_backdrop(options), str(options.get("seed", "")),
                                   options.get("exteriorColor"), options.get("interiorColor"),
                                   backdrop_color(options), backdrop_color2(options), backdrop_angle(options))

    from ..library_ops import stock_border
    wants_border = bool(options.get("frame")) or stock_border(options) is not None
    border = _resolve_asset("borders", stock_border(options), warnings) if wants_border else None
    if wants_border and border is None and not stock_border(options):
        warnings.append("frame requested but no border chosen; composed without one")

    composed = compose_hero(
        background, border, [cutout_path],
        layout="single",
        spotlight=bool(options.get("spotlight", True)),
        glow=bool(options.get("glow", False)),
        glow_color=options.get("glowColor") or "white",
        glow_radius=int(options.get("glowRadius") or 24),
        glow_intensity=float(options.get("glowIntensity") or 0.75),
        margin_frac=float(options.get("margin") or 0.06),
        canvas_size=(width, height),
        border_fit=options.get("frameFit") or "fit",
        # The app sends its vehicle form along, so a title or price
        # badge on the server's still is the same as the browser's.
        text=text_request(options.get("vehicle") or {}, text_options(options)),
        border_style=frame_style(options),
        shadow=shadow_style(options),
        reflection=reflection_style(options),
    )

    buf = io.BytesIO()
    composed.convert("RGB").save(buf, "PNG")
    return buf.getvalue(), warnings


def parse_options(raw: str | None) -> dict:
    """Control values arrive as a JSON string in a multipart field."""
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except ValueError as e:
        raise ValueError(f"options is not valid JSON: {e}") from e
    if not isinstance(value, dict):
        raise ValueError("options must be a JSON object")
    return value
