//! A vehicle page's HTML read into the record the CLI's `Vehicle`
//! dataclass holds: the analytics blob Jazel (FordDirect's dealer platform) embeds, the
//! schema.org Car node, and the Carfax widget's link.
//!
//! This replaces scrape.py::normalize_vehicle's body and the browser's
//! port of it in pipeline/listing.js. The CLI still fetches the page
//! (a headless browser, past the bot challenge) and keeps its extractor
//! registry, since a registered CMS's validator is Python; it hands the
//! blob it found in. The browser reads a saved page and lets the core find
//! the Jazel blob itself. Python's truthiness is the rule
//! throughout (an empty list or object counts as missing), since the
//! CLI's scraper is what the library was built with.

use serde::Deserialize;
use serde_json::{json, Map, Value};

#[derive(Deserialize)]
pub struct ListingRequest {
    pub html: String,
    #[serde(default)]
    pub url: Option<String>,
    /// The analytics object a host already extracted (the CLI's registry).
    /// Absent: the core looks for the Jazel marker itself.
    #[serde(default)]
    pub analytics: Option<Value>,
    #[serde(default = "yes")]
    pub extract: bool,
}

fn yes() -> bool { true }

// ---------- Python's rules ---------------------------------------------

pub(crate) fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// `a or b`.
fn or(a: Value, b: Value) -> Value { if truthy(&a) { a } else { b } }

/// dict.get(key), None for a missing key or a non-dict.
fn get(d: &Value, key: &str) -> Value { d.get(key).cloned().unwrap_or(Value::Null) }

/// scrape.g: a nested get that stops at anything that is not a dict.
fn g(d: &Value, path: &[&str]) -> Value {
    let mut cur = d;
    for key in path {
        match cur {
            Value::Object(o) => match o.get(*key) { Some(v) => cur = v, None => return Value::Null },
            _ => return Value::Null,
        }
    }
    cur.clone()
}

/// str(value), as Python prints it.
fn py_str(v: &Value) -> String {
    match v {
        Value::Null => "None".into(),
        Value::Bool(b) => if *b { "True".into() } else { "False".into() },
        Value::String(s) => s.clone(),
        Value::Number(n) => {
            if n.is_f64() {
                let f = n.as_f64().unwrap();
                if f.fract() == 0.0 && f.abs() < 1e16 { format!("{f:.1}") } else { format!("{f}") }
            } else {
                n.to_string()
            }
        }
        other => other.to_string(),
    }
}

/// scrape._nonzero: present and not a zero number or numeric string
/// ("0" is several dealer.com fields' "not set").
fn nonzero(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::String(s) if s.is_empty() => false,
        Value::String(s) => s.trim().parse::<f64>().map(|f| f != 0.0).unwrap_or(true),
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::Bool(b) => *b,
        _ => true,
    }
}

/// lo == hi, where 28 == 28.0 as in Python.
fn py_eq(a: &Value, b: &Value) -> bool {
    match (a.as_f64(), b.as_f64()) {
        (Some(x), Some(y)) if a.is_number() && b.is_number() => x == y,
        _ => a == b,
    }
}

// ---------- reading the page -------------------------------------------

/// The JSON object embedded at `marker`, by matching balanced braces
/// from the first '{' after it (regex cannot match nested JSON).
pub fn extract_balanced_json(text: &str, marker: &str) -> Option<Value> {
    let at = text.find(marker)?;
    let b = text.as_bytes();
    let start = at + marker.len() + b[at + marker.len()..].iter().position(|&c| c == b'{')?;
    let (mut depth, mut in_str, mut esc) = (0i64, false, false);
    let mut end = b.len();
    for (i, &c) in b.iter().enumerate().skip(start) {
        if in_str {
            if esc { esc = false } else if c == b'\\' { esc = true } else if c == b'"' { in_str = false }
            continue;
        }
        match c {
            b'"' => in_str = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 { end = i + 1; break; }
            }
            _ => {}
        }
    }
    serde_json::from_str(&text[start..end]).ok()
}

