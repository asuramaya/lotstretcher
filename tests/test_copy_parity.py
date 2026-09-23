"""The post copy is built once, in the core, for both surfaces.

facebook_post.py and social_post.py used to build the text in Python
and web/public/js/pipeline/copy.js ported them line for line, with this
test comparing the two. Both are thin hosts over core/src/copy.rs now.
tests/fixtures/copy-reference.json holds what the Python produced for
seven vehicles before it was deleted, and this test holds the core to
it natively (through the Python host) and in the wasm build (through
copy.js under node, with the wasm bytes read from disk). Needs node for
the second half; skipped (and says so) without it.

The vehicles are chosen to fire every branch the Python had a comment
explaining: a new Ford with a sticker (MSRP from the sticker, warranty
block, incentive language suppressed, the v.ford.com link), a used
non-Ford without one (site features, CARFAX 1-Owner, an original-MSRP
comparison from a sticker, a trim long enough to lose its hashtag, the
"Sport Utility/SUV/Crossover" body string), an EV with no price, a new
vehicle with delivery mileage that must not be spoken aloud, a used car
with no sticker, a title long enough to trim the Threads post, and a
new vehicle priced from the site's MSRP row.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from lotstretcher import core, dealer_config
from lotstretcher.facebook_post import build_facebook_post, check_pricing_consistency, explain_facebook_post
from lotstretcher.scrape import Vehicle
from lotstretcher.social_post import build_hashtags, build_instagram_caption, build_threads_post

pytestmark = pytest.mark.skipif(not core.available(), reason=f"core not built: {core.why_unavailable()}")

REPO = Path(__file__).resolve().parents[1]
REF = json.loads((REPO / "tests" / "fixtures" / "copy-reference.json").read_text())
DEALER, VEHICLES, EXPECTED = REF["dealer"], REF["vehicles"], REF["expected"]


@pytest.fixture(scope="module", autouse=True)
def dealer(tmp_path_factory):
    cfg = tmp_path_factory.mktemp("cfg") / "dealer.json"
    cfg.write_text(json.dumps({
        "dealer_name": DEALER["name"], "dealer_greeting": DEALER["greeting"],
        "dealer_address": DEALER["address"], "city_tags": DEALER["city_tags"],
    }))
    dealer_config.reload(cfg)
    yield
    dealer_config.reload()


def python_posts(fields: dict) -> dict:
    v = Vehicle(**fields)
    return {
        "facebook": build_facebook_post(v),
        "instagram": build_instagram_caption(v),
        "threads": build_threads_post(v),
        "hashtags": build_hashtags(v),
        "explain": explain_facebook_post(v),
        "issues": check_pricing_consistency(v),
    }


@pytest.fixture(scope="module")
def js_posts() -> dict:
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed; the JS side of the parity check cannot run")
    wasm = REPO / "web" / "public" / "core" / "lotstretcher_core_bg.wasm"
    script = f"""
      import {{ loadCore }} from '{(REPO / 'web' / 'public' / 'js' / 'core.js').as_posix()}';
      import {{ buildPosts }} from '{(REPO / 'web' / 'public' / 'js' / 'pipeline' / 'copy.js').as_posix()}';
      import fs from 'node:fs';
      await loadCore(fs.readFileSync('{wasm.as_posix()}'));
      const {{ vehicles, dealer }} = JSON.parse(fs.readFileSync(0, 'utf8'));
      const out = {{}};
      for (const [name, v] of Object.entries(vehicles)) out[name] = buildPosts(v, {{ dealer }});
      process.stdout.write(JSON.stringify(out));
    """
    run = subprocess.run([node, "--input-type=module", "-e", script],
                         input=json.dumps({"vehicles": VEHICLES, "dealer": DEALER}),
                         capture_output=True, text=True, check=True)
    return json.loads(run.stdout)


@pytest.mark.parametrize("name", list(VEHICLES))
@pytest.mark.parametrize("platform", ["facebook", "instagram", "threads"])
def test_native_post_matches_the_python_it_replaced(name, platform):
    py = python_posts(VEHICLES[name])
    assert py[platform] == EXPECTED[name][platform], f"{name}/{platform}\n{py[platform]}"


@pytest.mark.parametrize("name", list(VEHICLES))
def test_native_hashtags_and_notes_match(name):
    py = python_posts(VEHICLES[name])
    assert py["hashtags"] == EXPECTED[name]["hashtags"]
    assert py["explain"] == EXPECTED[name]["explain"]
    assert py["issues"] == EXPECTED[name]["issues"]


@pytest.mark.parametrize("name", list(VEHICLES))
@pytest.mark.parametrize("platform", ["facebook", "instagram", "threads"])
def test_wasm_post_matches(js_posts, name, platform):
    assert js_posts[name][platform] == EXPECTED[name][platform], f"{name}/{platform}\n{js_posts[name][platform]}"


@pytest.mark.parametrize("name", list(VEHICLES))
def test_wasm_hashtags_and_notes_match(js_posts, name):
    assert js_posts[name]["hashtags"] == EXPECTED[name]["hashtags"]
    assert js_posts[name]["explain"] == EXPECTED[name]["explain"]


def test_fixtures_fire_the_branches():
    """Pin the behaviours these vehicles exist to exercise, so a hollowed
    fixture cannot make the comparison pass trivially."""
    fb = EXPECTED["new_ford_with_sticker"]["facebook"]
    assert "Price: $48,905" in fb                 # sticker MSRP, not the site's discounted price
    assert "rebate" not in fb                     # incentive language suppressed on a new vehicle
    assert "Factory Warranties:" in fb
    assert "More details: http://v.ford.com/" in fb
    assert fb.count("Fog Lamps") == 1             # case-insensitive feature dedupe

    used = EXPECTED["used_kia_with_features"]
    assert "Original MSRP: $52,110" in used["facebook"]
    assert "#KiaTellurideSxPrestigeXLineNightfallEditionAwd" not in used["instagram"]  # too long
    assert "#SUV" in used["instagram"]
    assert used["facebook"].count("Sunroof") + used["facebook"].count("SUNROOF") == 1
    assert len(used["threads"]) <= 501

    assert "Price: Call for Price" in EXPECTED["ev_no_price"]["facebook"]
    assert "2 mi" not in EXPECTED["new_delivery_mileage"]["threads"]
    assert len(EXPECTED["long_title_threads_cut"]["threads"]) <= 501
    assert EXPECTED["new_no_sticker_msrp_row"]["explain"]["price_source"] == "site_pricing_rows_msrp"
    assert "Price: $58,120" in EXPECTED["new_no_sticker_msrp_row"]["facebook"]
