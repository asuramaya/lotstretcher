//! Row parallelism, behind the `threads` feature. Every hot loop in the
//! core is a loop over rows that touch only their own row, so they run
//! across a thread pool when there is one (rayon natively, rayon over
//! web workers in the threaded wasm build) and sequentially when there
//! is not. The arithmetic is per row either way, so the output is
//! byte-identical with and without threads, which the parity tests
//! hold to.

/// Call `f(row_index, row)` for every `row_len`-sized chunk of `data`.
pub fn rows_mut<T: Send, F: Fn(usize, &mut [T]) + Sync>(data: &mut [T], row_len: usize, f: F) {
    if row_len == 0 { return; }
    #[cfg(feature = "threads")]
    {
        use rayon::prelude::*;
        data.par_chunks_mut(row_len).enumerate().for_each(|(y, row)| f(y, row));
    }
    #[cfg(not(feature = "threads"))]
    {
        for (y, row) in data.chunks_mut(row_len).enumerate() { f(y, row); }
    }
}