/// The first schema.org Car node in the page's ld+json scripts.
fn ldjson_car(html: &str) -> Value {
    const OPEN: &str = "<script type=\"application/ld+json\"";
    let mut from = 0;
    while let Some(i) = html[from..].find(OPEN) {
        let tag = from + i;
        let Some(gt) = html[tag..].find('>') else { break };
        let body = tag + gt + 1;
        let Some(close) = html[body..].find("</script>") else { break };
        from = body + close;
        let Ok(data) = serde_json::from_str::<Value>(&html[body..body + close]) else { continue };
        let graph = match &data {
            Value::Object(o) => o.get("@graph").cloned().unwrap_or_else(|| Value::Array(vec![data.clone()])),
            Value::Array(_) => data.clone(),
            _ => continue,
        };
        if let Value::Array(nodes) = graph {
            if let Some(car) = nodes.into_iter().find(|n| n.get("@type").and_then(Value::as_str) == Some("Car")) {
                return car;
            }
        }
    }
    Value::Null
}

/// The Carfax report link from the page's `.carfax-logo` widget. The
/// blob's certifications.carfaxUrl is unreliable (null on a CPO Raptor
/// with a working Carfax badge); the widget's own link is the signal, and
/// it only exists once the CLI's fetch has waited for `.carfax-logo a`.
fn carfax_url(html: &str) -> Value {
    const CLASS: &str = "class=\"carfax-logo\"";
    let mut from = 0;
    while let Some(i) = html[from..].find(CLASS) {
        let at = from + i + CLASS.len();
        from = at;
        let Some(gt) = html[at..].find('>') else { break };
        let rest = html[at + gt + 1..].trim_start();
        if let Some(href) = rest.strip_prefix("<a href=\"") {
            if let Some(q) = href.find('"') {
                if q > 0 {
                    return Value::String(href[..q].to_string());
                }
            }
        }
    }
    Value::Null
}

/// The page's own address, for a saved copy handed in without one: the
/// canonical link, else og:url.
fn page_url(html: &str) -> Option<String> {
    let attr = |tag: &str, name: &str| -> Option<String> {
        let at = tag.find(&format!("{name}="))? + name.len() + 1;
        let q = tag[at..].chars().next()?;
        if q != '"' && q != '\'' { return None; }
        let v = &tag[at + 1..];
        Some(v[..v.find(q)?].to_string())
    };
    let tags = |name: &str| -> Vec<&str> {
        let open = format!("<{name}");
        let mut out = vec![];
        let mut from = 0;
        while let Some(i) = html[from..].find(&open) {
            let s = from + i;
            let e = html[s..].find('>').map(|e| s + e).unwrap_or(html.len());
            out.push(&html[s..e]);
            from = e;
        }
        out
    };
    tags("link").into_iter().find(|t| attr(t, "rel").as_deref() == Some("canonical")).and_then(|t| attr(t, "href"))
        .or_else(|| tags("meta").into_iter().find(|t| attr(t, "property").as_deref() == Some("og:url")).and_then(|t| attr(t, "content")))
}

// ---------- text ---------------------------------------------------------

fn named_entity(name: &str) -> Option<&'static str> {
    crate::entities::NAMED.binary_search_by(|(k, _)| (*k).cmp(name)).ok().map(|i| crate::entities::NAMED[i].1)
}

