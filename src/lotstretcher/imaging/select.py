"""
Auto-select hero + accent photos for imaging/compose from a vehicle's
images/exterior/cutout/angles.json (see classify.py's AngleClassifier and
cli.py's download_photos, which writes that file).

The picking itself is the core's (core/src/select.rs, op `select_shots`),
the same code that orders the browser's run; this module reads
angles.json, globs the folder when there is none, and adds the wheel
money shots. The priorities are the spec's `select` block.

pick_for_layout() is the one entrypoint most callers want -- routes to the
right picker for a given imaging/compose/layout.py layout name so a CLI
just needs to know the layout name, not which picker function goes with it.
"""
from __future__ import annotations

import json
from pathlib import Path

from lotstretcher import core


def load_angles(cutout_dir: Path) -> dict[str, dict]:
    path = Path(cutout_dir) / "angles.json"
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def _shots(angles: dict) -> list[dict]:
    return [{"name": f, "angle": info["angle"], "confidence": info["confidence"]} for f, info in angles.items()]


def _select(mode: str, angles: dict, **kw) -> dict:
    return core.call({"op": "select_shots", "mode": mode, "shots": _shots(angles), **kw})


def _paths(cutout_dir: Path, sel: dict) -> list[Path]:
    return [Path(cutout_dir) / s["name"] for s in sel["shots"]]


def _pngs(cutout_dir: Path) -> list[Path]:
    return sorted(Path(cutout_dir).glob("*.png"))


def pick_hero_shots(cutout_dir: Path, n_accents: int = 2) -> list[Path]:
    """For layout.py's "single"/"corners" layouts: [hero, accent, ...],
    1 + up to n_accents paths: a front-three-quarter hero when there is
    one, then the best shot of each accent angle not already used. Falls
    back to filename order if angles.json is missing or empty (e.g.
    --no-photo-sort was used)."""
    angles = load_angles(cutout_dir)
    if not angles:
        return _pngs(cutout_dir)[: 1 + n_accents]
    return _paths(cutout_dir, _select("hero", angles, n_accents=n_accents))


def pick_for_quad_layout(cutout_dir: Path) -> list[Path]:
    """For layout.py's "quad" layout: [hero, front, back, side]. A role
    with no match is omitted; compose_hero() leaves its slot empty."""
    angles = load_angles(cutout_dir)
    if not angles:
        return _pngs(cutout_dir)[:4]
    return _paths(cutout_dir, _select("quad", angles))


def pick_for_layout(cutout_dir: Path, layout: str = "corners", n_accents: int = 2) -> list[Path]:
    """Single entrypoint: route to the right picker for a given
    imaging/compose layout name ("single", "corners", "quad")."""
    if layout == "quad":
        return pick_for_quad_layout(cutout_dir)
    if layout == "single":
        return pick_hero_shots(cutout_dir, n_accents=0)
    return pick_hero_shots(cutout_dir, n_accents=n_accents)


def _with_wheels(selected: list[tuple[Path, str]], wheel_dir: Path | None) -> list[tuple[Path, str]]:
    if wheel_dir is not None and Path(wheel_dir).is_dir():
        selected += [(f, "wheel") for f in sorted(Path(wheel_dir).glob("*.png"))]
    return selected


def _pairs(cutout_dir: Path, mode: str, wheel_dir: Path | None) -> list[tuple[Path, str]]:
    angles = load_angles(cutout_dir)
    if angles:
        selected = [(Path(cutout_dir) / s["name"], s["angle"]) for s in _select(mode, angles)["shots"]]
    else:
        selected = [(f, "unknown") for f in _pngs(cutout_dir)]
    return _with_wheels(selected, wheel_dir)


def pick_for_carousel(cutout_dir: Path, wheel_dir: Path | None = None) -> list[tuple[Path, str]]:
    """The best shot of every angle, front to rear, as (path, angle)
    pairs, plus any wheel money shots at the end (label "wheel"). An
    angle the walkaround order does not know is still shown, after it."""
    return _pairs(cutout_dir, "carousel", wheel_dir)


def pick_for_conveyor(cutout_dir: Path) -> list[Path]:
    """[hero, left_accent, right_accent] for the "conveyor" layout: front
    on the left, tail on the right, each slot falling back to any
    distinct angle left, best first."""
    angles = load_angles(cutout_dir)
    if not angles:
        return _pngs(cutout_dir)[:3]
    return _paths(cutout_dir, _select("conveyor", angles))


def pick_all_for_carousel(cutout_dir: Path, wheel_dir: Path | None = None) -> list[tuple[Path, str]]:
    """EVERY cutout, grouped by the walkaround order (each angle's most
    confident first), for hero_video.py's conveyor, which shows off the
    whole shot library; wheel money shots last."""
    return _pairs(cutout_dir, "carousel_all", wheel_dir)


def pick_adaptive(cutout_dir: Path) -> tuple[str, list[Path]]:
    """quad (hero + 3 distinct accents) when the gallery has them, else
    corners (hero + 1-2, bigger boxes), else single: a quad with a role
    it cannot fill leaves a dead gap (a real Maverick shot from only
    front_3q, rear_3q and side)."""
    angles = load_angles(cutout_dir)
    if not angles:
        quad = _pngs(cutout_dir)[:4]
        n = len(quad) - 1
        return ("quad", quad) if n >= 3 else ("corners", quad[: 1 + n]) if n >= 1 else ("single", quad[:1])
    sel = _select("adaptive", angles)
    return sel["layout"], _paths(cutout_dir, sel)


def order_for_conveyor_start(pairs: list[tuple[Path, str]], cutout_dir: Path) -> list[tuple[Path, str]]:
    """Reseat `pairs` so the conveyor's FIRST frame shows exactly the
    hero still's arrangement (front on the left, angle in the hero slot,
    back on the right), and so the last frame hands back to the first:
    the clip loops seamlessly on autoplay."""
    angles = load_angles(cutout_dir)
    if not angles:
        hero, left, right = (_pngs(cutout_dir)[:3] + [None, None, None])[:3]
        by_path = {p: (p, lbl) for p, lbl in pairs}
        lead = [by_path[p] for p in (hero, right) if p in by_path]
        tail = [by_path[p] for p in (left,) if p in by_path and p not in (hero, right)]
        used = {p for p, _ in lead + tail}
        return lead + [pr for pr in pairs if pr[0] not in used] + tail
    # The core names shots by key; a pair's key is its path, so wheel
    # shots and cutouts from elsewhere keep their place in the middle.
    keyed = {str(p): (p, lbl) for p, lbl in pairs}
    sel = core.call({"op": "select_shots", "mode": "conveyor_start",
                     "shots": [{"name": str(Path(cutout_dir) / s["name"]), "angle": s["angle"], "confidence": s["confidence"]}
                               for s in _shots(angles)],
                     "pairs": [{"name": k, "angle": lbl} for k, (_p, lbl) in keyed.items()]})
    return [keyed[s["name"]] for s in sel["shots"]]
