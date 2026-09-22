"""Every control exists on both sides, or the suite fails.

shared/pipeline-spec.json's `controls` block defines each composition
control once. The browser renders its Options pane from that block, so a
new control needs no JavaScript. These tests close the other half: the
CLI flag each control names must actually exist, and the composition
flags the CLI offers must be represented in the spec.

Without this, "one route" degrades the usual way: someone adds a control
to the UI, forgets the flag, and the two surfaces quietly diverge again.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
SPEC = json.loads((REPO / "shared" / "pipeline-spec.json").read_text())
CLI_SOURCE = (REPO / "src" / "lotstretcher" / "cli.py").read_text()

CONTROLS = [c for g in SPEC["controls"]["groups"] for c in g["controls"]]


def cli_flags() -> set[str]:
    """Every long flag cli.py registers."""
    return set(re.findall(r'add_argument\(\s*"(--[a-z0-9-]+)"', CLI_SOURCE))


def surfaces(control: dict) -> list[str]:
    return control.get("surfaces", ["browser", "cli", "server"])


def test_controls_block_is_well_formed():
    assert CONTROLS, "no controls defined"
    seen = set()
    for c in CONTROLS:
        for field in ("key", "label", "type", "cli"):
            assert field in c, f"control {c.get('key', c)!r} is missing {field!r}"
        assert c["key"] not in seen, f"duplicate control key {c['key']!r}"
        seen.add(c["key"])
        assert c["type"] in ("toggle", "select", "range", "chips"), c["type"]


@pytest.mark.parametrize("control", [c for c in CONTROLS if "cli" in surfaces(c)],
                         ids=lambda c: c["key"])
def test_every_control_names_a_real_cli_flag(control):
    """The binding half of "one route". A control whose flag does not
    exist means the UI can express something the CLI cannot."""
    flag = control["cli"]
    assert flag in cli_flags(), (
        f"control {control['key']!r} maps to {flag!r}, which cli.py does not define. "
        f"Add the flag, or correct the mapping in shared/pipeline-spec.json."
    )


@pytest.mark.parametrize("control", [c for c in CONTROLS if "cli" not in surfaces(c)],
                         ids=lambda c: c["key"])
def test_browser_only_controls_explain_themselves(control):
    """A control may be browser-only, but only with a stated reason.
    Without this the surfaces field becomes a loophole: "no CLI flag
    yet" quietly turns into permanent divergence, which is the exact
    thing the controls block exists to prevent."""
    note = control.get("cliNote", "")
    assert len(note) > 30, (
        f"{control['key']} is browser-only but carries no cliNote explaining why. "
        f"Either add the CLI flag, or say why one cannot exist."
    )


@pytest.mark.parametrize("control", [c for c in CONTROLS if c["type"] == "range"],
                         ids=lambda c: c["key"])
def test_range_controls_have_sane_bounds(control):
    assert control["min"] < control["max"]
    assert control["min"] <= control["default"] <= control["max"], (
        f"{control['key']}: default {control['default']} is outside "
        f"[{control['min']}, {control['max']}]"
    )
    assert control.get("step", 0) > 0


@pytest.mark.parametrize("control", [c for c in CONTROLS if c["type"] == "select"],
                         ids=lambda c: c["key"])
def test_select_controls_offer_their_default(control):
    """A dynamic select fills its choices at runtime (glow colours from
    the spec, borders from the asset library), so only static ones can be
    checked here."""
    if control.get("dynamic"):
        return
    values = [c["value"] for c in control["choices"]]
    assert control["default"] in values, (
        f"{control['key']}: default {control['default']!r} is not among {values}"
    )


@pytest.mark.parametrize("control", [c for c in CONTROLS if c.get("requires")],
                         ids=lambda c: c["key"])
def test_gated_controls_name_a_real_capability(control):
    """A control gated on a capability the server never reports would be
    permanently invisible, which is worse than absent because it looks
    like a bug."""
    from lotstretcher.server import webapp
    reported = set(webapp.capabilities({"out_dir": None}))
    assert control["requires"] in reported, (
        f"{control['key']} requires capability {control['requires']!r}, "
        f"which /capabilities never reports"
    )


def test_browser_only_controls_are_not_gpu_dependent():
    """Anything offered in the browser must be doable there. A control
    that needs a GPU or a filesystem has to be marked cli/server only,
    or it will be offered on lotstretcher.org and fail."""
    needs_host = {"upscale", "nvenc", "filesystem"}
    for c in CONTROLS:
        if "browser" in surfaces(c) and c.get("requires") in needs_host:
            pytest.fail(
                f"{c['key']} is offered in the browser but requires "
                f"{c['requires']!r}; restrict its surfaces to cli/server"
            )


COMPOSITION_FLAGS = {
    # Composition flags the CLI offers that the spec must represent. Kept
    # explicit rather than derived: cli.py also carries scraping, sync and
    # output-path flags, none of which are composition controls.
    "--no-glow", "--glow-color", "--glow-radius", "--glow-intensity",
    "--no-hero", "--frame", "--border", "--background", "--photo-background",
    "--no-interiors", "--no-photo-sort", "--no-strict-cutouts", "--upscale",
    "--video-music", "--nvenc",
}


def test_every_composition_flag_has_a_control():
    """The reverse direction: a flag with no control is a capability the
    CLI has and the UI cannot reach."""
    mapped = {c["cli"] for c in CONTROLS}
    missing = sorted(COMPOSITION_FLAGS - mapped)
    assert not missing, (
        f"cli.py offers {missing} with no control in shared/pipeline-spec.json. "
        f"Add a control so the UI can reach it too."
    )
