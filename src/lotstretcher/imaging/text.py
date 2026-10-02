"""
Text on the still: the host side of core/src/text.rs.

The core rasterises and places the text; this module hands it the font
(assets/fonts/, the same file the site ships under studio/fonts/) and
turns the Text controls plus the vehicle record into the overlay plan
for one canvas size. Nothing here decides where a word goes.
"""
from __future__ import annotations

import argparse
from pathlib import Path

from lotstretcher import core
from lotstretcher import spec as _spec
from lotstretcher.imaging.assets import ASSETS_DIR

DEFAULT_FONT = "Lato Bold"


def _plain(options: dict | None) -> dict:
    """The control values a JSON request can carry (a Path, say, cannot)."""
    return {k: v for k, v in (options or {}).items() if isinstance(v, (str, int, float, bool, list, dict, type(None)))}


def styles(options: dict | None) -> dict:
    """The Studio's control values (app keys) as every field the core's
    requests take -- text, border_style, spotlight, shadow, reflection,
    backdrop -- decided by the core (core/src/controls.rs), the same
    mapping the browser's lib/text.js asks it for."""
    return core.call({"op": "styles", "options": _plain(options)})


def _text_facts(text: dict) -> dict:
    return core.call({"op": "text_facts", "text": _plain(text)})


def _font_files() -> dict[str, str]:
    """name -> file under assets/, from the manifest: the same list the
    studio ships (web/build-studio.py), so the CLI and the app offer the
    same fonts and the name is never retyped."""
    import json
    manifest = json.loads((Path(ASSETS_DIR) / "manifest.json").read_text())
    return {e["name"]: e["file"] for e in manifest.get("fonts", []) if e.get("studio")}


FONT_FILES = _font_files()
FONTS = tuple(FONT_FILES)
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
TEXT_CASES = ("as-is", "upper")


def color_choice(allowed: tuple[str, ...]):
    """An argparse type: one of `allowed`, or a colour of the user's own
    as #rrggbb (what the app's colour picker gives), which the core
    reads wherever a named colour goes."""
    import argparse
    from lotstretcher.imaging.palette import parse_hex

    def check(text: str) -> str:
        low = text.strip().lower()
        if low in allowed or parse_hex(low) is not None:
            return low
        raise argparse.ArgumentTypeError(f"{text!r} is not one of {', '.join(allowed)} or #rrggbb")
    return check


