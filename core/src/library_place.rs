//! Where a vehicle lives in a listings library: its bucket (new or used)
//! and its folder's name, for every host that writes one. The CLI's
//! vehicle_pipeline files a scrape there, and the browser saves a run to
//! the same place, so the Library pane, `recompose` and a re-run find one
//! folder per vehicle whoever made it.
//!
//! This is scrape.py's condition_bucket and vehicle_folder_name, which
//! tests/test_library_place.py holds it to on every record in the
//! operator's library and on accented names.

use serde_json::{json, Value};

/// A field as text: a string as it is, a number as it prints, else "".
fn text(record: &Value, key: &str) -> String {
    match record.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

/// "new" or "used". The scraped condition when there is one (anything
/// but new is used: certified is used with a warranty); else the address,
/// whose path says "Used-" on a used vehicle; else used, since filing a
/// used vehicle as new is the error that puts factory-warranty words on
/// its post.
pub fn bucket(record: &Value, url: &str) -> &'static str {
    let condition = text(record, "condition").trim().to_lowercase();
    if !condition.is_empty() {
        return if condition == "new" { "new" } else { "used" };
    }
    if !url.is_empty() {
        return if url.to_lowercase().contains("used") { "used" } else { "new" };
    }
    "used"
}

/// The ASCII letter an accented Latin letter is written with (what NFKD
/// then dropping the marks gives), or None to drop the character.
fn fold(c: char) -> Option<char> {
    if c.is_ascii() {
        return Some(c);
    }
    let base = match c {
        'À'..='Å' => 'A', 'à'..='å' => 'a', 'Ç' => 'C', 'ç' => 'c',
        'È'..='Ë' => 'E', 'è'..='ë' => 'e', 'Ì'..='Ï' => 'I', 'ì'..='ï' => 'i',
        'Ñ' => 'N', 'ñ' => 'n', 'Ò'..='Ö' => 'O', 'ò'..='ö' => 'o',
        'Ù'..='Ü' => 'U', 'ù'..='ü' => 'u', 'Ý' => 'Y', 'ý' | 'ÿ' => 'y',
        'Š' => 'S', 'š' => 's', 'Ž' => 'Z', 'ž' => 'z',
        _ => return None,
    };
    Some(base)
}

/// scrape.py's slugify: the parts joined by "-", folded to ASCII, kept to
/// word characters, spaces and dashes, runs of space or "_" made one "-",
/// dashes trimmed from the ends, cut to `maxlen`, "vehicle" if empty.
pub fn slugify(parts: &[String], maxlen: usize) -> String {
    let joined = parts.iter().filter(|p| !p.is_empty()).cloned().collect::<Vec<_>>().join("-");
    let kept: String = joined.chars().filter_map(fold)
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-' || c.is_ascii_whitespace() || *c == '\x0b')
        .collect();
    let mut out = String::new();
    let mut run = false;
    for c in kept.chars() {
        if c.is_ascii_whitespace() || c == '\x0b' || c == '_' {
            if !run { out.push('-'); }
            run = true;
        } else {
            out.push(c);
            run = false;
        }
    }
    let trimmed: String = out.trim_matches('-').chars().take(maxlen).collect();
    if trimmed.is_empty() { "vehicle".into() } else { trimmed }
}

/// The folder: year, make, model, trim and the last eight characters of
/// the stock number (else the VIN, else "unknown").
pub fn folder(record: &Value) -> String {
    let id = [text(record, "stock_number"), text(record, "vin")].into_iter().find(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".into());
    let chars: Vec<char> = id.chars().collect();
    let tail: String = chars[chars.len().saturating_sub(8)..].iter().collect();
    slugify(&[text(record, "year"), text(record, "make"), text(record, "model"), text(record, "trim"), tail], 80)
}

/// {bucket, folder} for a record and the address it came from.
pub fn place(record: &Value, url: &str) -> Value {
    json!({ "bucket": bucket(record, url), "folder": folder(record) })
}
