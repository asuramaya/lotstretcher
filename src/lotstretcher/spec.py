"""Loader for shared/pipeline-spec.json, the single source of truth for
every constant the Python pipeline and the browser client both need.

WHY THIS EXISTS: the two surfaces are necessarily two implementations,
but they must not be two specifications. The browser client used to
retype HERO_STILL_FORMATS, VIDEO_FORMATS, the palette bands, the glow
colours and the cutout gates as JavaScript literals. Nothing would have
caught those drifting apart except someone noticing that the website and
the CLI produced different output, which is exactly the kind of bug that
gets found by a customer rather than by a test.

tests/test_spec_parity.py asserts the modules below agree with the JSON,
so changing a constant in only one place fails the suite.

Modules keep their own module-level names (HERO_STILL_FORMATS and so on)
rather than reading this everywhere: those names are the readable API and
are used across the codebase. What changes is where the VALUES come from.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

# repo_root/src/lotstretcher/spec.py -> repo_root/shared/pipeline-spec.json
SPEC_PATH = Path(__file__).resolve().parents[2] / "shared" / "pipeline-spec.json"


@lru_cache(maxsize=1)
def load() -> dict:
    """The parsed spec. Cached: it is read on import paths that run per
    vehicle, and it never changes within a process."""
    with SPEC_PATH.open() as fh:
        return json.load(fh)


def get(*path, default=None):
    """spec.get("video", "gradientTurns") -> 1.0

    Returns `default` for a missing key rather than raising, so a spec
    written by an older version of the repo degrades to the code's own
    default instead of refusing to start."""
    node = load()
    for key in path:
        if not isinstance(node, dict) or key not in node:
            return default
        node = node[key]
    return node


def control_default(key: str, default=None):
    """A Studio control's default (controls.groups[].controls[].default),
    so a CLI flag starts where the app's lever does."""
    for group in get("controls", "groups", default=[]) or []:
        for control in group.get("controls", []):
            if control.get("key") == key:
                return control.get("default", default)
    return default


def sizes(section: str) -> dict[str, tuple[int, int]]:
    """{name: (w, h)} for heroStillFormats or videoFormats."""
    formats = get(section, "formats", default={})
    return {name: tuple(f["size"]) for name, f in formats.items()}


def rgb_map(*path) -> dict[str, tuple[int, int, int]]:
    """A {name: (r, g, b)} block, JSON lists converted to tuples so it
    compares equal to the literals these replace."""
    return {k: tuple(v) for k, v in (get(*path, default={}) or {}).items()}