def add_text_args(parser) -> None:
    """The Text controls as command-line flags, shared by lotstretcher
    and recompose so the two never drift."""
    title_default = _spec.control_default("titleMode", "none")
    parser.add_argument("--title", default=title_default, choices=TITLE_MODES,
                        help="A title on the still: 'vehicle' writes year make model trim from the "
                             f"listing, 'custom' writes --title-text, 'none' leaves it off (default: {title_default}).")
    parser.add_argument("--title-text", default=None, metavar="TEXT",
                        help="The title when --title custom.")
    parser.add_argument("--price-badge", action=argparse.BooleanOptionalAction,
                        default=bool(_spec.control_default("priceBadge", False)),
                        help="A price badge on the still: the post's own resolved price (MSRP for new, "
                             "listed price for used). On unless --no-price-badge; drawn only when there is a price.")
    parser.add_argument("--subtitle", "--text-line", dest="subtitle", default=None, metavar="TEXT",
                        help="A subtitle under the title: the trim line, the dealer, who to ask for.")
    parser.add_argument("--text-position", default="bl", choices=POSITIONS,
                        help="Where the text stack sits: tl, tr, bl, br, tc or bc (default: bl).")
    parser.add_argument("--text-color", default="white", type=color_choice(COLORS), metavar="COLOR",
                        help="Text colour: white (default, with a soft shadow; the badge inverted), black, paint "
                             "(the badge in the vehicle's own colour, from its colour name or sampled off the cutout), "
                             "or your own as #rrggbb (the badge in it).")
    parser.add_argument("--text-size", type=float, default=0.05, metavar="FRACTION",
                        help="Title size as a fraction of the canvas height (default: 0.05).")
    parser.add_argument("--text-case", default="as-is", choices=TEXT_CASES,
                        help="The case the words are set in: as-is (default) or upper.")
    parser.add_argument("--text-boxed", action="store_true",
                        help="The title and the subtitle on pills too, like the price badge (default: off).")
    parser.add_argument("--no-text-shadow", action="store_true",
                        help="No soft shadow under unboxed words.")
    parser.add_argument("--subtitle-size", type=float, default=0.62, metavar="FRACTION",
                        help="The subtitle's size as a share of the title's (default: 0.62).")
    parser.add_argument("--badge-size", type=float, default=0.85, metavar="FRACTION",
                        help="The price badge's size as a share of the title's (default: 0.85).")
    parser.add_argument("--text-font", default=DEFAULT_FONT, choices=FONTS, metavar="FONT",
                        help=f"The studio font every piece is set in (default: {DEFAULT_FONT}); one of "
                             f"{', '.join(FONTS)}.")
    # Each piece's own levers. Left unset ("same"), a piece follows the
    # shared flag above; set, it departs from it on that lever alone.
    # Spelled out flag by flag so the one-route test reads them off the
    # source, as it reads every other flag.
    parser.add_argument("--title-font", default=None, choices=FONTS, metavar="FONT",
                        help="The title's own font (default: --text-font).")
    parser.add_argument("--title-position", default=None, choices=POSITIONS,
                        help="The title's own corner (default: --text-position). Pieces sharing a corner stack there.")
    parser.add_argument("--title-color", default=None, type=color_choice(COLORS), metavar="COLOR",
                        help="The title's own colour: white, black, paint or #rrggbb (default: --text-color).")
    parser.add_argument("--title-case", default=None, choices=TEXT_CASES,
                        help="The title's own case (default: --text-case).")
    parser.add_argument("--title-box", default=None, choices=BOX_CHOICES,
                        help="The title on a pill (on) or bare (off); default: --text-boxed.")
    parser.add_argument("--badge-font", default=None, choices=FONTS, metavar="FONT",
                        help="The price badge's own font (default: --text-font).")
    parser.add_argument("--badge-position", default=None, choices=POSITIONS,
                        help="The price badge's own corner (default: --text-position).")
    parser.add_argument("--badge-color", default=None, type=color_choice(COLORS), metavar="COLOR",
                        help="The price badge's own colour: white, black, paint or #rrggbb (default: --text-color).")
    parser.add_argument("--subtitle-font", default=None, choices=FONTS, metavar="FONT",
                        help="The subtitle's own font (default: --text-font).")
    parser.add_argument("--subtitle-position", default=None, choices=POSITIONS,
                        help="The subtitle's own corner (default: --text-position).")
    parser.add_argument("--subtitle-color", default=None, type=color_choice(COLORS), metavar="COLOR",
                        help="The subtitle's own colour: white, black, paint or #rrggbb (default: --text-color).")
    parser.add_argument("--subtitle-case", default=None, choices=TEXT_CASES,
                        help="The subtitle's own case (default: --text-case).")
    parser.add_argument("--subtitle-box", default=None, choices=BOX_CHOICES,
                        help="The subtitle on a pill (on) or bare (off); default: --text-boxed.")


PIECES = ("title", "subtitle", "badge")
BOX_CHOICES = ("on", "off")


FRAME_STYLES = ("none", "line")
FRAME_COLORS = ("white", "black", "paint")


