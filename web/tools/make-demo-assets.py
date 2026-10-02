#!/usr/bin/env python3
"""Rebuild the landing page's demo images and clips (web/public/demo/) with
the app as it is now.

Honest by construction: every image is what the app makes when a dealer's
photos are dropped into it. The script serves web/public, drives the real
app in a headless browser, and saves what it renders. The only step done
here rather than in the app is lining up the "before" photo with the
"after", so the compare slider shows the same car in the same place: the
app reports where the cutout sat in the photo (cutBox), a probe render on a
flat magenta backdrop shows where it landed in the still, and the photo is
scaled and moved to match.

    .venv/bin/python web/tools/make-demo-assets.py                 # everything
    .venv/bin/python web/tools/make-demo-assets.py --only looks,compare

Needs playwright (with chromium), Pillow and ffmpeg, and the two vehicles
below in a listings library. Run it after a change to how stills or clips
look, then commit web/public/demo/.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import functools
import http.server
import io
import json
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

from PIL import Image

REPO = Path(__file__).resolve().parents[2]
PUBLIC = REPO / "web" / "public"
OUT = PUBLIC / "demo"

# The two vehicles the landing shows: the Mustang in its looks and the
# compare, the Raptor in its shapes, its clips and the share card.
MUSTANG = ("used/2024-Ford-Mustang-GT-Premium-R5430042", ["01", "03", "04", "07"], "2024 Mustang GT")
COMPARE_PHOTO = "03.jpg"   # its front three-quarter without the dealer's banner across the top
RAPTOR = ("used/2025-Ford-F-150-Raptor-SFB17235", ["01", "02", "03", "04", "05", "07"], "2025 F-150 Raptor")

CLEAR = {k: None for k in ["titleFont", "titlePosition", "titleCase", "titleColor", "titleBox", "badgeColor",
                           "badgePosition", "badgeFont", "subtitleFont", "subtitlePosition", "subtitleColor",
                           "subtitleCase", "subtitleBox", "spotStrength", "backdropColor", "backdropColor2",
                           "background", "titleText"]}
BASE = {**CLEAR, "titleMode": "none", "priceBadge": False, "subtitle": "", "textPosition": "bl",
        "textFont": "Lato Bold", "textSize": 0.05, "textCase": "as-is", "textBoxed": False, "textColor": "white",
        "backdrop": "vehicle", "border": "none", "spotlight": True, "glow": False, "shadow": True,
        "shadowStrength": 0.5, "reflection": False, "frameColor": "white", "frameWeight": 0.008, "spotSpread": 0.85}
SHOWROOM = {"backdrop": "sweep", "shadowStrength": 0.55, "reflection": True, "reflectionStrength": 0.35}


def looks(title: str) -> dict:
    """The eight looks in the landing's grid, by the file they become."""
    text = {"titleMode": "vehicle", "titleText": title, "priceBadge": True}
    return {
        "paint": {**text},
        "showroom": SHOWROOM,
        "halo": {"backdrop": "radial", **text, "textPosition": "tc", "textFont": "Bebas Neue",
                 "textCase": "upper", "textSize": 0.07},
        "light": {"backdrop": "generic", "backdropColor": "#f1f2f4", "backdropColor2": "#c3c8d0",
                  "spotlight": False, "shadowStrength": 0.65, **text, "textColor": "black"},
        "flag": {"backdrop": "asset", "background": "American Flag", **text, "textBoxed": True,
                 "textCase": "upper", "textFont": "Oswald Bold"},
        "stock": {"backdrop": "asset", "background": "Futuristic Showroom"},
        "two-tone": {"backdrop": "generic", "backdropColor": "#0d1b2e", "backdropColor2": "#b4532a", **text,
                     "textFont": "Playfair Display Bold"},
        "glow": {"backdrop": "horizon", "glow": True, "glowColor": "white", "glowRadius": 32, "glowIntensity": 0.6,
                 "reflection": True, "reflectionStrength": 0.5, "border": "line", "frameColor": "paint",
                 "frameWeight": 0.012},
    }


