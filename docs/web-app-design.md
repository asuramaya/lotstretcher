# lotstretcher.org — Browser Client Design

**Status:** design, not built. **Domain:** `lotstretcher.org` (registered, Cloudflare).

This document specifies the free, static, entirely client-side surface of lotstretcher.
It is the companion to the self-hosted CLI/server surface described in `README.md`
("One App, Two Hosts") and `CONTRIBUTING.md` ("One App, Two Hosts" / "One Specification").

Every performance number below was **measured**, not estimated. Provenance and the one
large untested gap are recorded in "Measurement provenance" at the end.

---

## 1. Product constraints

These came from the operator and are binding. They are the reason the design looks the
way it does, so any future change that violates one needs an explicit ruling.

| Constraint | Consequence |
|---|---|
| **No login** | No accounts, no sessions, no user table, no password reset, no support burden. |
| **No data saved** (server-side) | Photos never leave the device. There is nothing to breach and nothing to subpoena. |
| **Hosting stays essentially free** | Static assets + R2 (zero egress). No compute per request, no per-seat cost, no storage bill. |
| **No backend to leak** | Any third-party API key is the *user's*, held in the *user's* browser, sent *directly* to the provider. It never transits lotstretcher.org. |

The pipeline is the same imaging code as the CLI, compiled/ported to run in the tab.
The website is not a lesser product; it is the same product with a different input method.

---

## 2. What the browser surface can and cannot do

### Can (measured, CORS-verified)

- Process uploaded photos — a folder, a multi-select, or a phone camera capture.
- Fetch photos from **pasted image URLs**. Dealer photo CDNs send `Access-Control-Allow-Origin: *`.
- Fetch and parse **window-sticker PDFs**. `windowsticker.forddirect.com` also sends `ACAO: *`,
  so the full sticker flow works client-side via pdf.js (replacing the CLI's poppler shell-out
  in `imaging/sticker.py` / `window_sticker.py`).
- Classify (angle + scene), matte, compose, and render video — all on-device.
- Produce the same bundle contents the CLI produces (see §6).

### Cannot

- **Scrape a VDP.** A browser cannot read cross-origin HTML, and a Worker doing it server-side
  gets `HTTP 403` plus a Cloudflare challenge it cannot pass. This was tested directly.
- **Sync inventory.** Same reason, plus it is inherently a long-running batch job.

Scraping and sync stay on the self-hosted surface. Note precisely what is lost: only the
*automatic discovery* of photo URLs and vehicle metadata. Once you have the photos, the
browser runs the identical pipeline. §5 covers how to close most of that gap without scraping.

---

## 3. Measured performance envelope

Models chosen by benchmark, not by reputation:

| Stage | Model | Size | Speed | Quality |
|---|---|---|---|---|
| Matting | u2net int8 @ **fixed** 256×256 | 44.2 MB | 960 ms/photo @4 threads | 0/150 catastrophic failures on production photos; composites indistinguishable from BiRefNet |
| Angle classify | distilled MobileNetV3-small **fp32** | 6.1 MB | 26 ms/photo | 100% vs CLIP teacher |
| Scene classify | distilled MobileNetV3-small **fp32** | 6.1 MB | 38 ms/photo | 99.25% vs CLIP teacher |
| Compose | gradient + spotlight + placement | — | 55 ms/photo | — |
| Video | WebCodecs `VideoEncoder` | — | 3–4× realtime | software encode only 16% slower than hardware |

Timings are medians measured **in the app**, desktop Chromium @4 threads, i9-12900H.

The classifiers replace the CLIP visual tower at **1/29th the size**. Both were distilled from
labels already on disk from production runs — the training data was free.

### The classifiers ship fp32, because int8 is broken

This corrects an earlier claim in this document. The previously quoted figures
(int8, ~1.7 MB, 9–14 ms, 98.73%/95.94%) were measured on the PyTorch **checkpoints**, never on
the int8 ONNX artifacts that would actually ship. Measured against the CLIP teacher labels,
n=400 each:

