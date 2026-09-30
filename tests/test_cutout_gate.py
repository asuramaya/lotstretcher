"""Whether a cutout is good enough to compose is the core's gate
(core/src/gate.rs), read off the model's matte at the photo's full size
before refinement, on both surfaces: imaging/cutout.py's quality_ok and
the browser's gateCutout. They used to measure different things (see
gate.rs); on 160 library photos the browser's decision agreed with the
CLI's on 124 with its old gate and 127 with this one, the difference
being close-ups that fill the frame, which the CLI rejects and the
browser now does too."""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest
from PIL import Image, ImageDraw, ImageFilter

from lotstretcher import core

pytestmark = pytest.mark.skipif(not core.available(), reason=f"core not built: {core.why_unavailable()}")
REPO = Path(__file__).resolve().parents[1]


def _alpha(name: str) -> Image.Image:
    a = Image.new("L", (400, 300), 0)
    d = ImageDraw.Draw(a)
    if name == "car":
        d.rounded_rectangle((60, 90, 340, 250), 30, fill=255)
    elif name == "closeup":
        d.rectangle((0, 40, 399, 299), fill=255)                     # touches left, right and bottom
    elif name == "fuzzy":
        d.rounded_rectangle((60, 90, 340, 250), 30, fill=255)
        a = a.filter(ImageFilter.GaussianBlur(25))
    elif name == "tiny":
        d.rectangle((190, 140, 200, 150), fill=255)
    elif name == "all":
        a = Image.new("L", (400, 300), 255)
    return a


CASES = {"car": None, "closeup": "a close-up", "fuzzy": "edges too uncertain", "tiny": "subject too small",
         "empty": "no vehicle found", "all": "a close-up"}


def _gate(name, strict=True):
    return core.call({"op": "cutout_gate", "strict": strict, "alpha": {"$image": 0}}, [_alpha(name)])


@pytest.mark.parametrize("name", list(CASES))
def test_each_rule(name):
    g = _gate(name)
    if CASES[name] is None:
        assert g["ok"] and g["reason"] is None and g["bbox"] == [60, 90, 341, 251]
    else:
        assert not g["ok"] and g["reason"].startswith(CASES[name]), g


def test_gates_off_keeps_only_no_subject():
    assert _gate("closeup", strict=False)["ok"] and _gate("fuzzy", strict=False)["ok"]
    assert not _gate("empty", strict=False)["ok"]


def test_wasm_gates_alike():
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    names = list(CASES)
    script = f"""
      import fs from 'node:fs';
      import {{ loadCore, call }} from '{(REPO / 'web' / 'public' / 'js' / 'core.js').as_posix()}';
      await loadCore(fs.readFileSync('{(REPO / 'web' / 'public' / 'core' / 'lotstretcher_core_bg.wasm').as_posix()}'));
      const buf = new Uint8Array(fs.readFileSync(0)); const n = 400 * 300, out = [];
      for (let i = 0; i < {len(names)}; i++)
        out.push(call({{ op: 'cutout_gate', alpha: {{ $image: 0 }} }}, [{{ width: 400, height: 300, channels: 1, data: buf.subarray(i * n, (i + 1) * n) }}]));
      process.stdout.write(JSON.stringify(out));
    """
    run = subprocess.run([node, "--input-type=module", "-e", script], input=b"".join(_alpha(n).tobytes() for n in names),
                         capture_output=True, check=True)
    assert json.loads(run.stdout) == [_gate(n) for n in names]
