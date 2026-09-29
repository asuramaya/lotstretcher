"""The Studio's control values become the core's request fields in the
core (core/src/controls.rs, op `styles`), for both surfaces.

imaging/text.py and web/public/js/lib/text.js each mapped the controls
(text plan, per-piece styles, drawn frame, spotlight, shadow,
reflection, the backdrop's own colours and angle) and had drifted: the
JS ignored the CLI's frameStyle and read only a literal false as the
spotlight off. tests/fixtures/styles-reference.json holds what the
Python mapping returned for 300 random control sets before it was
deleted (1,500 were checked; the JS agreed on every one it covered);
this test holds the Python host and the wasm build to it.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from lotstretcher import core
from lotstretcher.imaging import text as T

pytestmark = pytest.mark.skipif(not core.available(), reason=f"core not built: {core.why_unavailable()}")

REPO = Path(__file__).resolve().parents[1]
REF = json.loads((REPO / "tests" / "fixtures" / "styles-reference.json").read_text())


def _python(o: dict) -> dict:
    t = T.text_options(o)
    return {"text": t, "wants_text": T.wants_text(t), "fonts": T.fonts_in(t), "border_style": T.frame_style(o),
            "spotlight": T.spotlight_style(o), "shadow": T.shadow_style(o), "reflection": T.reflection_style(o),
            "backdrop": {"color": T.backdrop_color(o), "color2": T.backdrop_color2(o), "angle": T.backdrop_angle(o)}}


@pytest.mark.parametrize("k", range(0, len(REF), 10))
def test_the_python_host_matches_the_mapping_it_replaced(k):
    for case in REF[k:k + 10]:
        assert _python(case["options"]) == case["expected"], case["options"]


def test_wasm_matches():
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    wasm = REPO / "web" / "public" / "core" / "lotstretcher_core_bg.wasm"
    script = f"""
      import fs from 'node:fs';
      import {{ loadCore }} from '{(REPO / 'web' / 'public' / 'js' / 'core.js').as_posix()}';
      import * as T from '{(REPO / 'web' / 'public' / 'js' / 'lib' / 'text.js').as_posix()}';
      await loadCore(fs.readFileSync('{wasm.as_posix()}'));
      const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
      process.stdout.write(JSON.stringify(cases.map((o) => {{ const t = T.textOptions(o), s = T.styles(o);
        return {{ text: t, wants_text: T.wantsText(t), fonts: T.fontsIn(t), border_style: T.frameStyle(o),
                 spotlight: T.spotlightStyle(o), shadow: T.shadowStyle(o), reflection: T.reflectionStyle(o),
                 backdrop: {{ color: s.backdrop.color, color2: s.backdrop.color2, angle: s.backdrop.angle }} }}; }})));
    """
    run = subprocess.run([node, "--input-type=module", "-e", script], input=json.dumps([c["options"] for c in REF]),
                         capture_output=True, text=True, check=True)
    for case, got in zip(REF, json.loads(run.stdout)):
        assert got == case["expected"], case["options"]


def test_where_the_two_had_drifted_the_cli_reading_holds():
    assert T.frame_style({"frameStyle": "line"})["kind"] == "line"
    assert T.spotlight_style({"spotlight": 0}) is False and T.spotlight_style({}) is True
    assert T.text_options({})["title"] == "none" and not T.wants_text(T.text_options({}))