# A flat backdrop nothing on a car is, with the light around the car off;
# laid over a look's own options, so the text (which moves the car) stays.
PROBE = {"backdrop": "generic", "backdropColor": "#ff00ff", "backdropColor2": "#ff00ff",
         "spotlight": False, "shadow": False, "reflection": False, "glow": False}


def image_of(data_url: str) -> Image.Image:
    return Image.open(io.BytesIO(base64.b64decode(data_url.split(",", 1)[1]))).convert("RGB")


def save_webp(img: Image.Image, name: str, width: int, small: bool = True, quality: int = 82) -> None:
    """name.webp at `width`, and name-sm.webp at half of it for the srcset."""
    for suffix, w in [("", width)] + ([("-sm", width // 2)] if small else []):
        h = round(img.height * w / img.width)
        path = OUT / f"{name}{suffix}.webp"
        img.resize((w, h), Image.LANCZOS).save(path, "WEBP", quality=quality, method=6)
        print(f"  {path.name:28} {w}x{h} {path.stat().st_size // 1024} KB", flush=True)


MODEL_ORIGIN = "https://models.lotstretcher.org/"


async def local_models(route) -> None:
    """The models from this checkout's web/public/models when it has them
    (models/<version>/name -> models/name), else from the model host."""
    name = route.request.url.rsplit("/", 1)[-1].split("?")[0]
    local = PUBLIC / "models" / name
    if local.is_file():
        await route.fulfill(path=str(local), headers={"access-control-allow-origin": "*",
                                                              "cross-origin-resource-policy": "cross-origin"})
    else:
        await route.continue_()


def serve(root: Path) -> tuple[http.server.ThreadingHTTPServer, str]:
    """web/dev-server.py's handler (the isolation headers, so the app runs
    threaded as it does on the site) on a free port."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("dev_server", REPO / "web" / "dev-server.py")
    dev = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(dev)
    handler = functools.partial(dev.Handler, directory=str(root))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{httpd.server_address[1]}"


class App:
    """The app in one headless page: load a vehicle, set options, run, read back."""

    def __init__(self, page, url: str, library: Path):
        self.page, self.url, self.library = page, url, library

    async def load(self, vehicle: tuple) -> dict:
        folder, picks, _title = vehicle
        d = self.library / folder
        v = json.loads((d / "details.json").read_text())
        v = v.get("vehicle", v)
        await self.page.goto(f"{self.url}/app.html?demo={folder[-8:]}", wait_until="load")
        await self.page.wait_for_timeout(1500)
        await self.page.set_input_files("#fileInput", [str(d / "images" / "exterior" / f"{n}.jpg") for n in picks])
        for field, key in [("year", "year"), ("make", "make"), ("model", "model"), ("trim", "trim"),
                           ("ext", "exterior_color_factory"), ("int", "interior_color")]:
            await self.page.fill(f"#f-{field}", str(v.get(key) or ""))
        await self.page.fill("#f-price", str(v.get("display_price") or ""))
        await self.page.fill("#f-miles", str(v.get("mileage") or ""))
        await self.page.select_option("#f-cond", "Used")
        for _ in range(600):
            await self.page.wait_for_timeout(1000)
            if await self.page.evaluate("() => !window.lotstretcher.state.preparing && window.lotstretcher.state.prepared"):
                return v
        raise TimeoutError(f"{folder}: the photos never finished preparing")

    async def run(self, options: dict, formats: list[str], video: list[str] = ()) -> None:
        await self.page.evaluate("() => document.querySelector('.nav-btn[data-go=options]').click()")
        await self.page.wait_for_timeout(400)
        await self.page.evaluate("(o) => Object.assign(window.lotstretcher.state.options, o)",
                                 {**options, "heroFormats": formats, "videoFormats": list(video)})
        await self.page.evaluate("() => { window.lotstretcher.state.done = false; document.getElementById('runBtn').click(); }")
        for _ in range(1200):
            await self.page.wait_for_timeout(1000)
            if await self.page.evaluate("() => window.lotstretcher.state.done && !window.lotstretcher.state.running"):
                return
        raise TimeoutError("the run never finished")

    async def lead(self, name: str | None = None) -> dict:
        """The named photo's still (else the front three-quarter's) in each
        shape it was made in, and where its cutout sat in the photo."""
        return await self.page.evaluate("""(name) => {
          const ps = window.lotstretcher.state.photos.filter((p) => p.heroes);
          const p = ps.find((p) => p.name === name) || ps.find((p) => p.angle === 'front_3q') || ps.find((p) => /front/.test(p.angle || '')) || ps[0];
          const url = (c) => { const cv = document.createElement('canvas'); cv.width = c.width; cv.height = c.height;
                               cv.getContext('2d').drawImage(c, 0, 0); return cv.toDataURL('image/png'); };
          return { name: p.name, box: p.cutBox?.box, photo: p.cutBox?.size,
                   heroes: Object.fromEntries(Object.entries(p.heroes).map(([k, c]) => [k, url(c)])) };
        }""", name)

    async def videos(self) -> dict:
        got = await self.page.evaluate("""async () => { const out = {};
          for (const [k, b] of Object.entries(window.lotstretcher.state.videos || {})) {
            const buf = new Uint8Array(await b.arrayBuffer()); let s = '';
            for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
            out[k] = btoa(s); }
          return out; }""")
        return {k: base64.b64decode(v) for k, v in got.items()}


def car_box(probe: Image.Image) -> tuple[int, int, int, int]:
    """Where the car landed in a probe render: the box of the largest patch
    that is not the magenta backdrop (the title and badge are smaller and
    sit apart, since the layout keeps the car clear of them)."""
    import numpy as np
    from scipy import ndimage
    a = np.asarray(probe).astype(int)
    solid = ~((a[..., 0] > 200) & (a[..., 1] < 60) & (a[..., 2] > 200))
    labels, n = ndimage.label(solid)
    biggest = 1 + int(np.argmax(ndimage.sum(solid, labels, range(1, n + 1))))
    ys, xs = np.nonzero(labels == biggest)
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def aligned_before(photo_path: Path, decoded: list[int], box: list[int], target: tuple, size: tuple) -> Image.Image:
    """The dealer's photo scaled and moved so its car sits where the still's does."""
    photo = Image.open(photo_path).convert("RGB")
    k = photo.width / decoded[0]                       # the app may decode below full size
    bx0, by0, bx1, by1 = (v * k for v in box)
    tx0, ty0, tx1, ty1 = target
    s = ((tx1 - tx0) / (bx1 - bx0) + (ty1 - ty0) / (by1 - by0)) / 2
    scaled = photo.resize((round(photo.width * s), round(photo.height * s)), Image.LANCZOS)
    import numpy as np
    ox, oy = round(tx0 - bx0 * s), round(ty0 - by0 * s)
    # Where the moved photo stops short of the frame, its edge runs on.
    left, top = max(0, ox), max(0, oy)
    right, bottom = max(0, size[0] - ox - scaled.width), max(0, size[1] - oy - scaled.height)
    if left or top or right or bottom:
        print(f"  the photo stops short of the frame by {left}/{top}/{right}/{bottom}px; its edge is extended",
              flush=True)
    padded = np.pad(np.asarray(scaled), ((top, bottom), (left, right), (0, 0)), mode="edge")
    x, y = left - ox, top - oy
    return Image.fromarray(padded[y:y + size[1], x:x + size[0]])


def clip(data: bytes, name: str, width: int, height: int) -> None:
    """A web-sized, silent, looping copy of the app's clip, and its poster."""
    with tempfile.NamedTemporaryFile(suffix=".mp4") as src:
        src.write(data)
        src.flush()
        mp4 = OUT / f"{name}.mp4"
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", src.name, "-an",
                        "-vf", f"scale={width}:{height}:flags=lanczos", "-c:v", "libx264", "-preset", "slow",
                        "-crf", "27", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(mp4)], check=True)
        frame = subprocess.run(["ffmpeg", "-loglevel", "error", "-ss", "1", "-i", str(mp4), "-frames:v", "1",
                                "-f", "image2pipe", "-vcodec", "png", "-"], check=True, capture_output=True).stdout
    print(f"  {mp4.name:28} {width}x{height} {mp4.stat().st_size // 1024} KB", flush=True)
    save_webp(Image.open(io.BytesIO(frame)).convert("RGB"), name, width, small=False)


