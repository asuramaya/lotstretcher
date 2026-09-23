"""The wheel money shot's mask arithmetic in the core against the numpy
and OpenCV it replaced (imaging/wheel.py and photos.py before the
seventh core slice). The models are mocked away: what is tested is
what happens to a mask once one exists.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from lotstretcher import core

pytestmark = pytest.mark.skipif(not core.available(), reason=f"core not built: {core.why_unavailable()}")

REPO = Path(__file__).resolve().parents[1]
W = json.loads((REPO / "shared" / "pipeline-spec.json").read_text())["wheel"]


def disc(mask, cx, cy, r):
    h, w = mask.shape
    yy, xx = np.mgrid[:h, :w]
    mask[(xx - cx) ** 2 + (yy - cy) ** 2 <= r * r] = True


def ref_components(mask):
    import cv2
    n, labels = cv2.connectedComponents(mask.astype(np.uint8))
    counts = np.bincount(labels.ravel())
    counts[0] = 0
    largest = labels == int(counts.argmax())
    return n - 1, largest


def as_l(mask):
    return Image.fromarray(np.where(mask, 255, 0).astype(np.uint8), mode="L")


def stats(mask):
    return core.call({"op": "mask_stats", "mask": {"$image": 0}}, [as_l(mask)])


def test_one_wheel_reads_as_one_dominant_blob():
    m = np.zeros((300, 400), dtype=bool)
    disc(m, 200, 160, 90)
    disc(m, 40, 40, 6)  # a stray confident speck
    s = stats(m)
    n, largest = ref_components(m)
    ys, xs = np.where(largest)
    assert s["components"] == n == 2
    assert s["largest_bbox"] == [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]
    assert s["dominance"] == pytest.approx(largest.sum() / m.sum())
    assert s["largest_width_frac"] == pytest.approx((xs.max() - xs.min() + 1) / 400)
    assert s["dominance"] >= W["centricMinDominance"] and s["largest_width_frac"] >= W["centricMinWidthFraction"]


def test_two_axles_read_as_two_blobs_neither_dominant():
    m = np.zeros((300, 800), dtype=bool)
    disc(m, 150, 220, 40)
    disc(m, 650, 220, 44)
    s = stats(m)
    n, largest = ref_components(m)
    assert s["components"] == n == 2
    assert s["dominance"] == pytest.approx(largest.sum() / m.sum())
    assert s["dominance"] < W["centricMinDominance"]
    assert s["largest_width_frac"] < W["centricMinWidthFraction"]


def test_bbox_matches_numpy_where_and_diagonal_pixels_connect():
    """cv2's default is 8-connectivity: pixels touching at a corner are
    one blob."""
    m = np.zeros((10, 10), dtype=bool)
    m[2, 2] = m[3, 3] = m[4, 4] = True
    m[8, 1] = True
    s = stats(m)
    ys, xs = np.where(m)
    assert s["bbox"] == [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]
    assert s["components"] == ref_components(m)[0] == 2
    assert s["largest_pixels"] == 3


def test_empty_mask():
    s = stats(np.zeros((8, 8), dtype=bool))
    assert not s["any"] and s["components"] == 0


def test_cutout_matches_the_numpy_composite_and_drops_fragments():
    rng = np.random.default_rng(3)
    photo = Image.fromarray(rng.integers(0, 255, (240, 320, 3), dtype=np.uint8), mode="RGB")
    m = np.zeros((240, 320), dtype=bool)
    disc(m, 160, 120, 70)
    m[5:12, 300:310] = True  # the mudguard scrap
    got = core.call({"op": "cutout_from_mask", "photo": {"$image": 0}, "mask": {"$image": 1},
                     "largest_only": True}, [photo, as_l(m)])
    _, largest = ref_components(m)
    ys, xs = np.where(largest)
    left, top, right, bottom = int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1
    alpha = np.where(largest, 255, 0).astype(np.uint8)
    ref = Image.fromarray(np.dstack([np.array(photo), alpha]), mode="RGBA").crop((left, top, right, bottom))
    assert got.mode == "RGBA" and got.size == ref.size
    assert got.tobytes() == ref.tobytes()
    aspect = (right - left) / (bottom - top)
    s = core.call({"op": "mask_stats", "mask": {"$image": 0}}, [as_l(m)])
    assert s["largest_aspect"] == pytest.approx(aspect)
    assert W["minAngleAspect"] <= s["largest_aspect"] <= W["maxAngleAspect"]


def test_tread_on_angle_fails_the_aspect_gate():
    m = np.zeros((300, 300), dtype=bool)
    m[40:260, 120:180] = True  # tall and narrow: a front-on tread shot
    assert stats(m)["largest_aspect"] < W["minAngleAspect"]


def test_duplicate_score_separates_a_copy_from_a_different_wheel():
    from lotstretcher.photos import _is_duplicate_wheel

    rng = np.random.default_rng(5)
    a = Image.fromarray(rng.integers(0, 255, (120, 130, 3), dtype=np.uint8), mode="RGB")
    b = Image.fromarray(rng.integers(0, 255, (120, 130, 3), dtype=np.uint8), mode="RGB")
    same = core.call({"op": "duplicate_score", "a": {"$image": 0}, "b": {"$image": 1}}, [a, a])
    other = core.call({"op": "duplicate_score", "a": {"$image": 0}, "b": {"$image": 1}}, [a, b])
    assert same == pytest.approx(1.0) and same > W["duplicateSimilarity"]
    assert other < W["duplicateSimilarity"]
    kept: list = []
    assert not _is_duplicate_wheel(a, kept)
    assert _is_duplicate_wheel(a.copy(), kept)
    assert not _is_duplicate_wheel(b, kept)
    assert len(kept) == 2
