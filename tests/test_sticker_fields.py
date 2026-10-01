"""A window sticker as the vehicle's own fields, from the core
(core/src/sticker_fields.rs), for both surfaces.

The browser's sticker.js used to flatten the parsed sticker and set its
engine, transmission and colours in its own title case; the CLI filled
only a blank trim. tests/fixtures/sticker-fields-reference.json holds what
that JavaScript returned for every real sticker in the operator's library
(111) and for the casing's edge cases, and this test holds the core to
it natively and in the wasm build under node. One difference is
deliberate: "W/ Miko" became "With  Miko" (two spaces) in the JS, and
the core writes one."""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from lotstretcher import core

pytestmark = pytest.mark.skipif(not core.available(), reason=f"core not built: {core.why_unavailable()}")

REPO = Path(__file__).resolve().parents[1]
REF = json.loads((REPO / "tests" / "fixtures" / "sticker-fields-reference.json").read_text())


def casing(text: str) -> str:
    return core.call({"op": "sticker_fields", "record": {"overview": {"engine": text}}})["fields"].get("engine", "")


def test_every_real_sticker_flattens_as_the_browser_did():
    for case in REF["cases"]:
        got = core.call({"op": "sticker_fields", "record": case["record"]})
        assert got == {"fields": case["fields"], "vehicle": case["vehicle"]}, case["record"]["overview"].get("vin")


@pytest.mark.parametrize("text, expected", [tuple(c) for c in REF["casing"] if c[0]])
def test_the_casing_a_person_writes(text, expected):
    assert casing(text) == expected


def test_the_make_comes_from_the_page_furniture():
    got = core.call({"op": "sticker_fields", "record": {"make": "Ford", "overview": {"model_line": "Bronco"}}})
    assert got["fields"]["make"] == "Ford" and got["vehicle"]["make"] == "Ford"


def test_a_placeholder_says_only_its_vin():
    got = core.call({"op": "sticker_fields", "record": {"placeholder": True, "overview": {"vin": "1FT8W2BT2REC59903", "model_line": "X"}}})
    assert got == {"fields": {"vin": "1FT8W2BT2REC59903"}, "vehicle": {"vin": "1FT8W2BT2REC59903"}}


def test_wasm_matches():
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed; the wasm side of the parity check cannot run")
    wasm = REPO / "web" / "public" / "core" / "lotstretcher_core_bg.wasm"
    script = f"""
      import fs from 'node:fs';
      import {{ loadCore, call }} from '{(REPO / 'web' / 'public' / 'js' / 'core.js').as_posix()}';
      await loadCore(fs.readFileSync('{wasm.as_posix()}'));
      const records = JSON.parse(fs.readFileSync(0, 'utf8'));
      process.stdout.write(JSON.stringify(records.map((record) => call({{ op: 'sticker_fields', record }}))));
    """
    run = subprocess.run([node, "--input-type=module", "-e", script],
                         input=json.dumps([c["record"] for c in REF["cases"]]), capture_output=True, text=True, check=True)
    for got, case in zip(json.loads(run.stdout), REF["cases"]):
        assert got == {"fields": case["fields"], "vehicle": case["vehicle"]}
