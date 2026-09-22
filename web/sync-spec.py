#!/usr/bin/env python3
"""Copy shared/pipeline-spec.json into web/public/spec/.

WHY A COPY AND NOT A SYMLINK: a symlink was tried first and fails in the
two places that matter. Starlette's StaticFiles refuses links that
resolve outside the mounted directory, so the self-hosted server 404s on
it, and static hosts generally do not follow links either.

The copy is COMMITTED, so a fresh clone works with no build step, and
tests/test_spec_parity.py asserts it is byte-identical to the canonical
file. A stale copy therefore fails the suite rather than silently
serving the browser different numbers from the ones Python uses, which
is the whole failure mode the shared spec exists to prevent.

Run after editing shared/pipeline-spec.json:
    python3 web/sync-spec.py
"""
import filecmp
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SRC = REPO / "shared" / "pipeline-spec.json"
DST = REPO / "web" / "public" / "spec" / "pipeline-spec.json"


def main() -> int:
    if not SRC.is_file():
        print(f"missing {SRC}", file=sys.stderr)
        return 1
    DST.parent.mkdir(parents=True, exist_ok=True)
    if DST.is_file() and filecmp.cmp(SRC, DST, shallow=False):
        print("already in sync")
        return 0
    shutil.copy2(SRC, DST)
    print(f"synced -> {DST.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
