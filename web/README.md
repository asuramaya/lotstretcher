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
│   │   ├── lib/         imageio, zip, delegate (what a self-hosted server can add)
│   │   ├── library/     the listings library: an HTTP or a folder source, one view
│   │   └── pipeline/    runtime, classify, matte, compose, video, copy, listing, sticker
│   ├── core/            the Rust core compiled to wasm32 — IN git, see below
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
| `scene.onnx` | 4-class scene student (fp32) | 6.1 MB |
| `matte.onnx` | u2net int8, fixed 256×256 | 44.2 MB |
| `labels.json` | class index order — **in git** | <1 KB |

`labels.json` is in git and the others are not, which is deliberate: the
class order is baked into each trained head, is not recoverable from the
model file, and produces confident nonsense rather than an error if it is
wrong.

The classifiers are produced by `web/tools/export-models.py` from the
distillation checkpoints. The matting model is `u2net` exported at a
fixed 256×256 and dynamically quantised.

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
hosts over it. The built `public/core/` is committed (737 KB, 272 KB
gzipped) so a clone deploys with no Rust toolchain. To rebuild after a
change in `core/`:

```bash
bash web/build-core.sh     # needs rustup's wasm32-unknown-unknown target,
                           # wasm-bindgen-cli matching core/Cargo.lock,
                           # and wasm-opt (cargo install wasm-opt)
```

The About pane reports `core: wasm vN`; the parity tests in `tests/`
hold the wasm build to the native one.

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

## Deploying

```bash
npx wrangler deploy
```

Static assets on Cloudflare Workers. In production the 44.2 MB matting
model moves to R2 (set `MODEL_ORIGIN` in `js/config.js`): Cloudflare caps
static assets at **25 MiB per file on free and paid plans alike**, so this
is not a billing question. R2 has zero egress cost, which keeps hosting at
$0.

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
| video, 720² three-shot conveyor, 9.6 s clip | 5.0 s, 6.8 s with glow |

## What the browser does not do

The core processing is the CLI's, one to one. What the browser lacks is
what needs a server: scraping a dealer page (the bookmarklet hands the
listing over instead), a server's private frames and backdrops (the
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
