//! The Ford Monroney window-sticker parser (port of imaging/sticker.py,
//! which the browser's sticker.js used to mirror by hand). The hosts
//! supply positioned words: the CLI from `pdftotext -bbox`, the browser
//! from pdf.js. Everything after that is here, so the two surfaces read
//! the same sticker the same way.
//!
//! The section layout (column x-positions, header labels, WARRANTY
//! sharing the fourth equipment column's space, the SOLD TO block) is
//! Ford's fixed template, not vehicle data, so it is safe to anchor on.
//! Where the Python used a Python string method or `re`, the same
//! semantics are reproduced here (see `py_title`, `is_upper`), because
//! tests/test_sticker_parity.py holds this to that Python's output on
//! every real sticker in the operator's library.

use serde::{Deserialize, Serialize};

use crate::spec;

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Word {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
    pub text: String,
}

#[derive(Deserialize)]
pub struct StickerRequest {
    pub words: Vec<Word>,
    /// Row-grouping tolerance in points (1.5 for pdftotext's word boxes).
    #[serde(default)]
    pub y_tol: Option<f64>,
}

#[derive(Serialize, Default)]
pub struct Overview {
    #[serde(skip_serializing_if = "Option::is_none")] pub vin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub model_line: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub trim_drivetrain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub seating_capacity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub engine: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub transmission: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub exterior_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub interior_trim: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub model: Option<String>,
    /// The trim a shopper would say ("Badlands", "XLT", "GT Premium"),
    /// from the year line with the model, body and drivetrain words
    /// taken out, or from the series in the seating line.
    #[serde(skip_serializing_if = "Option::is_none")] pub trim: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub body_style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub drivetrain: Option<String>,
    /// The model as a title uses it: no make, no drivetrain, and the
    /// Super Duty's F-250/F-350 put back in front.
    #[serde(skip_serializing_if = "Option::is_none")] pub model_name: Option<String>,
}

#[derive(Serialize, Default)]
pub struct Pricing {
    #[serde(skip_serializing_if = "Option::is_none")] pub base_price: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub destination_and_delivery: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub total_vehicle_and_options: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub total_msrp: Option<String>,
}

#[derive(Serialize)]
pub struct Sticker {
    pub overview: Overview,
    pub equipment: serde_json::Map<String, serde_json::Value>,
    pub optional_equipment: Vec<String>,
    pub warranties: Vec<String>,
    pub pricing: Pricing,
    /// Ford's "check back later" page: a well-formed PDF with no sticker.
    pub placeholder: bool,
    /// The make, found in the page furniture (spec sticker.makes).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub make: Option<String>,
}

// ---------------------------------------------------------------- text helpers

