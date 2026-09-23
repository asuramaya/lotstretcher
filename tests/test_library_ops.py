"""Rebuild-in-place and the job routes behind the Library pane.

resolve_recompose_options() turns the app's control values into what
the composers take, and refuses before touching a folder when an asset
or format does not exist. The routes are thin shells over it and over
jobs.start(); they are exercised with the rebuild itself stubbed, since
composing needs real cutouts and a model.
"""
from __future__ import annotations

import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from lotstretcher import library_ops
from lotstretcher.server import jobs


def test_defaults_match_the_recompose_cli():
    r = library_ops.resolve_recompose_options({})
    assert r["background_path"] is None and r["border_path"] is None
    assert r["style"] == {"glow": True, "glow_color": "white", "glow_radius": 24,
                          "glow_intensity": 0.75, "gradient": True, "border_fit": "fit",
                          "text": {"title": "none", "custom_title": None, "price_badge": False, "line": None,
                                   "position": "bl", "color": "white", "size": 0.05},
                          "border_style": None}
    assert r["hero_formats"] == ("square",)


def test_unknown_hero_format_is_refused():
    with pytest.raises(ValueError, match="unknown hero format"):
        library_ops.resolve_recompose_options({"heroFormats": ["cinema"]})


def test_all_formats_expand():
    r = library_ops.resolve_recompose_options({"heroFormats": ["all"]})
    assert len(r["hero_formats"]) >= 3 and "square" in r["hero_formats"]


def test_frame_without_a_library_is_refused(monkeypatch):
    from lotstretcher.imaging import assets
    monkeypatch.setattr(assets, "_load_manifest", lambda: {})
    with pytest.raises(ValueError):
        library_ops.resolve_recompose_options({"frame": True})


def test_jobs_track_success_and_failure():
    ex = ThreadPoolExecutor(max_workers=2)
    ok = jobs.start(ex, "recompose", "new/x", lambda: {"framed": 3})
    bad = jobs.start(ex, "recompose", "new/y", lambda: (_ for _ in ()).throw(RuntimeError("boom")))
    deadline = time.time() + 5
    while time.time() < deadline and any(jobs.get(j["id"])["status"] == "running" for j in (ok, bad)):
        time.sleep(0.02)
    assert jobs.get(ok["id"])["status"] == "done" and jobs.get(ok["id"])["result"] == {"framed": 3}
    assert jobs.get(bad["id"])["status"] == "failed" and "boom" in jobs.get(bad["id"])["error"]
    assert not jobs.running("recompose")


