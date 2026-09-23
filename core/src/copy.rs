//! Post copy for each platform (port of facebook_post.py and
//! social_post.py, which the browser's copy.js mirrored by hand). The
//! long Marketplace post, the Threads post inside its 500-character
//! cap, the Instagram caption, the hashtags, and the audit trail of
//! which condition-dependent branch fired. Both surfaces hand in the
//! vehicle record and the dealer boilerplate and get the same text.
//!
//! Nothing here invents a claim: every value is a scraped, stickered or
//! typed field; the only editorial decisions are ordering and what to
//! drop when a budget runs out. Python's formatting (f"{n:,}",
//! f"{x:,.0f}", int(float(s)), str.capitalize, str.isupper) is
//! reproduced exactly, and tests/test_copy_parity.py holds this to the
//! posts the Python produced.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
pub struct Dealer {
    #[serde(default)] pub greeting: Option<String>,
    #[serde(default)] pub address: Option<String>,
    #[serde(default)] pub city_tags: Vec<String>,
}

#[derive(Deserialize)]
pub struct CopyRequest {
    pub vehicle: Value,
    pub dealer: Dealer,
}

#[derive(Serialize)]
pub struct Explain {
    pub condition_bucket: &'static str,
    pub price_source: &'static str,
    /// The price the post shows, before formatting.
    pub resolved_price: Option<String>,
    /// The "Original MSRP" line's figure, when one is shown.
    pub original_msrp_comparison: Option<String>,
    pub factory_warranties_shown: bool,
    pub original_msrp_comparison_shown: bool,
    pub incentive_description_suppressed: bool,
    pub more_details_link: Option<String>,
    pub pricing_consistency_issues: Vec<String>,
}

#[derive(Serialize)]
pub struct Posts {
    pub facebook: String,
    pub instagram: String,
    pub threads: String,
    pub hashtags: Vec<String>,
    pub explain: Explain,
}

const THREADS_LIMIT: usize = 500;
const INSTAGRAM_VISIBLE: usize = 125;
const DELIVERY_MILEAGE_CEILING: i64 = 100;
const MAX_HASHTAGS: usize = 14;
const MAX_TAG_LENGTH: usize = 28;
const INCENTIVE_KEYWORDS: [&str; 5] = ["price includes", "rebate", "incentive", "discount", "cash allowance"];
const BODY_TYPE_TAGS: [(&str, &str); 13] = [
    ("suv", "SUV"), ("sport utility", "SUV"), ("truck", "Truck"), ("pickup", "Truck"), ("crew cab pickup", "Truck"),
    ("sedan", "Sedan"), ("coupe", "Coupe"), ("convertible", "Convertible"), ("hatchback", "Hatchback"), ("van", "Van"),
    ("cargo van", "WorkVan"), ("minivan", "Minivan"), ("wagon", "Wagon"),
];
const TRIM_ORDER: [&str; 7] = ["stock", "vin", "drivetrain", "engine", "color", "carfax", "mileage"];

// ------------------------------------------------------------ Python semantics

/// Python truthiness of a JSON value.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// Python str() of a scalar field.
fn text(v: &Value) -> String {
    match v {
        Value::Null => "None".into(),
        Value::Bool(b) => if *b { "True".into() } else { "False".into() },
        Value::Number(n) => {
            if let Some(i) = n.as_i64() { i.to_string() }
            else { let f = n.as_f64().unwrap_or(0.0); if f.fract() == 0.0 && f.abs() < 1e16 { format!("{f:.1}") } else { f.to_string() } }
        }
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn field<'a>(v: &'a Value, key: &str) -> &'a Value { v.get(key).unwrap_or(&Value::Null) }

/// A present, truthy field as text.
fn opt(v: &Value, key: &str) -> Option<String> {
    let f = field(v, key);
    if truthy(f) { Some(text(f)) } else { None }
}

fn lower_trim(v: &Value, key: &str) -> String { opt(v, key).unwrap_or_default().trim().to_lowercase() }

/// f"{n:,}" for an integer.
fn commas(n: i64) -> String {
    let s = n.abs().to_string();
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 { out.push(','); }
        out.push(ch);
    }
    if n < 0 { format!("-{out}") } else { out }
}

