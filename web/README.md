# lotstretcher browser client

The free surface: a static, entirely client-side app. Photos never leave
the device, there is no account, and there is no server-side storage —
because there is no server. See [`docs/web-app-design.md`](../docs/web-app-design.md)
for the design and the measurements behind it.

```
web/
├── public/              everything that gets deployed
│   ├── index.html       landing page
│   ├── app.html         the app
│   ├── selftest.html    pipeline harness (not linked from the app)
│   ├── _headers         COOP/COEP — see "Cross-origin isolation" below
│   ├── css/             tokens → base → app
│   ├── js/
│   │   ├── config.js    model manifest, limits, canvas sizes
│   │   ├── app.js       state + orchestration (no framework)
│   │   ├── core.js      loads the Rust core (wasm) and packs images for it
│   │   ├── lib/         widgets (every lever the Studio draws, one module), imageio, zip, delegate (what a self-hosted server can add)
│   │   ├── library/     the listings library: an HTTP or a folder source, one view
│   │   └── pipeline/    runtime, classify, matte, compose, video, copy, listing, sticker,
│   │                    core-worker + video-worker (the core in a worker, for a run)
│   ├── core/            the Rust core compiled to wasm32 — IN git, see below
│   ├── core-threads/    the same, threaded; loaded only inside the worker
│   ├── models/          NOT in git — see below
│   └── ort/             NOT in git — see below
├── build-core.sh        core/ → public/core/ (cargo + wasm-bindgen + wasm-opt)
├── dev-server.py        static server that sets the isolation headers
└── build-icons.py       rasterises icons/icon.svg to PNG
```

## Running it

```bash
python3 web/dev-server.py 8799     # http://127.0.0.1:8799
```

Use this rather than `python -m http.server`. It sets the cross-origin
isolation headers, without which the app silently runs single-threaded.

## Populating models/ and ort/

Both are large binaries kept out of git.

**`public/ort/`** — the onnxruntime-web WASM runtime:

```bash
npm pack onnxruntime-web@1.22.0
tar xzf onnxruntime-web-1.22.0.tgz
cp package/dist/ort.wasm.min.mjs \
   package/dist/ort-wasm-simd-threaded.mjs \
   package/dist/ort-wasm-simd-threaded.wasm \
   web/public/ort/
```

Take only those three. The `.jsep.*` files are the WebGPU build — 21.8 MB
we do not want, since this design is CPU-only by decision (Safari's
WebGPU is not dependable, and not every laptop has a usable GPU).

**`public/models/`** — three ONNX files:

| file | what | size |
|---|---|---|
| `angle.onnx` | 5-class angle student (fp32) | 6.1 MB |
| `scene.onnx` | 3-class scene classifier (fp32), trained on the library's own filing | 6.1 MB |
| `matte.onnx` | u2net int8, fixed 256×256 | 44.2 MB |
| `labels.json` | class index order — **in git** | <1 KB |

`labels.json` is in git and the others are not, which is deliberate: the
class order is baked into each trained head, is not recoverable from the
model file, and produces confident nonsense rather than an error if it is
wrong.

The angle classifier is produced by `web/tools/export-models.py` from
its distillation checkpoint. The scene classifier is trained by
`web/tools/train-scene.py` on the listings library's own filing (a body
shot has a cutout beside it, a close-up does not, interiors sit in their
own folder): the first scene student was distilled from raw CLIP labels
and inherited CLIP's cabin-versus-close-up confusion (measured at 72% on
the library's exteriors), while the command line's full cascade files
every photo it keeps, so the library is the better teacher. It has no
"marketing" class, since the CLI drops those photos and none are on
disk; a banner lands in detail and the cutout gates keep it out of the
stills either way. Held out by vehicle, not by photo. Re-run it as the
library grows:

```bash
.venv/bin/python web/tools/train-scene.py --epochs 8
```

The matting model is `u2net` exported at a fixed 256×256 and dynamically
quantised.

### Why the classifiers are fp32

