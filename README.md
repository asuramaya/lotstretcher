# lotstretcher

[![Python 3.11+](https://img.shields.io/badge/python-3.11+-blue.svg)](https://www.python.org/downloads/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Interface: CLI](https://img.shields.io/badge/interface-CLI-informational.svg)](#cli-command-reference)
[![Tests](https://img.shields.io/badge/tests-80%20passed-brightgreen.svg)](tests/)

**lotstretcher** automates the workflow of turning a vehicle listing from a dealership website
into polished, platform-specific social-media posts and high-converting marketing visuals -- stretching one
photo shoot into every format a dealer's lot needs to sell a car online.

Given a vehicle detail page (VDP) URL, it:

1. **Scrapes** vehicle specs, full-resolution photo galleries, window stickers, and Carfax history via Playwright (bypassing Cloudflare challenges).
2. **Processes** photos through a computer vision pipeline — zero-shot CLIP classification, rembg (BiRefNet) background removal, perceptual-hash deduplication (including a cross-vehicle photo cache that reuses an already-processed cutout when the dealer's CDN serves the same manufacturer stock photo to multiple listings), dealer banner cropping, and super-resolution upscaling.
3. **Composes** hero collages, solo framed images with branded borders, and animated MP4 video carousels — hero-video rendering runs across parallel workers with GPU-accelerated compositing, and overlaps with the next vehicle's scrape/CV work during a batch sync.
4. **Generates** ready-to-copy-paste posts for Facebook Marketplace, Instagram, and Threads — each tailored to platform character limits, hashtag strategies, and preview rules.
5. **Tracks** processed inventory via a persistent manifest, making daily syncs fast and incremental.

lotstretcher was originally built for [Tomball Ford](https://www.tomballford.com) (a DealerInspire CMS site) and is designed to work plug-and-play with any DealerInspire-powered dealership, and with any other dealership CMS via a pluggable extractor architecture.

---

## Why lotstretcher?

Vehicle photo/video merchandising software is a real market with real incumbents (CarCutter, Impel/SpinCar,
Spyne, PBS Systems, and others), and most of it is built and priced for multi-rooftop dealer *groups* —
contract terms, sales-call-gated pricing, brand-compliance dashboards across locations. That's a different
customer than the single-rooftop independent dealer this project was actually built for.

The closer comparison is the narrow pure-play tier — standalone AI background-removal/compositing tools —
where pricing is public: as of this research (2026-09), one such vendor lists **$0.20–$0.40 per photo, no
subscription**. lotstretcher does the same core job (photo classification, background removal, hero/video
compositing, post copy) self-hosted, **for the marginal cost of your own compute after setup** — no
per-photo fee, no monthly subscription, no contract, and your dealership's photos never leave your own
server. It's free and open source (MIT), not a crippled trial of a paid product.

That's the tradeoff, stated plainly: you run it yourself (a GPU with 4+ GB VRAM recommended, see below), and
in exchange you own the pipeline outright.

---

## One App, Two Hosts

lotstretcher is **one pipeline, one app, and one set of options**, reachable two ways. Which one you want
depends on how many vehicles you have and where the work should happen, not on paying for a better
version. There is no paid tier, no feature gate and no crippled free build: it is all MIT, in this one
repository.

The browser client in [`web/`](web/) is the *same files* in both places. `lotstretcher.org` serves it
from a CDN; `lotstretcher-serve` mounts the identical directory. There is no second build and no "server
edition" of the UI, so a fix lands in both at once and a control added to one appears in the other
because it *is* the other.

| | **The website** | **Self-hosted** |
|---|---|---|
| **For** | one car, right now, from a phone | a whole lot, on a schedule |
| **Input** | photos, camera, pasted image URLs, window sticker PDF, a listing address or VIN decoded on the device | that, plus **scraping** and full inventory sync |
| **Library** | open a listings folder from disk and browse it | the configured library is served, always there |
| **Where it runs** | entirely in your browser; photos never upload | your machine or your server |
| **Costs** | nothing to you, nothing to host | your own compute |
| **Install** | none | Python 3.11+, a GPU helps |

What differs between them is **capabilities, not code**. The app asks its host `/capabilities` and
unlocks what that host can actually do, so gated features live in the same source as everything else and
are simply switched off when a browser is on its own. It asks *"can I scrape?"*, never *"am I the paid
version?"*.

```bash
lotstretcher-serve                 # API + the browser client at http://127.0.0.1:8000/
lotstretcher-serve --no-app        # API only
```

Running it this way unlocks what a browser cannot do alone. The app hands a composition to the
server when, and only when, you switch on a control that needs one:

| endpoint | what it does |
|---|---|
| `GET /capabilities` | what this host can do, so the app unlocks accordingly |
| `GET /assets` | the background and border library, filling those selects |
| `POST /compose` | composes one cutout with the server's assets and GPU |
| `POST /scrape` | reads one vehicle page with the server's headless browser and returns the record `lotstretcher <url>` would build; the *A listing or VIN* sheet reads the page through it on a host that reports `scrape` |
| `GET /library`, `GET /library/{bucket}/{folder}/{file}` | the listings library (`--library`, default `~/Documents/listings`, the CLI's default `--out`), for the app's Library pane |
| `GET /library/status` | the last run, recent run history, fetched and delisted counts, running jobs |
| `POST /library/{bucket}/{folder}/recompose` | rebuild one vehicle's bundle in place with the app's current options; the same path as the `recompose` CLI (`library_ops.py`), returned as a job to poll at `GET /jobs/{id}` |
| `POST /library/{bucket}/{folder}/rescrape` | fetch the vehicle's page again and run the whole pipeline into the library, as `lotstretcher <url> --force` would; one at a time |
| `POST /library/sync` | one inventory sync cycle into the library, as `inventory-sync` would, when a dealer inventory URL is configured |
| `POST /library/{bucket}/{folder}/delist` | stamp the vehicle `delisted_at`, the same mark `inventory-sync` makes; nothing is deleted |
| `POST /library/{bucket}/{folder}/delete` | remove the folder and its manifest entry for good; the body must repeat the folder name |

A `lotstretcher-config.json` at the library root is read at startup as the dealer config, so the library
carries its own inventory URL, greeting, address and city tags. Classifiers are warmed in the background
at startup so the first re-scrape does not wait on a model load.

The CLI's flags and the app's controls meet in one place: `library_ops.hero_options_from_controls()` builds
the pipeline's options from the app's control values, and `cli.py` converts its own flags to those same
values before calling it. A control-parity test also fails if `cli.py` defines a flag it never reads,
which is how `--no-spotlight`, `--margin-frac`, `--video-duration` and `--video-fps` were found to be
accepted and ignored, and fixed.

**The Library pane** browses what the pipeline has produced: every vehicle folder under `new/` and
`used/`, its hero stills, framed and interior sets, clips, the three posts, and the record it was built
from, with a button to load the originals back in and rerun it with today's options. The layout it reads
is `library` in the shared spec, the same names `vehicle_pipeline` writes. Against your server the
configured library is simply there; on lotstretcher.org, or anywhere, you can open a listings folder
from disk and the same pane reads it in the browser. One reader, two sources, and
[`tests/test_library_parity.py`](tests/test_library_parity.py) feeds both the same synthetic library and
requires the same index back.

`POST /compose` receives the **cutout, never the source photograph**. Matting already happened on
your device, so the original image stays there; only the cut-out vehicle travels, and only when you
ask for something the server can do and a browser cannot. Anything it could not honour, such as a
border missing from its library, comes back on an `X-Lotstretcher-Warning` header rather than being
silently dropped.

**Why the website can't scrape, and what it does instead.** A browser can't read another site's HTML
(cross-origin rules), and dealer sites sit behind Cloudflare challenges that a serverless function can't
pass either: measured, not assumed. But that only blocks *discovering* photo URLs, never *using* them.
Dealer image CDNs serve cross-origin fine, so anything you hand the browser it can process. Scraping
lives on the self-hosted surface because that's the surface that can actually do it.

The website's *A listing or VIN* sheet is one field that takes the vehicle page address or a VIN, and
fetches nothing: a dealer page sits behind a bot challenge that only a real browser passes (a plain
fetch of one gets a 403, which is why the self-hosted server drives a headless browser). What the
address and the VIN say on their own is decoded on the device from tables in the spec
(`vin` in `shared/pipeline-spec.json`): the address's slug gives the year, make and model, the VIN
its check digit, model year and manufacturer. `lotstretcher/vin.py` and
`web/public/js/pipeline/vin.js` are the same decoder in both languages, and
[`tests/test_vin_parity.py`](tests/test_vin_parity.py) holds them to the same answers, including
every address in the local listings library when one is present. Model and trim are encoded per
manufacturer and need NHTSA's database, which is why the slug carries them here and the price,
mileage and photos stay yours to add. **Scan VIN** reads the door-jamb barcode through the camera on
the device (the browser's own barcode detector where it exists, else the vendored ZXing reader in
`web/public/vendor/zxing`, MIT) and takes the same route. Against a self-hosted server the same field
reads the whole page. The sheet also takes a saved copy of the page (Ctrl+S, "Webpage, HTML only") or its pasted
source, for the dealer's own photos and price without a server: `listing.js` is a port of
`normalize_vehicle()`, and [`tests/test_listing_parity.py`](tests/test_listing_parity.py) runs both
on one fixture under node and compares every field.

### One specification, enforced

Two implementations (Python and JavaScript) are unavoidable. Two *specifications* are not.
[`shared/pipeline-spec.json`](shared/pipeline-spec.json) holds every constant both sides need: output
formats and sizes, video timing, the palette bands and colour words, glow colours, the cutout quality
gates. Both read it, through `src/lotstretcher/spec.py` and `web/public/js/spec.js`.

The text side is held to the same rule, and more simply: the posts are built once, in the Rust core
(`core/src/copy.rs`), and `facebook_post.py`, `social_post.py` and `web/public/js/pipeline/copy.js` are
hosts that hand it the vehicle and the dealer boilerplate.
[`tests/test_copy_parity.py`](tests/test_copy_parity.py) holds the core, natively and in the wasm build
under node, to the posts the Python produced before it was deleted. The app's Settings (the gear in the
header) hold the same boilerplate `dealer_config` does: greeting, address, city hashtags, filled once
and kept on the device.

[`tests/test_spec_parity.py`](tests/test_spec_parity.py) enforces it, including the cases the
indirection alone can't cover: it compares the remaining Python literals against the spec, greps the
JavaScript for any module that goes back to hardcoding, and fails outright if a format size reappears as
a literal in `options.js`.

### The Rust core

Sharing the *algorithms* themselves, not just their constants, is done with a Rust crate in
[`core/`](core/) compiled twice: to a native library the CLI and server load through `ctypes`
(`src/lotstretcher/core.py`), and to wasm32 the browser loads (`web/public/js/core.js`, built by
`web/build-core.sh` into `web/public/core/`, which is committed so the static site needs no toolchain).
The spec is embedded in the crate at build time, so a constant changed there changes in the core.

**What is in it now:** the whole still compositing and the whole of both videos. Gradient backdrops
from the vehicle's colours (the palette logic included), the adaptive spotlight, placement and all five
layouts, glow, alpha compositing, and the bordered path: window detection in the frame's alpha, collision
of every placement against the border art, and the frame as the top layer. On both surfaces `compose_hero`
is a call into the core with a JSON request and one byte arena, and the same seed produces the same bytes
natively and in the browser. Every video frame comes from the core too (`render_frame`: backdrop,
spotlight, cars at rectangles with alphas, glow, border), and so does the choreography: the conveyor's
bar-locked schedule, pan geometry, beat pulse and transitions (`carousel_plan` / `carousel_frame`), and
the spin's placement, hold and cross-dissolve schedule (`spin_plan` / `spin_frame`). The CLI's
`hero_video.py` and `spin.py` and the browser's `video.js` supply only cutouts, labels and a clock, so the
browser's conveyor is the CLI's edit.

A host can also keep images *resident* in the core (`retain` / `release`) and name them by id: the video
hosts retain their cutouts, scaled cars, layers and flag frames once, so a frame request carries no
pixels in, only the finished frame out, and a retained car's glow halo is blurred once per clip rather
than once per frame. Measured on a real five-shot vehicle at 1254²: a glowing conveyor frame 108 ms to
21 ms, byte-identical; the whole 26 s clip's frames 84 s to 42 s. In the browser a 720² three-shot conveyor
renders in about 4 s for a 9.6 s clip. Interior photos are the core's too (`enhance_interior`: the
capped white balance from bright near-neutral pixels, then the highlight-holding exposure lift), so the
browser now writes the same `interior/` set the CLI's bundle carries, at the photo's own size. The wheel
money shot's mask arithmetic is the core's as well (`mask_stats`, `cutout_from_mask`, `duplicate_score`:
bounds, 8-connected blobs, the dominance, width and angle gates, the crop, the duplicate check); the
models that make the masks, CLIPSeg and SAM2, stay in the CLI, which is why wheel shots are a server
feature the app's capabilities list says the browser lacks. The Monroney sticker parser is the core's
(`parse_sticker`, `panel_split_x`): the CLI hands it `pdftotext -bbox` words and the browser hands it
pdf.js words, and both get the same record, checked on every real sticker in the operator's library
(114 of them, byte-identical to the Python parser they replaced) and, in the browser, against the same
fixtures. The post copy is the core's as well (`build_posts`: the Marketplace post, the Threads post inside
its cap, the Instagram caption, the hashtags and the audit notes), with `facebook_post.py`, `social_post.py`
and `copy.js` reduced to hosts that hand in the vehicle and the dealer boilerplate. Everything the operator
ruled into the core is in it; models stay in ONNX Runtime on both sides.

[`tests/test_core_parity.py`](tests/test_core_parity.py) holds the core to the Python it replaced, and is
skipped with a message when the core has not been built (`cargo build --release` in `core/`).

### Self-hosted runs in two modes

The CLI (the default — one-shot scripts and cron) and an opt-in **server mode** exposing a
[CarCutter](https://cloud.car-cutter.com/doc/api.html)-API-shaped HTTP surface — see
[Server Mode](#server-mode) below. The point isn't cloning CarCutter; it's that a lot of dealer-software
integrations already speak that shape, so switching the base URL to a self-hosted, fully open alternative
is a realistic option rather than a rewrite. Nothing about your inventory photos leaves your own server
in either mode.

---

## Hardware & System Requirements

### Hardware & GPU Acceleration
- **GPU (Recommended)**: NVIDIA GPU with **4+ GB VRAM** (CUDA support). `inventory-sync`'s batch pipeline (parallel hero-video rendering across CPU workers, GPU-accelerated compositing, overlapped scrape/CV work across vehicles) measures **~35–50 seconds of effective wall-clock time per vehicle** end-to-end on real inventory, not counting network waits on the dealer site.
- **CPU (Fallback)**: CPU-only execution is fully supported via PyTorch and ONNX Runtime CPU fallbacks, but processing time will be several minutes per vehicle due to deep-learning models (CLIP, BiRefNet, SwinIR/Real-ESRGAN, SAM2) and CPU-side video compositing.

> **Dependency & CUDA Note**:
> This package requires `onnxruntime-gpu` (not the CPU-only `onnxruntime` package) for `rembg`'s background-removal model to actually run on the GPU — the CPU package silently falls back to ~10x slower CPU inference with no error. It also installs `torch`, `torchvision`, `open_clip_torch`, `rembg`, and `spandrel`. Ensure your NVIDIA drivers and CUDA runtime are compatible with your installed PyTorch wheel. If running on a system without a GPU, ONNX Runtime and PyTorch will automatically execute on the CPU.

### System Dependencies
- **Python 3.11+**
- **FFmpeg**: Required for generating animated MP4 hero videos (`hero-video`).
  - *Ubuntu/Debian*: `sudo apt update && sudo apt install -y ffmpeg`
  - *macOS*: `brew install ffmpeg`
  - *Arch Linux*: `sudo pacman -S ffmpeg`

---

## Installation

Because `lotstretcher` is distributed as an open-source source repository, clone the repository and install it inside a Python virtual environment:

```bash
# 1. Clone the repository
git clone https://github.com/asuramaya/lotstretcher.git
cd lotstretcher

# 2. Create and activate a virtual environment (Python 3.11+)
python3 -m venv .venv
source .venv/bin/activate

# 3. Upgrade pip and install lotstretcher in editable mode
pip install --upgrade pip
pip install -e .

# Optional: Install development and test dependencies
pip install -e ".[dev]"

# 4. Install Playwright browser binaries (Chromium)
playwright install chromium
```

---

## Quick Start

Process a single vehicle listing:

```bash
lotstretcher "https://www.tomballford.com/vehicle/1HGCY1F24SA035661/Used-2025-Honda-Accord-Tomball-TX/"
```

Output lands in the current working directory under `new/` or `used/`, bucketed by condition. Each vehicle folder contains structured data, source assets, and finished marketing deliverables:

```
<year>-<make>-<model>-<trim>-<stock>/
├── details.json                  # Full scraped Vehicle record
├── images/
│   ├── exterior/                 # Originals + CLIP-classified exterior photos
│   │   ├── cutout/               # Transparent background cutouts
│   │   └── wheels/               # Extracted wheel close-ups
│   └── interior/                 # White-balance-corrected interior photos
├── window-sticker.pdf            # Original Monroney window sticker (if found)
├── window-sticker.json           # Parsed window sticker options & equipment
└── bundle/
    ├── hero.png                  # Composed hero collage (1:1 square for Facebook Marketplace)
    ├── hero-portrait.png         # 9:16 portrait (Stories, Reels, TikTok)
    ├── hero-horizontal.png       # 16:9 horizontal (YouTube, landscape feed)
    ├── hero-video.mp4            # Animated video carousel (1:1 square)
    ├── hero-video-vertical.mp4   # 9:16 vertical video (Instagram Reels / TikTok / Shorts)
    ├── hero-video-horizontal.mp4 # 16:9 widescreen video (YouTube)
    ├── framed/                   # Every exterior cutout framed individually
    ├── window-sticker-a.png      # Readable window sticker slide A
    ├── window-sticker-b.png      # Readable window sticker slide B
    ├── facebook.txt              # Ready-to-paste Facebook Marketplace listing text
    ├── instagram.txt             # Hook-first caption + targeted hashtags
    └── threads.txt               # Character-capped Threads post
```

---

## Configuration

lotstretcher uses a flexible configuration hierarchy:
**CLI Arguments > Environment Variables (`LOTSTRETCHER_*`) > JSON Config File (`--dealer-config` / `LOTSTRETCHER_CONFIG`) > Default Values**

### 1. JSON Configuration File

Create a `dealer-config.json` file for your dealership:

```json
{
  "dealer_name": "Apex Ford of Austin",
  "dealer_greeting": "Ask for Alex in Sales!",
  "dealer_address": "4500 Motorway Blvd, Austin, TX 78701",
  "city_tags": ["Austin", "AustinCars", "ATXAuto", "TexasTrucks"],
  "default_border_tag": "dealer-frame",
  "inventory_url": "https://www.apexfordaustin.com/inventory/all-vehicles/",
  "inventory_urls": {
    "used": "https://www.apexfordaustin.com/inventory/used-vehicles/",
    "new": "https://www.apexfordaustin.com/inventory/new-vehicles/",
    "all": "https://www.apexfordaustin.com/inventory/all-vehicles/"
  }
}
```

`inventory_urls` is what `inventory-sync --scope <name>` reads, so you can run `inventory-sync --scope used` instead of retyping your dealer's full URL every time. Scope names are entirely up to you -- they're just keys in this object, not a fixed set lotstretcher understands. There's deliberately no built-in default for these (unlike `dealer_name`/`dealer_greeting`/etc): an unconfigured `--scope` fails loudly rather than silently pointing at whichever dealership this tool happened to ship with example values for.

Pass it on any command with `--dealer-config` or by setting the `LOTSTRETCHER_CONFIG` environment variable:

```bash
lotstretcher <vdp-url> --dealer-config /path/to/dealer-config.json
```

### 2. Environment Variables

You can also configure lotstretcher directly using environment variables (ideal for Docker or CI/CD pipelines):

| Environment Variable | Description | Default |
|---|---|---|
| `LOTSTRETCHER_CONFIG` | Path to a JSON configuration file | `None` |
| `LOTSTRETCHER_DEALER_NAME` | Dealership name used in copy & captions | `Tomball Ford` |
| `LOTSTRETCHER_DEALER_GREETING` | Greeting line in Facebook / social posts | `Ask for us at the front desk!` |
| `LOTSTRETCHER_DEALER_ADDRESS` | Physical address included in listing copy | `22702 TX-249, Tomball, TX 77375` |
| `LOTSTRETCHER_CITY_TAGS` | Comma-separated hashtags for social copy | `Tomball,TomballCars,Houston,HoustonCars` |
| `LOTSTRETCHER_DEFAULT_BORDER_TAG`| Default border tag from `assets/manifest.json` | `tomball-dealer-frame` |
| `LOTSTRETCHER_INVENTORY_URL` | Full inventory search URL for batch crawling | `None` |
| `LOTSTRETCHER_INVENTORY_URL_<SCOPE>` | Per-scope inventory URL, e.g. `LOTSTRETCHER_INVENTORY_URL_USED` for `--scope used` | `None` |
| `LOTSTRETCHER_LISTINGS_ROOT` | Default output directory for listings | `./listings` or current directory |

See `.env.example` and `lotstretcher-config.json.example` for template files.

---

## Branded Assets & Borders

lotstretcher composites vehicle cutouts onto branded border frames. These assets live in `assets/` and are cataloged in `assets/manifest.json`:

- `assets/borders/`: Frame PNGs with transparent center windows (standard size: **1254×1254**). The frame sits on top of the cutouts so logos and phone numbers stay sharp.
- `assets/backgrounds/`: Background textures and graphics (used when not using the per-vehicle gradient generator).
- `assets/video/` & `assets/audio/`: Looping video backdrops and background tracks for animated hero videos.

### Adding Your Own Dealership Frame
1. Design a **1254×1254 PNG** with a transparent center where the vehicle should appear.
2. Save it to `assets/borders/my-dealer-frame.png`.
3. Register it in `assets/manifest.json`:
   ```json
   {
     "name": "My Dealership Frame",
     "file": "borders/my-dealer-frame.png",
     "tags": ["dealer-frame", "custom"]
   }
   ```
4. Use `--border "My Dealership Frame"` or set `"default_border_tag": "custom"` in your configuration.

### The studio library (what the app ships)

The app's "Stock" tiles on lotstretcher.org come from the same
manifest. An entry carrying `"studio": true` is exported by

```bash
python3 web/build-studio.py
```

into `web/public/studio/` (backgrounds as WebP at most 2048 px, frames
as lossless WebP so the window keeps its alpha) with a manifest the app
reads at start. The site composes those on the visitor's own machine;
there is no server behind lotstretcher.org, and the whole library is a
few hundred KB. Entries without the tag, such as a dealer's private
frames, stay on your machine and appear in the app only against your
own server, which composes them. The exported files are committed, so
run the build and commit its output when you add or retag an asset.

A frame is drawn for one shape, and the still formats have several. The
format always decides the canvas; `--frame-fit` decides how the frame
meets it: `fit` (the default) keeps the whole frame centred with the
backdrop filling the rest, `fill` covers the canvas and crops the frame's
edges, `stretch` pulls the frame to the canvas shape. The app's Frame
group has the same lever, previewed live per format.

### A frame the core draws

Frame art is drawn for one shape. `--frame-style line` draws a rounded
line inset from the edge at whatever size the canvas is, so it fits a
square, a portrait and a horizontal exactly, on the stills and on the clip.
`--frame-color` is white, black or `paint` (the vehicle's own colour,
from the listing's name or sampled off the cutout); `--frame-weight`
is the line's weight as a share of the shorter side. In the app it is
the "Studio line" tile of the Frame picker, with the colour and weight
levers beside it. Frame art, when given, wins.

### The sweep backdrop

`--backdrop sweep` draws a studio cyclorama in the vehicle's own
colours: the wall darkens toward the top, brightens to a lit floor
line, and the floor falls off below it with a pool of light where the
car stands. `--backdrop generic` is the seeded hue bands the app has
had all along, now on the command line too; `--backdrop vehicle` is
the default gradient. A photo (`--photo-background`) wins over any of
them. The clip holds one sweep frame behind the conveyor, as it holds
a photo. In the app it is the Backdrop picker's Sweep tile, drawn by
the core on the preview's subject.

### Looks: one tap, several levers

The Studio is laid out as an editor: the stage in the middle, in the
chosen format's own shape, a rail of tools beside it (Looks, then the
spec's groups, then Output) and one tool's levers open at a time. The
shapes are chosen under the stage, one chip per still or video format:
tap one to see it in its own shape, tick it to make it. Output holds
the run's estimates and the same run as a command line; what this host
can do lives in Settings. Looks is the first tool: a grid of looks, each a named set of light and
frame values defined once in the spec (`controls.looks`): Clean,
Showroom (shadow and reflection), Gallery (a white line and a soft
shadow) and Paint line (the vehicle's colour on the line, a glow and
the floor). Tapping one sets those levers; every lever stays yours to
move after, and the chip releases the moment a value differs. On the
command line `--look NAME` applies the same values to `lotstretcher`,
`recompose` and `hero-video`; any flag you also type wins over the
look, so `--look showroom --shadow-strength 0.9` is the showroom with
a darker shadow.

### A ground shadow

`--shadow` sets the vehicle down: a soft shadow read off the cutout's
own silhouette, squashed flat about its lowest opaque row and blurred,
so the car reads as standing on the backdrop rather than floating over
it. `--shadow-strength` is its darkness, 0 to 1 (default 0.5). It is
under every car on the stills and the clip, fades with a car
mid-dissolve, and sits beneath the glow. In the app it is the Light
group's "Ground shadow" toggle with its darkness slider; `recompose`
and `hero-video` take the same two flags.

`--reflection` adds a floor reflection: the vehicle mirrored below its
own contact line and faded out over the top of it, as a glossy studio
floor gives; `--reflection-strength` is its opacity at the floor line
(default 0.35). It sits under the shadow, so the two together read as
one floor. The app's Light group has the same toggle and slider.

### Text on the still

The core draws text (core/src/text.rs, the studio's Lato Bold, OFL) so
the CLI's hero and the app's preview carry the same words at the same
places. Three pieces stack in a corner and the vehicle is laid out clear
of them; with a frame they sit inside its window, never on its art.

```bash
lotstretcher URL --title vehicle --price-badge --text-line "Ask for Alex" \
    --text-position br --text-color white --text-size 0.05
```

`--title vehicle` writes year make model trim from the listing;
`--title custom` writes `--title-text`. `--price-badge` puts the post's
own resolved price in a pill (MSRP for new, the listed price for used).
`--text-color paint` puts the vehicle's own colour on the badge, from
the listing's colour name or sampled off the cutout. The app's Text
group is the same seven levers, previewed live as you type. `recompose` takes them too. The clip carries the same text on
every frame, with the conveyor laid out in the room beside it, and sits
on the same backdrop as the stills: `--photo-background` puts the photo
behind the clip too, unless `--video-flag-background` asks for the
flag video instead.

---

## CLI Reference & Usage

Installing `lotstretcher` registers 8 CLI commands (a 9th, `lotstretcher-serve`, is opt-in -- see Server Mode below):

### 1. `lotstretcher` — Full Ingestion Pipeline
Scrapes the VDP, runs CV segmentation, composes images/videos, and generates copy.

```bash
# Single vehicle
lotstretcher https://www.yourdealer.com/vehicle/12345/Used-2023-Ford-F-150/

# Batch from a URL list file
lotstretcher --file urls.txt --out ~/Documents/listings

# Crawl an inventory listing page (expands all matching VDPs)
lotstretcher "https://www.yourdealer.com/inventory/all-vehicles/?make=Ford&model=Mustang" --out ~/Documents/listings

# Dry-run: preview what a listing URL would expand to without scraping
lotstretcher "https://www.yourdealer.com/inventory/all-vehicles/" --dry-run

# Run full inventory sync (processes new vehicles and flags delisted ones)
lotstretcher "https://www.yourdealer.com/inventory/all-vehicles/" --out ~/Documents/listings --sync
```

**No VDP at all?** `lotstretcher` also accepts local photo folders in place of a URL -- a trade-in walked
around with a phone, an auction photo dump, a DAM export, anything with no dealership webpage to
scrape. Drop photos in a folder, optionally add a `vehicle.json` with whatever `Vehicle` fields
you know (year/make/model/price/description/... -- see `src/lotstretcher/local_source.py`), and it runs
through the exact same CLIP/cutout/compose/copy pipeline as a scraped vehicle. Mix local folders
and URLs freely in the same command; each is auto-detected by whether the argument is an existing
directory.

This is also exactly what the browser client does — same input, same pipeline, different surface (see
[One App, Two Hosts](#one-app-two-hosts)).

```bash
# my-trade-in/01.jpg, 02.jpg, ... + an optional vehicle.json
lotstretcher ./my-trade-in --out ~/Documents/listings

# vehicle.json is optional -- without one you still get hero/video/cutouts,
# just thinner post copy (no year/make/model to write sentences about)
echo '{"year": "2023", "make": "Ford", "model": "F-150", "trim": "Raptor"}' > ./my-trade-in/vehicle.json
```

### 2. `inventory-sync` — Automated Inventory Synchronizer
A dedicated CLI designed for cron jobs. It crawls live inventory, skips already-processed vehicles via `manifest.json`, processes new arrivals, and marks delisted inventory.

```bash
inventory-sync --inventory-url "https://www.yourdealer.com/inventory/all-vehicles/" --out ~/Documents/listings

# Also run the local-vision front-seat-config check (needs `ollama serve` with
# gemma4:e2b pulled) -- batched at the end of the run so the model loads once,
# not once per vehicle
inventory-sync --inventory-url "..." --out ~/Documents/listings --vision-seat-check

# Once your dealer-config.json has an "inventory_urls" map (see Configuration
# above), skip retyping the URL entirely:
inventory-sync --scope used
inventory-sync --scope new
```

**Safety valves**: a sync refuses to flag anything as delisted if the listing crawl came back incomplete (`--headed` to debug why), or if more than 30% of previously-seen active inventory would suddenly be flagged missing in one cycle (almost always a bad/narrow crawl, not real turnover). Pass `--confirm-mass-delist` to override either one if you're sure it's genuine.

**"Just Arrived, Photos Coming Soon" placeholders**: a vehicle whose gallery is nothing but the dealer's stock "photos coming soon" graphic is recognized as junk (perceptual-hash matched, see `imaging/templates/`) and left with zero photos rather than a fake cutout of the placeholder. It's marked `photos_pending` in the manifest instead of "done," so the next sync automatically retries it — no manual re-run needed once real photos go up.

### 3. `posts` — Regenerate Post Copy
Fast copy re-generation from existing `details.json` files without re-scraping or re-running computer vision models.

```bash
# Rebuild copy for all listings in a directory
posts ~/Documents/listings

# Rebuild copy for a single vehicle folder
posts ~/Documents/listings/used/2023-Ford-F-150-Raptor-PFA30435/
```

### 4. `recompose` — Recompose Images with New Borders / Layouts
Re-renders `bundle/hero.png` and `bundle/framed/*.png` using already-extracted cutouts. Ideal when you update your dealership logo or frame.

```bash
recompose ~/Documents/listings --border "Generic Dealer Frame"
```

`--resweep` self-heals photos that were misfiled into `images/interior/` under an older classifier or
threshold: it re-runs *current* classification against every interior photo already on disk and promotes
any that the pipeline would now call exterior — without re-scraping. It's conservative by design (a
promotion only happens if the photo also produces a valid cutout AND survives the same gallery-consistency
check `--prune-foreign` runs in reverse), so most candidates get correctly left alone; use `--dry-run`
first to see what it would do.

```bash
recompose ~/Documents/listings --resweep --interiors --dry-run   # preview
recompose ~/Documents/listings --resweep --interiors             # apply
# then, for any vehicle it reports as changed:
hero-video ~/Documents/listings/used/2023-Ford-.../ --format all
```

### 5. `compose` — Custom Single-Vehicle Hero Composer
Compose custom hero layouts for a single vehicle with specific layouts (`quad`, `corners`, `trio`, `split`), backgrounds, and lighting effects.

```bash
# List available backgrounds, borders, and layouts
compose --list-assets

# Compose with a specific layout and background
compose ~/Documents/listings/used/2023-Ford-F-150-Raptor-PFA30435/ --layout quad --background american-flag
```

### 6. `hero-video` — Animated Video Carousel Generator
Generates animated MP4 video carousels with multi-angle cutouts timed to background music and video loops.

```bash
hero-video ~/Documents/listings/used/2023-Ford-F-150-Raptor-PFA30435/
```

### 7. `export-feed` — Inventory Syndication Feed
Builds a CSV/TSV inventory feed from vehicles already scraped, in the shape third-party listing platforms
(Meta/Facebook Automotive Inventory Ads, and by convergent convention most others) expect to ingest — VIN,
price, mileage, colors, the dealer's own real photo URLs, one row per vehicle. There's no open, universal
inventory feed standard (every DMS integration is a bespoke, gatekept vendor relationship), but *exporting*
a feed needs nobody's permission — this just re-shapes data lotstretcher already has.

```bash
export-feed ~/Documents/listings --out feed.csv
export-feed ~/Documents/listings/used --out used-feed.csv --condition used --tsv
```

Read `src/lotstretcher/export_feed.py`'s module docstring before relying on this in production: the exact field
names were cross-confirmed from several independent secondary sources rather than pulled directly from
Meta's own (JS-rendered, partially login-gated) spec page — validate the output against your destination
platform's own feed validator, and adjust `FEED_COLUMNS`/`vehicle_to_row()` if reality differs; it's
deliberately kept as one flat mapping table, not scattered logic.

### 8. `spin-video` — Rotating "Spin" Video from Real Angles
Turns a vehicle's own real angle-labeled cutouts (front → front_3q → side → rear_3q → rear) into a rotating
video via cross-dissolve interpolation between them — the used-inventory-appropriate alternative to a
licensed generic 3D CAD model (right for new inventory, wrong for used: it shows the SKU, not the actual
physical car). This is **not** true 3D reconstruction — that's confirmed research-stage industry-wide, not
something any vendor ships at scale today. It's the same class of trick behind commercial "360 spin"
products: synthesize a smooth rotation from a handful of real photos instead of requiring a turntable shoot.
lotstretcher typically has 5 real angles per vehicle already — more anchor frames than the reference product's own
4-photo baseline. See `src/lotstretcher/imaging/compose/spin.py`'s module docstring for the full scope/honesty
notes (one side's half-turn, not a full 360; classical cross-dissolve, not a trained view-synthesis model).

```bash
spin-video ~/Documents/listings/used/2023-Ford-F-150-Raptor-PFA30435/
```

---

## Server Mode

`lotstretcher-serve` is a 9th command, opt-in and separate from the 8 above — a long-running HTTP service instead
of a one-shot script, exposing lotstretcher's own classify/cutout/composite pipeline behind a
[CarCutter](https://cloud.car-cutter.com/doc/api.html)-API-shaped surface: same request/response shapes
where it matters for drop-in compatibility, self-hosted, and every line of processing code is readable
(unlike the closed SaaS API it mirrors). It's a different front door onto the same imaging pipeline the CLI
uses, not a parallel implementation.

```bash
# Install the server extra (kept separate so `pip install -e .` for CLI-only use never pulls in a web framework)
pip install -e ".[server]"

lotstretcher-serve --data-dir ~/.lotstretcher-server --port 8000
```

Core endpoints implemented (see `src/lotstretcher/server/app.py`'s module docstring for the full scope, including
what's accepted-for-compatibility but not yet behavioral, e.g. `cut_type="blur"`):

- `POST /vehicle/composition/single-segment` — sync, one image in, one composited result out.
- `POST /vehicle/image/submission` — async, up to 60 images, optional `webhook_url` callback.
- `GET /vehicle/image/status` / `GET /vehicle/image/result` — poll a submission.
- `POST /vehicle/submission`, `POST /vehicle/list`, `GET /vehicle/status`, `DELETE /vehicle/delete`,
  `GET /vehicle/shotlist` — a light vehicle registry (SQLite-backed), bookkeeping only.

```bash
curl -X POST http://127.0.0.1:8000/vehicle/composition/single-segment \
  -H "Content-Type: application/json" \
  -d '{"image_url": "https://example.com/car.jpg", "cut_type": "complete"}'
```

---

## Daily Automation (Cron)

The included `daily_sync.sh` wraps `inventory-sync` for unattended cron use: starts Ollama if configured
(for `--vision-seat-check`), writes a timestamped log per run, and prunes logs older than 30 days.
Configure it entirely via environment variables (defaults shown, all optional):

```bash
export LOTSTRETCHER_REPO_DIR="/path/to/lotstretcher"                      # default: this deployment's checkout
export LOTSTRETCHER_SCOPE="used"                                  # a name from dealer-config.json's inventory_urls
# ...or set LOTSTRETCHER_INVENTORY_URL directly to skip scope resolution entirely
export LOTSTRETCHER_LISTINGS_ROOT="/path/to/listings"
export LOTSTRETCHER_CONFIG="/path/to/dealer-config.json"           # dealer_name/greeting/inventory_urls/etc
export LOTSTRETCHER_LOG_DIR="/path/to/sync-logs"                   # default: ~/.local/sync-logs
```

Add a cron job (`crontab -e`) to run daily at 6:00 AM:

```cron
0 6 * * * /path/to/lotstretcher/daily_sync.sh >> /var/log/lotstretcher-sync.log 2>&1
```

(`daily_sync.sh` writes its own per-run log under `LOTSTRETCHER_LOG_DIR` regardless -- the redirect above just
catches anything printed before that log file exists, e.g. a missing `.venv`.)

---

## Adding Support for Other Dealership CMS Platforms

`lotstretcher` comes out-of-the-box with support for **DealerInspire** CMS platforms. Adding support for another CMS (e.g. Dealer.com, DealerOn, CDK Global) is simple thanks to the pluggable extractor registry in `scrape.py`.

### How CMS Extraction Works
Most automotive CMS platforms embed vehicle data directly into a JavaScript variable on the page for Google Tag Manager / analytics. `lotstretcher` searches the rendered HTML for this marker and extracts the balanced JSON object.

### Example: Adding a Custom CMS Extractor

```python
# in scrape.py or an extension script:
from lotstretcher.scrape import register_extractor, normalize_vehicle, Vehicle

# 1. Define the JavaScript marker and validation function
CUSTOM_CMS_MARKER = "window.digitalData = "

def custom_cms_validator(data: dict) -> bool:
    # Verify that the parsed JSON contains expected vehicle keys
    return bool(data and "vehicle" in data and "vin" in data["vehicle"])

# 2. Register the extractor
register_extractor("custom_cms", CUSTOM_CMS_MARKER, custom_cms_validator)

# 3. Update normalize_vehicle() to map your CMS fields to the Vehicle dataclass
# (e.g. mapping data['vehicle']['vin'] -> Vehicle.vin)
```

---

## Troubleshooting

### 1. Cloudflare Challenge Timeouts / "Just a moment..."
- **Symptom**: `RuntimeError: Cloudflare challenge did not clear in time`.
- **Cause**: The dealership website is presenting an interactive Cloudflare turnstile or rate-limiting requests.
- **Solution**:
  - `lotstretcher` automatically retries with exponential backoff and passes realistic browser headers.
  - Avoid running dozens of parallel threads against the same domain simultaneously.
  - Test the URL in standard non-headless Chromium to verify your IP is not banned.

### 2. Missing Playwright Browser Binaries
- **Symptom**: `playwright._impl._errors.Error: Executable doesn't exist at ...`
- **Solution**: Run `playwright install chromium` inside your virtual environment. If running on headless Linux, also install OS dependencies with `playwright install-deps chromium`.

### 3. PyTorch / CUDA Out Of Memory (OOM)
- **Symptom**: `torch.cuda.OutOfMemoryError: CUDA out of memory`, or (specifically for hero videos) `h264_nvenc`'s `CreateInputBuffer failed: out of memory`.
- **Cause**: `lotstretcher` clears GPU cache between vehicles for the classification/cutout models, but `inventory-sync`'s batch pipeline deliberately overlaps a vehicle's hero-video rendering (parallel worker processes, each doing GPU-accelerated compositing plus an `h264_nvenc` encode) with the *next* vehicle's CLIP/rembg work on the main process — real concurrent GPU pressure, not a leak. On a smaller card (the reference numbers above assume 8+ GB) several concurrent encode sessions plus the classification models in memory at once can genuinely exceed what's free.
- **Solution**:
  - Hero-video rendering already self-heals for this specific case: if `h264_nvenc` fails to open, `render_hero_video()` automatically retries the same video with the software `libx264` encoder rather than losing it — you'll see `[fell back to libx264, GPU was too busy for h264_nvenc]` in the sync log. No video is lost, it's just slower under load.
  - If OOM shows up elsewhere (classification/cutout, not video encoding), or the fallback itself is triggering constantly and slowing your syncs more than you'd like, lower `VIDEO_WORKERS`/`MAX_INFLIGHT_VEHICLES` in `inventory_sync.py`, or drop `--nvenc`/`video_encoder="h264_nvenc"` entirely to encode on CPU only.
  - If you have limited VRAM (< 4 GB), set `export CUDA_VISIBLE_DEVICES=""` to force CPU execution mode.

### 4. Missing FFmpeg Error
- **Symptom**: `FileNotFoundError: [Errno 2] No such file or directory: 'ffmpeg'` when running `hero-video`.
- **Solution**: Install FFmpeg via your system package manager (`sudo apt install ffmpeg` or `brew install ffmpeg`).

### 5. Carfax Link Missing on Used Vehicles
- **Symptom**: `Vehicle.carfax_url` is `None` even though a badge is present on the website.
- **Explanation**: DealerInspire sites populate the Carfax link via an asynchronous client-side API call into the `.carfax-logo` element. `fetch_rendered_html()` waits up to 12 seconds for this element when "used" is in the URL. If the network is exceptionally slow, the link may not have loaded before timeout.

---

## Testing

`lotstretcher` includes a complete test suite:

```bash
# 1. Run unit tests
pytest tests/

# 2. Run scrape regression tests (against offline HTML fixtures)
python scrape_regression.py

# 3. Run computer vision & imaging calibration regression
python regression.py
```

---

## Project Structure

```
src/lotstretcher/            — Core package
  ├── cli.py         — Main CLI entry point ('lotstretcher')
  ├── inventory_sync.py — Cron-friendly inventory crawler and delist detector
  ├── compose_cli.py — Custom hero image layout composer
  ├── hero_video_cli.py — Animated video carousel generator
  ├── posts_cli.py   — Fast social copy regenerator (Marketplace, IG, Threads)
  ├── recompose_cli.py — Recompose bundles with updated borders/assets
  ├── export_feed_cli.py — Inventory syndication feed generator (CSV/TSV)
  ├── spin_video_cli.py — Rotating spin video from real angle cutouts
  ├── server/        — Opt-in CarCutter-API-shaped HTTP server (`lotstretcher-serve`)
  │   ├── app.py     — FastAPI endpoints (vehicle registry + image processing)
  │   ├── store.py   — SQLite-backed vehicle/submission registry
  │   └── processing.py — Shared fetch->classify->cutout->composite pipeline
  ├── scrape.py      — Playwright scraper & pluggable CMS extraction registry
  ├── local_source.py — Non-scrape entry point: local photo folder -> Vehicle
  ├── listing.py     — Inventory search page crawler (VDP link discovery)
  ├── photos.py      — Photo gallery downloader and batch pipeline
  ├── window_sticker.py — Monroney window sticker PDF downloader and parser
  ├── facebook_post.py — Facebook Marketplace post builder
  ├── social_post.py — Instagram and Threads post builders
  ├── vehicle_pipeline.py — Unified orchestrator for end-to-end vehicle processing
  ├── manifest.py    — Incremental fetch tracking & delist detection
  ├── dealer_config.py — Centralized multi-dealer configuration manager
  └── imaging/       — Computer vision & media pipeline:
      ├── classify.py    — CLIP zero-shot vehicle angle classification
      ├── cutout.py      — rembg (BiRefNet) background removal with alpha gating
      ├── pipeline.py    — Per-photo analysis (exterior/interior/detail scoring)
      ├── gallery.py     — Consensus filtering (removes foreign/mismatched cars)
      ├── letterbox.py   — Automated dealer watermark/banner cropping
      ├── interior.py    — Interior white-balance correction & feature extraction
      ├── wheel.py       — SAM2 / CLIPSeg wheel extraction and enhancement
      ├── select.py      — Hero and accent photo selection algorithms
      ├── dedupe.py      — Perceptual-hash image deduplication
      ├── sticker.py     — Window sticker PDF text and option parser
      ├── upscale.py     — Real-ESRGAN / SwinIR super-resolution upscaler
      ├── seat_vision.py — Seating configuration classifier (YOLO + CLIP)
      ├── palette.py     — Dominant vehicle paint color extractor
      └── compose/       — Composition engines for hero collages and video
assets/              — Branded borders, background images, video/audio loops
scrape_fixtures/     — Checked-in HTML fixtures for regression tests
tests/               — Pytest unit test suite
daily_sync.sh        — Reference daily automation script
scrape_regression.py — Scraper regression test runner
regression.py        — Computer vision & calibration regression test runner
setup.py             — Package configuration & entry points
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on code style, testing, and submitting pull requests.

---

## License

MIT License. See [LICENSE](LICENSE) for details.