/// Python's str.title(): a character after a cased character is
/// lowercased, any other is uppercased.
pub fn py_title(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_cased = false;
    for ch in s.chars() {
        let cased = ch.is_uppercase() || ch.is_lowercase();
        if cased {
            if prev_cased { out.extend(ch.to_lowercase()); } else { out.extend(ch.to_uppercase()); }
        } else {
            out.push(ch);
        }
        prev_cased = cased;
    }
    out
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

fn upper(s: &str) -> String { s.to_uppercase() }

/// A word like "5.0L" or "2.3L": an engine line even without the word
/// ENGINE ("5.0L TI-VCT V8: GT 480HP").
fn has_displacement(up: &str) -> bool {
    up.split(|c: char| c.is_whitespace() || c == ':' || c == ',').any(|w| {
        let b = w.as_bytes();
        b.len() == 4 && b[0].is_ascii_digit() && b[1] == b'.' && b[2].is_ascii_digit() && b[3] == b'L'
    })
}

/// "10-Speed Automatic Trans 1,595.00" among the options, when the
/// description block names no transmission: the line, price dropped.
fn transmission_from(lines: &[String]) -> Option<String> {
    for l in lines {
        let up = upper(l);
        if up.contains("-SPEED") && (up.contains("AUTO") || up.contains("MANUAL") || up.contains("TRANS")) {
            let words: Vec<&str> = l.split_whitespace().filter(|w| !w.chars().all(|c| c.is_ascii_digit() || c == ',' || c == '.')).collect();
            return Some(words.join(" "));
        }
    }
    None
}

fn is_word_char(ch: char) -> bool { ch.is_alphanumeric() || ch == '_' }

/// `\bWORD\b` anywhere in `hay`.
fn has_word(hay: &str, word: &str) -> bool {
    let chars: Vec<char> = hay.chars().collect();
    let needle: Vec<char> = word.chars().collect();
    if needle.is_empty() || chars.len() < needle.len() { return false; }
    for start in 0..=chars.len() - needle.len() {
        if chars[start..start + needle.len()] != needle[..] { continue; }
        let before_ok = start == 0 || !is_word_char(chars[start - 1]);
        let end = start + needle.len();
        let after_ok = end == chars.len() || !is_word_char(chars[end]);
        if before_ok && after_ok { return true; }
    }
    false
}

/// `^\d{4}\b`.
fn starts_with_year(s: &str) -> bool {
    let chars: Vec<char> = s.chars().collect();
    chars.len() >= 4 && chars[..4].iter().all(|c| c.is_ascii_digit()) && (chars.len() == 4 || !is_word_char(chars[4]))
}

/// The barcode and QR blocks come through as "text" in a symbol font:
/// Private Use Area glyphs or raw control bytes.
fn is_garbage(text: &str) -> bool {
    if text.trim().is_empty() { return true; }
    text.chars().any(|ch| {
        let cp = ch as u32;
        (0xE000..=0xF8FF).contains(&cp) || cp < 0x20 || (0x7F..=0x9F).contains(&cp)
    })
}

fn row_text(row: &[&Word]) -> String {
    row.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ")
}

fn sort_words(words: &mut [&Word]) {
    words.sort_by(|a, b| a.y0.partial_cmp(&b.y0).unwrap().then(a.x0.partial_cmp(&b.x0).unwrap()));
}

/// Cluster words (sorted by (y0, x0)) into visual rows by y0 proximity.
fn group_rows<'a>(words: &[&'a Word], y_tol: f64) -> Vec<Vec<&'a Word>> {
    let mut rows: Vec<Vec<&Word>> = Vec::new();
    for &w in words {
        match rows.last_mut() {
            Some(last) if (w.y0 - last[0].y0).abs() <= y_tol => last.push(w),
            _ => rows.push(vec![w]),
        }
    }
    for row in rows.iter_mut() {
        row.sort_by(|a, b| a.x0.partial_cmp(&b.x0).unwrap());
    }
    rows
}

fn uppers(row: &[&Word]) -> Vec<String> { row.iter().map(|w| upper(&w.text)).collect() }

fn has_all(row: &[&Word], needed: &[&str]) -> bool {
    let u = uppers(row);
    needed.iter().all(|n| u.iter().any(|t| t == n))
}

/// A sticker equipment item occasionally wraps onto a second row with
/// no larger gap to signal it; punctuation is the only signal.
fn merge_continuations(lines: Vec<String>) -> Vec<String> {
    const ENDINGS: [char; 5] = [',', ':', '-', '/', '&'];
    let mut merged: Vec<String> = Vec::new();
    for line in lines {
        let starts_continuation = line.starts_with(['-', '/', '&', ':', ',']);
        let continues = merged.last().map(|m| m.trim_end().ends_with(ENDINGS)).unwrap_or(false);
        if !merged.is_empty() && (continues || starts_continuation) {
            let last = merged.last_mut().unwrap();
            *last = format!("{last} {line}");
        } else {
            merged.push(line);
        }
    }
    merged
}

// ---------------------------------------------------------------- overview

fn find_vin(full_text: &str) -> Option<String> {
    // `\b([A-HJ-NPR-Z0-9]{17})\b`: a maximal run of word characters that
    // is exactly 17 long and entirely in the class.
    let ok = |c: char| c.is_ascii_digit() || (c.is_ascii_uppercase() && !matches!(c, 'I' | 'O' | 'Q'));
    let mut run = String::new();
    let flush = |run: &mut String| -> Option<String> {
        let hit = if run.chars().count() == 17 && run.chars().all(ok) { Some(run.clone()) } else { None };
        run.clear();
        hit
    };
    for ch in full_text.chars() {
        if is_word_char(ch) { run.push(ch); } else if let Some(v) = flush(&mut run) { return Some(v); }
    }
    flush(&mut run)
}

