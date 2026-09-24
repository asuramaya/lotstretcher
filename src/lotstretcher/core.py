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
        lib.ls_call.restype = _Buffer
        lib.ls_call.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_uint8), ctypes.c_size_t]
        lib.ls_detect_window.restype = ctypes.c_int
        lib.ls_detect_window.argtypes = [ctypes.POINTER(ctypes.c_uint8), ctypes.c_size_t, ctypes.c_size_t,
                                         ctypes.POINTER(ctypes.c_int64)]
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


def _arena(images) -> tuple[bytearray, list[dict]]:
    """Pack PIL images into one byte arena and describe each slice. An
    int in `images` is the id of an image the core already holds (see
    `retain`), and travels as that id with no bytes. One bytearray,
    filled in place, so a frame's inputs are copied once on the way in
    rather than joined and then copied again."""
    slices = []
    total = 0
    def mode_of(img):
        return img.mode if img.mode in ("RGBA", "L") else "RGB"

    for img in images:
        if isinstance(img, int):
            slices.append({"retained": img})
            continue
        channels = {"RGBA": 4, "L": 1}.get(mode_of(img), 3)
        n = img.width * img.height * channels
        slices.append({"offset": total, "len": n, "width": img.width, "height": img.height, "channels": channels})
        total += n
    arena = bytearray(total)
    for img, s in zip(images, slices):
        if isinstance(img, int):
            continue
        mode = mode_of(img)
        raw = (img if img.mode == mode else img.convert(mode)).tobytes()
        arena[s["offset"]:s["offset"] + s["len"]] = raw
    return arena, slices


def _buffer(arena: bytearray):
    """A ctypes view over the arena, no copy."""
    return (ctypes.c_uint8 * len(arena)).from_buffer(arena) if arena else None


def spotlight_fields(spotlight) -> dict:
    """The core's three spotlight fields from a host's value: a bool, or
    {"strength", "spread"} (on, with those levers)."""
    if isinstance(spotlight, dict):
        return {"spotlight": True, "spotlight_strength": spotlight.get("strength"), "spotlight_spread": spotlight.get("spread")}
    return {"spotlight": bool(spotlight), "spotlight_strength": None, "spotlight_spread": None}


def compose_hero(cars, width: int, height: int, background: dict, *, layout: str = "single",
                 spotlight: bool | dict = True, glow: bool = False, glow_color: str | None = None,
                 glow_radius: int | None = None, glow_intensity: float | None = None,
                 margin_frac: float | None = None, background_image=None, border=None,
                 border_fit: str | None = None, overlays: list | None = None, text: dict | None = None,
                 border_style: dict | None = None, shadow: dict | None = None,
                 reflection: dict | None = None):
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
    bg = dict(background)
    bg_index = border_index = None
    if bg.get("kind") == "image":
        if background_image is None:
            raise ValueError("background kind 'image' needs background_image")
        bg_index = len(images)
        images.append(background_image)
    if border is not None:
        border_index = len(images)
        images.append(border.convert("RGBA"))
    arena, slices = _arena(images)
    car_slices = slices[:len(cars)]
    if bg_index is not None:
        bg["image"] = slices[bg_index]

    req = {
        "width": width, "height": height, "background": bg, "cars": car_slices, "layout": layout,
        **spotlight_fields(spotlight), "glow": glow, "glow_color": glow_color, "glow_radius": glow_radius,
        "glow_intensity": glow_intensity, "margin_frac": margin_frac,
        "border": slices[border_index] if border_index is not None else None,
        "border_fit": border_fit,
        "overlays": list(overlays or []),
        # The Text controls with the vehicle (imaging/text.py::text_request):
        # the core plans them inside the frame's window once it knows it.
        "text": text,
        # A frame the core draws to the canvas (frame_style.rs) when no
        # border image is given: {"kind": "line", "weight", "color"}.
        "border_style": border_style,
        # A ground shadow under the cars (glow.rs::Shadow): {"strength"}, or None.
        "shadow": shadow,
        # A floor reflection under the cars (glow.rs::Reflection): {"strength"}, or None.
        "reflection": reflection,
    }
    buf = _buffer(arena)
    result = lib.ls_compose_hero(json.dumps(req).encode("utf-8"), buf, len(arena))
    try:
        if not result.ok:
            msg = ctypes.string_at(result.ptr, result.len).rstrip(b"\0").decode("utf-8", "replace")
            raise RuntimeError(f"core compose failed: {msg}")
        data = ctypes.string_at(result.ptr, result.len)
        return Image.frombytes("RGB", (result.width, result.height), data)
    finally:
        lib.ls_free(result)