/// html.unescape, rule for rule: numeric references (with the HTML5
/// replacements for the C1 range and the dropped code points), named
/// ones from the HTML5 table, the longest known prefix of an unknown
/// name, anything else left as written.
pub fn unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let c: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < c.len() {
        if c[i] != '&' {
            out.push(c[i]);
            i += 1;
            continue;
        }
        let j = i + 1;
        if j < c.len() && c[j] == '#' {
            let hex = j + 1 < c.len() && (c[j + 1] == 'x' || c[j + 1] == 'X');
            let ds = if hex { j + 2 } else { j + 1 };
            let mut k = ds;
            while k < c.len() && if hex { c[k].is_ascii_hexdigit() } else { c[k].is_ascii_digit() } { k += 1; }
            if k > ds {
                let digits: String = c[ds..k].iter().collect();
                let num = u128::from_str_radix(&digits, if hex { 16 } else { 10 }).unwrap_or(u128::MAX);
                if k < c.len() && c[k] == ';' { k += 1; }
                if let Some(r) = u32::try_from(num).ok().and_then(|n| crate::entities::INVALID_CHARREFS.iter().find(|(x, _)| *x == n)) {
                    out.push_str(r.1);
                } else if (0xD800..=0xDFFF).contains(&num) || num > 0x10FFFF {
                    out.push('\u{FFFD}');
                } else if !crate::entities::invalid_codepoint(num as u32) {
                    out.push(char::from_u32(num as u32).unwrap_or('\u{FFFD}'));
                }
                i = k;
                continue;
            }
            out.push('&');
            i += 1;
            continue;
        }
        // [^\t\n\f <&#;]{1,32};?
        let mut k = j;
        while k < c.len() && k - j < 32 && !matches!(c[k], '\t' | '\n' | '\x0c' | ' ' | '<' | '&' | '#' | ';') { k += 1; }
        if k == j {
            out.push('&');
            i += 1;
            continue;
        }
        if k < c.len() && c[k] == ';' { k += 1; }
        let name: String = c[j..k].iter().collect();
        if let Some(v) = named_entity(&name) {
            out.push_str(v);
        } else {
            let chars: Vec<char> = name.chars().collect();
            let hit = (2..chars.len()).rev().find_map(|x| {
                let p: String = chars[..x].iter().collect();
                named_entity(&p).map(|v| (v, chars[x..].iter().collect::<String>()))
            });
            match hit {
                Some((v, rest)) => { out.push_str(v); out.push_str(&rest); }
                None => { out.push('&'); out.push_str(&name); }
            }
        }
        i = k;
    }
    out
}

/// scrape.clean_html_text: <br> to newlines, other tags dropped,
/// entities decoded, runs of spaces and blank lines closed up.
pub fn clean_html_text(text: &Value) -> Value {
    let Value::String(t) = text else { return text.clone() };
    if t.is_empty() {
        return text.clone();
    }
    let lower = t.to_ascii_lowercase();
    let (b, lb) = (t.as_bytes(), lower.as_bytes());
    let mut s = String::with_capacity(t.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'<' {
            // <br\s*/?>
            if lb[i..].starts_with(b"<br") {
                let mut k = i + 3;
                while k < b.len() && (b[k] as char).is_ascii_whitespace() { k += 1; }
                if k < b.len() && b[k] == b'/' { k += 1; }
                if k < b.len() && b[k] == b'>' {
                    s.push('\n');
                    i = k + 1;
                    continue;
                }
            }
            // <[^>]+>
            if i + 1 < b.len() && b[i + 1] != b'>' {
                if let Some(e) = t[i + 1..].find('>') {
                    i = i + 1 + e + 1;
                    continue;
                }
            }
        }
        let ch = t[i..].chars().next().unwrap();
        s.push(ch);
        i += ch.len_utf8();
    }
    let s = unescape(&s);
    let mut out = String::with_capacity(s.len());
    let mut newlines = 0;
    let mut prev_space = false;
    for ch in s.chars() {
        if ch == ' ' || ch == '\t' {
            if !prev_space { out.push(' '); }
            prev_space = true;
            newlines = 0;
            continue;
        }
        prev_space = false;
        if ch == '\n' {
            newlines += 1;
            if newlines > 2 { continue; }
        } else {
            newlines = 0;
        }
        out.push(ch);
    }
    Value::String(out.trim_matches(|c: char| c.is_whitespace() || ('\x1c'..='\x1f').contains(&c)).to_string())
}

