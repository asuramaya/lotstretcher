"""The core keeps fonts per thread (core/src/text.rs, thread_local FONTS),
so the Python side must load a font into each thread that draws text. It
once remembered fonts per process, and the server's POST /video, answered
on another pool thread than the /compose that loaded the font, failed
with 'font "Lato Bold" is not loaded'."""
from __future__ import annotations

import threading

from lotstretcher.imaging import text


def test_each_thread_loads_its_own_font(monkeypatch):
    loads = []
    monkeypatch.setattr(text.core, "load_font", lambda name, data: loads.append((threading.get_ident(), name)))
    monkeypatch.setattr(text, "_tls", threading.local())
    text.ensure_font("Lato Bold")
    text.ensure_font("Lato Bold")            # once per thread, not per call
    t = threading.Thread(target=text.ensure_font, args=("Lato Bold",))
    t.start()
    t.join()
    assert len(loads) == 2 and loads[0][0] != loads[1][0]
