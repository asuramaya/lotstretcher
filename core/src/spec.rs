//! shared/pipeline-spec.json, embedded at build time.
//!
//! The spec is the single source of truth for constants on both
//! surfaces. Embedding it (rather than reading it at runtime) is what
//! makes the wasm build self-contained and keeps a stale copy from
//! drifting: the crate is rebuilt from the same file the Python and the
//! JavaScript read.

use serde_json::Value;
use std::sync::OnceLock;

const SPEC_JSON: &str = include_str!("../../shared/pipeline-spec.json");

pub fn spec() -> &'static Value {
    static SPEC: OnceLock<Value> = OnceLock::new();
    SPEC.get_or_init(|| serde_json::from_str(SPEC_JSON).expect("shared/pipeline-spec.json is valid JSON"))
}

pub fn get<'a>(path: &[&str]) -> &'a Value {
    let mut node = spec();
    for key in path {
        node = node.get(key).unwrap_or_else(|| panic!("pipeline spec is missing {}", path.join(".")));
    }
    node
}

pub fn f64_at(path: &[&str]) -> f64 {
    get(path).as_f64().unwrap_or_else(|| panic!("{} is not a number", path.join(".")))
}

pub fn rgb_at(path: &[&str]) -> [u8; 3] {
    let arr = get(path).as_array().expect("rgb triple");
    [arr[0].as_u64().unwrap() as u8, arr[1].as_u64().unwrap() as u8, arr[2].as_u64().unwrap() as u8]
}

/// {name: [r,g,b]} maps such as palette.colorWords and glow.colors.
pub fn rgb_map(path: &[&str]) -> Vec<(String, [u8; 3])> {
    let obj = get(path).as_object().expect("object of rgb triples");
    obj.iter()
        .map(|(k, v)| {
            let a = v.as_array().expect("rgb triple");
            (k.clone(), [a[0].as_u64().unwrap() as u8, a[1].as_u64().unwrap() as u8, a[2].as_u64().unwrap() as u8])
        })
        .collect()
}
