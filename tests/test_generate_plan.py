"""The categorised background set: its plan is pure and names every
category the app groups by; no network is touched here."""
import pytest

from lotstretcher.imaging.generate import CATEGORY_PROMPTS, PROVIDERS, set_plan


def test_the_plan_names_every_category_and_varies_the_prompt():
    plan = set_plan(list(CATEGORY_PROMPTS), 2)
    assert len(plan) == 2 * len(CATEGORY_PROMPTS)
    assert {p["category"] for p in plan} == set(CATEGORY_PROMPTS)
    a, b = [p for p in plan if p["category"] == "showroom"]
    assert a["prompt"] != b["prompt"] and a["name"] == "Showroom 1" and b["name"] == "Showroom 2"
    for p in plan:
        assert "no text" in p["prompt"] and p["category"] in p["tags"]
    assert "openrouter" in PROVIDERS


def test_an_unknown_category_is_refused():
    with pytest.raises(ValueError):
        set_plan(["neon"], 1)
