"""Glow colour names. The glow itself (blur, recolour, paste) lives in
the Rust core (core/src/glow.rs); this keeps the CLI's name validation."""
from __future__ import annotations

from ... import spec as _spec

# From shared/pipeline-spec.json -- see src/lotstretcher/spec.py.
GLOW_COLORS = _spec.rgb_map("glow", "colors")
DEFAULT_GLOW_COLOR = _spec.get("glow", "default", default="white")


def resolve_glow_color(name_or_rgb) -> tuple[int, int, int]:
    """One of the spec's glow colours by name, or a #rrggbb of the user's."""
    if isinstance(name_or_rgb, tuple):
        return name_or_rgb
    key = str(name_or_rgb).lower()
    if key in GLOW_COLORS:
        return GLOW_COLORS[key]
    from lotstretcher.imaging.palette import parse_hex
    rgb = parse_hex(key)
    if rgb is None:
        raise ValueError(f"Unknown glow color {name_or_rgb!r}, pick one of {list(GLOW_COLORS)} or #rrggbb")
    return rgb
