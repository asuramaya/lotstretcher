"""
A rotating "spin" video from a vehicle's own real angle-labeled cutouts --
the used-inventory-appropriate alternative to a licensed generic 3D CAD
model (right for new inventory, wrong for used: it shows the SKU, not the
actual physical car with its actual wear).

WHAT THIS IS NOT: true 3D reconstruction (photogrammetry / NeRF / Gaussian
Splatting) of the real vehicle. That's confirmed research-stage industry-
wide as of 2025-2026 (see decision 1449fdef, lotstretcher project graph) -- even
the field's own state of the art needed a purpose-built moving-vehicle
capture rig, not reprocessing of static lot photos. Nobody ships that at
scale yet, lotstretcher included.

WHAT THIS IS: the same class of trick CarCutter's own documented "NextGen
360" actually uses -- synthesize a smooth rotation from a HANDFUL of real
photos rather than requiring a turntable shoot. CarCutter's version works
from 4 photos (front/rear/left/right) with a trained view-interpolation
model. This version is classical, not learned: cross-dissolve between the
real angle-labeled cutouts already sitting in a vehicle's cutout gallery
(lotstretcher typically has 5 distinct angles per vehicle -- front, front_3q,
side, rear_3q, rear -- MORE real anchor frames than CarCutter's own
baseline), scaled/anchored to a consistent canvas position so the car
doesn't visibly jump or resize between shots. It reads as a rotation, not
a slideshow, but it is honest about being an interpolation between real
photos rather than a synthesized new viewpoint -- there is no attempt to
paint in geometry the source photos don't show.

SCOPE: one side's half-turn (front through rear along whichever side has
the fuller angle coverage), not a full 360 -- completing the other side
needs real photos of it, which isn't guaranteed per vehicle. Extending to
a full loop (this side, then a hard cut/dissolve to the mirrored return)
is a reasonable next step once this baseline is validated against real
output.
"""
from __future__ import annotations

import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path

from PIL import Image

from ... import core
from ... import spec as _spec

# From shared/pipeline-spec.json (the `spin` block), which core/src/spin.rs
# embeds: the same numbers drive both surfaces. The angle order is
# front-to-rear geometric, NOT the carousel's reveal order -- a spin has
# to read as continuous rotation, so it has to be monotonic.
SPIN_ANGLE_ORDER: list[str] = list(_spec.get("spin", "angleOrder"))
DEFAULT_CANVAS_SIZE = (_spec.get("spin", "canvasSize"), _spec.get("spin", "canvasSize"))
DEFAULT_FPS = float(_spec.get("spin", "fps"))
MIN_ANCHORS = int(_spec.get("spin", "minAnchors"))
DEFAULT_BUDGET_MB = float(_spec.get("spin", "budgetMb"))


def order_for_spin(cutout_dir: Path) -> list[tuple[Path, str]]:
    """Best (highest-confidence) real cutout per angle, in geometric
    front-to-rear order. Angles the vehicle doesn't have a shot for are
    just absent -- interpolating between whatever IS there is still
    honest; inventing a missing anchor would not be."""
    from ..select import load_angles

    cutout_dir = Path(cutout_dir)
    angles = load_angles(cutout_dir)
    if not angles:
        return []

    best: dict[str, tuple[str, float]] = {}
    for filename, info in angles.items():
        label, conf = info["angle"], info["confidence"]
        if label not in best or conf > best[label][1]:
            best[label] = (filename, conf)

    return [(cutout_dir / best[label][0], label) for label in SPIN_ANGLE_ORDER if label in best]


def plan_spin(cutouts: list[Image.Image], canvas_size: tuple[int, int], fps: float | None = None) -> dict:
    """The core's plan: one rect per anchor (one height, one ground line),
    the hold and dissolve lengths in frames, and the spotlight."""
    return core.call({"op": "spin_plan", "width": canvas_size[0], "height": canvas_size[1], "fps": fps,
                      "anchors": [{"width": c.width, "height": c.height} for c in cutouts]})


