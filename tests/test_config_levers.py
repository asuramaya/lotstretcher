"""A dealer's own lever defaults (lotstretcher-config.json's "studio"
object) reach every command beneath what is typed, and the clip's flags
mean one thing on lotstretcher and hero-video, old spellings included."""
from __future__ import annotations

import json

import pytest

from lotstretcher import dealer_config, looks
from lotstretcher.cli import build_parser, controls_from_args


@pytest.fixture
def studio(tmp_path):
    def write(values: dict):
        path = tmp_path / "lotstretcher-config.json"
        path.write_text(json.dumps({"studio": values}))
        dealer_config.reload(path)
    yield write
    dealer_config.reload()


def run(argv):
    parser = build_parser()
    args = parser.parse_args(argv)
    looks.apply_look(args, parser, argv)
    return controls_from_args(args)


def test_the_config_turns_glow_on_and_sets_the_bitrate(studio):
    studio({"glow": True, "videoBitrate": 12, "noSuchLever": 1})
    got = run([])
    assert got["glow"] is True and got["videoBitrate"] == 12


def test_a_typed_flag_wins_over_the_config(studio):
    studio({"glow": True, "videoBitrate": 12})
    got = run(["--no-glow", "--video-bitrate", "6"])
    assert got["glow"] is False and got["videoBitrate"] == 6


def test_without_a_config_the_studio_defaults_hold(studio):
    studio({})
    got = run([])
    assert got["glow"] is False and got["videoBitrate"] is None


@pytest.mark.parametrize("old, new", [
    (["--video-flag-background"], {"videoBackdrop": True}),
    (["--flag-background"], {"videoBackdrop": True}),
    (["--background-video", "Clip"], {"videoBackdrop": True, "videoClip": "Clip"}),
    (["--music"], {"videoMusic": True}),
    (["--audio", "Track"], {"videoMusic": True, "videoTrack": "Track"}),
    (["--bpm", "120"], {"videoBpm": 120.0}),
    (["--budget-mb", "30"], {"videoBudgetMb": 30.0}),
    (["--format", "square"], {"videoFormats": ["square"]}),
])
def test_the_old_spellings_still_work(old, new):
    got = controls_from_args(build_parser().parse_args(old))
    assert {k: got[k] for k in new} == new


def test_a_named_track_does_not_swallow_a_url():
    args = build_parser().parse_args(["--video-music", "https://dealer.example/vehicle/1/"])
    assert args.video_music is True and args.urls == ["https://dealer.example/vehicle/1/"]


def test_an_explicit_bitrate_reaches_the_pipeline():
    from lotstretcher.library_ops import hero_options_from_controls
    assert hero_options_from_controls({"videoBitrate": 8}).video_bitrate_mbps == 8.0
    assert hero_options_from_controls({"videoBitrate": 0}).video_bitrate_mbps is None
