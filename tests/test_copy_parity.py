"""The browser's post copy is the CLI's post copy.

web/public/js/pipeline/copy.js ports facebook_post.build_facebook_post,
social_post.build_threads_post and social_post.build_instagram_caption.
This runs both sides on the same vehicles, with the same dealer
boilerplate, and compares the finished text byte for byte. Needs node;
skipped (and says so) without it.

The vehicles are chosen to fire every branch the Python has a comment
explaining: a new Ford with a sticker (MSRP from the sticker, warranty
block, incentive language suppressed, the v.ford.com link), a used
non-Ford without one (site features, CARFAX 1-Owner, an original-MSRP
comparison from a sticker, a trim long enough to lose its hashtag, the
"Sport Utility/SUV/Crossover" body string), an EV with no price, and a
new vehicle with delivery mileage that must not be spoken aloud.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from lotstretcher import dealer_config
from lotstretcher.facebook_post import build_facebook_post
from lotstretcher.scrape import Vehicle
from lotstretcher.social_post import build_instagram_caption, build_threads_post

REPO = Path(__file__).resolve().parents[1]

DEALER = {
    "name": "Example Motors",
    "greeting": "Ask for Sam!",
    "address": "100 Main St, Austin, TX 78701",
    "city_tags": ["Austin", "AustinTX", "ATXCars"],
}

STICKER_NEW = {
    "pricing": {"total_msrp": "48,905"},
    "equipment": {
        "exterior": ["LED Fog Lamps", "Power Mirrors"],
        "interior": ["Heated Seats", "Led Fog Lamps"],   # dup, different case
        "functional_tech": ["SYNC 4"],
        "safety_security": ["Lane Keeping"],
    },
    "optional_equipment": ["Tow Package", "Heated seats"],
    "warranties": ["3yr/36,000 Bumper To Bumper", "5yr/60,000 Powertrain"],
}

VEHICLES = {
    "new_ford_with_sticker": dict(
        url="u", vin="1FTVW1EL0PWG12345", stock_number="T1", year="2025", make="Ford",
        model="Maverick", trim="Lariat", condition="New", mileage=7,
        title="2025 Ford Maverick Lariat", exterior_color_factory="Area 51",
        interior_color="Navy Pier", engine="2.0L EcoBoost", transmission="8-Speed Automatic",
        drivetrain="AWD", mpg_city="22", mpg_highway="28-30", body_type="Truck",
        cab_style="SuperCrew", box_length="4.5 ft", display_price="45,999",
        pricing_rows=[{"label": "MSRP", "text": "$48,905"}],
        dealer_description="Price includes $1,000 rebate. Call today!",
        sticker=STICKER_NEW,
    ),
    "used_kia_with_features": dict(
        url="u", vin="5XYP3DHC0NG123456", stock_number="K2", year="2022", make="Kia",
        model="Telluride", trim="SX Prestige X-Line Nightfall Edition AWD", condition="Used",
        mileage=31250, title="2022 Kia Telluride SX Prestige X-Line Nightfall Edition AWD",
        exterior_color_factory="Wolf Gray", interior_color="Black", engine="3.8L V6",
        transmission="Automatic", drivetrain="AWD", mpg_city="18", mpg_highway="24",
        body_type="Sport Utility/SUV/Crossover", display_price=38995,
        dealer_description="One owner, <b>clean</b> history.\n\nWell kept.",
        main_features=["CLEAN CARFAX", "1 OWNER", "Sunroof", "SUNROOF"],
        carfax_one_owner=True,
        sticker={"pricing": {"total_msrp": "52,110"}},
    ),
    "ev_no_price": dict(
        url="u", vin="1FT6W1EV3PWG00001", year="2023", make="Ford", model="F-150 Lightning",
        trim="XLT", condition="Certified Pre-Owned", mileage=12000,
        title="2023 Ford F-150 Lightning XLT", exterior_color_factory="Antimatter Blue",
        ev_battery_range=320, ev_mpge_combined=70, body_type="Crew Cab Pickup",
        features_structured={"Comfort": ["Heated Steering Wheel"], "Tech": ["Pro Power Onboard"]},
    ),
    "new_delivery_mileage": dict(
        url="u", vin="1FMSK8DH0PGA00002", stock_number="E9", year="2027", make="Ford",
        model="Expedition", trim="King Ranch", condition="New", mileage=2,
        title="2027 Ford Expedition King Ranch", display_price=90460,
    ),
}


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
    }


@pytest.fixture(scope="module")
def js_posts() -> dict:
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed; the JS side of the parity check cannot run")
    script = f"""
      import {{ buildAllPosts }} from '{(REPO / 'web' / 'public' / 'js' / 'pipeline' / 'copy.js').as_posix()}';
      import fs from 'node:fs';
      const {{ vehicles, dealer }} = JSON.parse(fs.readFileSync(0, 'utf8'));
      const out = {{}};
      for (const [name, v] of Object.entries(vehicles)) out[name] = buildAllPosts(v, {{ dealer }});
      process.stdout.write(JSON.stringify(out));
    """
    run = subprocess.run([node, "--input-type=module", "-e", script],
                         input=json.dumps({"vehicles": VEHICLES, "dealer": DEALER}),
                         capture_output=True, text=True, check=True)
    return json.loads(run.stdout)


@pytest.mark.parametrize("name", list(VEHICLES))
@pytest.mark.parametrize("platform", ["facebook", "instagram", "threads"])
def test_post_matches(js_posts, name, platform):
    py = python_posts(VEHICLES[name])[platform]
    js = js_posts[name][platform]
    assert js == py, f"{name}/{platform}\n--- python ---\n{py}\n--- js ---\n{js}"


def test_fixtures_fire_the_branches():
    """Pin the behaviours these vehicles exist to exercise, so a hollowed
    fixture cannot make the comparison pass trivially."""
    fb = python_posts(VEHICLES["new_ford_with_sticker"])["facebook"]
    assert "Price: $48,905" in fb                 # sticker MSRP, not the site's discounted price
    assert "rebate" not in fb                     # incentive language suppressed on a new vehicle
    assert "Factory Warranties:" in fb
    assert "More details: http://v.ford.com/" in fb
    assert fb.count("Fog Lamps") == 1             # case-insensitive feature dedupe

    used = python_posts(VEHICLES["used_kia_with_features"])
    assert "Original MSRP: $52,110" in used["facebook"]
    assert "#KiaTellurideSxPrestigeXLineNightfallEditionAwd" not in used["instagram"]  # too long
    assert "#SUV" in used["instagram"]
    assert used["facebook"].count("Sunroof") + used["facebook"].count("SUNROOF") == 1
    assert len(used["threads"]) <= 501

    assert "Price: Call for Price" in python_posts(VEHICLES["ev_no_price"])["facebook"]
    assert "2 mi" not in python_posts(VEHICLES["new_delivery_mileage"])["threads"]
