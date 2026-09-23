"""The interior treatment in the core against the numpy it replaced
(imaging/interior.py before the sixth core slice).

The reference below is that numpy, kept as the documented contract:
float32 throughout, a gamma lift faded out over the highlights of the
original luminance, a white balance from bright near-neutral pixels
that is partial and capped, and a gradient scrim. Run on synthetic
cabins and, when the library is present, on real interior photos.
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
K = json.loads((REPO / "shared" / "pipeline-spec.json").read_text())["interior"]
REAL = sorted((Path.home() / "Documents" / "listings" / "used").glob("*/images/interior/0[1-4].jpg"))[:6]


def ref_exposure(img, target_median=K["targetMedian"], max_lift=K["maxLift"]):
    arr = np.asarray(img.convert("RGB"), dtype=np.float32) / 255.0
    luminance = arr[..., 0] * 0.299 + arr[..., 1] * 0.587 + arr[..., 2] * 0.114
    median = float(np.median(luminance))
    if median <= 0.001 or median >= target_median:
        return img
    gamma = max(max_lift, np.log(target_median) / np.log(median))
    lifted = np.power(arr, gamma)
    t = np.clip((luminance - K["highlightKnee"]) / (K["highlightCeiling"] - K["highlightKnee"]), 0.0, 1.0)
    protect = (t * t * (3.0 - 2.0 * t))[..., None]
    blended = lifted * (1.0 - protect) + arr * protect
    return Image.fromarray((np.clip(blended, 0, 1) * 255).astype("uint8"), mode="RGB")


def ref_white_balance(img):
    arr = np.asarray(img.convert("RGB"), dtype=np.float32) / 255.0
    flat = arr.reshape(-1, 3)
    brightness = flat.max(axis=1)
    spread = flat.max(axis=1) - flat.min(axis=1)
    bright_enough = brightness >= np.percentile(brightness, K["whiteBalanceBrightPercentile"])
    neutralish = spread <= 0.18 * np.maximum(brightness, 1e-6) + 0.06
    sample = flat[bright_enough & neutralish & (brightness < 0.99)]
    if len(sample) < K["whiteBalanceMinSample"]:
        return img
    means = sample.mean(axis=0)
    if means.min() <= 1e-6:
        return img
    cast = float((means.max() - means.min()) / means.mean())
    if cast < K["whiteBalanceMinCast"]:
        return img
    gains = np.clip(means.mean() / means, 1.0 / K["whiteBalanceMaxGain"], K["whiteBalanceMaxGain"])
    gains = 1.0 + (gains - 1.0) * K["whiteBalanceStrength"]
    return Image.fromarray((np.clip(arr * gains, 0, 1) * 255).astype("uint8"), mode="RGB")


def ref_scrim(img, scrim_frac=K["scrimFrac"]):
    img = img.convert("RGB")
    w, h = img.size
    band = max(1, int(h * scrim_frac))
    arr = np.asarray(img, dtype=np.float32)
    ramp = np.linspace(0.0, K["scrimStrength"], band, dtype=np.float32) ** K["scrimGamma"]
    arr[h - band:] *= (1.0 - ramp)[:, None, None]
    return Image.fromarray(np.clip(arr, 0, 255).astype("uint8"), mode="RGB")


def cabin(seed, w=240, h=160, dark=0.35, cast=(1.0, 0.92, 0.8)):
    """A dim, warm-cast cabin with a blown window: the content the
    treatment exists for."""
    rng = np.random.default_rng(seed)
    base = rng.random((h, w, 3), dtype=np.float32) * dark
    base[:h // 3, w // 2:] = 0.97  # the window
    base[h // 2:, :w // 3] += 0.25  # a lighter seat
    base = np.clip(base * np.asarray(cast, dtype=np.float32), 0, 1)
    return Image.fromarray((base * 255).astype("uint8"), mode="RGB")


def diff(a, b):
    d = np.abs(np.asarray(a, dtype=np.int16) - np.asarray(b, dtype=np.int16))
    return float(d.mean()), int(d.max())


FIXTURES = [cabin(1), cabin(2, dark=0.6), cabin(3, cast=(0.85, 0.9, 1.0)), cabin(4, dark=0.1)]


@pytest.mark.parametrize("img", FIXTURES)
def test_exposure_matches_numpy(img):
    got = core.call({"op": "enhance_exposure", "image": {"$image": 0}}, [img])
    mean, mx = diff(got, ref_exposure(img))
    assert mx <= 1 and mean < 0.02, (mean, mx)


@pytest.mark.parametrize("img", FIXTURES)
def test_white_balance_matches_numpy(img):
    got = core.call({"op": "white_balance", "image": {"$image": 0}}, [img])
    mean, mx = diff(got, ref_white_balance(img))
    assert mx <= 1 and mean < 0.02, (mean, mx)


def test_scrim_matches_numpy():
    img = cabin(5, dark=0.9)
    got = core.call({"op": "scrim", "image": {"$image": 0}}, [img])
    mean, mx = diff(got, ref_scrim(img))
    assert mx <= 1 and mean < 0.01, (mean, mx)


def test_correctly_exposed_photo_passes_through_untouched():
    bright = cabin(6, dark=0.95, cast=(1.0, 1.0, 1.0))
    got = core.call({"op": "enhance_interior", "image": {"$image": 0}}, [bright])
    assert got.tobytes() == bright.tobytes()


def test_rgba_keeps_its_alpha():
    img = cabin(7).convert("RGBA")
    got = core.call({"op": "enhance_interior", "image": {"$image": 0}}, [img])
    assert got.mode == "RGBA" and got.getchannel("A").tobytes() == img.getchannel("A").tobytes()
    assert diff(got.convert("RGB"), ref_exposure(ref_white_balance(img.convert("RGB"))))[1] <= 1


@pytest.mark.skipif(not REAL, reason="no interior photos in ~/Documents/listings")
@pytest.mark.parametrize("path", REAL, ids=[f"{p.parents[2].name}/{p.name}" for p in REAL])
def test_real_interiors_match_numpy(path):
    from lotstretcher.imaging.interior import enhance_interior

    img = Image.open(path).convert("RGB")
    got = enhance_interior(img)
    mean, mx = diff(got, ref_exposure(ref_white_balance(img)))
    assert mx <= 1 and mean < 0.02, (mean, mx)