| | fp32 | int8 |
|---|---|---|
| angle (5 classes) | 100% | **9.75%** |
| scene (4 classes) | 99.25% | **11.50%** |

Both int8 numbers are *below chance*. `quantize_dynamic` rewrites MobileNetV3's 52 Conv nodes to
`ConvInteger` with per-tensor dynamic activation scales; the depthwise convolutions and HardSwish
activations collapse under one shared scale, the logits settle into a near-constant vector, and
`argmax` stops depending on the input at all. Per-channel weight scales changed nothing —
identical to two decimal places — because the damage is on the activation side, which
`per_channel` does not touch.

**The tell:** three different quantization schemes scoring identically to two decimals is not
three coincidences. It is evidence that the variable under test is not the variable that matters.

Cost of the fix: the model payload goes from ~48 MB to ~56 MB. Both classifiers stay well under
the 25 MiB per-file asset cap, so the hosting shape is unchanged, and everything is
browser-cached after first load. u2net quantises cleanly — it is a plain conv encoder/decoder
with no depthwise or HardSwish blocks.

A second correction from the same build: **u2net's output is min-max normalised, not passed
through a sigmoid.** BiRefNet is the model that needs the sigmoid. Applying one to u2net yields a
uniform ~0.5 field — a matte where every pixel is "maybe" — which surfaces as `ambiguous=1.0`
and `coverage=1.0` rather than as an error.

**Per vehicle, end to end:**

- ~12 s — desktop, 4 threads
- ~27 s — single thread
- ~2–3 min — phone-class (CPU-throttled emulation, **not** a real phone — see §9)

**Memory floor: ~466 MB**, decomposed:

| Component | MB |
|---|---|
| Chromium baseline | 84 |
| ORT session creation | +106 |
| Weights | +125 |
| Inference arenas | +141 |

ORT owns ~53% of the footprint. That is the strongest argument for a Rust core — **for memory,
not for quality or speed.** Quality is already where it needs to be.

*Since written:* the Rust core exists (`core/`, September 2026) and holds everything that is not a
model or IO on both surfaces; see the root README's "The Rust core". ORT still owns the models, so
the memory floor above stands until the matting model itself moves.

### Required runtime settings

- `ort.env.wasm.numThreads = 4` (throughput saturates at 4; more does not help)
- `ort.env.wasm.simd = true`
- **COOP/COEP cross-origin isolation** is mandatory for threads. Without it, everything
  silently drops to the ~27 s single-thread path.
- Video codec must be probed. `avc1.42001f` (level 3.1) caps at 3600 macroblocks;
  a 1254² frame needs 6084 and fails with "config unsupported". Use a descending
  candidate list; **`avc1.640034`** works. Do not hardcode a single codec string.

### Fixed input size is not a limitation, it is the finding

u2net at a **fixed** 256×256 beat dynamic-axis configurations decisively. ORT-web handles
dynamic shapes poorly, and the quality cost of the fixed size was nil on real vehicle photos.
Export the model with static axes.

---

## 4. Hosting shape (cost: $0)

```
lotstretcher.org
├── Workers static assets      landing page, app shell, ORT wasm,
│                              both classifiers (~1.7 MB each — well under the cap)
└── R2 bucket                  u2net int8 (44.2 MB) — zero egress cost
```

Cloudflare's static-asset limit is **25 MiB per file on free *and* paid plans**, so the 44.2 MB
matting model cannot be a static asset regardless of billing tier. R2 with zero egress is the
correct home. This mirrors how `handlingtheloop` hosts its stem weights on HuggingFace for
the identical reason.

Models are cached by the browser after first load. The 44 MB download happens once per device.

**Cloudflare Browser Rendering is a paid product and is not used.** There is no server-side
compute anywhere in this design.