/// f"{x:,.0f}": round half to even, then commas.
fn commas0f(x: f64) -> String {
    let f = x.floor();
    let diff = x - f;
    let r = if diff > 0.5 { f + 1.0 } else if diff < 0.5 { f } else if (f as i64) % 2 == 0 { f } else { f + 1.0 };
    commas(r as i64)
}

/// float(str(text).replace(",", "").replace("$", "").lstrip("+")).
fn to_float(text: &str) -> Option<f64> {
    let s = text.replace(',', "").replace('$', "");
    let s = s.trim_start_matches('+').trim();
    if s.is_empty() { return None; }
    s.parse::<f64>().ok().filter(|f| f.is_finite())
}

/// Python's str.isupper(): at least one cased character, none lowercase.
fn is_upper(s: &str) -> bool {
    let mut cased = false;
    for ch in s.chars() {
        if ch.is_lowercase() { return false; }
        if ch.is_uppercase() { cased = true; }
    }
    cased
}

/// Python's str.capitalize().
fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars.flat_map(|c| c.to_lowercase())).collect(),
        None => String::new(),
    }
}

fn char_len(s: &str) -> usize { s.chars().count() }

// ------------------------------------------------------------ pricing

fn sticker_msrp(v: &Value) -> Option<String> {
    let s = field(field(field(v, "sticker"), "pricing"), "total_msrp");
    if truthy(s) { Some(text(s)) } else { None }
}

fn is_new(v: &Value) -> bool { lower_trim(v, "condition") == "new" }

/// Used vehicles show the listed price; new vehicles post at MSRP: the
/// sticker's Total MSRP, then the site's MSRP pricing row, then the
/// site's display price.
fn resolve_display_price(v: &Value) -> Option<String> {
    if !is_new(v) { return opt(v, "display_price"); }
    if let Some(m) = sticker_msrp(v) { return Some(m); }
    if let Some(rows) = field(v, "pricing_rows").as_array() {
        for row in rows {
            if text(field(row, "label")).trim().to_uppercase() == "MSRP" {
                let t = field(row, "text");
                return if t.is_null() { None } else { Some(text(t)) };
            }
        }
    }
    opt(v, "display_price")
}

fn resolve_original_msrp_comparison(v: &Value) -> Option<String> {
    if is_new(v) { return None; }
    let msrp = sticker_msrp(v)?;
    let current = resolve_display_price(v);
    let msrp_num = to_float(&msrp)?;
    let current_num = to_float(&current.unwrap_or_else(|| "None".into()))?;
    if msrp_num <= current_num { return None; }
    Some(format!("${}", commas0f(msrp_num)))
}

fn looks_like_incentive_disclosure(t: &str) -> bool {
    let l = t.to_lowercase();
    t.contains('$') && INCENTIVE_KEYWORDS.iter().any(|k| l.contains(k))
}

fn ford_qr_link(vin: &str) -> String { format!("http://v.ford.com/?v={vin}&c=1&s=1") }

fn resolve_more_details_link(v: &Value) -> Option<String> {
    if lower_trim(v, "make") != "ford" { return None; }
    if !(truthy(field(v, "sticker")) && truthy(field(v, "vin"))) { return None; }
    Some(ford_qr_link(&text(field(v, "vin"))))
}

fn check_pricing_consistency(v: &Value) -> Vec<String> {
    let mut issues = Vec::new();
    let rows = field(v, "pricing_rows").as_array().cloned().unwrap_or_default();
    if !rows.is_empty() && !field(v, "display_price").is_null() {
        let display = to_float(&text(field(v, "display_price")));
        let last = rows.last().unwrap();
        let last_num = to_float(&text(field(last, "text")));
        if let (Some(d), Some(l)) = (display, last_num) {
            if (d - l).abs() > 1.0 {
                issues.push(format!(
                    "Pricing mismatch: display_price (${}) doesn't match the last pricing_rows entry {} (${}).",
                    commas0f(d), py_repr(field(last, "label")), commas0f(l)));
            }
        }
    }
    if !is_new(v) {
        if let Some(m) = sticker_msrp(v) {
            let msrp_num = to_float(&m);
            let current_num = to_float(&resolve_display_price(v).unwrap_or_else(|| "None".into()));
            if let (Some(mn), Some(cn)) = (msrp_num, current_num) {
                if mn <= cn {
                    issues.push(format!(
                        "Sticker MSRP (${}) is not higher than the current listed price (${}) -- unusual for a used/CPO vehicle, worth a manual check.",
                        commas0f(mn), commas0f(cn)));
                }
            }
        }
    }
    issues
}

