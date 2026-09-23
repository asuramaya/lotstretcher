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
RUSTFLAGS="-C target-feature=+simd128" cargo build --release --target wasm32-unknown-unknown --features wasm
wasm-bindgen --target web --out-dir ../web/public/core --out-name lotstretcher_core \
  target/wasm32-unknown-unknown/release/lotstretcher_core.wasm
# wasm-opt (binaryen; `cargo install wasm-opt` puts it in ~/.cargo/bin)
# takes the committed binary from 846 KB to 737 KB (272 KB gzipped).
export PATH="$HOME/.cargo/bin:$PATH"
if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -O3 -o ../web/public/core/lotstretcher_core_bg.wasm ../web/public/core/lotstretcher_core_bg.wasm
fi
ls -la ../web/public/core/
