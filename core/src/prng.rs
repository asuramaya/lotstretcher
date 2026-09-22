//! A seeded generator, the same on every surface.
//!
//! The Python used random.Random(seed) (Mersenne Twister over Python's
//! own hash of the seed) and the browser used mulberry32 over an FNV
//! hash: two valid streams that never agreed, which is why "the same
//! vehicle produces the same backdrop on both surfaces" was never true.
//! One generator here, seeded from the string's FNV-1a 64 hash, is the
//! whole fix. Existing backdrops built by the old Python stream will be
//! regenerated differently on the next rerun; that is a new valid
//! backdrop, not a regression.

pub struct Rng(u64);

impl Rng {
    pub fn from_seed(seed: &str) -> Self {
        let mut h: u64 = 0xcbf29ce484222325;
        for b in seed.as_bytes() {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        Rng(h)
    }

    /// splitmix64: small, fast, and identical in every language.
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^ (z >> 31)
    }

    /// Uniform in [0, 1), 53 bits of precision.
    pub fn random(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    pub fn uniform(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.random()
    }

    pub fn choice(&mut self, n: usize) -> usize {
        ((self.random() * n as f64) as usize).min(n - 1)
    }
}
