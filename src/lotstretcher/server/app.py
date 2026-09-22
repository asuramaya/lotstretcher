"""
Server mode: a CarCutter-API-shaped HTTP surface in front of lotstretcher's own
imaging pipeline, self-hosted.

WHY THIS EXISTS (roadmap item 5, strategy decision 1449fdef, lotstretcher project
graph): CarCutter's own documented API (cloud.car-cutter.com/doc/
api.html) is the shape a lot of dealer-software integrations already
speak. lotstretcher's core pipeline (classify, cutout, composite) does the same
job, self-hosted and fully open -- no data ever leaves your own server,
and every line of the model/processing code is readable, unlike a closed
SaaS API. This exposes that pipeline behind a compatible enough surface
that swapping the base URL is a realistic option, not a rewrite.

TWO MODES, ONE PIPELINE: this is a genuinely different way of running
lotstretcher than the CLI (a long-lived process instead of a one-shot script),
which is why it's a separate, OPT-IN dependency group (`pip install
-e ".[server]"`) -- installing lotstretcher to run it as a script never drags in
a web framework. See CONTRIBUTING.md's "CLI Only" note, revised to
document both modes rather than silently contradicted by this file.

SCOPE, STATED HONESTLY: this implements the CORE image-processing surface
(submission/status/result, single-segment) plus a light vehicle registry
(submission/list/status/delete/shotlist) end to end, backed by SQLite and
a thread pool -- not every field CarCutter's docs mention. guideline_id,
location_id, processing_speed, and retouching_accuracy are ACCEPTED (for
request-shape compatibility) but not yet wired to different behavior;
cut_type="blur" currently maps to the same treatment as "complete" (no
blur treatment built yet). Each such gap is a real, trackable follow-up,
not a silent no-op -- see the response's own "warning" field where one
applies. Extend FEED_COLUMNS-style: this is a small, flat request/
response schema (below), not scattered logic, specifically so a real
field difference is cheap to fix once one surfaces in practice.

Run:
    pip install -e ".[server]"
    lotstretcher-serve --data-dir ~/.lotstretcher-server --out ~/.lotstretcher-server/images
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from . import store
from .processing import fetch_image, process_image

MAX_IMAGES_PER_SUBMISSION = 60

app = FastAPI(title="lotstretcher server", description="Self-hosted, CarCutter-API-shaped vehicle imaging service")

# Populated by run()/configure() before the app serves traffic. Not a
# FastAPI dependency-injection setup on purpose -- this mirrors every
# other CLI entry point in this codebase (module-level state set once at
# startup), which keeps this file readable next to them rather than
# introducing a different pattern just for the server.
_state: dict = {}


def configure(data_dir: Path, out_dir: Path, max_workers: int = 4) -> None:
    from ..imaging.classify import InteriorExteriorTiebreakClassifier, SceneClassifier, default_backbone

    backbone = default_backbone()
    _state["data_dir"] = Path(data_dir)
    _state["out_dir"] = Path(out_dir)
    _state["classifier"] = SceneClassifier(backbone=backbone)
    _state["tiebreak"] = InteriorExteriorTiebreakClassifier(backbone=backbone)
    _state["executor"] = ThreadPoolExecutor(max_workers=max_workers)


# -- Request/response schemas -------------------------------------------------

class VehicleSubmission(BaseModel):
    vehicle_id: str
    metadata: dict = {}


class ImageEntry(BaseModel):
    id: str
    url: str


class ImageSubmission(BaseModel):
    vehicle_id: Optional[str] = None
    images: list[ImageEntry]
    cut_type: str = "complete"
    scene_id: Optional[str] = None
    guideline_id: Optional[str] = None       # accepted, not yet behavioral -- see module docstring
    location_id: Optional[str] = None        # accepted, not yet behavioral
    processing_speed: Optional[str] = None   # accepted, not yet behavioral
    retouching_accuracy: Optional[str] = None  # accepted, not yet behavioral
    webhook_url: Optional[str] = None


class SingleSegmentRequest(BaseModel):
    image_url: str
    cut_type: str = "complete"
    scene_id: Optional[str] = None


# -- Vehicle registry ----------------------------------------------------------

@app.post("/vehicle/submission")
def submit_vehicle(body: VehicleSubmission):
    store.upsert_vehicle(_state["data_dir"], body.vehicle_id, body.metadata)
    return {"vehicle_id": body.vehicle_id, "status": store.STATUS_NEW}


@app.post("/vehicle/list")
def list_vehicles(status: Optional[str] = None):
    return {"vehicles": store.list_vehicles(_state["data_dir"], status=status)}


@app.get("/vehicle/status")
def vehicle_status(vehicle_id: str):
    v = store.get_vehicle(_state["data_dir"], vehicle_id)
    if v is None:
        raise HTTPException(404, f"Unknown vehicle_id {vehicle_id!r}")
    return v


@app.delete("/vehicle/delete")
def delete_vehicle(vehicle_id: str):
    if not store.delete_vehicle(_state["data_dir"], vehicle_id):
        raise HTTPException(404, f"Unknown vehicle_id {vehicle_id!r}")
    return {"vehicle_id": vehicle_id, "deleted": True}


@app.get("/vehicle/shotlist")
def shotlist():
    """Vehicles still in "new" status -- CarCutter's own semantics for
    this endpoint (vehicles awaiting a photo shoot) don't map cleanly onto
    lotstretcher's pipeline (there's no separate "shoot" step; images arrive by
    URL, not an in-person capture app), so this is kept as the closest
    honest equivalent: registered vehicles nothing has been submitted
    for yet, not a literal port of CarCutter's own shoot-scheduling
    semantics."""
    return {"vehicles": store.list_vehicles(_state["data_dir"], status=store.STATUS_NEW)}


# -- Image processing: sync ----------------------------------------------------

@app.post("/vehicle/composition/single-segment")
def single_segment(body: SingleSegmentRequest):
    if body.cut_type not in ("complete", "normal", "blur", "none"):
        raise HTTPException(422, f"Unknown cut_type {body.cut_type!r}")
    try:
        content = fetch_image(body.image_url)
    except Exception as e:
        raise HTTPException(400, f"Could not fetch image_url: {e}")

    result = process_image(content, _state["out_dir"], f"single-{abs(hash(body.image_url))}",
                            cut_type=body.cut_type, scene_id=body.scene_id,
                            classifier=_state["classifier"], tiebreak_classifier=_state["tiebreak"])
    return {
        "category": result.category,
        "clip_label": result.clip_label,
        "clip_confidence": result.clip_confidence,
        "output_path": str(result.output_path) if result.output_path else None,
        "warning": result.warning,
    }


# -- Delegated composition (from the browser client) ----------------------------


@app.get("/assets")
def list_assets():
    """The asset library, so the app's background and border selects have
    something to offer. These render "none available" on lotstretcher.org
    because a browser has no asset library."""
    from .delegate import list_assets as _list
    return _list()


@app.post("/compose")
async def compose_delegated(cutout: UploadFile = File(...), options: str = Form("{}")):
    """Compose one cutout using this host's assets and hardware.

    The browser sends a CUTOUT, not the source photo: matting already
    happened on the device, so the original photograph never leaves it.
    Only the cut-out vehicle does, and only when the user asks for
    something this server can do and a browser cannot.
    """
    from .delegate import compose, parse_options

    try:
        opts = parse_options(options)
    except ValueError as e:
        raise HTTPException(422, str(e))

    content = await cutout.read()
    if not content:
        raise HTTPException(422, "cutout is empty")

    try:
        png, warnings = compose(content, opts, _state["out_dir"])
    except ValueError as e:
        raise HTTPException(422, str(e))
    except Exception as e:
        raise HTTPException(500, f"composition failed: {e}")

    # Anything asked for that could not be honoured rides back on a
    # header, since the body is the image. Silently dropping a requested
    # border is how a control becomes untrustworthy.
    headers = {"X-Lotstretcher-Warning": "; ".join(warnings)} if warnings else {}
    return Response(content=png, media_type="image/png", headers=headers)


@app.get("/library")
def library_index():
    """The listings library on this host, for the app's Library pane."""
    from . import library
    root = _state.get("library")
    if not root:
        raise HTTPException(404, "no library configured on this host (lotstretcher-serve --library)")
    return library.index(Path(root))