async def build(only: set[str], library: Path) -> None:
    from playwright.async_api import async_playwright

    httpd, url = serve(PUBLIC)
    errors: list[str] = []
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch()
            page = await browser.new_page(viewport={"width": 1280, "height": 900})
            page.on("pageerror", lambda e: errors.append(str(e)[:300]))
            await page.route(f"{MODEL_ORIGIN}**", local_models)
            app = App(page, url, library)

            if only & {"looks", "compare", "sticker"}:
                print("Mustang", flush=True)
                await app.load(MUSTANG)
                title = MUSTANG[2]
                if "looks" in only:
                    for name, opts in looks(title).items():
                        await app.run({**BASE, **opts}, ["square"])
                        save_webp(image_of((await app.lead())["heroes"]["square"]), f"var-{name}", 720)
                if "compare" in only:
                    await app.run({**BASE, **looks(title)["paint"]}, ["square"])
                    lead = await app.lead(COMPARE_PHOTO)
                    after = image_of(lead["heroes"]["square"])
                    await app.run({**BASE, **looks(title)["paint"], **PROBE}, ["square"])
                    target = car_box(image_of((await app.lead(COMPARE_PHOTO))["heroes"]["square"]))
                    photo = library / MUSTANG[0] / "images" / "exterior" / lead["name"]
                    save_webp(after, "after", 900)
                    save_webp(aligned_before(photo, lead["photo"], lead["box"], target, after.size), "before", 900)
                if "sticker" in only:
                    sticker = library / MUSTANG[0] / "bundle" / "window-sticker-1a.png"
                    save_webp(Image.open(sticker).convert("RGB"), "sticker", 720, small=False, quality=78)

            if only & {"shapes", "clips", "share"}:
                print("Raptor", flush=True)
                await app.load(RAPTOR)
                text = {"titleMode": "vehicle", "titleText": RAPTOR[2], "priceBadge": True}
                video = ["vertical", "horizontal"] if "clips" in only else []
                await app.run({**BASE, **text, **SHOWROOM}, ["square", "portrait", "horizontal"], video)
                heroes = {k: image_of(v) for k, v in (await app.lead())["heroes"].items()}
                if "shapes" in only:
                    save_webp(heroes["square"], "shape-square", 900)
                    save_webp(heroes["portrait"], "shape-portrait", 506)
                    save_webp(heroes["horizontal"], "shape-horizontal", 900)
                if "share" in only:
                    wide = heroes["horizontal"].resize((1200, 675), Image.LANCZOS)
                    card = wide.crop((0, 22, 1200, 652))
                    card.save(OUT / "share.jpg", "JPEG", quality=86, optimize=True, progressive=True)
                    print(f"  share.jpg                    1200x630 {(OUT / 'share.jpg').stat().st_size // 1024} KB")
                if "clips" in only:
                    clips = await app.videos()
                    clip(clips["horizontal"], "clip-horizontal", 960, 540)
                    clip(clips["vertical"], "clip-portrait", 540, 960)
            await browser.close()
    finally:
        httpd.shutdown()
    if errors:
        sys.exit("page errors:\n  " + "\n  ".join(errors))


PARTS = ("looks", "compare", "sticker", "shapes", "clips", "share")


def main() -> None:
    global OUT
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--only", default=",".join(PARTS), help=f"Comma-separated parts: {', '.join(PARTS)}")
    parser.add_argument("--out", default=str(PUBLIC / "demo"), help="Where to write (default: web/public/demo)")
    parser.add_argument("--library", default=str(Path.home() / "Documents" / "listings"),
                        help="The listings library holding the two demo vehicles")
    args = parser.parse_args()
    OUT = Path(args.out).expanduser()
    OUT.mkdir(parents=True, exist_ok=True)
    only = {p.strip() for p in args.only.split(",") if p.strip()}
    unknown = only - set(PARTS)
    if unknown:
        parser.error(f"unknown part(s) {sorted(unknown)}; choose from {', '.join(PARTS)}")
    asyncio.run(build(only, Path(args.library).expanduser()))


if __name__ == "__main__":
    main()
