"""
Animated version of compose_hero(): a looping video background (e.g. a
waving American flag) instead of a still, with a 3-slot CONVEYOR --
left accent, hero, right accent -- that continuously rotates through the
vehicle's whole shot library, timed to the beat of a looping audio track.

THE CONVEYOR: at any moment the 3 visible shots are simply 3 consecutive
entries of the (already front-to-rear ordered) shot list: left=shots[i-1],
hero=shots[i], right=shots[i+1]. Every bar, i advances by 1 and the whole
window slides. What makes this read as one continuous cycle instead of 3
independently-cutting slots is that each shot's OWN journey through the 3
slots is animated as a single throughline instead of 3 unrelated
crossfades:
  - The outgoing hero (shots[i]) doesn't just disappear -- it shrinks and
    moves into the left slot, becoming the new left accent.
  - The old left accent (shots[i-1]) fades out in place -- its journey
    ends here, it's been hero and left already.
  - The current right accent (shots[i+1]) grows and moves down into the
    hero slot, becoming the new hero.
  - A brand new shot (shots[i+2]) fades in at the right slot -- entering
    the conveyor for the first time.
Every shot's lifecycle is therefore: fade in at right -> grow into hero ->
shrink into left -> fade out. Confirmed this needed to be a real
position+scale morph, not independent alpha crossfades per slot -- an
earlier version faded new accent content in from nowhere (no visible
relationship to what was just on screen) and it read as random/jarring
rather than a cycle.

PAN, INTEGRATED WITH THE CONVEYOR: a shot whose native aspect is much
wider than the hero box (a side profile, mainly) fills the box's full
height and drives across it, entering and leaving past the frame edges.

The key is that EVERY appearance of a shot -- accent slot, static hero,
panning hero, and every intermediate frame of a morph -- is ONE rect:
where the whole, undistorted image is drawn. Nothing is ever clipped to a
sub-frame window. A pan is then just "draw wider than the frame and slide
it sideways," an accent is the same image drawn small, and the morph
between them is a plain interpolation of that single rect -- from the
exact frame steady playback left off at, to the exact frame it resumes
at, so there's no cut, no dissolve, and no pop at either boundary. The
vehicle is always whole; the frame's own edge (supplied by the border art
composited on top) is the only thing that ever hides part of it, which
reads as driving off screen.

Four earlier attempts are worth not repeating, all of them variations on
treating a pan as "an image inside a window":
  1. Interpolating the pan's window rect straight to an accent rect
     force-resized the image into shapes it doesn't have -- visible
     squish.
  2. A separate aspect-correct hero endpoint fixed the squish but landed
     the morph somewhere other than where the pan actually sits, so the
     hand-off popped.
  3. Cross-dissolving to hide that pop left the pan's edges gapped
     mid-transition.
  4. Carrying a real clip window (correct while the window WAS the frame)
     dragged a hard vertical edge across the vehicle's body the moment
     that window began shrinking toward the accent slot -- a truck cut in
     half in mid-frame.
The fix for all four is the same: there is no window. Draw the whole
thing and let it leave the frame.

Pan direction is set so the vehicle slides the way it FACES, which is
what reads as driving forward -- the cutout is a sprite over a static
flag, so it is the moving object; a right-facing vehicle sliding left
reads as reversing, however natural "reveal the tail then the hood"
sounds in the abstract. Which way any given photo faces is detected, not
assumed -- see imaging/classify.py::detect_hood_side(); confirmed real
need, since this vehicle's own two side shots face opposite ways.

MUSICAL TIMING CONTRACT: the audio file passed in MUST be a clean,
seamlessly-looping BARS_PER_LOOP-bar segment (4 by default) for the bar/
beat math below to land on the actual music -- there's no beat detection
here, just audio_loop_seconds / 4 bars / 4 beats-per-bar. A file that
isn't a clean 4-bar loop will make the conveyor's cuts and the hero's
pump drift off the actual downbeats. This is a real constraint on the
input, not an implementation detail to work around -- see
probe_duration_s().

Rendering strategy:
  - Every shot's placement (resized + collision-resolved position) in
    each of the 3 boxes is precomputed ONCE per shot -- 3 placements x N
    shots, not per frame.
  - During the STEADY portion of each bar (most of it), the 3 layers
    (left/hero/right) are simple pastes at their precomputed positions --
    cheap. Only the beat pulse (hero only) needs a live per-frame resize.
  - During the TRANSITION portion (the last `crossfade` seconds of each
    bar), all 4 moving/fading elements are recomposited live -- 2 morphs
    (resize from the shot's own full-res image at the current interpolated
    box size, not from an already-downscaled version, to avoid
    double-resampling) and 2 alpha fades (cheap: reuse the precomputed
    resting-size image, just scale its alpha channel).
  - The flag clip's own frames are decoded and cover-cropped to the canvas
    size ONCE, then reused via modulo indexing no matter how long the
    final video runs.
Frames are streamed to ffmpeg over a pipe as raw rgb24 rather than written
to disk as an intermediate PNG sequence.
"""
from __future__ import annotations