fn parse_overview(words: &[&Word], rows: &[Vec<&Word>], y_tol: f64) -> Overview {
    let mut o = Overview::default();
    let full_text = row_text(words);
    o.vin = find_vin(&full_text);

    let header = rows.iter().find(|r| has_all(r, &["VEHICLE", "DESCRIPTION"]));
    let grid_header = rows.iter().find(|r| has_all(r, &["STANDARD", "EQUIPMENT"]));
    let Some(header) = header else { return o };
    let header_y = header[0].y0;
    let grid_y = grid_header.map(|g| g[0].y0).unwrap_or(header_y + 90.0);

    let left: Vec<&Word> = words.iter().cloned().filter(|w| header_y < w.y0 && w.y0 < grid_y && w.x0 < 420.0).collect();
    let block_rows = group_rows(&left, y_tol);
    if let Some(first) = block_rows.first() {
        o.model_line = Some(py_title(&row_text(first)));
    }
    let mut unclassified: Vec<String> = Vec::new();
    for row in block_rows.iter().skip(1) {
        let text = row_text(row);
        let up = upper(&text);
        if starts_with_year(&text) {
            o.trim_drivetrain = Some(py_title(&text));
        } else if up.contains("PASSENGER") {
            o.seating_capacity = Some(py_title(&text));
        } else if up.contains("ENGINE") || has_word(&up, "ECOBOOST") || has_displacement(&up) {
            o.engine = Some(py_title(&text));
        } else if up.contains("TRANSMISSION") || has_word(&up, "AUTO") || has_word(&up, "MANUAL") {
            o.transmission = Some(py_title(&text));
        } else {
            unclassified.push(text);
        }
    }

    let color: Vec<&Word> = words.iter().cloned().filter(|w| header_y < w.y0 && w.y0 < grid_y && 420.0 < w.x0 && w.x0 < 620.0).collect();
    let color_rows = group_rows(&color, y_tol);
    for (label, key) in [("EXTERIOR", 0), ("INTERIOR", 1)] {
        let Some(label_row) = color_rows.iter().find(|r| r.len() == 1 && upper(&r[0].text) == label) else { continue };
        let label_y = label_row[0].y0;
        if let Some(value_row) = color_rows.iter().find(|r| label_y < r[0].y0 && r[0].y0 < label_y + 15.0) {
            let v = Some(py_title(&row_text(value_row)));
            if key == 0 { o.exterior_color = v } else { o.interior_trim = v }
        }
    }

    if let (Some(model_line), Some(trim)) = (&o.model_line, &o.trim_drivetrain) {
        let parts: Vec<&str> = trim.split_whitespace().collect();
        if let Some(first) = parts.first() {
            o.model = Some(format!("{} {} {}", first, model_line, parts[1..].join(" ")));
        }
    }
    // "XLT SERIES" under the equipment group (F-150), or the Super Duty's
    // "LARIAT 176" WB STYLESIDE" line in the description block.
    let mut series: Option<String> = None;
    for row in rows {
        let Some(j) = row.iter().position(|w| upper(&w.text) == "SERIES" && w.x0 < 420.0) else { continue };
        let x = row[j].x0;
        let before: Vec<&str> = row[..j].iter().filter(|w| w.x0 > x - 200.0).map(|w| w.text.as_str()).collect();
        if !before.is_empty() && before.len() <= 3 { series = Some(before.join(" ")); break; }
    }
    if series.is_none() {
        for line in &unclassified {
            let words: Vec<&str> = line.split_whitespace().collect();
            if !words.iter().any(|w| upper(w) == "WB") { continue; }
            let lead: Vec<&str> = words.iter().take_while(|w| !w.chars().any(|c| c.is_ascii_digit())).copied().collect();
            if !lead.is_empty() { series = Some(lead.join(" ")); break; }
        }
    }
    identity(&mut o, series);
    o
}

// ---------------------------------------------------------------- trim / body / drivetrain

const DRIVES: [&str; 7] = ["4X4", "4X2", "FWD", "AWD", "RWD", "4WD", "2WD"];
const MAKES: [&str; 2] = ["FORD", "LINCOLN"];

fn drive_word(up: &str) -> Option<&'static str> { DRIVES.iter().find(|d| **d == up).copied() }