def add_frame_style_args(parser) -> None:
    """The core-drawn frame's flags, shared by the CLIs."""
    parser.add_argument("--frame-style", default="none", choices=FRAME_STYLES,
                        help="A frame the core draws to fit every shape: 'line', a rounded line inset from "
                             "the edge (default: none). Ignored when --frame/--border gives frame art.")
    parser.add_argument("--frame-color", default="white", type=color_choice(FRAME_COLORS), metavar="COLOR",
                        help="The drawn frame's colour: white, black, paint (the vehicle's own), or your own as #rrggbb.")
    parser.add_argument("--frame-weight", type=float, default=0.008, metavar="FRACTION",
                        help="The drawn frame's line weight as a fraction of the shorter side (default: 0.008).")
    parser.add_argument("--frame-inset", type=float, default=0.035, metavar="FRACTION",
                        help="How far in from the edge the drawn frame sits, as a fraction of the shorter side (default: 0.035).")
    parser.add_argument("--frame-radius", type=float, default=0.02, metavar="FRACTION",
                        help="The drawn frame's corner radius as a fraction of the shorter side (default: 0.02).")


def controls_from_frame_style_args(args) -> dict:
    return {"frameStyle": args.frame_style, "frameColor": args.frame_color, "frameWeight": args.frame_weight,
            "frameInset": args.frame_inset, "frameRadius": args.frame_radius}


def frame_style(options: dict) -> dict | None:
    """The app's frame controls as the core's border_style, or None when
    no drawn frame is asked for (the app's Frame picker says "line" in its
    `border` value; the CLI says --frame-style line). The core's
    controls.rs, like every mapping below."""
    return styles(options)["border_style"]


def add_short_clip_args(parser) -> None:
    """The flags for a clip of one or two shots, which the conveyor (three
    or more) cannot fill: each shot holds the frame with a slow push, and
    the next crossfades in (core carousel.rs's push mode)."""
    parser.add_argument("--video-push", type=float, default=None, metavar="FRACTION",
                        help="How far each shot scales across its dwell in a clip of one or two shots, 0-0.2 "
                             f"(default: {_spec.control_default('videoPush', 0.06)}).")
    parser.add_argument("--video-crossfade", type=float, default=None, metavar="SECONDS",
                        help="Seconds of blend between the shots of a clip of one or two shots "
                             f"(default: {_spec.control_default('videoCrossfade', 0.5)}).")


def add_video_args(parser) -> None:
    """The clip's flags, shared by lotstretcher and hero-video so one
    spelling means one thing everywhere. The older spellings each tool had
    (--format, --bpm, --music, --audio, --flag-background, --background-video,
    --budget-mb, --video-flag-background) are kept as aliases."""
    parser.add_argument("--video-format", "--format", action="append", metavar="FORMAT", dest="video_format",
                        help="Frame shape for the clip; repeatable, or 'all': square 1254x1254 (Marketplace/feed), "
                             "vertical 1080x1920 (Reels/Stories/TikTok/Shorts), horizontal 1920x1080 (YouTube). "
                             "The edit is identical in every shape; only the blocking changes.")
    parser.add_argument("--video-fps", type=float, default=None, metavar="FPS",
                        help="Frame rate (default: 25 for the beat-synced CLI render, 30 in the browser).")
    parser.add_argument("--video-bpm", "--bpm", type=float, default=None, metavar="BPM", dest="video_bpm",
                        help="Tempo the cuts and pulse follow when there is no music (default: the spec's "
                             "defaultBpm). With --video-music the track's own bars set the clock.")
    parser.add_argument("--video-music", "--music", action="store_true", dest="video_music",
                        help="Score the clip with a looping track (silent unless given); the cuts are "
                             "bar/beat-locked either way.")
    parser.add_argument("--video-track", "--audio", default=None, metavar="TRACK", dest="video_track",
                        help="Which track --video-music plays: a name, tag or path (default: the library's); "
                             "naming one turns the music on.")
    parser.add_argument("--video-backdrop", "--video-flag-background", "--flag-background", action="store_true",
                        dest="video_backdrop",
                        help="Loop a stock video clip behind the shots instead of the gradient.")
    parser.add_argument("--video-clip", "--background-video", default=None, metavar="CLIP", dest="video_clip",
                        help="Which clip --video-backdrop loops: a name, tag or path (default: the library's); "
                             "naming one turns the backdrop on.")
    parser.add_argument("--video-bitrate", type=float, default=None, metavar="MBPS",
                        help="The clip's bitrate in Mbps (default: automatic, filling --video-budget-mb).")
    parser.add_argument("--video-budget-mb", "--budget-mb", type=float, default=None, metavar="MB",
                        dest="video_budget_mb",
                        help="With an automatic bitrate, fill this file size (default: each shape's own budget "
                             "from the spec).")
    parser.add_argument("--nvenc", action="store_true",
                        help="Encode on the GPU (h264_nvenc); the compositing stays on the CPU.")
    add_short_clip_args(parser)