@pytest.fixture
def served(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from lotstretcher.server import app as server_app
    d = tmp_path / "new" / "2026-Ford-Maverick-XLT-RB41981"
    (d / "images" / "exterior" / "cutout").mkdir(parents=True)
    (d / "details.json").write_text(json.dumps({"title": "2026 Ford Maverick XLT"}))
    (tmp_path / "run-summary.json").write_text(json.dumps({"run_at": "2026-09-16", "results": []}))
    (tmp_path / "runs.jsonl").write_text('{"run_at": "a"}\n{"run_at": "b"}\nnot json\n')
    monkeypatch.setitem(server_app._state, "library", tmp_path)
    monkeypatch.setitem(server_app._state, "executor", ThreadPoolExecutor(max_workers=1))
    return TestClient(server_app.app), tmp_path


def test_status_reads_the_root_files(served):
    client, _ = served
    s = client.get("/library/status").json()
    assert s["lastRun"]["run_at"] == "2026-09-16"
    assert [r["run_at"] for r in s["runs"]] == ["b", "a"], "newest first, bad lines skipped"
    assert "syncConfigured" in s and isinstance(s["jobs"], list)


def test_recompose_route_runs_the_shared_rebuild(served, monkeypatch):
    client, root = served
    seen = {}

    def fake(folder, resolved, classifier=None):
        seen["folder"] = folder
        seen["glow"] = resolved["style"]["glow"]
        return {"framed": 2}
    monkeypatch.setattr(library_ops, "recompose_folder", fake)

    r = client.post("/library/new/2026-Ford-Maverick-XLT-RB41981/recompose", json={"options": {"glow": False}})
    assert r.status_code == 200, r.text
    job = r.json()
    deadline = time.time() + 5
    while time.time() < deadline and client.get(f"/jobs/{job['id']}").json()["status"] == "running":
        time.sleep(0.02)
    final = client.get(f"/jobs/{job['id']}").json()
    assert final["status"] == "done" and final["result"] == {"framed": 2}
    assert seen["folder"] == root / "new" / "2026-Ford-Maverick-XLT-RB41981"
    assert seen["glow"] is False


def test_recompose_refuses_unknown_vehicle_and_bad_options(served):
    client, _ = served
    assert client.post("/library/new/nope/recompose", json={"options": {}}).status_code == 404
    assert client.post("/library/new/../recompose", json={"options": {}}).status_code in (400, 404)
    r = client.post("/library/new/2026-Ford-Maverick-XLT-RB41981/recompose",
                    json={"options": {"heroFormats": ["cinema"]}})
    assert r.status_code == 422


def test_hero_options_defaults_are_the_cli_defaults():
    """hero_options_from_controls({}) must equal what the CLI produced
    with no flags before the refactor: HeroOptions() plus the CLI's own
    format defaults."""
    from lotstretcher.vehicle_pipeline import HeroOptions
    from lotstretcher.imaging.compose.hero_video import VIDEO_FORMATS
    got = library_ops.hero_options_from_controls({})
    base = HeroOptions()
    for field in ("enabled", "glow", "glow_color", "glow_radius", "glow_intensity", "spotlight",
                  "margin_frac", "gradient", "video", "video_encoder", "interiors",
                  "interior_captions", "vision_seat_check", "background_path", "border_path",
                  "video_fps", "video_duration_s"):
        assert getattr(got, field) == getattr(base, field), field
    assert got.video_formats == tuple(VIDEO_FORMATS)
    assert got.hero_formats == ("square", "portrait")


def test_hero_options_carry_the_studio_levers():
    """The frame fit and the Text controls reach HeroOptions in the
    core's own field names, so the pipeline's stills and clip get what
    the app or the flags asked for."""
    from lotstretcher.imaging.text import text_options
    controls = {"frameFit": "fill", "titleMode": "custom", "titleText": "Just arrived", "priceBadge": True,
                "textLine": "Ask for Alex", "textPosition": "tr", "textColor": "paint", "textSize": 0.07}
    got = library_ops.hero_options_from_controls(controls)
    assert got.border_fit == "fill"
    assert got.text == text_options(controls)
    assert got.text["title"] == "custom" and got.text["custom_title"] == "Just arrived"
    assert got.text["price_badge"] is True and got.text["color"] == "paint" and got.text["size"] == 0.07
    # And nothing asked for means no text: the still never loads the font.
    from lotstretcher.imaging.text import wants_text
    assert not wants_text(library_ops.hero_options_from_controls({}).text)


def test_hero_options_apply_the_once_dead_flags():
    got = library_ops.hero_options_from_controls(
        {"spotlight": False, "margin": 0.1, "videoFps": 30, "videoDuration": 8, "videoFormats": []})
    assert got.spotlight is False and got.margin_frac == 0.1
    assert got.video_fps == 30.0 and got.video_duration_s == 8.0
    assert got.video is False, "an empty format list is --no-video"


def test_rescrape_route_needs_a_url_and_runs_one_at_a_time(served, monkeypatch):
    client, root = served
    # No url in the record: refused before anything starts.
    r = client.post("/library/new/2026-Ford-Maverick-XLT-RB41981/rescrape", json={"options": {}})
    assert r.status_code == 409

    d = root / "new" / "2026-Ford-Maverick-XLT-RB41981" / "details.json"
    d.write_text(json.dumps({"title": "x", "url": "https://d.example/vehicle/1/x/"}))
    import threading
    gate = threading.Event()
    seen = {}

    def fake(url, out_root, options, models):
        seen["url"] = url
        gate.wait(5)
        return {"status": "success", "folder": "2026-Ford-Maverick-XLT-RB41981"}
    monkeypatch.setattr(library_ops, "rescrape", fake)
    monkeypatch.setattr(server_module(), "_models", lambda: object())

    first = client.post("/library/new/2026-Ford-Maverick-XLT-RB41981/rescrape", json={"options": {}})
    assert first.status_code == 200, first.text
    second = client.post("/library/new/2026-Ford-Maverick-XLT-RB41981/rescrape", json={"options": {}})
    assert second.status_code == 409, "a second re-scrape must wait for the first"
    gate.set()
    deadline = time.time() + 5
    while time.time() < deadline and client.get(f"/jobs/{first.json()['id']}").json()["status"] == "running":
        time.sleep(0.02)
    assert client.get(f"/jobs/{first.json()['id']}").json()["status"] == "done"
    assert seen["url"] == "https://d.example/vehicle/1/x/"


def server_module():
    from lotstretcher.server import app as server_app
    return server_app


def test_mark_delisted_stamps_once(tmp_path):
    d = tmp_path / "used" / "x"
    d.mkdir(parents=True)
    (d / "details.json").write_text(json.dumps({"vin": "1"}))
    assert library_ops.mark_delisted(d, "2026-09-22T00:00:00+00:00") is True
    assert json.loads((d / "details.json").read_text())["delisted_at"] == "2026-09-22T00:00:00+00:00"
    assert library_ops.mark_delisted(d) is False, "a second mark must not overwrite the first stamp"
    assert json.loads((d / "details.json").read_text())["delisted_at"] == "2026-09-22T00:00:00+00:00"


def test_delete_vehicle_removes_folder_and_manifest_entry(tmp_path):
    from lotstretcher.manifest import load_manifest, save_manifest
    d = tmp_path / "used" / "2018-Ford-F-150-JFA30327"
    (d / "bundle").mkdir(parents=True)
    (d / "details.json").write_text("{}")
    save_manifest(tmp_path, {"vin:1FTEW1E58JFA30327": {"folder": "used/2018-Ford-F-150-JFA30327"},
                             "vin:OTHER": {"folder": "used/other"}})
    out = library_ops.delete_vehicle(tmp_path, "used", "2018-Ford-F-150-JFA30327")
    assert not d.exists()
    assert out["manifest_entries_removed"] == 1
    assert list(load_manifest(tmp_path)) == ["vin:OTHER"]
    with pytest.raises(FileNotFoundError):
        library_ops.delete_vehicle(tmp_path, "used", "../used")


def test_delete_route_demands_the_folder_name(served):
    client, root = served
    name = "2026-Ford-Maverick-XLT-RB41981"
    assert client.post(f"/library/new/{name}/delete", json={"confirm": "yes"}).status_code == 422
    assert (root / "new" / name).exists()
    r = client.post(f"/library/new/{name}/delist")
    assert r.status_code == 200 and r.json()["marked"] is True
    r = client.post(f"/library/new/{name}/delete", json={"confirm": name})
    assert r.status_code == 200, r.text
    assert not (root / "new" / name).exists()
    assert client.post(f"/library/new/{name}/delete", json={"confirm": name}).status_code == 404


def test_runs_route_returns_history_newest_first(served):
    client, _ = served
    r = client.get("/library/runs?limit=1")
    assert r.status_code == 200 and [x["run_at"] for x in r.json()["runs"]] == ["b"]
    assert [x["run_at"] for x in client.get("/library/runs").json()["runs"]] == ["b", "a"]


def test_video_configuration_surface_reaches_the_renderer():
    got = library_ops.hero_options_from_controls({"videoBpm": 120, "videoBudgetMb": 30})
    assert got.video_bpm == 120.0 and got.video_budget_mb == 30.0
    assert library_ops.hero_options_from_controls({"videoBudgetMb": 0}).video_budget_mb is None, \
        "0 means each format's own budget"