/// Python's repr() of a label field (a string in quotes, None bare).
fn py_repr(v: &Value) -> String {
    match v {
        Value::String(s) => if s.contains('\'') && !s.contains('"') { format!("\"{s}\"") } else { format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'")) },
        Value::Null => "None".into(),
        other => text(other),
    }
}

// ------------------------------------------------------------ the Marketplace post

fn feature_key(feature: &str) -> String {
    let mut out = String::new();
    let mut in_gap = false;
    for ch in feature.to_lowercase().chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() { out.push(ch); in_gap = false; }
        else if !in_gap { out.push(' '); in_gap = true; }
    }
    out.trim().to_string()
}

fn price_phrase(resolved: &str) -> String {
    match to_float(resolved) {
        Some(n) => format!("${}", commas(n.trunc() as i64)),
        None => resolved.to_string(),
    }
}

fn headline(v: &Value) -> String {
    let prefix = if is_new(v) { "New " } else { "" };
    format!("{}{}", prefix, opt(v, "title").unwrap_or_else(|| "Vehicle".into())).trim().to_string()
}

fn mpg_phrase(v: &Value) -> String {
    let mut parts = Vec::new();
    if let Some(c) = opt(v, "mpg_city") { parts.push(format!("{c} city")); }
    if let Some(h) = opt(v, "mpg_highway") { parts.push(format!("{h} hwy")); }
    parts.join("/")
}