def controls_from_video_args(args) -> dict:
    return {
        "videoMusic": bool(args.video_music or args.video_track),
        "videoBackdrop": bool(args.video_backdrop or args.video_clip),
        "videoFps": args.video_fps,
        "videoBpm": args.video_bpm,
        "videoBitrate": args.video_bitrate,
        "videoBudgetMb": args.video_budget_mb,
        "videoPush": args.video_push,
        "videoCrossfade": args.video_crossfade,
        "nvenc": args.nvenc,
    }


def add_spotlight_args(parser) -> None:
    """The spotlight's flags, shared by the CLIs: off, a chosen strength
    in place of the measured dim, and a spread for the pool of light."""
    parser.add_argument("--no-spotlight", action="store_true",
                        help="Disable the adaptive spotlight dim behind the vehicle. See the core "
                             "(core/src/spotlight.rs) -- the dim is measured from the actual contrast, "
                             "so turning it off flattens light cars against light backdrops.")
    parser.add_argument("--spotlight-strength", type=float, default=None, metavar="FRACTION",
                        help="How hard the backdrop dims around the vehicle, 0-1 (default: measured from "
                             "the contrast between the vehicle and what sits behind it).")
    parser.add_argument("--spotlight-spread", type=float, default=None, metavar="FRACTION",
                        help="How far the pool of light reaches, as a fraction of the distance to the "
                             "farthest corner, 0.4-1 (default: 0.85). Smaller is a tighter spot.")


def controls_from_spotlight_args(args) -> dict:
    return {"spotlight": not args.no_spotlight, "spotStrength": args.spotlight_strength, "spotSpread": args.spotlight_spread}


def spotlight_style(options: dict) -> bool | dict:
    """The app's spotlight controls as what the core takes: False when
    off, True when on with the measured dim and the spec's spread, else
    {"strength", "spread"} with whichever levers are set."""
    return styles(options)["spotlight"]


GLOW_COLOR_NAMES = tuple(_spec.get("glow", "colors"))


def add_glow_args(parser) -> None:
    """The glow's flags, shared by the CLIs, with the Studio's defaults."""
    radius, intensity = _spec.control_default("glowRadius", 24), _spec.control_default("glowIntensity", 0.75)
    parser.add_argument("--glow", action=argparse.BooleanOptionalAction, default=bool(_spec.control_default("glow", False)),
                        help="A halo behind the vehicle's cutout (default: off).")
    parser.add_argument("--glow-color", default=_spec.control_default("glowColor", "white"),
                        type=color_choice(GLOW_COLOR_NAMES), metavar="COLOR",
                        help=f"The glow's colour: {', '.join(GLOW_COLOR_NAMES)}, or your own as #rrggbb (default: white).")
    parser.add_argument("--glow-radius", type=int, default=radius, help=f"Glow blur radius in pixels (default: {radius}).")
    parser.add_argument("--glow-intensity", type=float, default=intensity, help=f"Glow opacity, 0-1 (default: {intensity}).")


def add_margin_arg(parser) -> None:
    """The layout margin's flag, shared by the CLIs, with the Studio's default."""
    margin = _spec.control_default("margin", 0.06)
    parser.add_argument("--margin-frac", type=float, default=margin, metavar="FRAC",
                        help=f"Breathing room inside each layout box, as a fraction (default: {margin}).")