/// A dealer CDN's /resize/WxH/ segment pointed at the spec's size.
pub fn upsize_image_url(url: &str) -> String {
    let target = crate::spec::get(&["listing", "photoSize"]).as_str().expect("listing.photoSize");
    let mut out = String::with_capacity(url.len());
    let mut rest = url;
    while let Some(i) = rest.find("/resize/") {
        let tail = &rest[i + 8..];
        let w = tail.bytes().take_while(u8::is_ascii_digit).count();
        let h = if w > 0 && tail[w..].starts_with('x') { tail[w + 1..].bytes().take_while(u8::is_ascii_digit).count() } else { 0 };
        if h > 0 && tail[w + 1 + h..].starts_with('/') {
            out.push_str(&rest[..i]);
            out.push_str("/resize/");
            out.push_str(target);
            out.push('/');
            rest = &tail[w + 1 + h + 1..];
        } else {
            out.push_str(&rest[..i + 1]);
            rest = &rest[i + 1..];
        }
    }
    out.push_str(rest);
    out
}

/// `\b1[\s-]*owner\b`, case-insensitively. The blob's
/// certifications.carfaxOneOwner is a stale pre-lookup snapshot (False on
/// every used vehicle checked, including ones plainly badged 1 OWNER); the
/// dealer's own "1 OWNER" tag in the features is the real per-vehicle
/// signal (one car shows CLEAN CARFAX and 1 OWNER, another CLEAN CARFAX
/// alone), so every feature list is searched.
fn says_one_owner(t: &str) -> bool {
    let c: Vec<char> = t.chars().collect();
    let word = |ch: char| ch.is_alphanumeric() || ch == '_';
    (0..c.len()).any(|i| {
        if c[i] != '1' || (i > 0 && word(c[i - 1])) { return false; }
        let mut k = i + 1;
        while k < c.len() && (c[k].is_whitespace() || c[k] == '-') { k += 1; }
        let tail: String = c[k..].iter().take(5).collect();
        tail.to_lowercase() == "owner" && (k + 5 == c.len() || !word(c[k + 5]))
    })
}

// ---------- the record -----------------------------------------------------

