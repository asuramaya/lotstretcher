//! The Studio's control values (the app's keys, which the CLI's flags
//! are converted to) as the fields the core's requests take: the text
//! plan, the drawn frame, the spotlight, shadow and reflection, and the
//! generated backdrop's colours. One op, `styles`, for both hosts.
//!
//! This replaces the matching functions of imaging/text.py and
//! web/public/js/lib/text.js, which were the same mapping written twice
//! and had drifted: the JS ignored the CLI's frameStyle and read only a
//! literal false as the spotlight off. The CLI's reading is kept. A lever
//! left out falls back to the spec's control default, except the title
//! and the price badge, whose absence means none was asked for.

use crate::listing::truthy;
use crate::spec;
use serde_json::{json, Map, Value};

const PIECES: [&str; 3] = ["title", "subtitle", "badge"];
const PIECE_LEVERS: [&str; 5] = ["font", "position", "color", "case", "box"];

/// controls.groups[].controls[key].default.
fn default(key: &str) -> Value {
    spec::get(&["controls", "groups"]).as_array().into_iter().flatten()
        .flat_map(|g| g.get("controls").and_then(Value::as_array).into_iter().flatten())
        .find(|c| c.get("key").and_then(Value::as_str) == Some(key))
        .and_then(|c| c.get("default").cloned())
        .unwrap_or(Value::Null)
}

fn get<'a>(o: &'a Value, key: &str) -> &'a Value { o.get(key).unwrap_or(&Value::Null) }

fn or(a: &Value, b: Value) -> Value { if truthy(a) { a.clone() } else { b } }

/// A number lever: its value, a numeric string's, or the default.
fn num(o: &Value, key: &str) -> f64 {
    let parse = |v: &Value| match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    };
    parse(get(o, key)).or_else(|| parse(&default(key))).unwrap_or(0.0)
}

fn unset(v: &Value) -> bool { v.is_null() || v.as_str() == Some("") }

/// One piece's own levers (titleFont, titlePosition, ...) as the core's
/// PieceStyle: only what departs from the shared lever; "same", "" and
/// null all mean the shared one.
pub fn piece_style(o: &Value, piece: &str) -> Value {
    let mut out = Map::new();
    for lever in PIECE_LEVERS {
        let key = format!("{piece}{}{}", lever[..1].to_uppercase(), &lever[1..]);
        let v = get(o, &key);
        if unset(v) || v.as_str() == Some("same") {
            continue;
        }
        if lever == "box" {
            out.insert("boxed".into(), json!(v.as_str() == Some("on") || v == &Value::Bool(true)));
        } else {
            out.insert(lever.into(), v.clone());
        }
    }
    Value::Object(out)
}

pub fn text_options(o: &Value) -> Value {
    let shadow = get(o, "textShadow");
    json!({
        "font": or(get(o, "textFont"), default("textFont")),
        "badge_size": num(o, "badgeSize"),
        "title_style": piece_style(o, "title"),
        "badge_style": piece_style(o, "badge"),
        "subtitle_style": piece_style(o, "subtitle"),
        "title": or(get(o, "titleMode"), json!("none")),
        "custom_title": or(get(o, "titleText"), Value::Null),
        "price_badge": truthy(get(o, "priceBadge")),
        "subtitle": or(get(o, "subtitle"), Value::Null),
        "position": or(get(o, "textPosition"), default("textPosition")),
        "color": or(get(o, "textColor"), default("textColor")),
        "size": num(o, "textSize"),
        "case": or(get(o, "textCase"), default("textCase")),
        "boxed": truthy(get(o, "textBoxed")),
        "shadow": if shadow.is_null() { true } else { truthy(shadow) },
        "subtitle_size": num(o, "subtitleSize"),
    })
}

pub fn wants_text(text: &Value) -> bool {
    get(text, "title").as_str().unwrap_or("none") != "none" || truthy(get(text, "price_badge")) || truthy(get(text, "subtitle"))
}

/// Every font the plan draws with: the shared one and each piece's own.
pub fn fonts_in(text: &Value) -> Vec<Value> {
    let mut names = vec![or(get(text, "font"), default("textFont"))];
    for p in PIECES {
        let own = get(get(text, &format!("{p}_style")), "font");
        if truthy(own) && !names.contains(own) {
            names.push(own.clone());
        }
    }
    names
}

/// The drawn frame the app's Frame picker ("line") or the CLI's
/// --frame-style asks for, or null.
pub fn frame_style(o: &Value) -> Value {
    if get(o, "border").as_str() != Some("line") && get(o, "frameStyle").as_str() != Some("line") {
        return Value::Null;
    }
    json!({"kind": "line", "color": or(get(o, "frameColor"), default("frameColor")),
           "weight": num(o, "frameWeight"), "inset": num(o, "frameInset"), "radius": num(o, "frameRadius")})
}

/// false when off; true for the measured dim and the spec's spread;
/// else {strength, spread} with whichever levers are set.
pub fn spotlight_style(o: &Value) -> Value {
    if o.get("spotlight").is_some_and(|v| !truthy(v)) {
        return json!(false);
    }
    let mut out = Map::new();
    for (key, name) in [("spotStrength", "strength"), ("spotSpread", "spread")] {
        let v = get(o, key);
        if !unset(v) {
            if let Some(f) = v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())) {
                out.insert(name.into(), json!(f));
            }
        }
    }
    if out.is_empty() { json!(true) } else { Value::Object(out) }
}