/// Sticker shorthand for trim words, spelled the way the badge reads.
fn trim_word(w: &str) -> String {
    let up = upper(w);
    let fixed = match up.as_str() {
        "XLT" | "XL" | "SE" | "SEL" | "ST" | "GT" | "SVT" | "FX4" | "STX" | "ST-LINE" | "I" | "II" | "III" => None,
        "LTD" => Some("Limited"),
        "KNG" => Some("King"),
        "TIMBERLNE" => Some("Timberline"),
        "PLAT" => Some("Platinum"),
        "ECOBOOST" => Some("EcoBoost"),
        _ => Some(""),
    };
    match fixed {
        None => if up == "ST-LINE" { "ST-Line".into() } else { up },
        Some("") => py_title(w),
        Some(x) => x.into(),
    }
}

fn identity(o: &mut Overview, series: Option<String>) {
    let model_line = o.model_line.clone().unwrap_or_default();
    let model_words: Vec<String> = model_line.split_whitespace().map(upper).collect();
    let mut trim: Vec<String> = Vec::new();
    let mut body: Vec<String> = Vec::new();
    let mut super_duty: Option<String> = None;

    if let Some(line) = &o.trim_drivetrain {
        let words: Vec<&str> = line.split_whitespace().collect();
        let mut i = 0;
        if words.first().map(|w| w.len() == 4 && w.chars().all(|c| c.is_ascii_digit())).unwrap_or(false) { i = 1; }
        while i < words.len() {
            let raw = words[i];
            let mut up = upper(raw);
            let next = words.get(i + 1).map(|w| upper(w)).unwrap_or_default();
            i += 1;
            // "St-Line-Awd": a drivetrain glued on with a hyphen.
            if let Some(pos) = up.rfind('-') {
                if let Some(d) = drive_word(&up[pos + 1..]) {
                    if o.drivetrain.is_none() { o.drivetrain = Some(d.into()); }
                    up.truncate(pos);
                }
            }
            if up.is_empty() || up == "-" { continue; }
            if let Some(d) = drive_word(&up) { if o.drivetrain.is_none() { o.drivetrain = Some(d.into()); } continue; }
            if up == "ADVANCED" && drive_word(&next).is_some() { continue; }
            match up.as_str() {
                "SUPERCREW" => { body.push("SuperCrew".into()); continue; }
                "SUPERCAB" => { body.push("SuperCab".into()); continue; }
                "REGULAR" | "CREW" if next == "CAB" => { body.push(format!("{} Cab", py_title(raw))); i += 1; continue; }
                "COUPE" | "CONVERTIBLE" | "FASTBACK" | "VAN" | "WAGON" => { body.push(py_title(raw)); continue; }
                // Super Duty rear wheels, Transit roof heights and seats, bed length.
                "DRW" | "SRW" | "MR" | "HR" | "LR" | "PASS" | "CARGO" | "BOX" => continue,
                "EXPED." | "EXPED" => continue,
                _ => {}
            }
            if up.ends_with("-DOOR") { body.push(py_title(raw)); continue; }
            if up.contains('\'') || up.chars().all(|c| c.is_ascii_digit()) { continue; }
            // F350, F-150: the model, not the trim.
            let bare = up.replace('-', "");
            if bare.len() == 4 && bare.starts_with('F') && bare[1..].chars().all(|c| c.is_ascii_digit()) {
                super_duty = Some(format!("F-{}", &bare[1..]));
                continue;
            }
            if model_words.contains(&up) || MAKES.contains(&up.as_str()) { continue; }
            // "St Line" reads as the badge does: "ST-Line".
            if up == "LINE" && trim.last().map(|t| t == "ST").unwrap_or(false) { trim.pop(); trim.push("ST-Line".into()); continue; }
            trim.push(trim_word(if up.len() < raw.len() { &raw[..up.len()] } else { raw }));
        }
    }
    if trim.is_empty() {
        if let Some(sr) = &series {
            trim = sr.split_whitespace().filter(|w| !model_words.contains(&upper(w))).map(trim_word).collect();
        }
    }
    if trim.is_empty() {
        // "Badlands - 4 Passenger", "Limited 7-Passenger": the series.
        if let Some(seat) = &o.seating_capacity {
            let mut series = Vec::new();
            for w in seat.split_whitespace() {
                let up = upper(w);
                if up == "-" || up.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) || up.contains("PASSENGER") { break; }
                series.push(trim_word(w));
            }
            trim = series;
        }
    }
    if !trim.is_empty() { o.trim = Some(trim.join(" ")); }
    if !body.is_empty() { o.body_style = Some(body.join(" ")); }

    let mut name: Vec<String> = model_line.split_whitespace()
        .filter(|w| !MAKES.contains(&upper(w).as_str()) && drive_word(&upper(w)).is_none())
        .map(|w| w.to_string()).collect();
    if let Some(f) = super_duty {
        if upper(&model_line) == "SUPER DUTY" { name.insert(0, f); }
    }
    if !name.is_empty() { o.model_name = Some(name.join(" ")); }
}

