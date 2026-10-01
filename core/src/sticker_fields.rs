//! A parsed window sticker as the vehicle's own fields, for both hosts:
//! the year, model, colours, engine and transmission the browser fills
//! its form with and the CLI fills a blank listing field with, and the
//! sticker's total as the MSRP. Colours, engine and transmission are set
//! the way a person writes them: title case with trims, drivetrains and
//! units kept as letters ("XLT", "4X4", "2.0L", "480HP"), and the
//! sticker's abbreviations spelled out ("Met" -> "Metallic").
//!
//! This replaces web/public/js/pipeline/sticker.js's displayCase and its
//! flattening, which only the browser had; tests/test_sticker_fields.py
//! holds it to what that code returned on every real sticker in the
//! operator's library.

use crate::listing::truthy;
use serde_json::{Map, Value};

/// Trim levels, drivetrains and the like are acronyms, not words: plain
/// title case turns "XLT FWD" into "Xlt Fwd", which reads as a typo.
const ACRONYMS: &[&str] = &[
    "XL", "XLT", "SE", "SEL", "LT", "LS", "LTZ", "RST", "ST", "GT", "SS", "SR", "SR5",
    "EX", "LX", "DX", "SV", "SL", "S", "RS", "GLS", "GLE", "TRD", "ZR2", "Z71", "SLE",
    "SLT", "XSE", "XLE", "FWD", "AWD", "RWD", "4WD", "2WD", "4X4", "4X2",
    "V6", "V8", "V10", "TDI", "GTI", "ABS", "LED", "USB", "AM/FM", "MSRP", "VIN",
    "MPG", "EPA", "SYNC", "AC", "A/C", "PHEV", "EV", "SUV",
    "TI-VCT", "VCT", "GTDI", "FHEV", "HEV", "PFDI", "HP", "DOHC",
];

/// Whole words the sticker abbreviates, spelled out (first one only).
const EXPANSIONS: &[(&str, &str)] = &[
    ("siriusxm", "SiriusXM"), ("ecoboost", "EcoBoost"), ("alum", "Aluminum"), ("incl", "Included"),
    ("conn", "Connected"),
];
const LATER: &[(&str, &str)] = &[
    ("tc", "Tri-Coat"), ("met", "Metallic"), ("metalic", "Metallic"), ("pkg", "Package"),
    ("trans", "Transmission"), ("powerboost", "PowerBoost"),
];

fn is_word(c: char) -> bool { c.is_ascii_alphanumeric() || c == '_' }

/// A word boundary between `chars[i - 1]` and `chars[i]`.
fn boundary(chars: &[char], i: usize) -> bool {
    let before = i > 0 && is_word(chars[i - 1]);
    let after = i < chars.len() && is_word(chars[i]);
    before != after
}

fn title_case(s: &str) -> Vec<char> {
    let mut c: Vec<char> = s.to_lowercase().chars().collect();
    let n = c.len();
    for i in 0..n {
        if c[i].is_ascii_lowercase() && (i == 0 || !is_word(c[i - 1])) { c[i] = c[i].to_ascii_uppercase(); }
    }
    // A letter straight after a digit is a unit, not a new word: "2.0L".
    let mut i = 0;
    while i + 1 < n {
        if c[i].is_ascii_digit() && c[i + 1].is_ascii_lowercase() && (i + 2 == n || !is_word(c[i + 2])) {
            c[i + 1] = c[i + 1].to_ascii_uppercase();
            i += 2;
        } else { i += 1; }
    }
    // "480hp" -> "480HP".
    let mut i = 0;
    while i + 2 < n {
        if c[i].is_ascii_digit() && c[i + 1].eq_ignore_ascii_case(&'h') && c[i + 2].eq_ignore_ascii_case(&'p') && boundary(&c, i + 3) {
            c[i + 1] = 'H'; c[i + 2] = 'P';
            i += 3;
        } else { i += 1; }
    }
    // Anything that is an acronym rather than a word, back in capitals.
    let mut i = 0;
    while i < n {
        if c[i].is_ascii_alphabetic() && boundary(&c, i) {
            let mut j = i + 1;
            while j < n && (c[j].is_ascii_alphanumeric() || c[j] == '/') { j += 1; }
            let mut e = j;
            while e > i + 1 && !boundary(&c, e) { e -= 1; }
            let word: String = c[i..e].iter().collect::<String>().to_ascii_uppercase();
            if ACRONYMS.contains(&word.as_str()) {
                for (k, ch) in word.chars().enumerate() { c[i + k] = ch; }
            }
            i = e;
        } else { i += 1; }
    }
    c
}

/// The first whole-word `word` (any case) in `c`, replaced.
fn expand_word(c: &mut Vec<char>, word: &str, to: &str) {
    let w: Vec<char> = word.chars().collect();
    for i in 0..c.len() {
        if i + w.len() <= c.len() && boundary(c, i) && boundary(c, i + w.len())
            && c[i..i + w.len()].iter().zip(&w).all(|(a, b)| a.to_ascii_lowercase() == *b) {
            c.splice(i..i + w.len(), to.chars());
            return;
        }
    }
}