fn mileage(v: &Value) -> Option<i64> {
    match field(v, "mileage") {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn string_list(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().map(text).collect()).unwrap_or_default()
}

pub fn build_facebook_post(v: &Value, dealer: &Dealer) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let mut new_features = |feats: Vec<String>| -> Vec<String> {
        let mut out = Vec::new();
        for f in feats {
            let key = feature_key(&f);
            if !key.is_empty() && !seen.contains(&key) { seen.push(key); out.push(f); }
        }
        out
    };

    if let Some(g) = &dealer.greeting { lines.push(g.clone()); }
    lines.push(headline(v));
    if let Some(a) = &dealer.address { lines.push(a.clone()); }
    lines.push(String::new());

    match resolve_display_price(v) {
        Some(p) => lines.push(format!("Price: {}", price_phrase(&p))),
        None => lines.push("Price: Call for Price".into()),
    }
    if let Some(m) = resolve_original_msrp_comparison(v) { lines.push(format!("Original MSRP: {m}")); }
    if let Some(m) = mileage(v) { lines.push(format!("Mileage: {} mi", commas(m))); }
    if let Some(vin) = opt(v, "vin") { lines.push(format!("VIN: {vin}")); }
    if let Some(s) = opt(v, "stock_number") { lines.push(format!("Stock #: {s}")); }
    lines.push(String::new());

    let mut specs = Vec::new();
    if let Some(x) = opt(v, "exterior_color_factory") { specs.push(format!("Exterior: {x}")); }
    if let Some(x) = opt(v, "interior_color") { specs.push(format!("Interior: {x}")); }
    if let Some(x) = opt(v, "engine") { specs.push(format!("Engine: {x}")); }
    if let Some(x) = opt(v, "transmission") { specs.push(format!("Transmission: {x}")); }
    if let Some(x) = opt(v, "drivetrain") { specs.push(format!("Drivetrain: {x}")); }
    if opt(v, "mpg_city").is_some() || opt(v, "mpg_highway").is_some() {
        specs.push(format!("MPG: {}", mpg_phrase(v)));
    } else if let Some(x) = opt(v, "ev_mpge_combined") {
        specs.push(format!("MPGe: {x} combined"));
    }
    if let Some(x) = opt(v, "ev_battery_range") { specs.push(format!("EV Range: {x} mi")); }
    if let Some(x) = opt(v, "cab_style") { specs.push(format!("Cab: {x}")); }
    if let Some(x) = opt(v, "box_length") { specs.push(format!("Bed length: {x}")); }
    if !specs.is_empty() { lines.extend(specs); lines.push(String::new()); }

    if let Some(d) = opt(v, "dealer_description") {
        if !(is_new(v) && looks_like_incentive_disclosure(&d)) {
            lines.push(d.trim().to_string());
            lines.push(String::new());
        }
    }

    let sticker = field(v, "sticker");
    let equipment = field(sticker, "equipment");
    if truthy(equipment) {
        for (key, label) in [("exterior", "Exterior"), ("interior", "Interior"), ("functional_tech", "Functional & Tech"), ("safety_security", "Safety & Security")] {
            let feats = new_features(string_list(field(equipment, key)));
            if feats.is_empty() { continue; }
            lines.push(format!("{label}:"));
            for f in feats { lines.push(format!("- {f}")); }
            lines.push(String::new());
        }
        let optional = new_features(string_list(field(sticker, "optional_equipment")));
        if !optional.is_empty() {
            lines.push("Optional Equipment:".into());
            for f in optional { lines.push(format!("- {f}")); }
            lines.push(String::new());
        }
        let warranties = string_list(field(sticker, "warranties"));
        if !warranties.is_empty() && lower_trim(v, "make") == "ford" {
            lines.push("Factory Warranties:".into());
            for w in warranties { lines.push(format!("- {w}")); }
            lines.push(String::new());
        }
    } else if truthy(field(v, "main_features")) {
        let feats = new_features(string_list(field(v, "main_features")));
        if !feats.is_empty() {
            lines.push("Features:".into());
            for f in feats { lines.push(format!("- {f}")); }
            lines.push(String::new());
        }
    } else if truthy(field(v, "features_structured")) {
        let mut feats = Vec::new();
        if let Some(groups) = field(v, "features_structured").as_object() {
            for (_, group) in groups { feats.extend(new_features(string_list(group))); }
        }
        if !feats.is_empty() {
            lines.push("Features:".into());
            for f in feats { lines.push(format!("- {f}")); }
            lines.push(String::new());
        }
    }

    if truthy(field(v, "carfax_one_owner")) { lines.push("CARFAX 1-Owner".into()); lines.push(String::new()); }
    if let Some(m) = resolve_more_details_link(v) { lines.push(format!("More details: {m}")); }

    format!("{}\n", lines.join("\n").trim())
}

// ------------------------------------------------------------ hashtags

fn tag(t: &str) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut cur = String::new();
    for ch in t.chars() {
        if ch.is_ascii_alphanumeric() { cur.push(ch); } else if !cur.is_empty() { parts.push(std::mem::take(&mut cur)); }
    }
    if !cur.is_empty() { parts.push(cur); }
    if parts.is_empty() { return None; }
    let joined = if parts.len() == 1 { parts[0].clone() } else {
        parts.iter().map(|p| if is_upper(p) { p.clone() } else { capitalize(p) }).collect::<String>()
    };
    if char_len(&joined) <= MAX_TAG_LENGTH { Some(joined) } else { None }
}

