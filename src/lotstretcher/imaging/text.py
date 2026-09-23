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
COLORS = ("white", "black")
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
                        help="Text colour (default: white, with a soft shadow; the badge is inverted).")
    parser.add_argument("--text-size", type=float, default=0.05, metavar="FRACTION",
                        help="Title size as a fraction of the canvas height (default: 0.05).")


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
                  window: tuple | None = None) -> list[dict]:
    """Overlays for one canvas, or [] when no text is asked for (so a
    run without text never loads the font). `window` is the frame's car
    window to inset from; a video host passes the one it lays out in."""
    if not wants_text(text):
        return []
    font = ensure_font(text.get("font") or DEFAULT_FONT)
    return core.overlay_plan(width, height, vehicle, font=font, window=list(window) if window else None,
                             **{k: v for k, v in text.items() if k != "font"})


def text_window(window: tuple, height: int, overlays: list[dict]) -> tuple:
    """The layout window with the text's band taken off it, the same rule
    compose_hero applies, so a clip's cars keep clear of the title."""
    if not overlays:
        return tuple(window)
    return tuple(core.call({"op": "text_window", "window": list(window), "height": height, "overlays": overlays}))