/// "Tri Coat", "Tri-Coat", "tri - coat": the first, as "Tri-Coat".
fn expand_tri_coat(c: &mut Vec<char>) {
    let lower: Vec<char> = c.iter().map(|ch| ch.to_ascii_lowercase()).collect();
    for i in 0..c.len() {
        if !boundary(c, i) || !lower[i..].starts_with(&['t', 'r', 'i']) { continue; }
        let mut j = i + 3;
        while j < c.len() && c[j].is_whitespace() { j += 1; }
        if j < c.len() && c[j] == '-' { j += 1; }
        while j < c.len() && c[j].is_whitespace() { j += 1; }
        if lower[j..].starts_with(&['c', 'o', 'a', 't']) && boundary(c, j + 4) {
            c.splice(i..j + 4, "Tri-Coat".chars());
            return;
        }
    }
}

/// The first "W/" at a word's start, as "With" and one space.
fn expand_with(c: &mut Vec<char>) {
    for i in 0..c.len().saturating_sub(1) {
        if boundary(c, i) && c[i].eq_ignore_ascii_case(&'w') && c[i + 1] == '/' {
            let spaced = c.get(i + 2).is_some_and(|ch| ch.is_whitespace());
            c.splice(i..i + 2, if spaced { "With".chars() } else { "With ".chars() });
            return;
        }
    }
}

/// A sticker's words as a person would write them in a post.
pub fn display_case(s: &str) -> String {
    let mut c = title_case(s);
    for (w, to) in EXPANSIONS { expand_word(&mut c, w, to); }
    expand_tri_coat(&mut c);
    for (w, to) in LATER { expand_word(&mut c, w, to); }
    expand_with(&mut c);
    c.into_iter().collect()
}

fn text(v: &Value) -> String {
    match v { Value::String(s) => s.clone(), Value::Null => String::new(), other => other.to_string() }
}

/// The parse_sticker record as {fields, vehicle}: `fields` every flat
/// fact the sticker states, `vehicle` the form's fields (year, model,
/// trim, colours, VIN, the MSRP as a bare number).
pub fn sticker_fields(rec: &Value) -> Value {
    let o = rec.get("overview").cloned().unwrap_or(Value::Null);
    let get = |k: &str| o.get(k).filter(|v| truthy(v)).cloned();
    let mut f = Map::new();
    // The make is found in the page furniture, not the overview.
    if let Some(m) = rec.get("make").filter(|v| truthy(v)) { f.insert("make".into(), m.clone()); }
    if let Some(v) = get("vin") { f.insert("vin".into(), v); }
    if !truthy(rec.get("placeholder").unwrap_or(&Value::Null)) {
        if let Some(line) = get("model_line") {
            f.insert("model_line".into(), line.clone());
            f.insert("model".into(), get("model_name").unwrap_or(line));
        }
        if let Some(v) = get("trim_drivetrain") { f.insert("trim_drivetrain".into(), v); }
        if let Some(v) = get("seating_capacity") { f.insert("seating".into(), v); }
        for (from, to) in [("engine", "engine"), ("transmission", "transmission")] {
            if let Some(v) = get(from) { f.insert(to.into(), Value::String(display_case(&text(&v)))); }
        }
        for (from, to) in [("exterior_color", "exterior_color"), ("interior_trim", "interior_color"), ("trim", "trim"),
                           ("body_style", "body_style"), ("drivetrain", "drivetrain")] {
            if let Some(v) = get(from) { f.insert(to.into(), v); }
        }
        let pricing = rec.get("pricing").cloned().unwrap_or(Value::Null);
        let msrp = ["total_msrp", "base_price"].iter().find_map(|k| pricing.get(*k).filter(|v| truthy(v)).cloned());
        f.insert("msrp".into(), msrp.unwrap_or(Value::Null));
        let year = f.get("trim_drivetrain").map(text).and_then(|t| t.split_whitespace().next().map(str::to_string))
            .filter(|y| y.len() == 4 && y.chars().all(|c| c.is_ascii_digit()));
        if let Some(y) = year { f.insert("year".into(), Value::String(y)); }
    }
    let mut v = Map::new();
    for key in ["year", "make", "model", "trim", "exterior_color", "interior_color", "vin", "msrp"] {
        let Some(val) = f.get(key).filter(|x| truthy(x)) else { continue };
        let s = text(val);
        let out = if key.ends_with("_color") { display_case(&s) }
            else if key == "msrp" { let t = s.strip_prefix('$').unwrap_or(&s).replace(',', ""); t.strip_suffix(".00").map(str::to_string).unwrap_or(t) }
            else { s.strip_prefix('$').unwrap_or(&s).replace(',', "") };
        v.insert(key.into(), Value::String(out));
    }
    let mut out = Map::new();
    out.insert("fields".into(), Value::Object(f));
    out.insert("vehicle".into(), Value::Object(v));
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_person_writes_the_units_and_the_trims_as_letters() {
        assert_eq!(display_case("2.0l ecoboost i-4 engine"), "2.0L EcoBoost I-4 Engine");
        assert_eq!(display_case("480hp 5.0l v8"), "480HP 5.0L V8");
        assert_eq!(display_case("AZURE GRAY MET TRI-COAT"), "Azure Gray Metallic Tri-Coat");
        assert_eq!(display_case("ebony actvx w/ miko suede"), "Ebony Actvx With Miko Suede");
        assert_eq!(display_case("a/c am/fm sync 4"), "A/C AM/FM SYNC 4");
    }
}
