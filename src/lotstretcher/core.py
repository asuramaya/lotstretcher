"""The Rust core, loaded as a native library through ctypes.

core/ is the one implementation of the image math for both surfaces
(see core/src/lib.rs). This module is the Python side's thin host:
it finds the cdylib, hands it byte buffers and a JSON request, and
turns the result back into a PIL Image. No numpy arithmetic lives here
any more; if the maths needs changing, it changes in Rust and both the
CLI and the browser get it.

The library is looked for in this order: LOTSTRETCHER_CORE (an explicit
path), the repo's core/target/release, and next to this file (a wheel
would ship it there). `available()` says whether one was found, and is
what /capabilities reports as `core`.
"""
from __future__ import annotations

import ctypes
import json
import os
from pathlib import Path

_LIB = None
_LIB_ERROR = None


class _Buffer(ctypes.Structure):
    _fields_ = [
        ("ptr", ctypes.POINTER(ctypes.c_uint8)),
        ("len", ctypes.c_size_t),
        ("width", ctypes.c_size_t),
        ("height", ctypes.c_size_t),
        ("channels", ctypes.c_size_t),
        ("ok", ctypes.c_int),
    ]


def _candidates() -> list[Path]:
    names = ["liblotstretcher_core.so", "liblotstretcher_core.dylib", "lotstretcher_core.dll"]
    roots = []
    explicit = os.environ.get("LOTSTRETCHER_CORE")
    if explicit:
        roots.append(Path(explicit))
    here = Path(__file__).resolve()
    roots.append(here.parents[2] / "core" / "target" / "release")
    roots.append(here.parent)
    out = []
    for r in roots:
        if r.is_file():
            out.append(r)
        else:
            out.extend(r / n for n in names)
    return out


def _load():
    global _LIB, _LIB_ERROR
    if _LIB is not None or _LIB_ERROR is not None:
        return _LIB
    for path in _candidates():
        if not path.is_file():
            continue
        try:
            lib = ctypes.CDLL(str(path))
        except OSError as e:
            _LIB_ERROR = f"{path}: {e}"
            continue
        lib.ls_compose_hero.restype = _Buffer
        lib.ls_compose_hero.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_uint8), ctypes.c_size_t]
        lib.ls_vehicle_gradient_colors.restype = ctypes.c_int
        lib.ls_vehicle_gradient_colors.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.POINTER(ctypes.c_uint8),
                                                   ctypes.c_size_t, ctypes.c_size_t, ctypes.c_size_t,
                                                   ctypes.POINTER(ctypes.c_uint8)]
        lib.ls_free.argtypes = [_Buffer]
        lib.ls_version.restype = ctypes.c_uint32
        _LIB = lib
        _LIB_PATH[0] = path
        return lib
    _LIB_ERROR = _LIB_ERROR or "no built core found (cargo build --release in core/)"
    return None


_LIB_PATH: list[Path | None] = [None]


def available() -> bool:
    return _load() is not None


def why_unavailable() -> str | None:
    _load()
    return None if _LIB else _LIB_ERROR


def path() -> Path | None:
    _load()
    return _LIB_PATH[0]


def _arena(images) -> tuple[bytes, list[dict]]:
    """Pack PIL images into one byte arena and describe each slice."""
    parts = []
    slices = []
    offset = 0
    for img in images:
        mode = "RGBA" if img.mode == "RGBA" else "RGB"
        raw = img.convert(mode).tobytes()
        slices.append({"offset": offset, "len": len(raw), "width": img.width, "height": img.height,
                       "channels": 4 if mode == "RGBA" else 3})
        parts.append(raw)
        offset += len(raw)
    return b"".join(parts), slices


def compose_hero(cars, width: int, height: int, background: dict, *, layout: str = "single",
                 spotlight: bool = True, glow: bool = False, glow_color: str | None = None,
                 glow_radius: int | None = None, glow_intensity: float | None = None,
                 margin_frac: float | None = None, background_image=None):
    """Compose one hero the way the browser does, in the same code.

    `cars` are RGBA PIL images, hero first. `background` is one of
    {"kind": "vehicle", "seed", "exterior", "interior"},
    {"kind": "generic", "seed"} or {"kind": "image"} with
    `background_image` supplied. Returns an RGB PIL Image.
    """
    from PIL import Image

    lib = _load()
    if lib is None:
        raise RuntimeError(f"lotstretcher core is not available: {_LIB_ERROR}")

    images = list(cars)
    if background.get("kind") == "image":
        if background_image is None:
            raise ValueError("background kind 'image' needs background_image")
        images.append(background_image)
    arena, slices = _arena(images)
    car_slices = slices[:len(cars)]
    bg = dict(background)
    if bg.get("kind") == "image":
        bg["image"] = slices[-1]

    req = {
        "width": width, "height": height, "background": bg, "cars": car_slices, "layout": layout,
        "spotlight": spotlight, "glow": glow, "glow_color": glow_color, "glow_radius": glow_radius,
        "glow_intensity": glow_intensity, "margin_frac": margin_frac,
    }
    buf = (ctypes.c_uint8 * len(arena)).from_buffer_copy(arena) if arena else None
    result = lib.ls_compose_hero(json.dumps(req).encode("utf-8"), buf, len(arena))
    try:
        if not result.ok:
            msg = ctypes.string_at(result.ptr, result.len).rstrip(b"\0").decode("utf-8", "replace")
            raise RuntimeError(f"core compose failed: {msg}")
        data = ctypes.string_at(result.ptr, result.len)
        return Image.frombytes("RGB", (result.width, result.height), data)
    finally:
        lib.ls_free(result)


def vehicle_gradient_colors(exterior: str | None, interior: str | None, sample=None):
    """(exterior_stop, interior_stop) from the core; `sample` is an RGBA
    PIL image of a cutout, used when the exterior name has no colour word."""
    lib = _load()
    if lib is None:
        raise RuntimeError(f"lotstretcher core is not available: {_LIB_ERROR}")
    raw = sample.convert("RGBA").tobytes() if sample is not None else b""
    buf = (ctypes.c_uint8 * len(raw)).from_buffer_copy(raw) if raw else None
    out = (ctypes.c_uint8 * 6)()
    lib.ls_vehicle_gradient_colors(
        exterior.encode("utf-8") if exterior else None, interior.encode("utf-8") if interior else None,
        buf, len(raw), sample.width if sample is not None else 0, sample.height if sample is not None else 0, out)
    v = bytes(out)
    return (v[0], v[1], v[2]), (v[3], v[4], v[5])