pub fn build_hashtags(v: &Value, dealer: &Dealer, limit: usize) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    let mut add = |value: &str| {
        if let Some(t) = tag(value) { if !tags.contains(&t) { tags.push(t); } }
    };
    let (make, model, trim, year) = (opt(v, "make"), opt(v, "model"), opt(v, "trim"), opt(v, "year"));
    if let (Some(mk), Some(md)) = (&make, &model) {
        add(&format!("{mk} {md}"));
        if let Some(t) = &trim { add(&format!("{mk} {md} {t}")); }
        if let Some(y) = &year { add(&format!("{y} {mk} {md}")); }
    }
    add(&make.clone().unwrap_or_default());

    let body = lower_trim(v, "body_type");
    if !body.is_empty() {
        let mut keys: Vec<(&str, &str)> = BODY_TYPE_TAGS.to_vec();
        keys.sort_by_key(|(k, _)| std::cmp::Reverse(k.len()));
        let matched = keys.iter().find(|(k, _)| body.contains(k)).map(|(_, t)| t.to_string());
        add(&matched.unwrap_or(body.clone()));
    }

    let condition = lower_trim(v, "condition");
    if condition.starts_with("cert") { add("CertifiedPreOwned"); }
    else if condition == "new" { add("NewCar"); }
    else if !condition.is_empty() { add("UsedCars"); }

    for c in &dealer.city_tags { add(c); }
    for g in ["CarsForSale", "ForSale", "CarDealership"] { add(g); }

    tags.into_iter().take(limit).map(|t| format!("#{t}")).collect()
}

// ------------------------------------------------------------ Threads and Instagram

fn showable_mileage(v: &Value) -> Option<i64> {
    mileage(v).filter(|m| *m >= DELIVERY_MILEAGE_CEILING)
}

fn hook(v: &Value) -> String {
    let mut parts = vec![headline(v)];
    if let Some(p) = resolve_display_price(v) { parts.push(price_phrase(&p)); }
    let line = parts.join(" — ");
    if let Some(m) = showable_mileage(v) {
        let with_miles = format!("{line} — {} mi", commas(m));
        if char_len(&with_miles) <= INSTAGRAM_VISIBLE { return with_miles; }
    }
    line
}

fn city_state(addr: &str) -> String {
    let parts: Vec<&str> = addr.split(',').map(|p| p.trim()).filter(|p| !p.is_empty()).collect();
    if parts.len() >= 3 {
        let st = parts[2].split_whitespace().next().unwrap_or("");
        format!("{}, {}", parts[1], st)
    } else if parts.len() == 2 {
        format!("{}, {}", parts[0], parts[1])
    } else {
        addr.to_string()
    }
}

pub fn build_threads_post(v: &Value, dealer: &Dealer, limit: usize) -> String {
    let h = hook(v);
    let cta: String = [dealer.greeting.clone(), dealer.address.as_deref().map(city_state)]
        .into_iter().flatten().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ");

    let mut optional: Vec<(&str, String)> = Vec::new();
    if let Some(m) = showable_mileage(v) {
        if !h.contains(&format!("{} mi", commas(m))) { optional.push(("mileage", format!("{} miles", commas(m)))); }
    }
    if let Some(x) = opt(v, "exterior_color_factory") { optional.push(("color", x)); }
    if let Some(x) = opt(v, "engine") { optional.push(("engine", x)); }
    if let Some(x) = opt(v, "drivetrain") { optional.push(("drivetrain", x)); }
    if truthy(field(v, "carfax_one_owner")) { optional.push(("carfax", "CARFAX 1-Owner".into())); }
    if let Some(x) = opt(v, "vin") { optional.push(("vin", format!("VIN {x}"))); }
    if let Some(x) = opt(v, "stock_number") { optional.push(("stock", format!("Stock #{x}"))); }
    let get = |k: &str| optional.iter().find(|(key, _)| *key == k).map(|(_, v)| v.clone());

    let mut keep: Vec<&str> = ["mileage", "carfax", "color", "engine", "drivetrain", "vin", "stock"]
        .into_iter().filter(|k| get(k).is_some()).collect();

    let assemble = |keys: &[&str], tags: &[String]| -> String {
        let body = keys.iter().filter_map(|k| get(k)).collect::<Vec<_>>().join(" · ");
        let mut blocks = vec![h.clone()];
        if !body.is_empty() { blocks.push(body); }
        if !cta.is_empty() { blocks.push(cta.clone()); }
        if !tags.is_empty() { blocks.push(tags.join(" ")); }
        blocks.join("\n\n")
    };

    let mut tags = build_hashtags(v, dealer, 6);
    for drop in TRIM_ORDER {
        if char_len(&assemble(&keep, &tags)) <= limit { break; }
        keep.retain(|k| *k != drop);
    }
    while !tags.is_empty() && char_len(&assemble(&keep, &tags)) > limit { tags.pop(); }
    let mut t = assemble(&keep, &tags);
    if char_len(&t) > limit {
        // text[:limit].rsplit(" ", 1)[0].rstrip(" ·—\n")
        let cut: String = t.chars().take(limit).collect();
        let head = match cut.rfind(' ') { Some(i) => cut[..i].to_string(), None => cut };
        t = head.trim_end_matches([' ', '·', '—', '\n']).to_string();
    }
    format!("{t}\n")
}