def controls_from_glow_args(args) -> dict:
    return {"glow": bool(args.glow), "glowColor": args.glow_color, "glowRadius": args.glow_radius,
            "glowIntensity": args.glow_intensity}


SHADOW_STRENGTH = float(_spec.control_default("shadowStrength", 0.5))


def add_shadow_args(parser) -> None:
    """The ground shadow's flags, shared by the CLIs."""
    parser.add_argument("--shadow", action=argparse.BooleanOptionalAction,
                        default=bool(_spec.control_default("shadow", False)),
                        help="A soft ground shadow under the vehicle, read off its own silhouette, so it "
                             "looks set down on the backdrop. On unless --no-shadow.")
    parser.add_argument("--shadow-strength", type=float, default=SHADOW_STRENGTH, metavar="FRACTION",
                        help=f"The shadow's darkness, 0-1 (default: {SHADOW_STRENGTH}).")


def controls_from_shadow_args(args) -> dict:
    return {"shadow": bool(args.shadow), "shadowStrength": args.shadow_strength}


def shadow_style(options: dict) -> dict | None:
    """The app's shadow controls as the core's `shadow` field, or None
    when no shadow is asked for."""
    return styles(options)["shadow"]


BACKDROPS = tuple(_spec.get("compose", "backdrops"))
# The kinds a colour of the user's own applies to; vehicle is the paint's.
COLOURED_BACKDROPS = tuple(_spec.get("compose", "colouredBackdrops"))


def add_backdrop_arg(parser) -> None:
    """The generated backdrop's kind and colour, shared by the CLIs. A
    photo (--photo-background) wins over both."""
    parser.add_argument("--backdrop", default="vehicle", choices=BACKDROPS,
                        help="The generated backdrop: 'vehicle', a gradient from the vehicle's own colours "
                             "(default); 'generic', seeded hue bands; 'sweep', a studio cyclorama in the "
                             "vehicle's colours with a lit floor line; 'radial', a halo pooled where the car "
                             "stands; 'horizon', two tones about a soft horizon. Ignored when "
                             "--photo-background is given.")
    parser.add_argument("--backdrop-color", default=None, metavar="HEX",
                        help="A colour of your own for the coloured backdrops (bands, sweep, halo, two-tone), "
                             "as #rrggbb or a colour word; the first stop (the wall, the centre). Without it "
                             "they take the vehicle's paint. The vehicle backdrop is always the paint's.")
    parser.add_argument("--backdrop-color2", default=None, metavar="HEX",
                        help="The second stop (the floor, the edge) when both are yours; with only one "
                             "colour given, its dark and light are used.")
    parser.add_argument("--backdrop-angle", type=float, default=None, metavar="DEG",
                        help="The direction of the paint gradient or the bands, in degrees; default seeded per image.")


def backdrop_color(options: dict) -> str | None:
    """The app's chosen backdrop colour, or None: only the coloured kinds
    take one; the vehicle backdrop is computed from the paint."""
    return styles(options)["backdrop"]["color"]


def backdrop_color2(options: dict) -> str | None:
    """The second chosen stop, or None."""
    return styles(options)["backdrop"]["color2"]


ANGLED_BACKDROPS = tuple(_spec.get("compose", "angledBackdrops"))


def backdrop_angle(options: dict) -> float | None:
    """A fixed direction for the linear backdrops, or None (seeded)."""
    return styles(options)["backdrop"]["angle"]


def piece_seed(kind: str, vehicle: dict | None, fallback: str, photo: str = "", fmt: str = "square") -> str:
    """The seed a generated backdrop is drawn with: the spec's compose.seeds
    template for this piece (still, hero, clip), filled exactly as the
    browser's lib/text.js pieceSeed fills it."""
    v = vehicle or {}
    template = _spec.get("compose", "seeds", kind, default="{vehicle}/{photo}/{format}")
    stem = photo.rsplit(".", 1)[0] if "." in photo else photo
    return (template.replace("{vehicle}", str(v.get("vin") or v.get("stock_number") or fallback))
            .replace("{photo}", stem).replace("{format}", fmt))