def call(op: dict, images: list | None = None):
    """The general entry point. `op` is a dict with an "op" field (see
    core/src/frame.rs::Op); any PIL images it refers to are passed in
    `images` and referred to by index in `op` as {"$image": i}. Returns
    a PIL Image for image results, or the decoded JSON value otherwise."""
    from PIL import Image

    lib = _load()
    if lib is None:
        raise RuntimeError(f"lotstretcher core is not available: {_LIB_ERROR}")
    arena, slices = _arena(images or [])

    def bind(node):
        if isinstance(node, dict):
            if "$image" in node:
                return slices[node["$image"]]
            return {k: bind(v) for k, v in node.items()}
        if isinstance(node, list):
            return [bind(v) for v in node]
        return node

    buf = _buffer(arena)
    result = lib.ls_call(json.dumps(bind(op)).encode("utf-8"), buf, len(arena))
    try:
        if not result.ok:
            msg = ctypes.string_at(result.ptr, result.len).rstrip(b"\0").decode("utf-8", "replace")
            raise RuntimeError(f"core {op.get('op')} failed: {msg}")
        data = ctypes.string_at(result.ptr, result.len)
        if result.channels == 0:
            return json.loads(data.decode("utf-8"))["value"]
        mode = {1: "L", 3: "RGB", 4: "RGBA"}[result.channels]
        # frombuffer shares `data` (already our copy) instead of copying
        # it a second time; Pillow copies on the first write.
        return Image.frombuffer(mode, (result.width, result.height), data, "raw", mode, 0, 1)
    finally:
        lib.ls_free(result)


def render_frame(cars, width: int, height: int, background: dict, *, border=None, spotlight=None,
                 glow=False, glow_color=None, glow_radius=None, glow_intensity=None, resample="lanczos",
                 background_image=None, overlays=None, shadow=None, reflection=None):
    """One video frame. `cars` are (rgba_image, x, y, w, h, alpha) tuples,
    optionally with a seventh element (other_rgba_image, t) to dissolve
    the car toward `other` by `t` before pasting; `spotlight` is
    (cx, cy, dim) or None. A car already at (w, h) is pasted without
    resampling, which is how a host caches scaled cars."""
    images = [c[0] for c in cars]
    car_ops = [{"image": {"$image": i}, "x": c[1], "y": c[2], "w": c[3], "h": c[4], "alpha": c[5]}
               for i, c in enumerate(cars)]
    for c, o in zip(cars, car_ops):
        if len(c) > 6 and c[6] is not None:
            o["mix"] = {"image": {"$image": len(images)}, "t": c[6][1]}
            images.append(c[6][0])
    op = {"op": "render_frame", "width": width, "height": height, "background": dict(background),
          "cars": car_ops,
          "glow": glow, "glow_color": glow_color, "glow_radius": glow_radius, "glow_intensity": glow_intensity,
          "resample": resample, "overlays": list(overlays or []), "shadow": shadow,
          "reflection": reflection}
    if background.get("kind") == "image":
        op["background"]["image"] = {"$image": len(images)}
        images.append(background_image)
    if border is not None:
        op["border"] = {"$image": len(images)}
        images.append(border)
    if spotlight is not None:
        # (cx, cy, dim) or (cx, cy, dim, {"strength", "spread"}): the
        # levers, when given, replace the measured dim and the spread.
        levers = spotlight[3] if len(spotlight) > 3 and isinstance(spotlight[3], dict) else {}
        op["spotlight"] = {"cx": spotlight[0], "cy": spotlight[1], "dim": spotlight[2],
                           "strength": levers.get("strength"), "spread": levers.get("spread")}
    return call(op, images)


