"""
Hero image composition: background + car cutout(s) + branded border frame.

Layer order (bottom to top): background (scaled/cropped to fill the
canvas, adaptively dimmed toward the edges) -> car cutout(s) (optionally
glowing), scaled and positioned per the chosen layout -> border (its own
alpha handles the window automatically, so it just sits on top without
extra masking logic).

See imaging/assets.py for how borders/backgrounds are looked up by
name/tag rather than hardcoded paths, imaging/select.py for picking which
angle-classified cutout goes in which layout slot, and layout.py/
background.py/effects.py in this package for the pieces this wires
together.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from PIL import Image

from .layout import LAYOUTS
from .effects import DEFAULT_GLOW_COLOR


DEFAULT_CANVAS_SIZE = (1254, 1254)


@lru_cache(maxsize=4)
def _load_border(border_path: str) -> Image.Image:
    """The border RGBA, decoded once per path: compose_hero() runs 8-12x
    per vehicle against the same ~6MB PNG. Window detection and the
    collision mask now happen inside the core per call, which is cheap
    next to the decode."""
    return Image.open(border_path).convert("RGBA")


def compose_hero(background_path, border_path: Path | None, car_paths: list[Path],
                  layout: str = "single", spotlight: bool = True,
                  glow: bool = False, glow_color=DEFAULT_GLOW_COLOR,
                  glow_radius: int = 24, glow_intensity: float = 0.75,
                  margin_frac: float = 0.06,
                  canvas_size: tuple[int, int] = DEFAULT_CANVAS_SIZE,
                  border_fit: str = "fit") -> Image.Image:
    """
    car_paths[0] is always the hero (drives the spotlight measurement and
    center). car_paths[1:] fill whatever accent slots `layout` defines --
    see imaging/compose/layout.py for what each layout name expects (e.g.
    "quad" wants [hero, front, back, side]). Extra car_paths beyond what
    the layout has slots for are silently unused; fewer than the layout
    expects just leaves those slots empty.

    background_path may be a path OR an already-built PIL Image -- the
    generated gradients (background.py::gradient_background()) are made
    per-image and never hit disk, so there'd be nothing to pass a path to.

    border_path may be None for a FRAMELESS composition. The border does
    three jobs at once: it defines the window the cars are laid out in,
    it supplies the alpha mask placements are collision-checked against,
    and it's the top layer. With no border, the window is the whole
    canvas and there is nothing to collide with, so that check is skipped
    rather than run against an empty mask.

    canvas_size is the format's and always wins. A border drawn for
    another shape (a square dealer frame on a 4:5 post) is fitted to it
    by border_fit: "fit" keeps the whole frame, centred, with the
    backdrop filling the rest; "fill" covers the canvas and crops the
    frame's edges; "stretch" pulls it to the canvas shape.

    margin_frac is the breathing room left inside each layout box. The
    0.06 default suits layouts that must also look right half-empty; the
    "conveyor" layout is tuned around a tighter one (see its docstring),
    since all its slots are always filled.
    """
    if layout not in LAYOUTS:
        raise ValueError(f"Unknown layout {layout!r}, pick one of {list(LAYOUTS)}")

    # The whole composition runs in the Rust core (core/), the same code
    # the browser runs: gradient, window detection, placement, collision
    # against the border art, spotlight, glow, the border on top.
    # background_path may also be a background SPEC dict ({"kind":
    # "vehicle", "seed", "exterior", "interior"} or {"kind": "generic",
    # "seed"}), in which case the core builds the gradient itself and no
    # Python gradient is drawn. This file is a host, not an implementation.
    from ... import core

    cars = [p.convert("RGBA") if isinstance(p, Image.Image) else Image.open(p).convert("RGBA")
            for p in car_paths]
    if isinstance(background_path, dict):
        background, bg_image = background_path, None
    else:
        bg = background_path if isinstance(background_path, Image.Image) else Image.open(background_path)
        background, bg_image = {"kind": "image"}, bg.convert("RGB")
    border = _load_border(str(border_path)) if border_path is not None else None
    return core.compose_hero(cars, canvas_size[0], canvas_size[1], background, background_image=bg_image,
                             border=border, layout=layout, spotlight=spotlight, glow=glow,
                             glow_color=str(glow_color), glow_radius=glow_radius,
                             glow_intensity=glow_intensity, margin_frac=margin_frac,
                             border_fit=border_fit)