pub fn normalize(req: &ListingRequest) -> Value {
    let html = req.html.as_str();
    let analytics = if req.extract {
        extract_balanced_json(html, crate::spec::get(&["listing", "analyticsMarker"]).as_str().unwrap_or(""))
            .filter(|d| d.as_object().is_some_and(|o| o.contains_key("vdp_gtm_payload")))
    } else {
        req.analytics.clone().filter(|a| !a.is_null())
    };
    let ld = ldjson_car(html);
    let mut warnings: Vec<Value> = vec![];
    if analytics.is_none() {
        warnings.push(json!("Could not find embedded vehicle data blob; falling back to schema.org data only, most fields will be empty."));
    }
    let p = analytics.as_ref().map(|a| g(a, &["vdp_gtm_payload"])).filter(|p| !p.is_null()).unwrap_or(json!({}));

    let year = get(&p, "year");
    let year = if truthy(&year) { json!(py_str(&year)) } else { Value::Null };
    let (make, model, trim) = (get(&p, "make"), get(&p, "model"), get(&p, "trim"));

    let certs = or(get(&p, "certifications"), json!({}));
    let certified = truthy(&or(get(&certs, "certifiedByManufacturer"), get(&certs, "certifiedByDealer")));
    let condition = match get(&p, "used") {
        Value::Bool(false) => json!("New"),
        Value::Bool(true) => json!(if certified { "Certified Pre-Owned" } else { "Used" }),
        _ => match or(get(&p, "conditions_array"), json!([])) {
            Value::Array(a) => a.last().cloned().unwrap_or(Value::Null),
            Value::String(s) => s.chars().last().map(|c| json!(c.to_string())).unwrap_or(Value::Null),
            _ => Value::Null,
        },
    };

    let bits: Vec<String> = [&year, &make, &model, &trim].iter().filter(|b| truthy(b)).map(|b| py_str(b)).collect();
    let title = if bits.is_empty() { g(&ld, &["name"]) } else { json!(bits.join(" ")) };

    let colors = or(g(&p, &["visual", "colors"]), json!({}));
    let specs = or(get(&p, "specifications"), json!({}));
    let transmission = or(get(&specs, "transmission_new"), get(&specs, "transmission"));
    let transmission = match &transmission {
        Value::String(s) if !s.is_empty() => json!(s.trim_matches(|c: char| c.is_whitespace())),
        other => other.clone(),
    };
    let mpg = |lo_key: &str, hi_key: &str| -> Value {
        let (lo, hi) = (get(&specs, lo_key), get(&specs, hi_key));
        if !(nonzero(&lo) || nonzero(&hi)) { return Value::Null; }
        if py_eq(&lo, &hi) { lo } else { json!(format!("{}-{}", py_str(&lo), py_str(&hi))) }
    };
    let body_types = or(get(&specs, "vehicleType"), json!([]));
    let body_type = match &body_types {
        Value::Array(a) if !a.is_empty() => json!(a.iter().map(py_str).collect::<Vec<_>>().join(", ")),
        _ => or(g(&ld, &["bodyType "]), g(&ld, &["bodyType"])),
    };

    let price = or(get(&p, "displayPrice"), get(&p, "price"));
    let display_price = if nonzero(&price) { price } else { Value::Null };
    let mut pricing_rows = vec![];
    if let Value::Array(rows) = or(get(&p, "flattened_pricing"), json!([])) {
        for row in rows {
            let pr = or(get(&row, "pricing"), json!({}));
            let (label, text) = (get(&pr, "Label"), get(&pr, "Text"));
            if truthy(&label) && truthy(&text) {
                pricing_rows.push(json!({"label": label, "text": text}));
            }
        }
    }

    let features = or(get(&p, "features"), json!({}));
    let main_features = or(get(&features, "mainFeatures"), json!([]));
    let features_structured = or(get(&features, "featuresStructured"), json!({}));

    let loc = or(get(&p, "location"), json!({}));
    let mut csz: String = [get(&loc, "city"), get(&loc, "state")].iter().filter(|b| truthy(b)).map(py_str).collect::<Vec<_>>().join(", ");
    let zip = get(&loc, "zipCode");
    if truthy(&zip) {
        csz = format!("{csz} {}", py_str(&zip)).trim().to_string();
    }
    let mut addr: Vec<String> = [get(&loc, "address1"), get(&loc, "address2")].iter().filter(|b| truthy(b)).map(py_str).collect();
    if !csz.is_empty() { addr.push(csz); }

    let visual = or(get(&p, "visual"), json!({}));
    let mut combined = get(&visual, "combinedPhotos");
    if !truthy(&combined) {
        let mut both = vec![];
        for key in ["dealerPhotos", "stockPhotos"] {
            if let Value::Array(a) = or(get(&visual, key), json!([])) { both.extend(a); }
        }
        combined = Value::Array(both);
    }
    let mut photo_urls: Vec<String> = vec![];
    let mut seen: Vec<&str> = vec![];
    if let Value::Array(photos) = &combined {
        for photo in photos {
            if let Some(Value::String(src)) = photo.get("source") {
                if !src.is_empty() && !seen.contains(&src.as_str()) {
                    seen.push(src);
                    photo_urls.push(upsize_image_url(src));
                }
            }
        }
    }
    if photo_urls.is_empty() {
        if let Value::String(img) = or(g(&p, &["visual", "image", "source"]), g(&ld, &["image"])) {
            if !img.is_empty() { photo_urls.push(upsize_image_url(&img)); }
        }
    }
    let mut video_urls = vec![];
    if let Value::Array(vids) = or(get(&visual, "dealerVideos"), json!([])) {
        for vid in vids {
            match &vid {
                Value::Object(o) => if let Some(src) = o.get("source").filter(|s| truthy(s)) { video_urls.push(src.clone()) },
                Value::String(_) => video_urls.push(vid.clone()),
                _ => {}
            }
        }
    }
    let window_sticker_url = or(get(&or(get(&p, "expando"), json!({})), "WindowStickerUrl"), Value::Null);

    let mut haystacks: Vec<Value> = main_features.as_array().cloned().unwrap_or_default();
    if let Value::Object(o) = &features_structured {
        for tags in o.values() {
            if let Value::Array(a) = tags { haystacks.extend(a.iter().cloned()); }
        }
    }
    let one_owner = haystacks.iter().any(|t| t.as_str().is_some_and(says_one_owner));

    if photo_urls.is_empty() { warnings.push(json!("No photos found for this vehicle.")); }
    if !truthy(&window_sticker_url) { warnings.push(json!("No window sticker URL found (common for used vehicles).")); }
    if !truthy(&display_price) { warnings.push(json!("No price found.")); }

    let url = req.url.clone().filter(|u| !u.is_empty()).or_else(|| page_url(html));
    let mut v = Map::new();
    let mut put = |k: &str, val: Value| { v.insert(k.to_string(), val); };
    put("url", json!(url));
    put("vin", or(get(&p, "vin"), g(&ld, &["vehicleIdentificationNumber"])));
    put("stock_number", get(&p, "stockNumber"));
    put("year", year);
    put("make", make);
    put("model", model);
    put("trim", trim);
    put("condition", condition);
    put("vehicle_status", get(&p, "vehicleStatus"));
    put("mileage", get(&p, "mileage"));
    put("title", title);
    put("exterior_color_factory", or(g(&colors, &["exterior", "factory"]), g(&ld, &["color"])));
    put("exterior_color_generic", g(&colors, &["exterior", "generic"]));
    put("interior_color", g(&colors, &["interior", "factory"]));
    put("engine", or(get(&specs, "engine"), g(&ld, &["vehicleEngine", "name"])));
    put("transmission", transmission);
    put("drivetrain", get(&specs, "drivetrain"));
    put("fuel_type", or(get(&specs, "fuelType"), g(&ld, &["fuelType"])));
    put("mpg_city", mpg("mpgCityLow", "mpgCityHigh"));
    put("mpg_highway", mpg("mpgHighwayLow", "mpgHighwayHigh"));
    put("body_type", body_type);
    put("ev_battery_range", get(&p, "evBatteryRange"));
    put("ev_mpge_combined", get(&p, "evMpgCombined"));
    put("cab_style", or(get(&p, "cabStyle"), Value::Null));
    put("box_length", get(&p, "boxLength"));
    put("display_price", display_price);
    put("pricing_rows", Value::Array(pricing_rows));
    put("dealer_description", clean_html_text(&or(get(&p, "dealerDescription"), g(&ld, &["description"]))));
    put("dealer_comments", or(clean_html_text(&get(&p, "dealerComments")), Value::Null));
    put("main_features", main_features);
    put("features_structured", features_structured);
    put("options", or(get(&p, "options"), json!([])));
    put("tags", or(get(&p, "tags"), json!([])));
    put("dealer_name", get(&loc, "name"));
    put("dealer_address", if addr.is_empty() { Value::Null } else { json!(addr.join(", ")) });
    put("dealer_phone", get(&loc, "contactNumber"));
    put("photo_urls", json!(photo_urls));
    put("video_urls", Value::Array(video_urls));
    put("window_sticker_url", window_sticker_url);
    put("sticker", Value::Null);
    put("carfax_url", carfax_url(html));
    put("carfax_one_owner", json!(one_owner));
    put("warnings", Value::Array(warnings));
    Value::Object(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unescapes_like_python() {
        assert_eq!(unescape("One &amp; only &amp &notit; &#39;x&#x27; &#150; &#0; &bogus;"), "One & only & ¬it; 'x' \u{2013} \u{FFFD} &bogus;");
    }

    #[test]
    fn upsizes_every_resize_segment() {
        assert_eq!(upsize_image_url("https://p.test/x/resize/640x480/a.jpg"), "https://p.test/x/resize/2048x2048/a.jpg");
        assert_eq!(upsize_image_url("https://p.test/resize/x/a.jpg"), "https://p.test/resize/x/a.jpg");
    }

    #[test]
    fn one_owner_is_a_word() {
        assert!(says_one_owner("1 OWNER") && says_one_owner("CARFAX 1-Owner") && !says_one_owner("11 owners") && !says_one_owner("1 owners"));
    }
}