---

## 5. Input paths

Ordered by how well they work, best first.

### 5a. Upload (primary)

- **Desktop:** folder picker (`webkitdirectory`) or multi-select. This is exactly the
  `local_source.py` contract the CLI already implements — same input, same pipeline,
  different surface.
- **Mobile:** camera capture (`<input capture>`) or photo-library multi-select.

### 5b. Paste image URLs (secondary)

Dealer photo CDNs allow cross-origin reads. Paste a list of image URLs, the app fetches and
processes them. This covers the common "I can see the photos but I'm not at my desk" case.

### 5c. Window sticker (metadata)

Paste a window-sticker PDF URL or drop the file. pdf.js extracts text and positions
client-side, recovering trim, options, and MSRP without any scraping.

### 5d. Bookmarklet (built, then removed 2026-09-23: replaced by the address/VIN decoder in pipeline/vin.js)

The dealer's own browser is already authenticated and already has the VDP loaded. A
bookmarklet run **on that page** can read `window.jzlAnalyticsObject.vdp_gtm_payload` — the
same analytics JSON `scrape.py` extracts — and hand the full vehicle record plus photo URLs
to lotstretcher.org.

This recovers nearly all of what scraping provides, without lotstretcher ever making a
cross-origin request. The user is on the page; the user's browser reads it; nothing is
circumvented.

**Open question:** ship in v1, or start with upload + URL paste and add it once the core
is proven? *Recommendation: defer to v2.* It is the highest-leverage feature but also
the one most coupled to a specific CMS payload shape, and it needs the core to be
trustworthy first.

---

## 6. Output — the bundle

Reproduce what the CLI produces:

```
hero.png
hero-portrait.png
hero-video-1.mp4, hero-video-2.mp4, hero-video-3.mp4
framed/          (4 files)
interior/
window-sticker-1a.png, window-sticker-1b.png
facebook.txt
instagram.txt
threads.txt
```

Delivered as a ZIP built in the tab, or individually — on mobile, individual saves and the
native share sheet matter more than a ZIP.

**Open question:** videos in v1? They are measured at 3–4× realtime and work, but they are
also the heaviest part of the phone-class budget. *Recommendation: yes, but generate on
explicit request rather than automatically*, so the default path stays fast.

---

## 7. Backgrounds and assets — three tiers

This is the part the operator correctly called tricky. It resolves cleanly once you notice
the default already exists.

### Tier 0 — generated gradient (default; no key, no assets, no network)

`imaging/palette.py::vehicle_gradient_colors()` derives a two-stop gradient from the
vehicle's own paint color (measuring the cutout when the color name is missing);
`imaging/compose/background.py::make_linear_gradient(size, angle, start, end)` renders it.

This is **already the production default**, and it was chosen deliberately over a shared
backdrop image — a repeated backdrop previously got posts flagged as spam. It is per-vehicle,
it ships as pure math, and it weighs zero bytes.

**A generated gradient is a better neutral default than any generic asset pack would be.**
Tier 0 is fully usable on its own. Nothing above it is required.

### Tier 1 — bring your own assets (browser-local)

The user drags in their own frames, backdrops, and logo once; they persist on that device.

This is where the operator's "no storage to pay for" tension dissolves:

- **Operator storage** — costs money, creates liability, requires accounts. **None. Ever.**
- **Browser-local storage** — OPFS / IndexedDB. The *user's own disk*. Free to the operator,
  private to the user, never transits any server, survives reloads.

A dealer adds their logo once and it is there next time. That is not a compromise of the
no-backend principle; it is what makes the principle survive contact with real use.

### Tier 2 — bring your own API key (optional)

Two *different* integrations, often conflated:

| Want | Provider | Note |
|---|---|---|
| Better post copy — headline variants, feature phrasing, per-platform tone | **OpenRouter** (LLM) | Cheap per call. Arguably the higher-value half. |
| Generated backdrops | **Recraft** (image gen) | `imaging/generate.py` already integrates it: `recraftv4_1`, ~$0.035/image. |