// ---------------------------------------------------------------- equipment grid

const COLUMNS: [(&str, &str); 4] = [
    ("EXTERIOR", "exterior"), ("INTERIOR", "interior"), ("FUNCTIONAL", "functional_tech"), ("SAFETY/SECURITY", "safety_security"),
];

fn column_key(label: &str) -> &'static str {
    COLUMNS.iter().find(|(l, _)| *l == label).map(|(_, k)| *k).unwrap_or("")
}

fn parse_equipment_grid(rows: &[Vec<&Word>]) -> (Vec<(String, Vec<String>)>, Vec<String>) {
    let header = rows.iter().find(|r| {
        has_all(r, &["EXTERIOR", "INTERIOR", "FUNCTIONAL"]) && r.iter().any(|w| upper(&w.text).contains("SAFETY"))
    });
    let Some(header) = header else { return (Vec::new(), Vec::new()) };

    let mut col_starts: Vec<(f64, String)> = header.iter()
        .map(|w| (w.x0, upper(&w.text)))
        .filter(|(_, t)| COLUMNS.iter().any(|(l, _)| l == t))
        .collect();
    col_starts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap().then(a.1.cmp(&b.1)));
    let last_gap = if col_starts.len() > 1 { col_starts[col_starts.len() - 1].0 - col_starts[col_starts.len() - 2].0 } else { 160.0 };
    let bounds: Vec<(String, f64, f64)> = col_starts.iter().enumerate().map(|(i, (x0, label))| {
        let x1 = if i + 1 < col_starts.len() { col_starts[i + 1].0 } else { x0 + last_gap };
        (label.clone(), x0 - 2.0, x1 - 2.0)
    }).collect();

    let end_row = rows.iter().find(|r| has_all(r, &["INCLUDED", "ON", "THIS", "VEHICLE"]));
    let y_end = end_row.map(|r| r[0].y0).unwrap_or(1e9);
    let header_y = header[0].y0;

    let mut grid = Vec::new();
    let mut warranty_lines: Vec<String> = Vec::new();
    for (label, x0, x1) in &bounds {
        let in_band = |w: &&Word| *x0 <= w.x0 && w.x0 < *x1;
        let mut col_rows: Vec<&Vec<&Word>> = rows.iter()
            .filter(|r| header_y < r[0].y0 && r[0].y0 < y_end && r.iter().any(in_band))
            .collect();
        let band_text = |r: &Vec<&Word>| row_text(&r.iter().cloned().filter(in_band).collect::<Vec<_>>());

        let warranty_row = col_rows.iter().find(|r| r.iter().any(|w| upper(&w.text) == "WARRANTY" && in_band(&w)));
        if let Some(wr) = warranty_row {
            let wy = wr[0].y0;
            let raw: Vec<String> = col_rows.iter().filter(|r| r[0].y0 > wy).map(|r| band_text(r))
                .filter(|l| !l.trim().is_empty()).collect();
            warranty_lines = merge_continuations(raw);
            col_rows.retain(|r| r[0].y0 < wy);
        }
        let lines: Vec<String> = col_rows.iter().map(|r| band_text(r)).filter(|l| !l.trim().is_empty()).collect();
        let lines = merge_continuations(lines);
        grid.push((column_key(label).to_string(), lines.iter().map(|l| py_title(l)).collect()));
    }
    (grid, warranty_lines)
}

