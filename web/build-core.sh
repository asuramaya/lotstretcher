#!/usr/bin/env bash
# Build the Rust core for the browser: core/ -> web/public/core/.
#
# wasm-bindgen's CLI is used directly rather than wasm-pack, whose
# current release passes cargo a flag it no longer accepts. The CLI
# version must match the wasm-bindgen crate in core/Cargo.lock;
# `cargo install wasm-bindgen-cli --version <that>` once.
set -euo pipefail
cd "$(dirname "$0")/../core"
# SIMD is in every browser the app already needs for WebCodecs; LLVM
# vectorises the per-pixel loops with it on.
# The plain build: no threads (node has no workers, and a page without
# cross-origin isolation has no SharedArrayBuffer).
RUSTFLAGS="-C target-feature=+simd128" cargo build --release --target wasm32-unknown-unknown \
  --no-default-features --features wasm
wasm-bindgen --target web --out-dir ../web/public/core --out-name lotstretcher_core \
  target/wasm32-unknown-unknown/release/lotstretcher_core.wasm

# The threaded build: rayon over web workers (wasm-bindgen-rayon, in
# its no-bundler mode). Needs nightly with rust-src, since std must be
# rebuilt with atomics; the link flags give it a shared, imported
# memory and the TLS exports wasm-bindgen wants. It is committed like
# the plain build. Only a worker may load it (rayon's join blocks the
# calling thread, which a page's main thread may not do): the video
# renderer runs in one and takes it there; the page takes the plain
# build. Skipped, with a note, when nightly is not installed.
if rustup run nightly cargo --version >/dev/null 2>&1; then
  RUSTFLAGS="-C target-feature=+atomics,+bulk-memory,+mutable-globals,+simd128 \
    -C link-arg=--shared-memory -C link-arg=--max-memory=1073741824 -C link-arg=--import-memory \
    -C link-arg=--export=__wasm_init_tls -C link-arg=--export=__tls_size \
    -C link-arg=--export=__tls_align -C link-arg=--export=__tls_base" \
    cargo +nightly build --release --target wasm32-unknown-unknown \
    --no-default-features --features wasm-threads \
    -Z build-std=std,panic_abort --target-dir target/threads
  wasm-bindgen --target web --out-dir ../web/public/core-threads --out-name lotstretcher_core \
    target/threads/wasm32-unknown-unknown/release/lotstretcher_core.wasm
else
  echo "nightly not installed: threaded wasm build skipped (rustup toolchain install nightly --component rust-src)"
fi
# wasm-opt (binaryen; `cargo install wasm-opt` puts it in ~/.cargo/bin)
# takes the committed binary from 846 KB to 737 KB (272 KB gzipped).
export PATH="$HOME/.cargo/bin:$PATH"
if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -O3 -o ../web/public/core/lotstretcher_core_bg.wasm ../web/public/core/lotstretcher_core_bg.wasm
  if [ -f ../web/public/core-threads/lotstretcher_core_bg.wasm ]; then
    wasm-opt -O3 --enable-threads --enable-bulk-memory --enable-simd \
      -o ../web/public/core-threads/lotstretcher_core_bg.wasm ../web/public/core-threads/lotstretcher_core_bg.wasm
  fi
fi
ls -la ../web/public/core/ ../web/public/core-threads/ 2>/dev/null