OpenRouter routes *text* models; it is not the right router for image generation. Do not
ship a single "AI key" field that pretends these are one thing.

**CORS is verified.** A preflight to `https://openrouter.ai/api/v1/chat/completions` with
`Origin: https://lotstretcher.org` returns:

```
HTTP/2 204
access-control-allow-origin: *
access-control-allow-headers: Authorization,User-Agent,X-Api-Key,…,HTTP-Referer,X-Title,…
access-control-allow-methods: GET,OPTIONS,PATCH,DELETE,POST,PUT
```

So a static page can call OpenRouter directly. The key goes browser → provider. It never
touches lotstretcher.org, because lotstretcher.org has no server to touch.

#### Key handling — the real risk is trust, not cryptography

**A static site asking for an API key is phishing-shaped.** That is the actual problem to
solve, and it is a UX and credibility problem. Mitigations, all of which should ship together:

1. **Prefer OAuth PKCE** where the provider supports it (OpenRouter does). The user
   authorizes without ever pasting a raw secret. This is the single biggest improvement.
2. **Default to `sessionStorage`** — the key is gone when the tab closes. Persistence is a
   deliberate, clearly labeled opt-in, never the default. **Never IndexedDB for secrets.**
3. **Make the claim verifiable.** The app is open source and the network tab shows the key
   going only to the provider. Say this *in the UI, next to the field*, not buried in docs.
4. **Recommend a spend-capped key.** It is the user's money.
5. **Carry over the repo's existing rule**, stated in `imaging/generate.py`:
   *never log, print, or commit a key.* No key in console output, error messages,
   analytics, or URL parameters — the browser makes every one of those easier to do
   by accident than the CLI does.

---

## 8. Build order

Deliberately front-loads everything with no security surface.

| Version | Scope | Why here |
|---|---|---|
| **v1** — *built, see [`web/`](../web/)* | Upload + URL paste → classify, matte, compose → bundle download. Tier 0 gradients only. No keys, no asset UI, no accounts. | Genuinely complete on its own, and there is nothing to explain to the user. |
| **v2** | BYO asset library (OPFS). Bookmarklet for VDP metadata. | The logo is what dealers will ask for first. |
| **v3** | BYO keys — **copy generation first**, backgrounds second. | Cheaper, more useful, and lower-stakes than image generation. |

---

## 9. Measurement provenance — and the gap

Every timing, size, and quality figure above was measured in **desktop Chromium on an
i9-12900H**. The phone-class figure was produced by CDP CPU throttling, which is an
approximation of a slow CPU — not of a different browser engine.

**No iPhone, iPad, or Safari of any kind was tested at any point.** This is tracked as
osiris obligation `d4902910` and is the single largest risk to this design:

- Safari runs JavaScriptCore, not V8.
- The **WebKit per-page memory ceiling** is the specific concern. The ~466 MB floor
  *should* fit, but that is an inference, not an observation.
- Safari's WebGPU is known to break catastrophically, which is why this design is CPU-only
  throughout. That decision is already made and is not at risk.

**Required before any engineering budget is committed:** load the ORT-web WASM CPU path with
u2net int8 on a real iPhone — the *oldest* one worth supporting — confirm the tab survives,
and measure one matte.

If the tab dies, the browser-first shape needs rethinking and the self-hosted path becomes
primary. Everything else in this document is downstream of that one test.

### Methodological note

During the research that produced these numbers, **four** surprising results turned out to be
instrument error rather than real phenomena — including one, "dynamic axes are ~175× slower in
ORT-web," that was stated confidently and later retracted (it was a `ReferenceError` in the
harness timing out every model equally). The tell was that a known-good control timed out
identically.

**Always re-run a known-good control before believing a surprising result.**