import math
import statistics
import subprocess
from pathlib import Path

from PIL import Image

from .effects import DEFAULT_GLOW_COLOR
from ... import spec as _spec
from ... import core
from .layout import LAYOUTS, conveyor_for_window
from ..classify import detect_hood_side

AUDIO_BITRATE_KBPS = 128

# See the module docstring's MUSICAL TIMING CONTRACT -- these aren't tuned
# constants, they're the definition of "a bar" and "a beat" given a clean
# N-bar loop, so changing them means "the input has a different bar/beat
# count," not "make the pacing faster/slower."
BARS_PER_LOOP = int(_spec.get("video", "barsPerLoop"))
BEATS_PER_BAR = int(_spec.get("video", "beatsPerBar"))

MIN_TRANSITION_S = _spec.get("video", "minTransitionS")
MAX_TRANSITION_S = _spec.get("video", "maxTransitionS")
TRANSITION_FRAC = _spec.get("video", "transitionFrac")  # fraction of a bar spent on the 4-way conveyor morph


# The beat "pump": a quick scale-up on the beat that snaps back down --
# real punch, not a slow sine wave. 0.035 (3.5%) is deliberately
# conservative: quad_layout()/corners_layout() leave a ~2%-of-window-height
# gap between the hero box and the accent row above it (their own
# `round(wh * 0.02)`), and on this border's real geometry that gap works
# out to ~4% of a typical hero rect's height -- so the pulse's peak
# growth, symmetric around the hero's own center, stays under that gap
# with margin to spare rather than reaching back into the accents, which
# is the exact bug the hero box bounds fix (layout.py) exists to prevent.
PULSE_STRENGTH = _spec.get("video", "pulseStrength")
PULSE_DECAY = _spec.get("video", "pulseDecay")

# A hero cutout whose native aspect ratio is much wider than the hero
# box's -- a side profile, mainly -- would otherwise be letterboxed (fit
# to width, lots of dead space above/below). Past this much extra width
# (at fill-to-height scale) it instead fills the box's full height and
# pans edge-to-edge across during its STEADY (non-transitioning) hold.
MIN_PAN_OVERFLOW_FRAC = _spec.get("video", "minPanOverflowFrac")

# Only this angle pans -- see core/src/carousel.rs.
PAN_ANGLE_LABEL = _spec.get("video", "panAngleLabel")

# Fallbacks for the pieces that are now optional. DEFAULT_BPM is not an
# arbitrary pick: the original 4-bar loop measures 9.606s, i.e. 2.4015s a
# bar and 0.6s a beat -- exactly 100 BPM. So a music-less render at the
# default keeps the identical cut and pump cadence the scored one had.
DEFAULT_BPM = float(_spec.get("video", "defaultBpm"))
DEFAULT_FPS = float(_spec.get("video", "fps"))
DEFAULT_CANVAS_SIZE = (1254, 1254)

