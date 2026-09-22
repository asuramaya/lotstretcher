"""Long-running work started from the app, tracked in memory.

A recompose takes seconds per vehicle and a sync takes minutes, so the
routes that start them return at once with a job id and the app polls.
In-memory on purpose: a job that outlives the process is not a job the
app can still be watching, and the results are on disk regardless (the
folder is the record). The list is capped so a long-lived server does
not grow without bound.
"""
from __future__ import annotations

import threading
import time
import traceback
import uuid
from collections import OrderedDict

MAX_JOBS = 200

_lock = threading.Lock()
_jobs: "OrderedDict[str, dict]" = OrderedDict()


def start(executor, kind: str, target: str, fn) -> dict:
    """Run fn() on the executor and track it. fn returns the job's result
    (any JSON-able value) or raises."""
    job = {
        "id": uuid.uuid4().hex[:12],
        "kind": kind,
        "target": target,
        "status": "running",
        "started": time.time(),
        "finished": None,
        "result": None,
        "error": None,
    }
    with _lock:
        _jobs[job["id"]] = job
        while len(_jobs) > MAX_JOBS:
            _jobs.popitem(last=False)

    def run():
        try:
            result = fn()
            with _lock:
                job["status"] = "done"
                job["result"] = result
        except Exception as e:  # the app shows this string; a traceback belongs in the log
            traceback.print_exc()
            with _lock:
                job["status"] = "failed"
                job["error"] = f"{type(e).__name__}: {e}"
        finally:
            with _lock:
                job["finished"] = time.time()

    executor.submit(run)
    return dict(job)


def get(job_id: str) -> dict | None:
    with _lock:
        job = _jobs.get(job_id)
        return dict(job) if job else None


def recent(limit: int = 20) -> list[dict]:
    with _lock:
        return [dict(j) for j in list(_jobs.values())[-limit:]][::-1]


def running(kind: str | None = None) -> list[dict]:
    with _lock:
        return [dict(j) for j in _jobs.values()
                if j["status"] == "running" and (kind is None or j["kind"] == kind)]