/// `(\d+)YR/([\d,]+)\s+(.*)` matched at the start of `raw`.
fn format_warranty(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let mut i = 0;
    while i < chars.len() && chars[i].is_ascii_digit() { i += 1; }
    let years: String = chars[..i].iter().collect();
    let rest: String = chars[i..].iter().collect();
    let parsed = (|| {
        if years.is_empty() || !rest.starts_with("YR/") { return None; }
        let after = &rest[3..];
        let miles_len = after.chars().take_while(|c| c.is_ascii_digit() || *c == ',').count();
        if miles_len == 0 { return None; }
        let miles: String = after.chars().take(miles_len).collect();
        let tail: String = after.chars().skip(miles_len).collect();
        let ws = tail.chars().take_while(|c| c.is_whitespace()).count();
        if ws == 0 { return None; }
        let label: String = tail.chars().skip(ws).take_while(|c| *c != '\n').collect();
        Some((miles, label))
    })();
    let Some((miles, label)) = parsed else { return py_title(raw) };
    let mut label = label.replace("BUMPER / BUMPER", "Bumper-to-Bumper").trim().to_string();
    let first_upper = label.chars().next().map(|c| c.is_uppercase()).unwrap_or(false);
    if (!label.is_empty() && !first_upper) || is_upper(&label) {
        label = py_title(&label);
    }
    // " -(\S)" -> " - \1": a hyphen with a preceding space gets a space after.
    let mut fixed = String::with_capacity(label.len() + 4);
    let lc: Vec<char> = label.chars().collect();
    let mut i = 0;
    while i < lc.len() {
        if lc[i] == ' ' && i + 2 < lc.len() + 1 && i + 1 < lc.len() && lc[i + 1] == '-' && i + 2 < lc.len() && !lc[i + 2].is_whitespace() {
            fixed.push_str(" - ");
            i += 2;
            continue;
        }
        fixed.push(lc[i]);
        i += 1;
    }
    format!("{years}-Year / {miles}-Mile {fixed}")
}

// ---------------------------------------------------------------- pricing / options

fn find_label(row: &[&Word], label: &[&str]) -> Option<usize> {
    let texts = uppers(row);
    if texts.len() < label.len() { return None; }
    (0..=texts.len() - label.len()).find(|&i| texts[i..i + label.len()].iter().zip(label).all(|(t, l)| t == l)).map(|i| i + label.len())
}

/// `\$?[\d,]+\.\d{2}` as a full match.
fn is_money(s: &str) -> bool {
    let s = s.strip_prefix('$').unwrap_or(s);
    let chars: Vec<char> = s.chars().collect();
    let n = chars.iter().take_while(|c| c.is_ascii_digit() || **c == ',').count();
    n >= 1 && chars.len() == n + 3 && chars[n] == '.' && chars[n + 1].is_ascii_digit() && chars[n + 2].is_ascii_digit()
}

fn money_after(rows: &[Vec<&Word>], label: &[&str]) -> Option<String> {
    for row in rows {
        let Some(start) = find_label(row, label) else { continue };
        for w in &row[start..] {
            if is_money(w.text.trim_matches('$')) {
                return Some(if w.text.starts_with('$') { w.text.clone() } else { format!("${}", w.text) });
            }
        }
    }
    None
}

fn parse_pricing(rows: &[Vec<&Word>]) -> Pricing {
    Pricing {
        base_price: money_after(rows, &["BASE", "PRICE"]),
        destination_and_delivery: money_after(rows, &["DESTINATION", "&", "DELIVERY"]),
        total_vehicle_and_options: money_after(rows, &["TOTAL", "VEHICLE", "&", "OPTIONS/OTHER"]),
        total_msrp: money_after(rows, &["TOTAL", "MSRP"]),
    }
}

fn parse_optional_equipment(words: &[&Word], rows: &[Vec<&Word>], y_tol: f64) -> Vec<String> {
    let header = rows.iter().find(|r| {
        let u = uppers(r);
        u.iter().any(|t| t == "OPTIONAL") && u.iter().any(|t| t.contains("EQUIPMENT"))
    });
    let end_row = rows.iter().find(|r| upper(&r[0].text) == "SOLD" && r.len() > 1 && upper(&r[1].text) == "TO");
    let Some(header) = header else { return Vec::new() };
    let header_y = header[0].y0;
    let y_end = end_row.map(|r| r[0].y0).unwrap_or(header_y + 70.0);
    let price_header = rows.iter().find(|r| upper(&r[0].text) == "PRICE" && r.len() > 1 && upper(&r[1].text) == "INFORMATION");
    let x_end = price_header.map(|r| r[0].x0 - 5.0).unwrap_or(450.0);
    let left: Vec<&Word> = words.iter().cloned().filter(|w| header_y < w.y0 && w.y0 < y_end && w.x0 < x_end).collect();
    let mut items = Vec::new();
    for r in group_rows(&left, y_tol) {
        let text = row_text(&r);
        let text = text.trim().trim_start_matches('.');
        if !text.is_empty() && !upper(text).contains("NO CHARGE") {
            items.push(py_title(text));
        }
    }
    items
}

