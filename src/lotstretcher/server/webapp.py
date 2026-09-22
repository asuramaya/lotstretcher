"""Serving the browser client from the self-hosted server.

ONE APP, TWO HOSTS. web/public is exactly what lotstretcher.org serves,
and this mounts that same directory. There is no second build, no
"server edition" of the UI, and no forked copy to keep in sync: a fix to
the app is a fix to both, and a control added to one appears in the
other because it is the other.

What differs is CAPABILITIES, not code. Self-hosted has things a public
static site cannot: a Python process that can scrape, a real filesystem,
GPU upscaling, inventory sync. The app asks /capabilities what it is
running against and unlocks accordingly, so the gated features live in
the same source as everything else and are simply switched off when the
answer is "static".

Cross-origin isolation matters as much here as on the CDN. Without
COOP/COEP the browser refuses SharedArrayBuffer, onnxruntime-web drops
to a single thread, and a vehicle takes roughly twice as long with no
error to explain it. The middleware below mirrors web/public/_headers.
"""
from __future__ import annotations

import os
from pathlib import Path

# repo_root/src/lotstretcher/server/webapp.py -> repo_root/web/public
DEFAULT_WEB_ROOT = Path(__file__).resolve().parents[3] / "web" / "public"


def web_root() -> Path | None:
    """Where the browser client lives, or None if it is not present.

    LOTSTRETCHER_WEB_ROOT overrides, which is what a packaged install or a
    container uses when the repo layout is not around it.
    """
    override = os.environ.get("LOTSTRETCHER_WEB_ROOT")
    if override:
        path = Path(override).expanduser()
        return path if (path / "app.html").is_file() else None
    return DEFAULT_WEB_ROOT if (DEFAULT_WEB_ROOT / "app.html").is_file() else None


def capabilities(state: dict) -> dict:
    """What this host can do, for the app to switch on.

    Deliberately describes CAPABILITIES rather than naming a product
    edition. The app asks "can I scrape?", not "am I the paid version?",
    so adding a capability never means teaching the client about a new
    tier.
    """
    from .. import spec

    root = web_root()
    return {
        "host": "self-hosted",
        "version": spec.get("version", default=1),
        # Things only a real process can do. Each one is the reason the
        # self-hosted surface exists at all.
        "scrape": True,
        "inventorySync": True,
        "batch": True,
        "filesystem": True,
        "windowStickerFetch": True,   # no CORS limits from a server
        # GPU-dependent. Reported honestly rather than advertised: a
        # CPU-only host should not offer upscaling it will crawl through.
        "upscale": _torch_cuda_available(),
        "nvenc": _nvenc_available(),
        # Where output lands, so the app can say so instead of only
        # offering a download.
        "outDir": str(state.get("out_dir")) if state.get("out_dir") else None,
        "servingWebApp": root is not None,
    }


def _torch_cuda_available() -> bool:
    try:
        import torch
        return bool(torch.cuda.is_available())
    except Exception:
        return False


def _nvenc_available() -> bool:
    """ffmpeg with an NVENC encoder compiled in. Checked once; the answer
    cannot change while the process runs."""
    import shutil
    import subprocess
    if not shutil.which("ffmpeg"):
        return False
    try:
        out = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"],
                             capture_output=True, text=True, timeout=10)
        return "h264_nvenc" in out.stdout
    except (subprocess.SubprocessError, OSError):
        return False


def _sync_spec(root: Path) -> None:
    """Refresh the served copy of shared/pipeline-spec.json.

    Done on startup so editing the canonical file and restarting cannot
    leave the browser reading different numbers from the ones Python
    uses. A symlink would avoid the copy but StaticFiles refuses links
    that resolve outside the mount, which is how this was found.
    """
    import filecmp
    import shutil
    from .. import spec as _spec

    src = _spec.SPEC_PATH
    dst = root / "spec" / "pipeline-spec.json"
    try:
        if not src.is_file():
            return
        dst.parent.mkdir(parents=True, exist_ok=True)
        if not dst.is_file() or not filecmp.cmp(src, dst, shallow=False):
            shutil.copy2(src, dst)
    except OSError:
        # A read-only install ships the copy already in place; failing to
        # refresh it is not a reason to refuse to serve.
        pass


def install(app, state: dict) -> bool:
    """Mount the browser client on `app`. Returns whether it was found.

    Mounting is last so it cannot shadow an API route: StaticFiles at "/"
    is a catch-all, and FastAPI matches in registration order.
    """
    root = web_root()
    if root is None:
        return False

    _sync_spec(root)

    from fastapi.responses import FileResponse, JSONResponse
    from fastapi.staticfiles import StaticFiles
    from starlette.middleware.base import BaseHTTPMiddleware

    class IsolationHeaders(BaseHTTPMiddleware):
        """Mirrors web/public/_headers.

        Without these the browser will not hand out SharedArrayBuffer,
        onnxruntime-web silently falls back to one thread, and everything
        takes about twice as long with nothing in the console to say why.
        """
        async def dispatch(self, request, call_next):
            response = await call_next(request)
            response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
            response.headers["Cross-Origin-Embedder-Policy"] = "require-corp"
            response.headers["X-Content-Type-Options"] = "nosniff"

            """Cache policy, and it is not the CDN's.

            StaticFiles sends only ETag and Last-Modified, which lets a
            browser reuse a cached module without revalidating. On
            lotstretcher.org that is fine because a deploy changes the
            URL; here it is a real bug, because the app updates when the
            PACKAGE updates and the path never changes. A self-hosted
            user would upgrade lotstretcher and keep running the old UI.
            Found exactly that way: a freshly edited module kept loading
            from cache.

            Source revalidates every time (cheap, it is a 304 when
            unchanged). Weights do not: they are large, immutable, and
            the whole point of caching them is that the 44MB matting
            model downloads once per device.
            """
            path = request.url.path
            if path.startswith("/models/") or path.startswith("/ort/"):
                response.headers.setdefault(
                    "Cache-Control", "public, max-age=31536000, immutable")
            else:
                response.headers.setdefault("Cache-Control", "no-cache")

            return response

    app.add_middleware(IsolationHeaders)

    @app.get("/capabilities")
    def _capabilities():
        return JSONResponse(capabilities(state))

    @app.get("/")
    def _index():
        return FileResponse(root / "index.html")

    app.mount("/", StaticFiles(directory=str(root), html=True), name="webapp")
    return True