@app.get("/library/{bucket}/{folder}/{rel:path}")
def library_file(bucket: str, folder: str, rel: str):
    """One file from one vehicle folder: a hero, a clip, a post."""
    from fastapi.responses import FileResponse
    from . import library
    root = _state.get("library")
    if not root:
        raise HTTPException(404, "no library configured on this host")
    try:
        path = library.resolve_file(Path(root), bucket, folder, rel)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except FileNotFoundError:
        raise HTTPException(404, "no such file")
    # Finished output does not change under its name; a folder rewritten
    # by a rerun gets a new mtime, which the browser revalidates on.
    return FileResponse(path, headers={"Cache-Control": "no-cache"})


@app.get("/library/status")
def library_status():
    """Sync and run history at the library root, plus what is running now."""
    from . import jobs, library
    root = _state.get("library")
    if not root:
        raise HTTPException(404, "no library configured on this host")
    out = library.status(Path(root))
    out["jobs"] = jobs.recent()
    out["syncConfigured"] = _sync_configured()
    return out


def _sync_configured() -> bool:
    from ..dealer_config import get as dealer
    try:
        cfg = dealer()
    except Exception:
        return False
    return bool(cfg.inventory_url or cfg.inventory_urls)


class RecomposeRequest(BaseModel):
    options: dict = {}