# One edit, three frames. The choreography is identical in all of them --
# same shot order, same bar-locked cuts, same pan behaviour, same pump on
# the kick; only the blocking changes, because the blocking is the part
# that depends on the frame's shape (see layout.py::conveyor_for_window).
#
# Budgets are the square's 50MB scaled by pixel count, so every format
# gets the same bits per pixel as the canvas the look was tuned on. The
# 50MB figure is a MARKETPLACE limit and applies only to the square;
# Reels, Shorts and TikTok all allow far more, so inheriting it there
# would have meant paying for a constraint that doesn't exist.
# From shared/pipeline-spec.json, so the browser client renders the same
# shapes at the same budgets -- see src/lotstretcher/spec.py.
VIDEO_FORMATS = {
    name: {"canvas": tuple(f["size"]), "budget_mb": f["budget_mb" if "budget_mb" in f else "budgetMb"],
            "note": f["note"]}
    for name, f in _spec.get("videoFormats", "formats", default={}).items()
}
DEFAULT_VIDEO_FORMAT = _spec.get("videoFormats", "default", default="square")
# Full rotations the generated gradient sweeps through over the whole
# video. The backdrop has to keep moving now that there's no waving flag
# doing it -- a static gradient behind a static accent row reads as a
# still image with a car twitching on it.
GRADIENT_TURNS = _spec.get("video", "gradientTurns")

# The pan runs from "nose centered in the frame" to "tail centered": the
# vehicle drives through, entering and leaving past the frame's edges.
# Most of it is off-frame at each endpoint, which is the point -- it
# reads as a vehicle driving past, not as a cropped photo.
#
# Nothing is ever CLIPPED to a sub-frame window, though, and that
# distinction is the whole ballgame. A vehicle continuing past the
# frame's own edge reads as driving off screen; a vehicle cut by a hard
# vertical edge in the MIDDLE of the frame reads as broken. An earlier
# version clipped the hero to a window rect that shrank toward the accent
# slot during the transition, which dragged exactly such an edge across
# the truck's body -- see _render(), which no longer clips at all.
PAN_BARS = int(_spec.get("video", "panBars"))

# How much of each layout box is left as breathing room. Much tighter
# than compute_placement()'s 0.06 still-image default: a still is looked
# at, so it can afford air, but a frame that's on screen for two seconds
# wants to read big, and the inset was being paid twice (once around the
# accent boxes, once around the hero) which measurably emptied the frame.
HERO_MARGIN_FRAC = _spec.get("video", "heroMarginFrac")
ACCENT_MARGIN_FRAC = _spec.get("video", "accentMarginFrac")


def probe_duration_s(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True,
    )
    return float(out.stdout.strip())


def probe_fps(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate",
         "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True,
    )
    num, _, den = out.stdout.strip().partition("/")
    return float(num) / float(den or 1)


# How far under the stated cap to actually aim. The 3% container
# allowance below is an ESTIMATE of muxing overhead, not a safety margin,
# and treating it as one left almost none: measured across the fleet's 40
# square renders, the largest was 46.50MB against Marketplace's 50MB and
# five were above 46MB. That is a 7% cushion absorbing every source of
# error at once -- a rate-control overshoot, a container that muxes fatter
# than estimated, or a platform that measures the limit differently than
# we do. 10% costs about 0.5dB of bitrate, which is invisible on this
# content, and buys a margin that is actually a margin.
SIZE_SAFETY_FRAC = _spec.get("video", "sizeSafetyFrac")