// ---------------------------------------------------------------- entry points

/// Clean, sorted words: the garbage filter and the (y0, x0) order both
/// hosts' words go through before anything reads them.
fn prepare(words: &[Word]) -> Vec<&Word> {
    let mut out: Vec<&Word> = words.iter().filter(|w| !is_garbage(&w.text)).collect();
    sort_words(&mut out);
    out
}

pub fn parse_sticker(req: &StickerRequest) -> Sticker {
    let y_tol = req.y_tol.unwrap_or(1.5);
    let words = prepare(&req.words);
    let rows = group_rows(&words, y_tol);
    let full_text = row_text(&words);
    let lower = full_text.to_lowercase();
    let placeholder = spec::get(&["sticker", "placeholderMarkers"]).as_array().unwrap().iter()
        .any(|m| lower.contains(m.as_str().unwrap()));
    let up = upper(&full_text);
    let make = spec::get(&["sticker", "makes"]).as_array().unwrap().iter()
        .map(|m| m.as_str().unwrap()).find(|m| up.contains(m)).map(py_title);

    let overview = parse_overview(&words, &rows, y_tol);
    let (grid, warranty_raw) = parse_equipment_grid(&rows);
    let mut equipment = serde_json::Map::new();
    for (key, lines) in grid {
        equipment.insert(key, serde_json::Value::Array(lines.into_iter().map(serde_json::Value::String).collect()));
    }
    let optional_equipment = parse_optional_equipment(&words, &rows, y_tol);
    let mut overview = overview;
    if overview.transmission.is_none() {
        let mut all: Vec<String> = optional_equipment.clone();
        for v in equipment.values() { if let Some(a) = v.as_array() { all.extend(a.iter().filter_map(|x| x.as_str().map(String::from))); } }
        overview.transmission = transmission_from(&all);
    }
    Sticker {
        overview,
        equipment,
        optional_equipment,
        warranties: warranty_raw.iter().filter(|w| !w.trim().is_empty()).map(|w| format_warranty(w)).collect(),
        pricing: parse_pricing(&rows),
        placeholder,
        make,
    }
}

/// Where a two-panel landscape sticker's gutter sits: the widest
/// text-free vertical gap near the page's centre, in points, or None
/// for a single-flow page. Anchored below the VEHICLE DESCRIPTION row,
/// since the top margin's barcode metadata can span the gutter.
pub fn panel_split_x(words: &[Word], y_tol: f64, center_frac: f64, search_frac: f64, min_gap: f64) -> Option<f64> {
    let words = prepare(words);
    if words.is_empty() { return None; }
    let page_width = words.iter().map(|w| w.x1).fold(f64::MIN, f64::max);
    let center = page_width * center_frac;
    let band = page_width * search_frac;
    let (lo, hi) = (center - band, center + band);
    let rows = group_rows(&words, y_tol);
    let min_y = rows.iter().find(|r| has_all(r, &["VEHICLE", "DESCRIPTION"])).map(|r| r[0].y0).unwrap_or(0.0);
    let words: Vec<&Word> = words.into_iter().filter(|w| w.y0 >= min_y).collect();
    if words.is_empty() { return None; }
    let mut intervals: Vec<(f64, f64)> = words.iter().filter(|w| w.x1 > lo && w.x0 < hi).map(|w| (w.x0, w.x1)).collect();
    if intervals.is_empty() { return None; }
    intervals.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mut merged: Vec<(f64, f64)> = vec![intervals[0]];
    for &(x0, x1) in &intervals[1..] {
        let last = merged.last_mut().unwrap();
        if x0 <= last.1 { last.1 = last.1.max(x1); } else { merged.push((x0, x1)); }
    }
    let mut gaps: Vec<(f64, f64, f64)> = Vec::new();
    let mut prev_end = lo;
    for &(x0, x1) in &merged {
        gaps.push((x0 - prev_end, prev_end, x0));
        prev_end = x1;
    }
    gaps.push((hi - prev_end, prev_end, hi));
    gaps.sort_by(|a, b| b.partial_cmp(a).unwrap());
    let (best, start, end) = gaps[0];
    if best >= min_gap { Some((start + end) / 2.0) } else { None }
}
