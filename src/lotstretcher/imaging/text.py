"""
Text on the still: the host side of core/src/text.rs.

The core rasterises and places the text; this module hands it the font
(assets/fonts/, the same file the site ships under studio/fonts/) and
turns the Text controls plus the vehicle record into the overlay plan
for one canvas size. Nothing here decides where a word goes.
"""
from __future__ import annotations

from pathlib import Path

from lotstretcher import core
from lotstretcher.imaging.assets import ASSETS_DIR

DEFAULT_FONT = "Lato Bold"
FONT_FILES = {DEFAULT_FONT: "fonts/Lato-Bold.ttf"}
_loaded: set[str] = set()


def ensure_font(name: str = DEFAULT_FONT) -> str:
    """Load `name` into the core once per process. Returns the name."""
    if name in _loaded:
        return name
    rel = FONT_FILES.get(name)
    if rel is None:
        raise ValueError(f"unknown font {name!r}; one of {sorted(FONT_FILES)}")
    path = Path(ASSETS_DIR) / rel
    core.load_font(name, path.read_bytes())
    _loaded.add(name)
    return name


POSITIONS = ("tl", "tr", "bl", "br", "tc", "bc")
COLORS = ("white", "black", "paint")
TITLE_MODES = ("none", "vehicle", "custom")


def add_text_args(parser) -> None:
    """The Text controls as command-line flags, shared by lotstretcher
    and recompose so the two never drift."""
    parser.add_argument("--title", default="none", choices=TITLE_MODES,
                        help="A title on the still: 'vehicle' writes year make model trim from the "
                             "listing, 'custom' writes --title-text (default: none).")
    parser.add_argument("--title-text", default=None, metavar="TEXT",
                        help="The title when --title custom.")
    parser.add_argument("--price-badge", action="store_true",
                        help="A price badge on the still: the post's own resolved price (MSRP for new, "
                             "listed price for used).")
    parser.add_argument("--text-line", default=None, metavar="TEXT",
                        help="A smaller line under the title: the dealer, a salesperson, a call to action.")
    parser.add_argument("--text-position", default="bl", choices=POSITIONS,
                        help="Where the text stack sits: tl, tr, bl, br, tc or bc (default: bl).")
    parser.add_argument("--text-color", default="white", choices=COLORS,
                        help="Text colour: white (default, with a soft shadow; the badge inverted), black, or paint "
                             "(the badge in the vehicle's own colour, from its colour name or sampled off the cutout).")
    parser.add_argument("--text-size", type=float, default=0.05, metavar="FRACTION",
                        help="Title size as a fraction of the canvas height (default: 0.05).")


FRAME_STYLES = ("none", "line")
FRAME_COLORS = ("white", "black", "paint")


def add_frame_style_args(parser) -> None:
    """The core-drawn frame's flags, shared by the CLIs."""
    parser.add_argument("--frame-style", default="none", choices=FRAME_STYLES,
                        help="A frame the core draws to fit every shape: 'line', a rounded line inset from "
                             "the edge (default: none). Ignored when --frame/--border gives frame art.")
    parser.add_argument("--frame-color", default="white", choices=FRAME_COLORS,
                        help="The drawn frame's colour: white, black, or paint (the vehicle's own).")
    parser.add_argument("--frame-weight", type=float, default=0.008, metavar="FRACTION",
                        help="The drawn frame's line weight as a fraction of the shorter side (default: 0.008).")


def controls_from_frame_style_args(args) -> dict:
    return {"frameStyle": args.frame_style, "frameColor": args.frame_color, "frameWeight": args.frame_weight}


def frame_style(options: dict) -> dict | None:
    """The app's frame controls as the core's border_style, or None when
    no drawn frame is asked for. The app's Frame picker says "line" in
    its `border` value; the CLI says --frame-style line."""
    wanted = options.get("border") == "line" or options.get("frameStyle") == "line"
    if not wanted:
        return None
    return {"kind": "line", "color": options.get("frameColor") or "white",
            "weight": float(options.get("frameWeight") if options.get("frameWeight") is not None else 0.008)}


SHADOW_STRENGTH = 0.5


def add_shadow_args(parser) -> None:
    """The ground shadow's flags, shared by the CLIs."""
    parser.add_argument("--shadow", action="store_true",
                        help="A soft ground shadow under the vehicle, read off its own silhouette, so it "
                             "looks set down on the backdrop (default: off).")
    parser.add_argument("--shadow-strength", type=float, default=SHADOW_STRENGTH, metavar="FRACTION",
                        help=f"The shadow's darkness, 0-1 (default: {SHADOW_STRENGTH}).")


def controls_from_shadow_args(args) -> dict:
    return {"shadow": bool(args.shadow), "shadowStrength": args.shadow_strength}