@app.post("/library/{bucket}/{folder}/recompose")
def library_recompose(bucket: str, folder: str, body: RecomposeRequest):
    """Rebuild one vehicle's bundle from its existing cutouts with the
    given control values: the same path as the `recompose` CLI, started
    from the Library pane. Returns a job to poll."""
    from . import jobs, library
    from ..library_ops import recompose_folder, resolve_recompose_options
    root = _state.get("library")
    if not root:
        raise HTTPException(404, "no library configured on this host")
    try:
        library.resolve_file(Path(root), bucket, folder, "details.json")
    except ValueError as e:
        raise HTTPException(400, str(e))
    except FileNotFoundError:
        raise HTTPException(404, "no such vehicle")
    try:
        resolved = resolve_recompose_options(body.options)
    except ValueError as e:
        raise HTTPException(422, str(e))
    target = Path(root) / bucket / folder
    return jobs.start(_state["executor"], "recompose", f"{bucket}/{folder}",
                      lambda: recompose_folder(target, resolved))


@app.post("/library/sync")
def library_sync():
    """Run one inventory sync cycle into the library, as `inventory-sync`
    would with the configured dealer inventory URL. One at a time."""
    from . import jobs
    from ..dealer_config import get as dealer
    root = _state.get("library")
    if not root:
        raise HTTPException(404, "no library configured on this host")
    if jobs.running("sync"):
        raise HTTPException(409, "a sync is already running")
    cfg = dealer()
    url = cfg.inventory_url or next(iter(cfg.inventory_urls.values()), None)
    if not url:
        raise HTTPException(409, "no inventory URL configured; set inventory_url in the dealer config "
                                 "or LOTSTRETCHER_INVENTORY_URL")

    def run():
        from ..inventory_sync import run_sync
        return run_sync({"inventory_url": url, "listings_root": str(root)})

    return jobs.start(_state["executor"], "sync", url, run)


class RescrapeRequest(BaseModel):
    options: dict = {}


def _models():
    """The classifier set, built once per server process on first use:
    one CLIP load shared by every re-scrape after it."""
    if "models" not in _state:
        from ..library_ops import Models
        _state["models"] = Models()
    return _state["models"]


@app.post("/library/{bucket}/{folder}/rescrape")
def library_rescrape(bucket: str, folder: str, body: RescrapeRequest):
    """Fetch the vehicle's page again and run the whole pipeline into the
    library with the given control values: `lotstretcher <url> --force`,
    started from the Library pane. The URL comes from the folder's own
    record. Returns a job to poll."""
    from . import jobs, library
    from ..library_ops import hero_options_from_controls, rescrape
    root = _state.get("library")
    if not root:
        raise HTTPException(404, "no library configured on this host")
    try:
        details_path = library.resolve_file(Path(root), bucket, folder, "details.json")
    except ValueError as e:
        raise HTTPException(400, str(e))
    except FileNotFoundError:
        raise HTTPException(404, "no such vehicle")
    import json as _json
    try:
        url = (_json.loads(details_path.read_text(encoding="utf-8")) or {}).get("url")
    except ValueError:
        url = None
    if not url or not str(url).startswith(("http://", "https://")):
        raise HTTPException(409, "this vehicle's record carries no listing URL to fetch from")
    try:
        hero_options_from_controls(body.options)   # refuse bad assets/formats before starting
    except ValueError as e:
        raise HTTPException(422, str(e))
    if jobs.running("rescrape"):
        raise HTTPException(409, "a re-scrape is already running; one at a time keeps the site's "
                                 "challenge from escalating")
    return jobs.start(_state["executor"], "rescrape", f"{bucket}/{folder}",
                      lambda: rescrape(url, Path(root), body.options, _models()))


@app.get("/jobs/{job_id}")
def job_status(job_id: str):
    from . import jobs
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "no such job")
    return job


class ScrapeRequest(BaseModel):
    url: str