def compute_video_bitrate_kbps(total_seconds: float, budget_mb: float = 50.0,
                                audio_kbps: int = AUDIO_BITRATE_KBPS,
                                container_overhead_frac: float = 0.03,
                                safety_frac: float = SIZE_SAFETY_FRAC,
                                min_kbps: int = 4000, max_kbps: int = 20000) -> int:
    """Video bitrate that fills (but doesn't exceed) budget_mb once audio,
    a container-overhead estimate and a safety margin are accounted for.
    Clamped at the top too -- 1080-ish square H.264 doesn't visibly improve
    much past ~20Mbps, so a short video shouldn't request an absurd
    bitrate just because the budget technically allows it.

    The bottom clamp is what would actually break the budget: at min_kbps
    a video longer than about 105s exceeds 50MB no matter what this
    returns. Our longest pass is a shot per bar at 2.4s, so that needs ~44
    cutouts and cannot happen on real inventory -- but it is the failure
    mode to check first if a file ever comes out over.
    """
    budget_bits = budget_mb * 1024 * 1024 * 8 * (1 - container_overhead_frac) * (1 - safety_frac)
    audio_bits = audio_kbps * 1000 * total_seconds
    video_kbps = (budget_bits - audio_bits) / total_seconds / 1000
    return int(max(min_kbps, min(max_kbps, video_kbps)))


def _trim_dark_edges(frames: list, threshold_frac: float = 0.5) -> list:
    """Drop a leading/trailing run of anomalously dark frames -- confirmed
    real on a real stock flag loop, whose very last frame (of 176) was
    pure black (mean luminance 0.0 against ~130-140 for every neighbor),
    flashing black every ~7s on loop. Only trims from the two ends, never
    the interior."""
    import numpy as np

    brightness = [float(np.asarray(f).mean()) for f in frames]
    med = statistics.median(brightness)
    threshold = med * threshold_frac
    lo, hi = 0, len(frames)
    while lo < hi and brightness[lo] < threshold:
        lo += 1
    while hi > lo and brightness[hi - 1] < threshold:
        hi -= 1
    return frames[lo:hi]


def _cover_fit(img: Image.Image, canvas_size: tuple[int, int]) -> Image.Image:
    """CSS background-size: cover, resampled by the core."""
    cw, ch = canvas_size
    scale = max(cw / img.width, ch / img.height)
    nw, nh = max(cw, round(img.width * scale)), max(ch, round(img.height * scale))
    resized = core.resize(img.convert("RGB"), nw, nh)
    left, top = (nw - cw) // 2, (nh - ch) // 2
    return resized.crop((left, top, left + cw, top + ch))


def _read_bg_frames(video_path: Path, canvas_size: tuple[int, int]) -> list[Image.Image]:
    """Decode every frame of the background clip ONCE, drop any broken
    dark frame(s) at the loop seam, then cover-crop each to canvas_size."""
    import cv2

    cap = cv2.VideoCapture(str(video_path))
    raw = []
    try:
        while True:
            ok, bgr = cap.read()
            if not ok:
                break
            raw.append(bgr[:, :, ::-1])
    finally:
        cap.release()
    if not raw:
        raise ValueError(f"Could not decode any frames from {video_path}")

    raw = _trim_dark_edges(raw)
    if not raw:
        raise ValueError(f"All frames in {video_path} were anomalously dark after trimming")
    return [_cover_fit(Image.fromarray(rgb), canvas_size) for rgb in raw]


_SCALED_CACHE: dict = {}
_SCALED_CACHE_MAX = 48


def _scaled(car: int, w: int, h: int) -> int:
    """The shot's car at (w, h), resampled by the core, kept resident in
    the core, and memoized on size, not position: a pan slides the same
    bitmap and the beat pulse cycles through the same handful of integer
    sizes, so the core resamples once per size and then pastes a car it
    already holds at the rectangle's size, with no pixels crossing the
    boundary for it. Bounded because a hero-sized entry is a few MB."""
    key = (car, w, h)
    held = _SCALED_CACHE.pop(key, None)
    if held is None:
        if len(_SCALED_CACHE) >= _SCALED_CACHE_MAX:
            core.release(_SCALED_CACHE.pop(next(iter(_SCALED_CACHE))))
        held = core.retain(core.resize(car, w, h))
    # Least recently USED goes first: a hit moves to the back, so the
    # cars a frame has already looked up can never be the ones evicted
    # to make room for the rest of that same frame.
    _SCALED_CACHE[key] = held
    return held


