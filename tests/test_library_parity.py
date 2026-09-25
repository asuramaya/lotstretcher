"""The library layout is one thing: spec.library, written by the
pipeline, read by server/library.py and by the browser's reader.

Two checks. The names in the spec must be the names vehicle_pipeline
actually writes (grepped from its source, not restated here), and the
server's index and file resolver must behave on a synthetic library,
including refusing a path that climbs out of a vehicle folder.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from lotstretcher.server import library

REPO = Path(__file__).resolve().parents[1]
SPEC = json.loads((REPO / "shared" / "pipeline-spec.json").read_text())["library"]
PIPELINE = (REPO / "src" / "lotstretcher" / "vehicle_pipeline.py").read_text()
COMPOSE_SOURCES = "\n".join(p.read_text() for p in (REPO / "src" / "lotstretcher" / "imaging").glob("*.py")) \
    + "\n".join(p.read_text() for p in (REPO / "src" / "lotstretcher" / "imaging" / "compose").glob("*.py"))


@pytest.mark.parametrize("name", [
    SPEC["details"], SPEC["images"], SPEC["bundle"]["dir"],
    *SPEC["bundle"]["posts"].values(),
])
def test_pipeline_writes_the_spec_names(name):
    assert f'"{name}"' in PIPELINE, f"vehicle_pipeline.py never writes {name!r}"


def test_video_names_follow_the_pipeline_rule():
    """hero-video.mp4 is the square one; other formats carry a suffix."""
    videos = SPEC["bundle"]["videos"]
    assert videos["square"] == "hero-video.mp4"
    for fmt, name in videos.items():
        if fmt != "square":
            assert name == f"hero-video-{fmt}.mp4"


def test_hero_names_follow_the_composer_rule():
    """imaging/compose/pipeline.py: hero.png is the default still format,
    hero-<fmt>.png the others. The spec must name the same files."""
    from lotstretcher.imaging.compose.pipeline import hero_still_name
    full = json.loads((REPO / "shared" / "pipeline-spec.json").read_text())
    default = full["heroStillFormats"]["default"]
    assert SPEC["bundle"]["hero"] == hero_still_name(default)
    assert SPEC["bundle"]["heroPortrait"] == hero_still_name("portrait")
    assert SPEC["bundle"]["heroHorizontal"] == hero_still_name("horizontal")


@pytest.mark.parametrize("name", [SPEC["bundle"]["framed"], SPEC["bundle"]["interior"]])
def test_composer_writes_the_bundle_dirs(name):
    assert f'"{name}"' in COMPOSE_SOURCES, f"nothing under imaging/ writes a {name!r} directory"


def test_js_reader_indexes_the_same_library(lib):
    """The browser's DirectorySource, fed the same synthetic library as a
    webkitdirectory FileList, must produce the index the server does."""
    import shutil
    import subprocess
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    entries = []
    for p in sorted(lib.rglob("*")):
        if p.is_file():
            entries.append({"rel": f"listings/{p.relative_to(lib).as_posix()}", "text": p.read_text(errors="replace")})
    script = f"""
      import {{ loadSpecFrom }} from '{(REPO / 'web' / 'public' / 'js' / 'spec.js').as_posix()}';
      import {{ DirectorySource }} from '{(REPO / 'web' / 'public' / 'js' / 'library' / 'source.js').as_posix()}';
      import fs from 'node:fs';
      loadSpecFrom(JSON.parse(fs.readFileSync('{(REPO / 'shared' / 'pipeline-spec.json').as_posix()}', 'utf8')));
      const entries = JSON.parse(fs.readFileSync(0, 'utf8'));
      // Stand-ins for webkitdirectory Files: the path and a text() reader.
      const files = entries.map((e) => ({{ webkitRelativePath: e.rel, getFile: async () => ({{ text: async () => e.text }}) }}));
      const src = DirectorySource.fromFileList(files);
      const idx = await src.index();
      process.stdout.write(JSON.stringify(idx));
    """
    run = subprocess.run([node, "--input-type=module", "-e", script], input=json.dumps(entries),
                         capture_output=True, text=True, check=True)
    js = json.loads(run.stdout)
    py = library.index(lib)
    def strip(v):
        return {k: v[k] for k in ("bucket", "folder", "card", "files", "images")}
    assert sorted(map(strip, js["vehicles"]), key=lambda v: v["folder"]) == \
           sorted(map(strip, py["vehicles"]), key=lambda v: v["folder"])
    assert js["buckets"] == py["buckets"]


@pytest.fixture
def lib(tmp_path):
    def vehicle(bucket, folder, details, with_hero=True):
        d = tmp_path / bucket / folder
        (d / "bundle" / "framed").mkdir(parents=True)
        (d / "images" / "exterior" / "cutout").mkdir(parents=True)
        (d / "details.json").write_text(json.dumps(details))
        if with_hero:
            (d / "bundle" / "hero.png").write_bytes(b"png")
        (d / "bundle" / "framed" / "01.png").write_bytes(b"png")
        (d / "bundle" / "facebook.txt").write_text("post")
        (d / "images" / "exterior" / "01.jpg").write_bytes(b"jpg")
        (d / "images" / "exterior" / "cutout" / "01.png").write_bytes(b"derived")
    vehicle("new", "2026-Ford-Maverick-XLT-RB41981", {"title": "2026 Ford Maverick XLT", "display_price": 31000})
    vehicle("used", "2018-Ford-F-150-Platinum-JFA30327", {"title": "2018 Ford F-150 Platinum", "mileage": 61000})
    (tmp_path / "used" / "not-a-vehicle").mkdir()          # no details.json: ignored
    (tmp_path / "run-summary.json").write_text('{"vehicles": 2}')
    return tmp_path


def test_index_lists_vehicles_with_cards_and_files(lib):
    idx = library.index(lib)
    assert idx["buckets"] == SPEC["buckets"]
    assert {v["folder"] for v in idx["vehicles"]} == {
        "2026-Ford-Maverick-XLT-RB41981", "2018-Ford-F-150-Platinum-JFA30327"}
    new = next(v for v in idx["vehicles"] if v["bucket"] == "new")
    assert new["card"]["title"] == "2026 Ford Maverick XLT"
    assert "bundle/hero.png" in new["files"] and "bundle/framed/01.png" in new["files"]
    assert "details.json" not in new["files"]
    assert new["images"] == ["images/exterior/01.jpg"], "derived cutouts must not be listed as originals"
    assert idx["summary"] == {"vehicles": 2}


def test_resolve_file_serves_inside_and_refuses_outside(lib):
    v = "2026-Ford-Maverick-XLT-RB41981"
    assert library.resolve_file(lib, "new", v, "bundle/hero.png").read_bytes() == b"png"
    with pytest.raises(ValueError):
        library.resolve_file(lib, "new", v, "../../run-summary.json")
    with pytest.raises(ValueError):
        library.resolve_file(lib, "new", "../used", "x")
    with pytest.raises(ValueError):
        library.resolve_file(lib, "etc", v, "passwd")
    with pytest.raises(FileNotFoundError):
        library.resolve_file(lib, "new", v, "bundle/missing.png")
