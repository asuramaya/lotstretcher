"""Every browser module parses. A syntax error in one module takes the
whole app down at load, before any behaviour can be tested, and nothing
else in this suite executes the client's JavaScript as a whole; this is
the cheapest check that catches it. Needs node."""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
JS = REPO / "web" / "public" / "js"
MODULES = sorted(p for p in JS.rglob("*.js") if "vendor" not in p.parts)
NODE = shutil.which("node")

pytestmark = pytest.mark.skipif(not NODE, reason="node is not installed")


@pytest.mark.parametrize("module", MODULES, ids=lambda p: str(p.relative_to(JS)))
def test_module_parses(module: Path):
    r = subprocess.run([NODE, "--input-type=module", "--check"], input=module.read_text(),
                       capture_output=True, text=True)
    assert r.returncode == 0, f"{module.relative_to(REPO)} does not parse:\n{r.stderr}"
