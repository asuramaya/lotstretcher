"""
Recraft API asset generation -- backgrounds and (later) borders, generated
on demand and saved into assets/ with a manifest.json entry, so the same
lookup in imaging/assets.py works whether an asset was hand-picked or
AI-generated. Nothing here runs automatically; it's called explicitly via
generate_assets.py (a paid API call per image, on purpose never a silent
side effect of the main scraping pipeline).

Requires RECRAFT_API_KEY in .env at the repo root (gitignored -- never log,
print, or commit that key; _api_key() only ever reads it). The OpenRouter
provider reads OPENROUTER_API_KEY the same way, under the same rule.

API reference (verified against recraft.ai/docs, Aug 2026): POST
https://external.api.recraft.ai/v1/images/generations, Bearer auth, JSON
body {prompt, model, size, n, response_format}. Default model is
recraftv4_1 ($0.035/image) rather than the Pro tier (6x the cost) -- bump
via the model= kwarg if a specific generation needs the higher quality.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

import requests

def _find_root_dir() -> Path:
    curr = Path(__file__).resolve()
    for parent in curr.parents:
        if (parent / "assets" / "manifest.json").exists() or (parent / "setup.py").exists():
            return parent
    return Path(__file__).resolve().parents[3]


ROOT = _find_root_dir()
ENV_PATH = ROOT / ".env"
ASSETS_DIR = ROOT / "assets"
MANIFEST_PATH = ASSETS_DIR / "manifest.json"

API_URL = "https://external.api.recraft.ai/v1/images/generations"
DEFAULT_MODEL = "recraftv4_1"
DEFAULT_SIZE = "1024x1024"

# OpenRouter: one chat completion asking for an image back (the API's
# image-output route: modalities ["image", "text"], the picture comes as
# a data URL in choices[0].message.images). The default model is a
# fast, cheap image model; pass another with --model.
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_MODEL = "google/gemini-2.5-flash-image"
PROVIDERS = ("recraft", "openrouter")

# The categories a generated set is sorted into, each with a prompt the
# generator varies by index. Every background is empty of vehicles,
# text and logos: the car is composited on top and the words are the
# core's. A category is also the tag the app groups the tiles by.
CATEGORY_PROMPTS = {
    "showroom": "an empty modern car showroom interior, polished reflective floor, soft overhead lighting, "
                "wide open floor in the foreground, no vehicles, no people, no text, no logos",
    "lot": "an empty dealership lot at golden hour, clean asphalt in the foreground, low sun, long soft "
           "shadows, distant buildings blurred, no vehicles, no people, no text, no logos",
    "road": "an empty scenic road, smooth asphalt in the foreground, open landscape beyond, soft daylight, "
            "no vehicles, no people, no signs, no text",
    "studio": "a photography studio cyclorama, seamless curved backdrop, single soft key light, gentle "
              "floor reflection, muted colour, no objects, no text",
    "abstract": "an abstract backdrop of soft light gradients and gentle geometric shapes, deep colour, "
                "clean floor plane in the lower third, no text, no logos",
    "seasonal": "an empty outdoor scene in a clear season, foreground ground plane clean and level, soft "
                "natural light, no vehicles, no people, no text",
}
CATEGORY_VARIANTS = ("wide shot", "low angle", "evening light", "overcast light", "close and intimate", "cool tones", "warm tones")


def _load_env() -> dict:
    env = {}
    if ENV_PATH.exists():
        for line in ENV_PATH.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def _api_key(name: str = "RECRAFT_API_KEY") -> str:
    key = os.environ.get(name) or _load_env().get(name)
    if not key:
        raise RuntimeError(f"{name} not set (expected in .env at the repo root)")
    return key


def generate_image_openrouter(prompt: str, model: str = OPENROUTER_MODEL) -> bytes:
    """One paid OpenRouter call that returns an image. The key is read,
    sent in the header, and never printed."""
    import base64
    headers = {"Authorization": f"Bearer {_api_key('OPENROUTER_API_KEY')}", "Content-Type": "application/json",
               "HTTP-Referer": "https://lotstretcher.org", "X-Title": "lotstretcher"}
    body = {"model": model, "modalities": ["image", "text"],
            "messages": [{"role": "user", "content": f"Generate one image: {prompt}. Photographic, 16:9, no text."}]}
    resp = requests.post(OPENROUTER_URL, json=body, headers=headers, timeout=120)
    resp.raise_for_status()
    message = resp.json()["choices"][0]["message"]
    images = message.get("images") or []
    if not images:
        raise RuntimeError("OpenRouter returned no image; the model may not support image output")
    url = images[0]["image_url"]["url"]
    if url.startswith("data:"):
        return base64.b64decode(url.split(",", 1)[1])
    got = requests.get(url, timeout=60)
    got.raise_for_status()
    return got.content


def generate_image(prompt: str, model: str = DEFAULT_MODEL, size: str = DEFAULT_SIZE,
                    style: str | None = None) -> bytes:
    """One paid API call. Returns raw image bytes (Recraft returns a URL;
    this downloads it so callers don't have to)."""
    headers = {"Authorization": f"Bearer {_api_key()}", "Content-Type": "application/json"}
    body = {"prompt": prompt, "model": model, "size": size, "n": 1, "response_format": "url"}
    if style:
        body["style"] = style

    resp = requests.post(API_URL, json=body, headers=headers, timeout=60)
    resp.raise_for_status()
    image_url = resp.json()["data"][0]["url"]

    img_resp = requests.get(image_url, timeout=60)
    img_resp.raise_for_status()
    return img_resp.content


def _slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or "asset"


def _load_manifest() -> dict:
    if MANIFEST_PATH.exists():
        return json.loads(MANIFEST_PATH.read_text())
    return {"backgrounds": [], "borders": []}


def _save_manifest(manifest: dict) -> None:
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n")


def _add_asset(kind: str, dest: Path, name: str, tags: list[str], prompt: str,
               category: str | None = None, studio: bool = False, hosted: bool = False) -> None:
    """Register one file in assets/manifest.json. `category` is what the
    app groups the tile under; `studio` ships it with the site;
    `hosted` means the site loads it from the CDN (build-studio.py
    --hosted-base) rather than carrying the bytes."""
    manifest = _load_manifest()
    entry = {
        "file": f"{kind}/{dest.name}",
        "name": name,
        "tags": [*tags, "ai-generated"],
        "prompt": prompt,
    }
    if category:
        entry["category"] = category
    if studio:
        entry["studio"] = True
    if hosted:
        entry["hosted"] = True
    manifest.setdefault(kind, []).append(entry)
    _save_manifest(manifest)


def generate_background(prompt: str, name: str, tags: list[str] | None = None, provider: str = "recraft",
                        category: str | None = None, studio: bool = False, hosted: bool = False, **kwargs) -> Path:
    if provider == "openrouter":
        content = generate_image_openrouter(prompt, **{k: v for k, v in kwargs.items() if k == "model"})
    elif provider == "recraft":
        content = generate_image(prompt, **kwargs)
    else:
        raise ValueError(f"unknown provider {provider!r}; one of {', '.join(PROVIDERS)}")
    dest = ASSETS_DIR / "backgrounds" / f"{_slugify(name)}.png"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(content)
    _add_asset("backgrounds", dest, name, tags or [], prompt, category=category, studio=studio, hosted=hosted)
    return dest


def set_plan(categories: list[str], count: int) -> list[dict]:
    """What a categorised set would generate: one entry per (category,
    variant), named "<Category> <n>", tagged with the category. Pure, so
    --dry-run can print it and a test can check it."""
    plan = []
    for cat in categories:
        base = CATEGORY_PROMPTS.get(cat)
        if base is None:
            raise ValueError(f"unknown category {cat!r}; one of {', '.join(CATEGORY_PROMPTS)}")
        for i in range(count):
            variant = CATEGORY_VARIANTS[i % len(CATEGORY_VARIANTS)]
            plan.append({"category": cat, "name": f"{cat.title()} {i + 1}", "prompt": f"{base}, {variant}",
                         "tags": [cat, variant.replace(" ", "-")]})
    return plan


def generate_set(categories: list[str], count: int = 2, provider: str = "openrouter", hosted: bool = True,
                 dry_run: bool = False, **kwargs) -> list[Path]:
    """Generate a categorised set of backgrounds and register each as a
    studio asset (hosted: the site loads it from the CDN). Every item is
    a paid call; --dry-run prints the plan and calls nothing."""
    out = []
    for item in set_plan(categories, count):
        if dry_run:
            print(f"would generate {item['name']!r} [{item['category']}]: {item['prompt']}")
            continue
        out.append(generate_background(item["prompt"], item["name"], item["tags"], provider=provider,
                                       category=item["category"], studio=True, hosted=hosted, **kwargs))
        print(f"saved {out[-1].name} [{item['category']}]")
    return out
