"""One-tap looks: the spec's presets reach the CLI as --look and the
app as chips, from the same values. A flag typed beside --look wins."""
from __future__ import annotations

import argparse

import pytest

from lotstretcher import looks, spec
from lotstretcher.imaging.text import (add_backdrop_arg, add_frame_style_args, add_reflection_args, add_shadow_args,
                                       controls_from_frame_style_args, controls_from_reflection_args,
                                       controls_from_shadow_args)


def parser():
    p = argparse.ArgumentParser()
    p.add_argument("--no-spotlight", action="store_true")
    p.add_argument("--no-glow", action="store_true")
    p.add_argument("--glow-color", default="white")
    p.add_argument("--glow-radius", type=int, default=24)
    p.add_argument("--glow-intensity", type=float, default=0.75)
    p.add_argument("--frame", action="store_true")
    add_frame_style_args(p)
    add_shadow_args(p)
    add_reflection_args(p)
    p.add_argument("--photo-background", action="store_true")
    add_backdrop_arg(p)
    looks.add_look_arg(p)
    return p


def test_the_spec_has_looks_and_every_value_is_one_a_control_accepts():
    controls = {c["key"]: c for g in spec.get("controls", "groups") for c in g["controls"]}
    assert len(looks.looks()) >= 3
    for lk in looks.looks():
        assert lk["id"] and lk["label"] and lk["hint"]
        for key, value in lk["values"].items():
            c = controls[key]
            if c["type"] == "toggle":
                assert isinstance(value, bool), (lk["id"], key)
            elif c["type"] == "select" and c.get("dynamic") == "glowColors":
                assert value in spec.get("glow", "colors"), (lk["id"], key, value)
            elif c["type"] == "select":
                assert value in [ch["value"] for ch in c["choices"]], (lk["id"], key, value)
            elif c["type"] == "range":
                assert c["min"] <= value <= c["max"], (lk["id"], key, value)


@pytest.mark.parametrize("look", [lk["id"] for lk in looks.looks()])
def test_every_look_maps_onto_flags(look):
    p = parser()
    out = looks.assignments(looks.find(look), p)
    assert out, look
    for dest in out:
        assert p.get_default(dest) is not None or dest in ("frame_style",), dest


def test_look_applies_and_typed_flags_win():
    p = parser()
    argv = ["--look", "showroom"]
    args = p.parse_args(argv)
    touched = looks.apply_look(args, p, argv)
    assert args.shadow is True and args.shadow_strength == 0.55
    assert args.reflection is True and args.reflection_strength == 0.35
    assert args.no_glow is True and args.no_spotlight is False and args.frame_style == "none"
    assert "shadow" in touched
    assert controls_from_shadow_args(args)["shadowStrength"] == 0.55

    argv = ["--look", "showroom", "--shadow-strength", "0.9", "--no-spotlight"]
    args = p.parse_args(argv)
    looks.apply_look(args, p, argv)
    assert args.shadow is True and args.shadow_strength == 0.9, "the typed flag wins over the look"
    assert args.no_spotlight is True

    argv = ["--look", "gallery"]
    args = p.parse_args(argv)
    looks.apply_look(args, p, argv)
    assert controls_from_frame_style_args(args) == {"frameStyle": "line", "frameColor": "white", "frameWeight": 0.008,
                                                    "frameInset": 0.035, "frameRadius": 0.02}
    assert controls_from_reflection_args(args)["reflection"] is False

    # "none" for the Frame picker resets the line and the art flag.
    argv = ["--look", "clean", "--frame-style", "line"]
    args = p.parse_args(argv)
    looks.apply_look(args, p, argv)
    assert args.frame_style == "line", "typed --frame-style survives the look's none"
    argv = ["--look", "clean"]
    args = p.parse_args(argv)
    looks.apply_look(args, p, argv)
    assert args.frame_style == "none" and args.frame is False

    assert looks.apply_look(p.parse_args([]), p, []) == []
    with pytest.raises(ValueError):
        looks.find("neon")


def test_backdrop_flag_reaches_the_controls_and_the_showroom_look_uses_the_sweep():
    p = parser()
    argv = ["--look", "showroom"]
    args = p.parse_args(argv)
    looks.apply_look(args, p, argv)
    assert args.backdrop == "sweep" and args.photo_background is False
    argv = ["--look", "showroom", "--backdrop", "generic"]
    args = p.parse_args(argv)
    looks.apply_look(args, p, argv)
    assert args.backdrop == "generic"
    argv = ["--look", "clean"]
    args = p.parse_args(argv)
    looks.apply_look(args, p, argv)
    assert args.backdrop == "vehicle", "clean leaves the backdrop alone"
    from lotstretcher.library_ops import generated_backdrop
    assert generated_backdrop({"backdrop": "sweep"}) == "sweep"
    assert generated_backdrop({"backdrop": "asset"}) == "vehicle" and generated_backdrop({}) == "vehicle"