pub fn build_instagram_caption(v: &Value, dealer: &Dealer) -> String {
    let mut blocks = vec![hook(v)];
    let mut detail = Vec::new();
    if let Some(m) = showable_mileage(v) { detail.push(format!("Mileage: {} mi", commas(m))); }
    if let Some(x) = opt(v, "exterior_color_factory") { detail.push(format!("Exterior: {x}")); }
    if let Some(x) = opt(v, "interior_color") { detail.push(format!("Interior: {x}")); }
    if let Some(x) = opt(v, "engine") { detail.push(format!("Engine: {x}")); }
    if let Some(x) = opt(v, "transmission") { detail.push(format!("Transmission: {x}")); }
    if let Some(x) = opt(v, "drivetrain") { detail.push(format!("Drivetrain: {x}")); }
    if opt(v, "mpg_city").is_some() || opt(v, "mpg_highway").is_some() { detail.push(format!("MPG: {}", mpg_phrase(v))); }
    else if let Some(x) = opt(v, "ev_mpge_combined") { detail.push(format!("MPGe: {x} combined")); }
    if let Some(x) = opt(v, "ev_battery_range") { detail.push(format!("EV range: {x} mi")); }
    if truthy(field(v, "carfax_one_owner")) { detail.push("CARFAX 1-Owner".into()); }
    if let Some(x) = opt(v, "stock_number") { detail.push(format!("Stock #{x}")); }
    if !detail.is_empty() { blocks.push(detail.join("\n")); }
    let contact: String = [dealer.greeting.clone(), dealer.address.clone()].into_iter().flatten()
        .filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n");
    if !contact.is_empty() { blocks.push(contact); }
    blocks.push(build_hashtags(v, dealer, MAX_HASHTAGS).join(" "));
    format!("{}\n", blocks.join("\n\n"))
}

pub fn explain(v: &Value) -> Explain {
    let new = is_new(v);
    let msrp = sticker_msrp(v);
    let has_msrp_row = field(v, "pricing_rows").as_array().map(|rows| rows.iter().any(|r| text(field(r, "label")).trim().to_uppercase() == "MSRP")).unwrap_or(false);
    let price_source = if !new { "site_display_price" } else if msrp.is_some() { "sticker_total_msrp" } else if has_msrp_row { "site_pricing_rows_msrp" } else { "site_display_price_fallback" };
    let desc = opt(v, "dealer_description");
    let original = resolve_original_msrp_comparison(v);
    Explain {
        condition_bucket: if new { "new" } else { "used_or_cpo" },
        price_source,
        resolved_price: resolve_display_price(v),
        original_msrp_comparison_shown: original.is_some(),
        original_msrp_comparison: original,
        factory_warranties_shown: truthy(field(field(v, "sticker"), "warranties")) && lower_trim(v, "make") == "ford",
        incentive_description_suppressed: new && desc.map(|d| looks_like_incentive_disclosure(&d)).unwrap_or(false),
        more_details_link: resolve_more_details_link(v),
        pricing_consistency_issues: check_pricing_consistency(v),
    }
}

pub fn build_posts(req: &CopyRequest) -> Posts {
    let (v, d) = (&req.vehicle, &req.dealer);
    Posts {
        facebook: build_facebook_post(v, d),
        instagram: build_instagram_caption(v, d),
        threads: build_threads_post(v, d, THREADS_LIMIT),
        hashtags: build_hashtags(v, d, MAX_HASHTAGS),
        explain: explain(v),
    }
}