@app.post("/scrape")
def scrape_listing(body: ScrapeRequest):
    """Read one vehicle page with this host's headless browser and return
    the record the CLI would have built from it.

    The browser client cannot read another site's page itself; on
    lotstretcher.org it uses the bookmarklet instead. Against this server
    the same sheet offers a URL field, and this is where it lands. The
    record's shape is scrape.Vehicle, the same one the bookmarklet's
    normaliser produces, so the app fills the same fields either way.

    Runs in FastAPI's threadpool (a plain def), which is what Playwright's
    sync API needs.
    """
    import dataclasses
    from urllib.parse import urlparse

    from ..vehicle_pipeline import scrape_vehicle

    parsed = urlparse(body.url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise HTTPException(422, "url must be an http(s) address of a vehicle page")

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        raise HTTPException(501, "playwright is not installed on this host; "
                                 "pip install playwright && playwright install chromium")

    try:
        with sync_playwright() as pw:
            v = scrape_vehicle(pw, body.url)
    except RuntimeError as e:
        # The two loud sanity failures: not a single vehicle's page, or
        # a page that redirected to a different vehicle.
        raise HTTPException(422, str(e))
    except Exception as e:
        raise HTTPException(502, f"could not read that page: {type(e).__name__}: {e}")

    return dataclasses.asdict(v)


# -- Image processing: async batch ----------------------------------------------

def _run_submission(submission_id: str) -> None:
    data_dir, out_dir = _state["data_dir"], _state["out_dir"]
    sub = store.get_submission(data_dir, submission_id)
    if sub is None:
        return
    for img in sub["images"]:
        store.update_image_result(data_dir, submission_id, img["image_id"], store.STATUS_PROCESSING)
        try:
            content = fetch_image(img["url"])
            result = process_image(content, out_dir, f"{submission_id}-{img['image_id']}",
                                    classifier=_state["classifier"], tiebreak_classifier=_state["tiebreak"])
            store.update_image_result(data_dir, submission_id, img["image_id"], store.STATUS_DONE,
                                       output_path=str(result.output_path) if result.output_path else None,
                                       category=result.category, warning=result.warning)
        except Exception as e:
            store.update_image_result(data_dir, submission_id, img["image_id"], store.STATUS_FAILED,
                                       warning=str(e))

    if sub["webhook_url"]:
        import requests
        try:
            requests.post(sub["webhook_url"],
                          json=store.get_submission(data_dir, submission_id), timeout=15)
        except Exception:
            pass  # best-effort -- the client can still poll /vehicle/image/result


@app.post("/vehicle/image/submission")
def submit_images(body: ImageSubmission):
    if not body.images:
        raise HTTPException(422, "images must be non-empty")
    if len(body.images) > MAX_IMAGES_PER_SUBMISSION:
        raise HTTPException(422, f"At most {MAX_IMAGES_PER_SUBMISSION} images per submission")

    submission_id = store.create_submission(
        _state["data_dir"], body.vehicle_id, {img.id: img.url for img in body.images}, body.webhook_url)
    _state["executor"].submit(_run_submission, submission_id)
    return {"submission_id": submission_id}


@app.get("/vehicle/image/status")
def image_status(submission_id: str):
    sub = store.get_submission(_state["data_dir"], submission_id)
    if sub is None:
        raise HTTPException(404, f"Unknown submission_id {submission_id!r}")
    return {"submission_id": submission_id,
            "images": [{"id": i["image_id"], "status": i["status"]} for i in sub["images"]]}


@app.get("/vehicle/image/result")
def image_result(submission_id: str):
    sub = store.get_submission(_state["data_dir"], submission_id)
    if sub is None:
        raise HTTPException(404, f"Unknown submission_id {submission_id!r}")
    return {"submission_id": submission_id,
            "images": [{"id": i["image_id"], "status": i["status"], "output_path": i["output_path"],
                        "category": i["category"], "warning": i["warning"]} for i in sub["images"]]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--no-app", action="store_true",
                         help="Serve only the API, without the browser client. The app is "
                              "the same web/public that lotstretcher.org serves; there is no "
                              "separate server build of it.")
    parser.add_argument("--data-dir", default="~/.lotstretcher-server", help="Where the SQLite registry lives")
    parser.add_argument("--out-dir", default=None, help="Where processed images are saved "
                                                          "(default: <data-dir>/images)")
    parser.add_argument("--workers", type=int, default=4, help="Async batch worker thread pool size")
    parser.add_argument("--library", default=str(Path.home() / "Documents" / "listings"),
                         help="The listings library to serve to the app's Library pane: the folder "
                              "`lotstretcher --out` writes (default: ~/Documents/listings, the CLI's "
                              "default too). Pass an empty string to serve none.")
    args = parser.parse_args()

    import uvicorn

    data_dir = Path(args.data_dir).expanduser()
    out_dir = Path(args.out_dir).expanduser() if args.out_dir else data_dir / "images"
    configure(data_dir, out_dir, max_workers=args.workers)
    library = Path(args.library).expanduser() if args.library else None
    if library and library.is_dir():
        _state["library"] = library
        print(f"  library: {library}")
    elif library:
        print(f"  library: {library} does not exist yet; the Library pane will offer a folder picker only")

    # Mounted LAST so the catch-all static route cannot shadow an API
    # path: FastAPI matches routes in registration order.
    if not args.no_app:
        from .webapp import install, web_root
        if install(app, _state):
            print(f"  browser client: http://{args.host}:{args.port}/  (from {web_root()})")
        else:
            print("  browser client: not found; serving the API only. "
                  "Set LOTSTRETCHER_WEB_ROOT to point at web/public.")

    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