def _clear_scaled() -> None:
    for held in _SCALED_CACHE.values():
        core.release(held)
    _SCALED_CACHE.clear()


def _car_at(car: int, draw_rect, alpha: float) -> tuple:
    """A render_frame car entry for `car` drawn at draw_rect."""
    dx, dy, dw, dh = draw_rect
    w, h = max(1, round(dw)), max(1, round(dh))
    return (_scaled(car, w, h), round(dx), round(dy), w, h, alpha)


def render_hero_video(background_video: Path | None, border_path: Path | None, carousel_paths: list[Path],
                       audio_path: Path | None, out_path: Path, carousel_labels: list[str] | None = None,
                       gradient_colors: tuple | None = None, bpm: float = DEFAULT_BPM,
                       fps: float = DEFAULT_FPS, canvas_size: tuple[int, int] = DEFAULT_CANVAS_SIZE,
                       loops: int | None = None, budget_mb: float = 50.0, layout: str = "conveyor", n_accents: int = 2,
                       bars_per_loop: int = BARS_PER_LOOP,
                       glow: bool = True, glow_color=DEFAULT_GLOW_COLOR,
                       glow_radius: int = 24, glow_intensity: float = 0.75,
                       border_fit: str = "fit",
                       text: dict | None = None, vehicle: dict | None = None,
                       background_image: Path | None = None,
                       border_style: dict | None = None,
                       shadow: dict | None = None,
                       reflection: dict | None = None,
                       backdrop_spec: dict | None = None,
                       encoder: str = "libx264",
                       hood_sides: dict[str, str] | None = None,
                       target_duration_s: float | None = None) -> dict:
    """
    carousel_paths: the FULL shot library, in conveyor order (see
    imaging/select.py::pick_all_for_carousel() -- deliberately not deduped
    to one-per-angle, the whole point of the conveyor is to show
    everything). carousel_labels is currently unused by the conveyor
    itself (kept for API compatibility / future use) since slot
    membership is now pure positional adjacency, not a diversity search.
    loops: how many audio loops long the video runs (audio duration is
    probed, not assumed -- see probe_duration_s()).

    Returns a small report dict (duration, bitrate, timing) for logging.
    """
    if layout != "conveyor" or n_accents != 2:
        raise ValueError("the conveyor is a 3-slot design (left/hero/right) -- layout must be "
                          f"'conveyor' with n_accents=2, got layout={layout!r} n_accents={n_accents!r}")
    if len(carousel_paths) < 3:
        raise ValueError("need at least 3 shots for a left/hero/right conveyor")

    if background_video is None and background_image is None and gradient_colors is None:
        raise ValueError("need a background_video, a background_image or gradient_colors to draw a backdrop")

    # The format decides the canvas; a frame of another shape is fitted
    # to it (compose::fit_border), and the car window follows the fit.
    border = Image.open(border_path).convert("RGBA") if border_path is not None else None
    if border is not None:
        border, window = core.fit_border(border, canvas_size[0], canvas_size[1], border_fit)
    elif border_style is not None:
        # The core's own frame, drawn at this format's size; its "paint"
        # colour comes off the first shot when the record names none.
        border = core.draw_frame(canvas_size[0], canvas_size[1], border_style, vehicle,
                                 sample=Image.open(carousel_paths[0]).convert("RGBA"))
        window = tuple(core.detect_window(border))
    else:
        window = (0, 0, canvas_size[0], canvas_size[1])
    # The still's text on every frame: planned once inside the window,
    # and the cars laid out clear of its band.
    from ..text import plan_overlays, text_window
    overlays = plan_overlays(canvas_size[0], canvas_size[1], vehicle, text or {}, window,
                             sample=Image.open(carousel_paths[0]).convert("RGBA"))
    window = text_window(window, canvas_size[1], overlays)

    # "conveyor" means the conveyor arrangement that suits this frame, not
    # one specific function -- a vertical canvas needs its slots stacked
    # (layout.py::conveyor_stack_layout). An explicit layout name still
    # wins, so a caller can force either arrangement.
    layout_fn = conveyor_for_window(window) if layout == "conveyor" else LAYOUTS[layout]
    boxes = layout_fn(window, n_accents)
    (hero_box, hero_anchor), (left_box, left_anchor), (right_box, right_anchor) = boxes

    # The audio used to be the clock as well as the soundtrack. Without
    # it, a bar is derived from bpm instead, so every downstream timing
    # (cut, transition, pump) is unchanged in kind -- only its source
    # moves. `loops` still means "how many loop-lengths long", scored or not.
    if audio_path is not None:
        audio_loop_s = probe_duration_s(audio_path)
    else:
        audio_loop_s = bars_per_loop * BEATS_PER_BAR * 60.0 / bpm
    if background_video is not None:
        fps = probe_fps(background_video)

    # A still photo behind the clip is one backdrop frame held for the
    # whole clip; the core cover-fits it to the canvas as it draws.
    # A generated backdrop other than the turning gradient (a sweep, hue
    # bands) is drawn once by the core and held, like a photo; its paint
    # is read off the first shot when the record names none.
    bg_frames = (_read_bg_frames(background_video, canvas_size) if background_video is not None
                 else [Image.open(background_image).convert("RGB")] if background_image is not None
                 else [core.call({"op": "render_frame", "width": canvas_size[0], "height": canvas_size[1],
                                  "background": {**backdrop_spec, "sample": {"$image": 0}}, "cars": []},
                                 [Image.open(carousel_paths[0]).convert("RGBA")])]
                 if backdrop_spec is not None and backdrop_spec.get("kind") != "vehicle"
                 else None)
    # One representative backdrop frame for the spotlight's contrast
    # measurement (compute_dim_strength) -- it only needs a sample of
    # what sits behind the car, not the animation.
    representative_bg = (bg_frames[0] if bg_frames is not None
                          else core.linear_gradient(canvas_size[0], canvas_size[1], *gradient_colors))
    # Fresh per call: the cache is keyed by the core's id for each cutout,
    # which a later call re-retains under a new id, so nothing can hit a
    # stale entry; clearing also gives the core the memory back.
    _clear_scaled()

    n = len(carousel_paths)
    # The choreography is the core's (core/src/carousel.rs): schedule,
    # pan geometry, spotlight measurement, all of it. This host supplies
    # the cutouts, which way each nose faces, and the clock.
    cars_rgba = [Image.open(p).convert("RGBA") for p in carousel_paths]
    # Everything a frame draws from stays resident in the core for the
    # clip: the cutouts (scaled copies come off them), the border, and
    # every flag frame. A frame request then carries ids, not pixels.
    held: list[int] = []
    sides = []
    for i, p in enumerate(carousel_paths):
        side = hood_sides.get(p.name) if hood_sides else None
        pannable = (carousel_labels[i] == PAN_ANGLE_LABEL) if carousel_labels else True
        if side is None and pannable:
            # A gallery scraped before angles.json carried hood_side:
            # one live CLIP call, the same one photos.py makes at cutout
            # time for every newer gallery.
            import io as _io
            buf = _io.BytesIO()
            cars_rgba[i].save(buf, format="PNG")
            side = detect_hood_side(buf.getvalue())
        sides.append((pannable, side))
    images = [representative_bg] + ([border] if border is not None else []) + cars_rgba
    first_car = 2 if border is not None else 1
    plan = core.call({
        "op": "carousel_plan", "width": canvas_size[0], "height": canvas_size[1],
        "backdrop": {"$image": 0}, **({"border": {"$image": 1}} if border is not None else {}),
        "shots": [{"image": {"$image": first_car + i}, "pannable": pannable, "hood_side": side}
                  for i, (pannable, side) in enumerate(sides)],
        "audio_loop_s": audio_loop_s, "bars_per_loop": bars_per_loop, "window": list(window),
    }, images)
    shots = plan["shots"]
    schedule, carousel_period = [tuple(x) for x in plan["schedule"]], plan["period"]
    # The timing is the plan's: dwell (one bar), the morph's length and
    # the beat, all from the loop's own measured length.
    dwell, transition_s, beat_s = plan["dwell"], plan["transition_s"], plan["beat_s"]
    cars_held = [core.retain(c) for c in cars_rgba]
    held += cars_held
    border_held = core.retain(border) if border is not None else None
    if border_held is not None:
        held.append(border_held)
    if bg_frames is not None:
        bg_frames = [core.retain(f) for f in bg_frames]
        held += bg_frames

    # Default length is ONE full pass of the shot library: the conveyor
    # has nothing new to show after that, and a run that stops there
    # can't strand a vehicle's last angles off the end (the old
    # loops-of-audio length was set by the soundtrack, which knows
    # nothing about how many photos this vehicle has). `loops` still
    # forces the old audio-driven length when given.
    if target_duration_s is not None:
        # --video-duration. With music the carousel is beat-synced, so
        # the length rounds to whole audio loops; without it, exact.
        if audio_path is not None:
            loops = max(1, round(target_duration_s / audio_loop_s))
            total_seconds = audio_loop_s * loops
        else:
            total_seconds = max(target_duration_s, 1.0 / fps)
    else:
        total_seconds = carousel_period if loops is None else audio_loop_s * loops

    total_frames = round(total_seconds * fps)
    total_seconds = total_frames / fps  # snap to an exact frame count
    bitrate_kbps = compute_video_bitrate_kbps(
        total_seconds, budget_mb=budget_mb,
        audio_kbps=AUDIO_BITRATE_KBPS if audio_path is not None else 0)

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    log_path = out_path.with_suffix(".ffmpeg.log")

    def _run_encode(enc: str) -> None:
        """Streams every frame to one ffmpeg process using encoder `enc`.
        Raises RuntimeError if ffmpeg exits nonzero -- including a hardware
        encoder (h264_nvenc) that failed to even open (GPU out of memory,
        or the driver's concurrent-session cap), which otherwise surfaces
        first as a BrokenPipeError on some later stdin.write() once ffmpeg
        has already given up and exited. That write-time symptom is caught
        here and folded into the same "ffmpeg exited nonzero" path so the
        caller only has one failure mode to handle."""
        cmd = [
            "ffmpeg", "-y",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{canvas_size[0]}x{canvas_size[1]}",
            "-r", str(fps), "-i", "pipe:0",
        ]
        if audio_path is not None:
            cmd += ["-stream_loop", "-1", "-i", str(audio_path), "-map", "0:v", "-map", "1:a"]
        cmd += [
            "-c:v", enc, "-preset", "medium", "-b:v", f"{bitrate_kbps}k",
            "-maxrate", f"{int(bitrate_kbps * 1.2)}k", "-bufsize", f"{int(bitrate_kbps * 2)}k",
            "-pix_fmt", "yuv420p",
        ]
        if audio_path is not None:
            cmd += ["-c:a", "aac", "-b:a", f"{AUDIO_BITRATE_KBPS}k"]
        cmd += ["-t", f"{total_seconds:.3f}", str(out_path)]

        with open(log_path, "w") as logf:
            proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=logf)
            try:
                for f in range(total_frames):
                    t = f / fps
                    fo = core.call({"op": "carousel_frame", "plan": plan, "t": t})
                    hero = shots[fo["hero"]]
                    if bg_frames is not None:
                        background, bg_frame = {"kind": "image"}, bg_frames[f % len(bg_frames)]
                    else:
                        # Rotating rather than looping: a generated backdrop has
                        # no seam to hide, so it can just keep turning. The core
                        # draws it in place; no pixels travel for it.
                        background, bg_frame = {
                            "kind": "linear",
                            "angle": gradient_colors[0] + GRADIENT_TURNS * 360.0 * (f / max(1, total_frames)),
                            "start": list(gradient_colors[1]), "end": list(gradient_colors[2]),
                        }, None
                    cars = [_car_at(cars_held[c["shot"]], c["rect"], c["alpha"]) for c in fo["cars"]]
                    canvas = core.render_frame(
                        cars, canvas_size[0], canvas_size[1], background, background_image=bg_frame,
                        border=border_held, spotlight=(hero["center"][0], hero["center"][1], hero["dim"]),
                        glow=glow, glow_color=str(glow_color), glow_radius=glow_radius,
                        glow_intensity=glow_intensity, overlays=overlays, shadow=shadow,
                        reflection=reflection)
                    try:
                        proc.stdin.write(canvas.tobytes())
                    except BrokenPipeError:
                        # ffmpeg already exited (most often the encoder failed
                        # to open) -- stop feeding it, the exit-code check
                        # below is what actually reports the failure.
                        break
            finally:
                proc.stdin.close()
                ret = proc.wait()
                _clear_scaled()

        if ret != 0:
            raise RuntimeError(f"ffmpeg failed (exit {ret}) -- see {log_path}")

    # h264_nvenc shares this machine's single GPU with CLIP/rembg (running
    # concurrently on other vehicles/workers) and with every other video
    # worker's own encoder session -- under real load it can fail to open
    # at all (CUDA out of memory) rather than degrade gracefully. Losing an
    # entire hero video to transient GPU pressure is worse than a slower
    # software encode, so fall back to libx264 once rather than surface
    # the failure -- this is what actually guarantees a video comes out of
    # every call, independent of how busy the GPU is when it runs.
    enc_used = encoder
    try:
        try:
            _run_encode(encoder)
        except RuntimeError:
            if encoder == "libx264":
                raise
            enc_used = "libx264"
            _run_encode("libx264")
    finally:
        for image_id in held:
            core.release(image_id)

    log_path.unlink(missing_ok=True)

    return {
        "out_path": str(out_path),
        "encoder": enc_used,
        "duration_s": round(total_seconds, 2),
        "fps": fps,
        "total_frames": total_frames,
        "n_shots": n,
        "shot_order": [p.name for p in carousel_paths],
        "pan_shots": {carousel_paths[i].name: f"hood {sides[i][1]} -> slides "
                                              f"{'right' if s['pan_x_end'] > s['pan_x_start'] else 'left'}, {s['bars']} bars"
                       for i, s in enumerate(shots) if s["is_pan"]},
        "carousel_period_s": round(carousel_period, 2),
        # Frame-rounding can leave total_seconds a hair under the
        # period; only flag a pass that is really cut short.
        "carousel_incomplete": carousel_period > total_seconds + 0.5 / fps,
        "audio_loop_s": round(audio_loop_s, 3),
        "bars_per_loop": bars_per_loop,
        "clock": "audio" if audio_path is not None else f"{bpm:g} bpm",
        "backdrop": "video" if background_video is not None else "photo" if background_image is not None
        else backdrop_spec["kind"] if backdrop_spec is not None else "gradient",
        "framed": border is not None,
        "bar_dwell_s": round(dwell, 3),
        "beat_s": round(beat_s, 3),
        "transition_s": round(transition_s, 2),
        "bitrate_kbps": bitrate_kbps,
        "file_size_mb": round(out_path.stat().st_size / (1024 * 1024), 2),
    }