fn strength_style(o: &Value, on: &str, strength: &str) -> Value {
    if !truthy(get(o, on)) { Value::Null } else { json!({"strength": num(o, strength)}) }
}

/// The generated backdrop's kind and the colours and angle of the
/// user's own that it takes: colours only for the coloured kinds (the
/// vehicle backdrop is the paint's), an angle only for the linear ones.
pub fn backdrop(o: &Value) -> Value {
    // Colours and angle follow the kind asked for; none asked, none apply.
    let k = get(o, "backdrop").as_str().unwrap_or("");
    let kind = or(get(o, "backdrop"), default("backdrop"));
    let listed = |name: &str| spec::get(&["compose", name]).as_array().is_some_and(|a| a.iter().any(|v| v.as_str() == Some(k)));
    let colour = |key: &str| {
        let c = get(o, key).as_str().unwrap_or("").trim().to_string();
        if listed("colouredBackdrops") && !c.is_empty() { json!(c) } else { Value::Null }
    };
    let a = get(o, "backdropAngle");
    let angle = if listed("angledBackdrops") && !unset(a) {
        a.as_f64().or_else(|| a.as_str().and_then(|s| s.trim().parse().ok())).map_or(Value::Null, |f| json!(f))
    } else { Value::Null };
    json!({"kind": kind, "color": colour("backdropColor"), "color2": colour("backdropColor2"), "angle": angle})
}

fn in_list(name: &str, kind: &str) -> bool {
    spec::get(&["compose", name]).as_array().is_some_and(|a| a.iter().any(|v| v.as_str() == Some(kind)))
}

/// The core's background field for a generated backdrop of `kind`: the
/// paint's names for every kind but the seeded hue bands, the user's own
/// stops for the coloured kinds, a fixed direction for the linear ones.
pub fn backdrop_spec(kind: &str, seed: &str, exterior: &Value, interior: &Value, color: &Value, color2: &Value, angle: &Value) -> Result<Value, String> {
    if !in_list("backdrops", kind) {
        let known: Vec<&str> = spec::get(&["compose", "backdrops"]).as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        return Err(format!("unknown backdrop {kind:?}; one of {}", known.join(", ")));
    }
    let mut out = Map::new();
    out.insert("kind".into(), json!(kind));
    out.insert("seed".into(), json!(seed));
    if kind != "generic" {
        out.insert("exterior".into(), exterior.clone());
        out.insert("interior".into(), interior.clone());
    }
    if in_list("colouredBackdrops", kind) {
        if truthy(color) { out.insert("color".into(), color.clone()); }
        if truthy(color2) { out.insert("color2".into(), color2.clone()); }
    }
    if in_list("angledBackdrops", kind) {
        if let Some(a) = angle.as_f64().or_else(|| angle.as_str().and_then(|s| s.trim().parse().ok())) { out.insert("angle".into(), json!(a)); }
    }
    Ok(Value::Object(out))
}

/// The names a turning clip gradient reads its two stops from: the
/// user's own for a coloured kind (one colour given is both stops),
/// else the paint's. The same stops the still's backdrop takes; the CLI's
/// clip used to drop a second colour.
pub fn gradient_names(kind: &str, exterior: &Value, interior: &Value, color: &Value, color2: &Value) -> (Value, Value) {
    if in_list("colouredBackdrops", kind) && (truthy(color) || truthy(color2)) {
        let a = if truthy(color) { color.clone() } else { color2.clone() };
        let b = if truthy(color2) { color2.clone() } else { color.clone() };
        return (a, b);
    }
    (exterior.clone(), interior.clone())
}

pub fn styles(o: &Value) -> Value {
    let text = text_options(o);
    json!({
        "wants_text": wants_text(&text),
        "fonts": fonts_in(&text),
        "text": text,
        "border_style": frame_style(o),
        "spotlight": spotlight_style(o),
        "shadow": strength_style(o, "shadow", "shadowStrength"),
        "reflection": strength_style(o, "reflection", "reflectionStrength"),
        "backdrop": backdrop(o),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_levers_mean_the_defaults_and_absent_words_mean_none() {
        let s = styles(&json!({}));
        assert_eq!(s["text"]["title"], "none");
        assert_eq!(s["text"]["price_badge"], false);
        assert_eq!(s["wants_text"], false);
        assert_eq!(s["spotlight"], true);
        assert_eq!(s["border_style"], Value::Null);
        assert_eq!(s["text"]["size"], 0.05);
    }

    #[test]
    fn a_piece_keeps_only_what_departs() {
        let s = styles(&json!({"titleMode": "vehicle", "titleFont": "Oswald", "titleColor": "same", "badgeBox": "on", "frameStyle": "line", "spotlight": 0}));
        assert_eq!(s["text"]["title_style"], json!({"font": "Oswald"}));
        assert_eq!(s["text"]["badge_style"], json!({"boxed": true}));
        assert_eq!(s["fonts"], json!(["Lato Bold", "Oswald"]));
        assert_eq!(s["border_style"]["kind"], "line");
        assert_eq!(s["spotlight"], false);
    }
}
