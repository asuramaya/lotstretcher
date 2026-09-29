//! What a VIN says on its own, decoded from the spec's `vin` tables with
//! no database and no call to anyone: whether it is well formed (the
//! check digit), the model year, the manufacturer (the first three
//! characters) and the country. Model and trim are encoded per
//! manufacturer and are not here; a listing address carries them in its
//! slug, which `from_url` reads.
//!
//! This replaces lotstretcher/vin.py and web/public/js/pipeline/vin.js,
//! which were one algorithm written twice; both are hosts over this now
//! (ops `vin_decode` and `vin_record`).

use crate::spec;
use serde::Serialize;
use serde_json::Value;

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Decoded {
    pub vin: String,
    pub valid: bool,
    pub year: Option<i64>,
    pub make: Option<String>,
    pub country: Option<String>,
    pub warnings: Vec<String>,
    /// One manufacturer code, several brands: the address's slug decides.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub makes: Option<Vec<String>>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Record {
    pub url: Option<String>,
    pub vin: Option<String>,
    pub year: Option<i64>,
    pub make: Option<String>,
    pub model: Option<String>,
    pub trim: Option<String>,
    pub warnings: Vec<String>,
    pub photo_urls: Vec<String>,
    pub video_urls: Vec<String>,
    pub pricing_rows: Vec<Value>,
    pub title: Option<String>,
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Slug {
    pub year: Option<i64>,
    pub make: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct FromUrl {
    pub vin: Option<String>,
    pub slug: Option<String>,
    pub fields: Slug,
}

/// Upper case, I/O/Q read as 1/0/0 (a VIN never holds them), anything
/// that is not a letter or digit dropped.
pub fn normalize(text: &str) -> String {
    text.to_uppercase()
        .chars()
        .map(|c| match c { 'O' | 'Q' => '0', 'I' => '1', c => c })
        .filter(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
        .collect()
}

/// The character position 9 should hold, or None when a character is
/// not a VIN character.
pub fn check_digit(vin: &str) -> Option<char> {
    let table = spec::get(&["vin", "transliteration"]);
    let weights = spec::get(&["vin", "weights"]).as_array().expect("vin.weights");
    let mut total = 0i64;
    for (ch, w) in vin.chars().zip(weights) {
        let v = if let Some(d) = ch.to_digit(10) {
            d as i64
        } else {
            table.get(ch.to_string())?.as_i64()?
        };
        total += v * w.as_i64().unwrap_or(0);
    }
    let r = total % 11;
    Some(if r == 10 { 'X' } else { char::from_digit(r as u32, 10).unwrap() })
}

/// Position 10 names the year in a 30-year cycle; position 7 says which
/// cycle for North American VINs (a letter there means 2010 on).
pub fn model_year(vin: &[char]) -> Option<i64> {
    let codes = spec::get(&["vin", "yearCodes"]).as_str().expect("vin.yearCodes");
    let start = spec::f64_at(&["vin", "yearCycleStart"]) as i64;
    let i = codes.chars().position(|c| c == vin[9])? as i64;
    let mut year = start + i;
    if vin[6].is_alphabetic() || !"12345".contains(vin[0]) {
        year += 30;
    }
    Some(year)
}

/// A VIN that fails the check digit is still returned, flagged, since a
/// typo is the common case and the year and make may still be right.
pub fn decode(text: &str) -> Decoded {
    let vin = normalize(text);
    let chars: Vec<char> = vin.chars().collect();
    let mut out = Decoded { vin: vin.clone(), valid: false, year: None, make: None, country: None, warnings: vec![], makes: None };
    if chars.len() != 17 {
        out.warnings.push(format!("A VIN has 17 characters; this has {}.", chars.len()));
        return out;
    }
    let expected = match check_digit(&vin) {
        Some(c) => c,
        None => {
            out.warnings.push("That is not a VIN: it holds a character a VIN cannot.".into());
            return out;
        }
    };
    out.valid = expected == chars[8];
    if !out.valid {
        out.warnings.push("The VIN's check digit does not match; one character is probably mistyped.".into());
    }
    out.year = model_year(&chars);
    let wmi: String = chars[..3].iter().collect();
    out.country = spec::get(&["vin", "countries"]).get(chars[0].to_string()).and_then(|v| v.as_str()).map(String::from);
    match spec::get(&["vin", "wmi"]).get(&wmi) {
        None | Some(Value::Null) => out.warnings.push(format!("The manufacturer code {wmi} is not one the app knows; type the make.")),
        Some(Value::Array(list)) => {
            let makes: Vec<String> = list.iter().filter_map(|m| m.as_str().map(String::from)).collect();
            out.warnings.push(format!("That manufacturer code is {}; pick the make.", makes.join(" or ")));
            out.makes = Some(makes);
        }
        Some(v) => out.make = v.as_str().map(String::from),
    }
    out
}

fn is_vin_shaped(s: &str) -> bool {
    s.chars().count() == 17
        && s.chars().all(|c| c.is_ascii_digit() || (c.is_ascii_uppercase() && !matches!(c, 'I' | 'O' | 'Q')))
}

fn is_word(c: char) -> bool { c.is_alphanumeric() || c == '_' }

/// `\b(19|20)\d\d\b`: a year standing as its own word.
fn has_year_word(s: &str) -> bool {
    let c: Vec<char> = s.chars().collect();
    (0..c.len().saturating_sub(3)).any(|i| {
        ((c[i] == '1' && c[i + 1] == '9') || (c[i] == '2' && c[i + 1] == '0'))
            && c[i + 2].is_ascii_digit() && c[i + 3].is_ascii_digit()
            && (i == 0 || !is_word(c[i - 1]))
            && (i + 4 == c.len() || !is_word(c[i + 4]))
    })
}

fn is_year(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 4 && (b.starts_with(b"19") || b.starts_with(b"20")) && b[2].is_ascii_digit() && b[3].is_ascii_digit()
}

/// %XX sequences decoded; a malformed one is kept as written.
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = |c: u8| (c as char).to_digit(16);
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The path of an absolute address: after the host, before any query
/// or fragment.
fn url_path(url: &str) -> String {
    let rest = match url.find("://") { Some(i) => &url[i + 3..], None => return String::new() };
    let rest = &rest[..rest.find(['?', '#']).unwrap_or(rest.len())];
    match rest.find('/') { Some(i) => percent_decode(&rest[i..]), None => String::new() }
}

/// A listing address read on the device: the VIN in its path and the
/// year-make-model words of its slug.
pub fn from_url(url: &str) -> FromUrl {
    let mut out = FromUrl::default();
    let path = url_path(url);
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    for (i, part) in parts.iter().enumerate() {
        let up = part.to_uppercase();
        if is_vin_shaped(&up) && check_digit(&up).is_some() {
            out.vin = Some(up);
            out.slug = parts.get(i + 1).map(|s| s.to_string());
            break;
        }
    }
    if out.slug.is_none() {
        // No VIN segment: the last path word with a year in it.
        out.slug = parts.iter().rev().find(|p| has_year_word(&p.replace('-', " "))).map(|s| s.to_string());
    }
    if let Some(slug) = &out.slug {
        out.fields = parse_slug(slug);
    }
    out
}

const CONDITION_WORDS: [&str; 7] = ["new", "used", "certified", "pre", "owned", "preowned", "cpo"];

fn capitalize(w: &str) -> String {
    let mut c = w.chars();
    match c.next() {
        Some(f) => f.to_uppercase().chain(c.flat_map(char::to_lowercase)).collect(),
        None => String::new(),
    }
}

/// year, make, model from a slug like Used-2024-Ford-F--250SD-Tomball-TX:
/// a doubled dash is a literal hyphen in a name, a leading condition word
/// is skipped, and the city before a two-letter state is dropped.
pub fn parse_slug(slug: &str) -> Slug {
    let mut words: Vec<String> = slug.replace("--", "\0").split('-').filter(|w| !w.is_empty())
        .map(|w| w.replace('\0', "-").replace('_', " ")).collect();
    while words.first().is_some_and(|w| CONDITION_WORDS.contains(&w.to_lowercase().as_str())) {
        words.remove(0);
    }
    let mut out = Slug::default();
    if words.first().is_some_and(|w| is_year(w)) {
        out.year = words.remove(0).parse().ok();
    }
    if words.is_empty() {
        return out;
    }
    let make = &words[0];
    out.make = Some(if make.chars().count() > 3 { capitalize(make) } else { make.to_uppercase() });
    let mut rest = &words[1..];
    // A dealer's slug ends in its city and state: drop both when the last
    // word is a state code (a two-letter model such as NX sits earlier).
    if rest.len() >= 3 {
        let last = &rest[rest.len() - 1];
        if last.len() == 2 && last.chars().all(|c| c.is_ascii_alphabetic()) {
            rest = &rest[..rest.len() - 2];
        }
    }
    if !rest.is_empty() {
        // An all-lower-case word is capitalised.
        out.model = Some(rest.iter().map(|w| {
            if w.chars().any(char::is_lowercase) && !w.chars().any(char::is_uppercase) { capitalize(w) } else { w.clone() }
        }).collect::<Vec<_>>().join(" "));
    }
    out
}

/// What the app fills from a pasted address or VIN, in the
/// scrape.Vehicle shape: the decoded VIN plus the slug's words. Nothing
/// is fetched.
pub fn record_from_text(text: &str) -> Record {
    let text = text.trim();
    let lower: String = text.chars().take(8).collect::<String>().to_lowercase();
    let is_url = lower.starts_with("http://") || lower.starts_with("https://");
    let u = if is_url { from_url(text) } else { FromUrl::default() };
    let d = if u.vin.is_some() || !is_url { Some(decode(u.vin.as_deref().unwrap_or(text))) } else { None };
    let nonempty = |s: &Option<String>| s.clone().filter(|s| !s.is_empty());
    let mut v = Record {
        url: if is_url { Some(text.to_string()) } else { None },
        vin: d.as_ref().filter(|d| d.vin.chars().count() == 17).map(|d| d.vin.clone()),
        year: u.fields.year.filter(|y| *y != 0).or_else(|| d.as_ref().and_then(|d| d.year)),
        make: nonempty(&u.fields.make).or_else(|| d.as_ref().and_then(|d| d.make.clone())),
        model: u.fields.model.clone(),
        trim: None, warnings: vec![], photo_urls: vec![], video_urls: vec![], pricing_rows: vec![], title: None,
    };
    if let Some(d) = &d {
        v.warnings.extend(d.warnings.iter().cloned());
        if let (Some(dm), Some(um)) = (&d.make, nonempty(&u.fields.make)) {
            if dm.to_lowercase() != um.to_lowercase() {
                v.warnings.push(format!("The VIN says {dm}; the address says {um}."));
            }
        }
    }
    if is_url && u.vin.is_none() {
        v.warnings.push("No VIN in that address; only what its words say was read.".into());
    }
    let words: Vec<String> = [v.year.map(|y| y.to_string()), v.make.clone(), v.model.clone()]
        .into_iter().flatten().filter(|s| !s.is_empty()).collect();
    v.title = if words.is_empty() { None } else { Some(words.join(" ")) };
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_year_make_and_the_check_digit() {
        let d = decode("3FTTW8HA3TRB41981");
        assert!(d.valid && d.year == Some(2026) && d.make.as_deref() == Some("Ford") && d.country.as_deref() == Some("Mexico"));
        assert!(d.warnings.is_empty());
        let typo = decode("3FTTW8HA4TRB41981");
        assert!(!typo.valid && typo.warnings[0].contains("check digit") && typo.year == Some(2026));
        assert_eq!(decode("2C3CDXBG5NH123456").makes, Some(vec!["Chrysler".to_string(), "Dodge".to_string()]));
        assert_eq!(normalize("3ftt w8ha3trb41981"), "3FTTW8HA3TRB41981");
    }

    #[test]
    fn the_address_gives_year_make_model_and_vin() {
        let r = record_from_text("https://www.tomballford.com/vehicle/1FT8W2BT2REC59903/Used-2024-Ford-F--250SD-Tomball-TX/");
        assert_eq!(r.vin.as_deref(), Some("1FT8W2BT2REC59903"));
        assert_eq!(r.title.as_deref(), Some("2024 Ford F-250SD"));
        let r = record_from_text("https://dealer.example/inventory/new-2025-honda-civic-sport-houston-tx/");
        assert_eq!(r.model.as_deref(), Some("Civic Sport"));
        assert!(r.vin.is_none());
        assert!(record_from_text("https://dealer.example/used/").title.is_none());
    }
}
