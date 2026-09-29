"""
Where each car cutout goes within the border's window.

A layout is a function (window, n_extra) -> [(box, anchor), ...], always
hero first. compose_hero() zips this 1:1 against the car_paths it's given,
so the caller (imaging/select.py, or a CLI) is responsible for handing
cars over in the same order the chosen layout expects.

The layouts and the placement are the core's (core/src/layout.rs, which
carries each layout's reasoning); this module names them for the Python
callers and resizes a placed car.
"""
from __future__ import annotations

from PIL import Image

from lotstretcher import core


def compute_placement(car: Image.Image, box: tuple[int, int, int, int],
                      margin_frac: float = 0.06, anchor: str = "bottom") -> tuple[int, int, Image.Image]:
    """Scale `car` (already cropped to its visible pixels) to fit within
    `box` minus a margin, its height capped at a reference silhouette's so
    a head-on shot stands no taller than a three-quarter one and centred
    cars share one floor line. Returns (x, y, resized_car) without touching
    any canvas, so the placement is known ahead of the dim/vignette/glow
    passes. Resampled by the core, so these are the pixels it composites."""
    p = core.call({"op": "placement", "width": car.width, "height": car.height, "box": list(box),
                   "margin_frac": margin_frac, "anchor": anchor})
    new_size = (p["w"], p["h"])
    car_resized = car if car.size == new_size else core.resize(car, *new_size)
    return p["x"], p["y"], car_resized


def _named(name: str, default_extra: int):
    def layout(window: tuple[int, int, int, int], n_extra: int = default_extra) -> list[tuple[tuple, str]]:
        slots = core.call({"op": "layout", "name": name, "window": list(window), "n_extra": n_extra})
        return [(tuple(box), anchor) for box, anchor in slots]
    layout.__name__ = f"{name}_layout"
    layout.__doc__ = f"The core's {name!r} layout (core/src/layout.rs)."
    return layout


single_layout = _named("single", 0)
corners_layout = _named("corners", 2)
quad_layout = _named("quad", 3)
conveyor_layout = _named("conveyor_plain", 2)
conveyor_stack_layout = _named("conveyor_stack", 2)
conveyor_wide_layout = _named("conveyor_wide", 2)
_conveyor_for_window = _named("conveyor", 2)


def conveyor_for_window(window: tuple[int, int, int, int]):
    """Whichever conveyor arrangement suits this frame's shape: stacked
    once taller than wide, a lineup once much wider than tall, the tuned
    corners original between, so a square keeps it."""
    return _conveyor_for_window


LAYOUTS = {
    "single": single_layout,
    "corners": corners_layout,
    "quad": quad_layout,
    "conveyor": conveyor_layout,
    "conveyor_stack": conveyor_stack_layout,
    "conveyor_wide": conveyor_wide_layout,
}