def load_font(name: str, data: bytes) -> None:
    """Keep a font's bytes in the core under `name` (a TTF/OTF). The
    bytes travel through the arena as a one-row single-channel image,
    which is what the arena carries; the core reads them as a font."""
    from PIL import Image
    carrier = Image.frombytes("L", (len(data), 1), data)
    call({"op": "load_font", "name": name, "data": {"$image": 0}}, [carrier])


def overlay_plan(width: int, height: int, vehicle: dict | None, **text) -> list[dict]:
    """Text overlays for one canvas from the Text controls: title
    ("none" | "vehicle" | "custom"), custom_title, price_badge, line,
    position, color, size (fraction of height), font."""
    return call({"op": "overlay_plan", "width": width, "height": height, "vehicle": vehicle or {}, **text})


def draw_frame(width: int, height: int, style: dict, vehicle: dict | None = None, sample=None):
    """The core's own frame (a line inset from the edge) at width x height
    as an RGBA PIL image; "paint" takes the vehicle's colour name, else
    the paint sampled off `sample` (the hero cutout)."""
    op = {"op": "draw_frame", "width": width, "height": height, "style": dict(style), "vehicle": vehicle or {}}
    if sample is not None:
        op["sample"] = {"$image": 0}
    return call(op, [sample] if sample is not None else [])


def fit_border(border, width: int, height: int, fit: str = "fit"):
    """`border` (RGBA PIL) laid onto a width x height canvas by `fit`
    (fit, fill, stretch or slice): the frame a format of another shape gets.
    Returns (fitted RGBA image, (left, top, right, bottom) car window)."""
    fitted = call({"op": "fit_border", "border": {"$image": 0}, "width": width, "height": height, "fit": fit}, [border])
    window = call({"op": "fit_window", "border": {"$image": 0}, "width": width, "height": height, "fit": fit}, [border])
    return fitted, tuple(window)


def retain(image) -> int:
    """Keep `image` (PIL, or an id to re-retain) inside the core and get
    its id back. Any op then takes the id wherever it takes an image, and
    no pixels cross the boundary for it again. Pair with `release`."""
    return int(call({"op": "retain", "image": {"$image": 0}}, [image]))


def release(image_id: int) -> bool:
    return bool(call({"op": "release", "id": int(image_id)}))


def release_all() -> int:
    return int(call({"op": "release_all"}))


def resize(image, width: int, height: int, bilinear: bool = False):
    return call({"op": "resize", "image": {"$image": 0}, "width": width, "height": height, "bilinear": bilinear}, [image])


def linear_gradient(width: int, height: int, angle: float, start, end):
    return call({"op": "linear_gradient", "width": width, "height": height, "angle": angle,
                 "start": list(start), "end": list(end)})


def dim_strength(background_region, car) -> float:
    return float(call({"op": "dim_strength", "background": {"$image": 0}, "car": {"$image": 1}}, [background_region, car]))


def resolve_collision(border, car, x: int, y: int) -> int:
    return int(call({"op": "resolve_collision", "border": {"$image": 0}, "car": {"$image": 1}, "x": x, "y": y},
                    [border, car]))


def detect_window(border) -> tuple[int, int, int, int]:
    """A border's transparent window as (left, top, right, bottom)."""
    lib = _load()
    if lib is None:
        raise RuntimeError(f"lotstretcher core is not available: {_LIB_ERROR}")
    raw = border.convert("RGBA").tobytes()
    buf = (ctypes.c_uint8 * len(raw)).from_buffer_copy(raw)
    out = (ctypes.c_int64 * 4)()
    if not lib.ls_detect_window(buf, border.width, border.height, out):
        raise ValueError("Could not find a transparent window in this border image")
    return tuple(int(v) for v in out)


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
