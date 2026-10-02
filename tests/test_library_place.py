"""Where a vehicle lives in a library (core/src/library_place.rs): its
bucket and folder, which the CLI files a scrape under and the browser's
Save to library writes a run to. Held to scrape.py's own condition_bucket
and vehicle_folder_name as they were (kept below as the reference) on
every record in the operator's library and on accented names, natively
and in the wasm build under node."""
from __future__ import annotations

import glob
import json
import re
import shutil
import subprocess
import unicodedata
from pathlib import Path

import pytest

from lotstretcher import core

pytestmark = pytest.mark.skipif(not core.available(), reason=f"core not built: {core.why_unavailable()}")

REPO = Path(__file__).resolve().parents[1]
KEYS = ("year", "make", "model", "trim", "stock_number", "vin", "condition")


def reference(record: dict, url: str) -> dict:
    """scrape.py before the core took it over."""
    def slugify(*parts, maxlen=80):
        text = "-".join(p for p in parts if p)
        text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
        text = re.sub(r"[^\w\s-]", "", text)
        text = re.sub(r"[\s_]+", "-", text).strip("-")
        return text[:maxlen] or "vehicle"
    condition = (record.get("condition") or "").strip().lower()
    if condition:
        bucket = "new" if condition == "new" else "used"
    elif url:
        bucket = "used" if "used" in url.lower() else "new"
    else:
        bucket = "used"
    tail = (record.get("stock_number") or record.get("vin") or "unknown")[-8:]
    folder = slugify(record.get("year") or "", record.get("make") or "", record.get("model") or "",
                     record.get("trim") or "", tail)
    return {"bucket": bucket, "folder": folder}


def cases() -> list[tuple[dict, str]]:
    out = []
    for f in sorted(glob.glob(str(Path.home() / "Documents" / "listings" / "*" / "*" / "details.json"))):
        data = json.loads(Path(f).read_text())
        v = data.get("vehicle", data)
        out.append(({k: v.get(k) for k in KEYS}, v.get("url") or ""))
    out += [
        ({"year": "2024", "make": "Citroën", "model": "Ë-C4", "trim": "Shine Plus", "stock_number": "Ñ123"}, ""),
        ({"year": "2023", "make": "Mercedes-Benz", "model": "GLE 350", "trim": "4MATIC®  SUV", "vin": "4JGFB4KB0PA000001"}, ""),
        ({"make": "Ford", "model": "F-150", "trim": "XL_Pkg / 101A", "condition": " NEW "}, "https://x/Used-2023"),
        ({"model": "Bronco", "condition": "Certified"}, ""),
        ({}, "https://www.tomballford.com/vehicle/1FT/2026-Ford-F-150/"),
        ({}, "https://www.tomballford.com/vehicle/1FT/Used-2021-Ford-Bronco/"),
        ({"year": "2025", "make": "Ford", "model": "Super Duty F-250 SRW", "trim": "Lariat " * 20, "stock_number": "S1"}, ""),
        ({"year": 2022, "make": "Toyota", "model": "Camry", "trim": "", "stock_number": "", "vin": "4T1C11AK5NU000000"}, ""),
    ]
    return out


def test_every_record_is_filed_where_the_cli_filed_it():
    checked = 0
    for record, url in cases():
        expect = reference({k: (str(v) if isinstance(v, int) else v) for k, v in record.items()}, url)
        assert core.call({"op": "library_place", "record": record, "url": url}) == expect, record
        checked += 1
    assert checked >= 8


def test_scrape_asks_the_core():
    from lotstretcher.scrape import Vehicle, condition_bucket, vehicle_folder_name
    v = Vehicle(url="u", year="2016", make="Ford", model="Mustang", trim="Shelby GT350", stock_number="G522288")
    assert vehicle_folder_name(v) == "2016-Ford-Mustang-Shelby-GT350-G522288"
    assert condition_bucket(v, "https://x/Used-2016-Ford") == "used"


def test_wasm_matches():
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed; the wasm side of the parity check cannot run")
    wasm = REPO / "web" / "public" / "core" / "lotstretcher_core_bg.wasm"
    script = f"""
      import fs from 'node:fs';
      import {{ loadCore, call }} from '{(REPO / 'web' / 'public' / 'js' / 'core.js').as_posix()}';
      await loadCore(fs.readFileSync('{wasm.as_posix()}'));
      const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
      process.stdout.write(JSON.stringify(cases.map(([record, url]) => call({{ op: 'library_place', record, url }}))));
    """
    all_cases = cases()
    run = subprocess.run([node, "--input-type=module", "-e", script],
                         input=json.dumps(all_cases), capture_output=True, text=True, check=True)
    for got, (record, url) in zip(json.loads(run.stdout), all_cases):
        assert got == core.call({"op": "library_place", "record": record, "url": url})