Their int8 exports are **broken** and must not be used. `quantize_dynamic`
rewrites MobileNetV3's 52 Conv nodes to `ConvInteger` with per-tensor
dynamic activation scales, and the depthwise convolutions plus HardSwish
collapse under a single shared scale. Measured against the CLIP teacher
labels:

| | fp32 | int8 |
|---|---|---|
| angle (5 classes) | 100% | 9.75% |
| scene (4 classes) | 99.25% | 11.50% |

Both int8 figures are *below chance*, because the logits settle into a
near-constant vector and `argmax` stops depending on the input. Per-channel
weight scales change nothing — identical to two decimal places — because
the damage is on the activation side.

u2net quantises cleanly; it is a plain conv encoder/decoder with no
depthwise or HardSwish blocks.

## The Rust core

Everything that is not a model or IO runs in one Rust crate, `core/`,
compiled to native for the CLI and to wasm32 for this client: backdrops,
spotlight, layouts, glow, compositing, both videos' choreography and
frames, the text layer, the interior treatment, the sticker parser and the post copy.
`js/core.js` loads it and hands it JSON requests plus one byte arena;
`pipeline/compose.js`, `video.js`, `sticker.js` and `copy.js` are thin
hosts over it. The built `public/core/` is committed (925 KB, 336 KB
gzipped) so a clone deploys with no Rust toolchain. To rebuild after a
change in `core/`:

```bash
bash web/build-core.sh     # needs rustup's wasm32-unknown-unknown target,
                           # wasm-bindgen-cli matching core/Cargo.lock,
                           # and wasm-opt (cargo install wasm-opt)
```

The app's Settings (the gear in the header) report `core: wasm vN`; the parity tests in `tests/`
hold the wasm build to the native one.

### Threads

Two builds of the core ship. The page loads the plain, single-threaded
one: rayon's join blocks the calling thread, which a page's main thread
may not do. The video renderer runs in a worker of its own
(`js/pipeline/video-worker.js`) and loads the threaded build there
(`public/core-threads/`, rayon over web workers, wasm-bindgen-rayon in
its no-bundler mode, built by `build-core.sh` on nightly with
rust-src). The page hands the worker the spec, the loaded studio fonts' bytes,
the cutouts and the backdrop as pixels, and gets the MP4 back; the page
stays free to draw while it renders. Anything that stops the worker
(no cross-origin isolation, no WebCodecs there, a failed load) falls
back to rendering on the page with the same code.

`public/bench/` times both builds inside one worker on a real cutout
(Chromium, 20 hardware threads, pool of 8):

| | plain | threaded x8 |
|---|---|---|
| compose 1254², no glow | 74 ms | 20 ms |
| compose 1254², glow | 122 ms | 37 ms |
| video frame 720² | 33 ms | 9.5 ms |

