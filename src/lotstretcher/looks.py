"""
One-tap looks: named presets of control values, defined once in
shared/pipeline-spec.json (controls.looks). The app's Look pane renders
them as chips; here `--look NAME` applies the same values to a parsed
command line, with any flag the user typed explicitly winning over the
look, so `--look showroom --shadow-strength 0.9` is the showroom with
a darker shadow.

The mapping from a control value to an argparse attribute is the spec's
own: each control names its flag (`cli`, inverted by `cliInvert`), or a
choice names one of its own (`--frame-style line` for the Frame
picker's "line"). Nothing here is hand-listed per look.
"""
from __future__ import annotations

import argparse
import copy

from lotstretcher import spec


def looks() -> list[dict]:
    return list(spec.get("controls", "looks", default=[]) or [])


def look_ids() -> list[str]:
    return [lk["id"] for lk in looks()]


def find(look_id: str) -> dict:
    for lk in looks():
        if lk["id"] == look_id:
            return lk
    raise ValueError(f"unknown look {look_id!r}; one of {', '.join(look_ids())}")


def add_look_arg(parser) -> None:
    names = ", ".join(look_ids())
    parser.add_argument("--look", default=None, choices=look_ids(), metavar="NAME",
                        help=f"A one-tap look from the app: {names}. Sets several light and frame "
                             "flags at once; any flag you also give explicitly wins.")


def _controls() -> dict[str, dict]:
    return {c["key"]: c for g in spec.get("controls", "groups", default=[]) for c in g["controls"]}


def _dest(flag: str) -> str:
    return flag.lstrip("-").replace("-", "_")


def explicit_dests(parser, argv=None) -> set[str]:
    """Which argparse attributes the user actually typed: the parser is
    re-run with every default suppressed, so only given flags land."""
    quiet = copy.deepcopy(parser)
    for action in quiet._actions:
        action.default = argparse.SUPPRESS
    ns, _ = quiet.parse_known_args(argv)
    return set(vars(ns))


def assignments(look: dict, parser) -> dict[str, object]:
    """The argparse attributes a look sets, from the spec's flag names:
    {dest: value}. A choice without a flag of its own resets the sibling
    choices' flags to the parser's defaults ("none" for the Frame picker
    puts --frame-style back to none and --frame off)."""
    controls = _controls()
    out: dict[str, object] = {}
    for key, value in look["values"].items():
        control = controls.get(key)
        if control is None:
            raise ValueError(f"look {look['id']!r} names no control {key!r}")
        choices = control.get("choices") or []
        if any(c.get("cli") for c in choices):
            chosen = next((c for c in choices if c.get("value") == value), None)
            if chosen is None:
                raise ValueError(f"look {look['id']!r}: {key} has no choice {value!r}")
            if chosen.get("cli"):
                out[_dest(chosen["cli"])] = chosen.get("cliValue", True)
            else:
                for sibling in choices:
                    if sibling.get("cli"):
                        dest = _dest(sibling["cli"])
                        out[dest] = parser.get_default(dest)
            continue
        flag = control.get("cli")
        if not flag:
            raise ValueError(f"look {look['id']!r}: {key} has no command-line flag")
        out[_dest(flag)] = (not value) if control.get("cliInvert") else value
    return out


def apply_look(args, parser, argv=None) -> list[str]:
    """Apply `args.look` (if any) onto `args`, leaving every explicitly
    given flag alone. Returns the attribute names it set, for a log line."""
    look_id = getattr(args, "look", None)
    if not look_id:
        return []
    given = explicit_dests(parser, argv)
    touched = []
    for dest, value in assignments(find(look_id), parser).items():
        if dest in given:
            continue
        setattr(args, dest, value)
        touched.append(dest)
    return touched