def shadow_style(options: dict) -> dict | None:
    """The app's shadow controls as the core's `shadow` field, or None
    when no shadow is asked for."""
    if not options.get("shadow"):
        return None
    strength = options.get("shadowStrength")
    return {"strength": float(strength if strength is not None else SHADOW_STRENGTH)}


BACKDROPS = ("vehicle", "generic", "sweep")


def add_backdrop_arg(parser) -> None:
    """The generated backdrop's kind, shared by the CLIs. A photo
    (--photo-background) wins over it."""
    parser.add_argument("--backdrop", default="vehicle", choices=BACKDROPS,
                        help="The generated backdrop: 'vehicle', a gradient from the vehicle's own colours "
                             "(default); 'generic', seeded hue bands; 'sweep', a studio cyclorama in the "
                             "vehicle's colours with a lit floor line. Ignored when --photo-background is given.")


def backdrop_spec(kind: str, seed: str, exterior: str | None, interior: str | None) -> dict:
    """The core's background field for a generated backdrop of `kind`."""
    if kind == "generic":
        return {"kind": "generic", "seed": seed}
    if kind not in BACKDROPS:
        raise ValueError(f"unknown backdrop {kind!r}; one of {', '.join(BACKDROPS)}")
    return {"kind": kind, "seed": seed, "exterior": exterior, "interior": interior}


REFLECTION_STRENGTH = 0.35


def add_reflection_args(parser) -> None:
    """The floor reflection's flags, shared by the CLIs."""
    parser.add_argument("--reflection", action="store_true",
                        help="A floor reflection under the vehicle, mirrored below it and faded out, as a "
                             "glossy studio floor gives (default: off).")
    parser.add_argument("--reflection-strength", type=float, default=REFLECTION_STRENGTH, metavar="FRACTION",
                        help=f"The reflection's opacity at the floor line, 0-1 (default: {REFLECTION_STRENGTH}).")


def controls_from_reflection_args(args) -> dict:
    return {"reflection": bool(args.reflection), "reflectionStrength": args.reflection_strength}


def reflection_style(options: dict) -> dict | None:
    """The app's reflection controls as the core's `reflection` field, or
    None when none is asked for."""
    if not options.get("reflection"):
        return None
    strength = options.get("reflectionStrength")
    return {"strength": float(strength if strength is not None else REFLECTION_STRENGTH)}


def controls_from_text_args(args) -> dict:
    """argparse values -> the app's Text control keys."""
    return {
        "titleMode": args.title,
        "titleText": args.title_text,
        "priceBadge": bool(args.price_badge),
        "textLine": args.text_line,
        "textPosition": args.text_position,
        "textColor": args.text_color,
        "textSize": args.text_size,
    }


def text_options(options: dict) -> dict:
    """The Text controls (app keys) as the core's plan fields."""
    return {
        "title": options.get("titleMode") or "none",
        "custom_title": options.get("titleText") or None,
        "price_badge": bool(options.get("priceBadge", False)),
        "line": options.get("textLine") or None,
        "position": options.get("textPosition") or "bl",
        "color": options.get("textColor") or "white",
        "size": float(options.get("textSize") if options.get("textSize") is not None else 0.05),
    }


def wants_text(text: dict) -> bool:
    return text.get("title", "none") != "none" or bool(text.get("price_badge")) or bool(text.get("line"))


def text_request(vehicle: dict | None, text: dict) -> dict | None:
    """The Text controls and the vehicle as one compose-request field,
    with the font loaded, or None when no text is asked for. The core
    plans the words inside the frame's window itself, so a title never
    sits on the frame's art."""
    if not wants_text(text):
        return None
    font = ensure_font(text.get("font") or DEFAULT_FONT)
    return {**{k: v for k, v in text.items() if k != "font"}, "font": font, "vehicle": vehicle or {}}


def plan_overlays(width: int, height: int, vehicle: dict | None, text: dict,
                  window: tuple | None = None, sample=None) -> list[dict]:
    """Overlays for one canvas, or [] when no text is asked for (so a
    run without text never loads the font). `window` is the frame's car
    window to inset from; a video host passes the one it lays out in.
    `sample` is the hero cutout (RGBA PIL) the "paint" colour is read off
    when the record names no colour."""
    if not wants_text(text):
        return []
    font = ensure_font(text.get("font") or DEFAULT_FONT)
    op = {"font": font, "window": list(window) if window else None, **{k: v for k, v in text.items() if k != "font"}}
    if sample is not None:
        op["sample"] = {"$image": 0}
    return core.call({"op": "overlay_plan", "width": width, "height": height, "vehicle": vehicle or {}, **op},
                     [sample] if sample is not None else [])


def text_window(window: tuple, height: int, overlays: list[dict]) -> tuple:
    """The layout window with the text's band taken off it, the same rule
    compose_hero applies, so a clip's cars keep clear of the title."""
    if not overlays:
        return tuple(window)
    return tuple(core.call({"op": "text_window", "window": list(window), "height": height, "overlays": overlays}))