A run keeps one worker for the lot: its stills and its clip both go
through it (`js/pipeline/core-worker.js` is the page's handle). The
live preview stays on the page's plain build, since it wants a frame
back in the same tick. On a whole clip the gain is smaller than the
per-frame table suggests (6.8 s to 4.1 s for the conveyor above): the
H.264 encode is the other half of a clip's time and it does not
parallelise here.

## Cross-origin isolation

`onnxruntime-web`'s threaded build needs `SharedArrayBuffer`, which needs
`crossOriginIsolated`, which needs both:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without them ORT does not error — it quietly drops to one thread, and a
vehicle takes ~27 s instead of ~12 s. The app detects this and says so
rather than letting it look like the models are just slow.

`public/_headers` covers production; `dev-server.py` mirrors it. Change
one, change the other.

## What a first run makes

With nothing changed in the Studio a run makes what the landing shows:
every exterior in all three shapes (`heroStillFormats.browserDefault`),
titled with the vehicle and badged with its price when it has one, a
ground shadow under it, and a portrait clip wherever the browser can
encode one in hardware (`videoFormats.browserDefault`, WebCodecs).
Results are grouped by shape.

The first visit downloads the three models (56 MB) as soon as the app
opens, with a bar in the top strip, and keeps them in the Cache API;
later visits load them from the device in well under a second. Photos
are decoded at most 2048 px on the long side
(`cutout.maxSourceSideBrowser`). The prepare pass logs where its time
went ("[lotstretcher] prepare timings") and keeps it on `state.timings`.

Tried and measured, not shipped (2026-09-25): ORT's WebGPU build cannot
run the u2net matte (MaxPool ceil mode) and gains about a millisecond on
the classifiers for a 22 MB runtime (`bench/gpu`); ORT's proxy worker
made a prepare slower; on 150 library photos against BiRefNet, u2netp
(4.6 MB) had four failures where u2net has none, and ISNet at 1024 has
half the edge error but runs four times slower.

## Deploying

```bash
cd web && wrangler deploy      # https://lotstretcher.org (and www, and the workers.dev name)
```

Static assets on Cloudflare Workers, no Worker script (`wrangler.jsonc`),
on the custom domains in its `routes`. The three ONNX models are served
from the `lotstretcher-models` R2 bucket through its custom domain,
`https://models.lotstretcher.org/models/v1/NAME.onnx` (`MODEL_ORIGIN` and
`MODEL_VERSION` in `js/config.js`), which Cloudflare caches; the bucket's
CORS rule allows GET from any origin so the cross-origin-isolated page can
fetch them. Cloudflare caps static assets at **25 MiB per file on free
and paid plans alike**, and the matting model is 44.2 MB. R2 has zero
egress cost, which keeps hosting at $0. `public/.assetsignore` keeps that
model and the tooling out of the upload. The app keeps the models in the
Cache API after the first download (cache `lotstretcher-models-v1`).

A model is never overwritten: a changed one goes up under the next
version, with a year-long immutable cache header, and `MODEL_VERSION`
moves with it (the app drops the old version's cache):

```bash
wrangler r2 object put lotstretcher-models/models/v2/NAME.onnx --file public/models/NAME.onnx \
  --content-type application/octet-stream --cache-control "public, max-age=31536000, immutable" --remote
```

The CSP in `public/_headers` allows `blob:` media (the clip plays from
memory) and `self` fonts (the studio fonts double as page fonts).

## Testing the pipeline

`selftest.html` runs the real modules against real photos and reports
per-stage timings and visual output:

```
http://127.0.0.1:8799/selftest.html?photos=a.jpg,b.jpg&ext=Agate%20Black&int=Ebony
```

It also accepts dropped files. `window.SELFTEST` holds the result as JSON
once `status` is `ok`, so it can be driven from automation.

Measured on desktop Chromium, 4 threads (i9-12900H):

| stage | median |
|---|---|
| scene classify | 38 ms |
| angle classify | 26 ms |
| matte | 960 ms |
| compose, 1254² (Rust core) | 135 ms, 227 ms with glow |
| interior treatment, 900 px wide | 52 ms |
| video, 720² three-shot conveyor, 9.6 s clip, on the page | 5.0 s, 6.8 s with glow |
| the same clip in the run's worker, threaded core, 8 threads | 4.1 s with glow |

## What the browser does not do

The core processing is the CLI's, one to one. What the browser lacks is
what needs a server: scraping a dealer page (the address's VIN is
decoded on the device instead, and a saved page can be loaded), a
server's private frames and backdrops (the
studio library under `studio/` ships with the site and composes here;
anything else in a self-hosted `assets/` reaches the browser through
`POST /compose`), GPU upscaling,
wheel money shots (CLIPSeg and SAM2 have no browser build), and library
management beyond reading a folder. The app's capabilities list names
each one and why. The self-hosted server is never less than this page.

## The untested risk

Every number here was measured in desktop Chromium. **No iPhone, iPad or
Safari of any kind has been tested at any point.** Safari runs
JavaScriptCore, not V8, and the WebKit per-page memory ceiling against
the measured ~466 MB floor is the open question. It should fit. That is
an inference, not an observation. [`docs/ios-checklist.md`](../docs/ios-checklist.md)
is the ten-minute test to run on a real device.