def backdrop_spec(kind: str, seed: str, exterior: str | None, interior: str | None,
                  color: str | None = None, color2: str | None = None, angle: float | None = None) -> dict:
    """The core's background field for a generated backdrop of `kind`
    (core/src/controls.rs): `color` and `color2` (#rrggbb or colour
    words) are the stops the coloured kinds draw from; `angle` fixes the
    linear kinds' direction. The vehicle backdrop takes only the angle."""
    try:
        return core.call({"op": "backdrop_spec", "kind": kind, "seed": seed, "exterior": exterior, "interior": interior,
                          "color": color, "color2": color2, "angle": angle})
    except RuntimeError as e:
        raise ValueError(str(e).split("failed: ", 1)[-1]) from None


def gradient_stops(kind: str, exterior: str | None, interior: str | None, color: str | None = None,
                   color2: str | None = None, sample_path: Path | None = None) -> tuple[tuple, tuple]:
    """The two stops a clip's turning gradient is drawn between, as a
    still's backdrop takes them (core/src/controls.rs): two colours of the
    user's own exactly for a coloured kind, one as its backdrop-safe dark
    and light, else the paint's, measured off `sample_path` when the record
    names no colour."""
    from PIL import Image

    op = {"op": "gradient_stops", "kind": kind, "exterior": exterior, "interior": interior,
          "color": color or None, "color2": color2 or None}
    images = []
    if sample_path is not None:
        op["sample"] = {"$image": 0}
        images.append(Image.open(sample_path).convert("RGBA"))
    a, b = core.call(op, images)
    return tuple(a), tuple(b)


REFLECTION_STRENGTH = float(_spec.control_default("reflectionStrength", 0.35))


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
    return styles(options)["reflection"]


def controls_from_text_args(args) -> dict:
    """argparse values -> the app's Text control keys."""
    return {
        "titleMode": args.title,
        "titleText": args.title_text,
        "priceBadge": bool(args.price_badge),
        "subtitle": args.subtitle,
        "textPosition": args.text_position,
        "textColor": args.text_color,
        "textSize": args.text_size,
        "textCase": args.text_case,
        "textBoxed": bool(args.text_boxed),
        "textShadow": not args.no_text_shadow,
        "subtitleSize": args.subtitle_size,
        "badgeSize": args.badge_size,
        "textFont": args.text_font,
        "titleFont": args.title_font, "titlePosition": args.title_position, "titleColor": args.title_color,
        "titleCase": args.title_case, "titleBox": args.title_box,
        "badgeFont": args.badge_font, "badgePosition": args.badge_position, "badgeColor": args.badge_color,
        "subtitleFont": args.subtitle_font, "subtitlePosition": args.subtitle_position, "subtitleColor": args.subtitle_color,
        "subtitleCase": args.subtitle_case, "subtitleBox": args.subtitle_box,
    }


def text_options(options: dict) -> dict:
    """The Text controls (app keys) as the core's plan fields."""
    return styles(options)["text"]


def fonts_in(text: dict) -> list[str]:
    """Every font the plan draws with: the shared one and each piece's own."""
    return _text_facts(text)["fonts"]


def ensure_fonts(text: dict) -> str:
    """Load every font the plan needs; returns the shared font's name."""
    for name in fonts_in(text):
        ensure_font(name)
    return text.get("font") or DEFAULT_FONT


def wants_text(text: dict) -> bool:
    return _text_facts(text)["wants_text"]


def text_request(vehicle: dict | None, text: dict) -> dict | None:
    """The Text controls and the vehicle as one compose-request field,
    with the font loaded, or None when no text is asked for. The core
    plans the words inside the frame's window itself, so a title never
    sits on the frame's art."""
    if not wants_text(text):
        return None
    font = ensure_fonts(text)
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
    font = ensure_fonts(text)
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