def render_spin_frames(cutouts: list[Image.Image], gradient_colors: tuple, canvas_size: tuple[int, int],
                       fps: float | None = None) -> Iterator[Image.Image]:
    """Every frame of the spin, RGB, in order. The core decides the
    schedule, places each anchor once into a canvas-sized layer, and
    dissolves between layers; this host only walks the frame count."""
    plan = plan_spin(cutouts, canvas_size, fps)
    w, h = canvas_size
    base_angle, start, end = gradient_colors
    # The layers and the backdrop stay resident in the core for the
    # whole clip: a frame is a request naming them by id, and the only
    # pixels that cross the boundary are the finished frame's. The
    # backdrop never turns in a spin, so it is rendered once.
    held: list[int] = []
    try:
        layers = []
        for c, rect in zip(cutouts, plan["rects"]):
            layer = core.retain(core.call({"op": "place_layer", "image": {"$image": 0}, "width": w, "height": h,
                                           "rect": rect}, [c.convert("RGBA")]))
            held.append(layer)
            layers.append(layer)
        backdrop = core.retain(core.render_frame([], w, h, {"kind": "linear", "angle": base_angle,
                                                            "start": list(start), "end": list(end)},
                                                 spotlight=tuple(plan["spotlight"])))
        held.append(backdrop)
        for f in range(plan["total_frames"]):
            at = core.call({"op": "spin_frame", "plan": plan, "frame": f})
            mix = None if at["next"] is None else (layers[at["next"]], at["tau"])
            yield core.render_frame([(layers[at["index"]], 0, 0, w, h, 1.0, mix)], w, h, {"kind": "image"},
                                    background_image=backdrop)
    finally:
        for image_id in held:
            core.release(image_id)


def render_spin_video(cutout_dir: Path, out_path: Path, gradient_colors: tuple,
                       canvas_size: tuple[int, int] = DEFAULT_CANVAS_SIZE,
                       fps: float = DEFAULT_FPS, budget_mb: float = DEFAULT_BUDGET_MB,
                       encoder: str = "libx264") -> dict | None:
    """Renders the spin and encodes it to `out_path`. Returns a small
    report dict, or None if there aren't enough real angles to make a
    spin worth producing (see MIN_ANCHORS) -- not an error, just not
    every vehicle's gallery has the coverage for this yet.

    Mirrors hero_video.py's render_hero_video()'s own encoder-fallback
    contract on purpose (retry once with libx264 if a hardware encoder
    fails to open under GPU pressure).
    """
    anchors = order_for_spin(cutout_dir)
    if len(anchors) < MIN_ANCHORS:
        return None

    cutouts = [Image.open(p).convert("RGBA") for p, _label in anchors]
    plan = plan_spin(cutouts, canvas_size, fps)
    total_frames, total_seconds = plan["total_frames"], plan["total_seconds"]
    n = len(cutouts)

    overhead = float(_spec.get("spin", "containerOverheadFrac"))
    bitrate_kbps = round((budget_mb * 8192) / total_seconds * overhead)

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    log_path = out_path.with_suffix(".ffmpeg.log")

    def _run_encode(enc: str) -> None:
        cmd = [
            "ffmpeg", "-y",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{canvas_size[0]}x{canvas_size[1]}",
            "-r", str(fps), "-i", "pipe:0",
            "-c:v", enc, "-preset", "medium", "-b:v", f"{bitrate_kbps}k",
            "-maxrate", f"{int(bitrate_kbps * 1.2)}k", "-bufsize", f"{int(bitrate_kbps * 2)}k",
            "-pix_fmt", "yuv420p", "-t", f"{total_seconds:.3f}", str(out_path),
        ]
        with open(log_path, "w") as logf:
            proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=logf)
            try:
                for frame in render_spin_frames(cutouts, gradient_colors, canvas_size, fps):
                    try:
                        proc.stdin.write(frame.tobytes())
                    except BrokenPipeError:
                        break
            finally:
                proc.stdin.close()
                ret = proc.wait()
        if ret != 0:
            raise RuntimeError(f"ffmpeg failed (exit {ret}) -- see {log_path}")

    enc_used = encoder
    try:
        _run_encode(encoder)
    except RuntimeError:
        if encoder == "libx264":
            raise
        print(f"    ! {encoder} failed for spin video, retrying with libx264", file=sys.stderr)
        enc_used = "libx264"
        _run_encode("libx264")

    log_path.unlink(missing_ok=True)
    return {
        "out_path": str(out_path),
        "encoder": enc_used,
        "duration_s": round(total_seconds, 2),
        "n_anchors": n,
        "frames": total_frames,
        "angles": [label for _p, label in anchors],
        "file_size_mb": round(out_path.stat().st_size / (1024 * 1024), 2),
    }
