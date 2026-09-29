//! Which shots a layout gets and in what order, from each cutout's
//! angle label and confidence (the classifier's angles.json on the CLI,
//! the browser's own classification in the app). The priorities come
//! from the spec's `select` block.
//!
//! This replaces the picking logic of imaging/select.py and the
//! browser's walkaround(); both hosts keep only the file IO (reading
//! angles.json, globbing a folder, the wheel shots) and call the op
//! `select_shots`.

use crate::spec;
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
pub struct Shot {
    pub name: String,
    #[serde(default)]
    pub angle: String,
    #[serde(default)]
    pub confidence: f64,
}

#[derive(Deserialize)]
pub struct SelectRequest {
    /// In the host's order (angles.json's order on the CLI, the order the
    /// photos were added in the browser); ties keep it.
    pub shots: Vec<Shot>,
    /// hero | layout | quad | conveyor | adaptive | carousel |
    /// carousel_all | walkaround | conveyor_start
    pub mode: String,
    #[serde(default)]
    pub layout: Option<String>,
    #[serde(default)]
    pub n_accents: Option<usize>,
    /// conveyor_start: the pairs to reseat, as (name, label) shots.
    #[serde(default)]
    pub pairs: Vec<Shot>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Selection {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layout: Option<String>,
    pub shots: Vec<Shot>,
}

fn list(key: &str) -> Vec<String> {
    spec::get(&["select", key]).as_array().expect("select list").iter()
        .map(|v| v.as_str().expect("angle label").to_string()).collect()
}

/// Best shot index per angle label, labels in first-seen order; a tie
/// keeps the earlier shot.
fn best_by_angle(shots: &[Shot]) -> Vec<(String, usize)> {
    let mut best: Vec<(String, usize)> = Vec::new();
    for (i, s) in shots.iter().enumerate() {
        match best.iter_mut().find(|(l, _)| *l == s.angle) {
            Some(slot) => if s.confidence > shots[slot.1].confidence { slot.1 = i },
            None => best.push((s.angle.clone(), i)),
        }
    }
    best
}

fn best_of(best: &[(String, usize)], label: &str) -> Option<usize> {
    best.iter().find(|(l, _)| l == label).map(|(_, i)| *i)
}

/// Indices sorted by confidence, highest first, ties in host order.
fn by_confidence(shots: &[Shot], idx: impl Iterator<Item = usize>) -> Vec<usize> {
    let mut v: Vec<usize> = idx.collect();
    v.sort_by(|a, b| shots[*b].confidence.partial_cmp(&shots[*a].confidence).unwrap_or(std::cmp::Ordering::Equal));
    v
}

/// [hero, accent, ...] for the single and corners layouts: the first
/// angle of heroPriority leads, accents are the best shot of each
/// accentPriority angle not yet used, then anything left by confidence.
pub fn hero_shots(shots: &[Shot], n_accents: usize) -> Vec<usize> {
    if shots.is_empty() {
        return vec![];
    }
    let best = best_by_angle(shots);
    let hero = list("heroPriority").iter().find_map(|a| best_of(&best, a)).unwrap_or(best[0].1);
    let mut selected = vec![hero];
    for label in list("accentPriority") {
        if selected.len() > n_accents {
            break;
        }
        if let Some(i) = best_of(&best, &label) {
            if !selected.contains(&i) {
                selected.push(i);
            }
        }
    }
    if selected.len() <= n_accents {
        for i in by_confidence(shots, (0..shots.len()).filter(|i| !selected.contains(i))) {
            if selected.len() > n_accents {
                break;
            }
            selected.push(i);
        }
    }
    selected.truncate(1 + n_accents);
    selected
}

/// [hero, front, back, side] for the quad layout; a role with no match
/// is left out rather than repeated.
pub fn quad(shots: &[Shot]) -> Vec<usize> {
    let best = best_by_angle(shots);
    let pick = |labels: &[&str]| labels.iter().find_map(|l| best_of(&best, l));
    let roles = [pick(&["front_3q", "front", "side"]), pick(&["front", "front_3q"]), pick(&["rear", "rear_3q"]), pick(&["side"])];
    let mut out = vec![];
    for i in roles.into_iter().flatten() {
        if !out.contains(&i) {
            out.push(i);
        }
    }
    out
}

/// [hero, left accent, right accent] for the conveyor still: front on
/// the left, tail on the right, each falling back to any distinct angle
/// left, best first.
pub fn conveyor(shots: &[Shot]) -> Vec<usize> {
    let best = best_by_angle(shots);
    let mut ranked: Vec<usize> = best.iter().map(|(_, i)| *i).collect();
    ranked.sort_by(|a, b| shots[*b].confidence.partial_cmp(&shots[*a].confidence).unwrap_or(std::cmp::Ordering::Equal));
    let mut used: Vec<usize> = vec![];
    let mut take = |preferred: &[String]| -> Option<usize> {
        let found = preferred.iter().filter_map(|l| best_of(&best, l)).find(|i| !used.contains(i))
            .or_else(|| ranked.iter().copied().find(|i| !used.contains(i)));
        if let Some(i) = found {
            used.push(i);
        }
        found
    };
    let hero = take(&list("heroPriority"));
    let left = take(&["front".to_string(), "front_3q".to_string()]);
    let right = take(&["rear".to_string(), "rear_3q".to_string()]);
    [hero, left, right].into_iter().flatten().collect()
}

/// quad when there are three distinct accents, corners with one or two,
/// single with none.
pub fn adaptive(shots: &[Shot]) -> (&'static str, Vec<usize>) {
    let q = quad(shots);
    match q.len().saturating_sub(1) {
        n if n >= 3 => ("quad", q),
        n if n >= 1 => ("corners", hero_shots(shots, n)),
        _ => ("single", hero_shots(shots, 0)),
    }
}

/// The best shot of every angle, front to rear by the walkaround order,
/// angles the order does not know after it in first-seen order.
pub fn carousel(shots: &[Shot]) -> Vec<usize> {
    let best = best_by_angle(shots);
    let order = list("walkaround");
    let mut out: Vec<usize> = order.iter().filter_map(|l| best_of(&best, l)).collect();
    out.extend(best.iter().filter(|(l, _)| !order.contains(l)).map(|(_, i)| *i));
    out
}

/// Every shot, grouped by the walkaround order (each angle's most
/// confident first), angles the order does not know after it.
pub fn carousel_all(shots: &[Shot]) -> Vec<usize> {
    let order = list("walkaround");
    let mut labels: Vec<&str> = order.iter().map(String::as_str).collect();
    for s in shots {
        if !labels.contains(&s.angle.as_str()) {
            labels.push(&s.angle);
        }
    }
    labels.iter().flat_map(|l| by_confidence(shots, (0..shots.len()).filter(|i| shots[*i].angle == *l))).collect()
}

/// The run's order for the browser's results and bundle: every shot in
/// walkaround order, with the hero (the best of the first heroPriority
/// angle present, the bundle's cover) moved to the front.
pub fn walkaround(shots: &[Shot]) -> Vec<usize> {
    let mut all = carousel_all(shots);
    let lead = list("heroPriority").iter().find_map(|a| all.iter().position(|i| shots[*i].angle == *a));
    if let Some(p) = lead {
        let i = all.remove(p);
        all.insert(0, i);
    }
    all
}

/// Reseat a conveyor clip's pairs so its first frame is the conveyor
/// still: hero first, its right accent second, its left accent last
/// (the conveyor draws left = last, hero = first, right = second). A run
/// is one full pass, so the last frame hands back to the first.
pub fn conveyor_start(pairs: &[Shot], shots: &[Shot]) -> Vec<Shot> {
    let picks: Vec<Option<&str>> = {
        let c = conveyor(shots);
        (0..3).map(|k| c.get(k).map(|i| shots[*i].name.as_str())).collect()
    };
    let (hero, left, right) = (picks[0], picks[1], picks[2]);
    let find = |n: Option<&str>| n.and_then(|n| pairs.iter().find(|p| p.name == n));
    let mut lead: Vec<&Shot> = [hero, right].into_iter().filter_map(|n| find(n)).collect();
    let tail: Vec<&Shot> = find(left).filter(|p| Some(p.name.as_str()) != hero && Some(p.name.as_str()) != right).into_iter().collect();
    let used: Vec<&str> = lead.iter().chain(tail.iter()).map(|p| p.name.as_str()).collect();
    let middle: Vec<&Shot> = pairs.iter().filter(|p| !used.contains(&p.name.as_str())).collect();
    lead.extend(middle);
    lead.extend(tail);
    lead.into_iter().cloned().collect()
}

pub fn select(req: &SelectRequest) -> Result<Selection, String> {
    let s = &req.shots;
    let pick = |idx: Vec<usize>| idx.into_iter().map(|i| s[i].clone()).collect::<Vec<_>>();
    let n = req.n_accents.unwrap_or(2);
    Ok(match req.mode.as_str() {
        "hero" => Selection { layout: None, shots: pick(hero_shots(s, n)) },
        "quad" => Selection { layout: None, shots: pick(quad(s)) },
        "conveyor" => Selection { layout: None, shots: pick(conveyor(s)) },
        "layout" => {
            let layout = req.layout.as_deref().unwrap_or("corners");
            let idx = match layout { "quad" => quad(s), "single" => hero_shots(s, 0), _ => hero_shots(s, n) };
            Selection { layout: None, shots: pick(idx) }
        }
        "adaptive" => {
            let (layout, idx) = adaptive(s);
            Selection { layout: Some(layout.to_string()), shots: pick(idx) }
        }
        "carousel" => Selection { layout: None, shots: pick(carousel(s)) },
        "carousel_all" => Selection { layout: None, shots: pick(carousel_all(s)) },
        "walkaround" => Selection { layout: None, shots: pick(walkaround(s)) },
        "conveyor_start" => Selection { layout: None, shots: conveyor_start(&req.pairs, s) },
        other => return Err(format!("unknown select mode {other:?}")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shots(v: &[(&str, &str, f64)]) -> Vec<Shot> {
        v.iter().map(|(n, a, c)| Shot { name: n.to_string(), angle: a.to_string(), confidence: *c }).collect()
    }
    fn names(s: &[Shot], idx: &[usize]) -> Vec<String> { idx.iter().map(|i| s[*i].name.clone()).collect() }

    #[test]
    fn the_front_three_quarter_leads_and_accents_differ() {
        let s = shots(&[("a", "side", 0.9), ("b", "front_3q", 0.7), ("c", "front_3q", 0.8), ("d", "rear", 0.6)]);
        assert_eq!(names(&s, &hero_shots(&s, 2)), ["c", "a", "d"]);
        assert_eq!(names(&s, &walkaround(&s)), ["c", "b", "a", "d"]);
        assert_eq!(adaptive(&s).0, "corners");
    }

    #[test]
    fn a_maverick_with_three_angles_takes_corners_not_a_hollow_quad() {
        let s = shots(&[("a", "front_3q", 0.9), ("b", "rear_3q", 0.9), ("c", "side", 0.9)]);
        let (layout, idx) = adaptive(&s);
        assert_eq!(layout, "corners");
        assert_eq!(idx.len(), 3);
    }
}

/// A cutout's 64-bit difference hash (9x8 grey over a mid-grey ground,
/// so the transparent surround reads the same in every shot) and its
/// aspect: what says two cutouts are the same shot, a re-save or a
/// resized copy, rather than two views of one car. It hashes the cut-out
/// car, not the photo: on a dealer's studio photos the backdrop dominates
/// a whole-photo hash and different angles sit within a few bits.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Signature {
    /// 16 hex digits, row-major, bit 63 first.
    pub hash: String,
    pub aspect: f64,
}

pub fn shot_signature(img: &crate::Image) -> Signature {
    // Flatten onto mid grey, then down in steps: straight to 9x8 aliases,
    // and a resized copy of one shot then lands ten bits from itself.
    let mut grey = crate::Image::new(img.width, img.height, 3);
    for i in 0..img.width * img.height {
        let px = &img.data[i * img.channels..(i + 1) * img.channels];
        let a = if img.channels == 4 { px[3] as u32 } else { 255 };
        for c in 0..3 {
            let v = if img.channels == 1 { px[0] } else { px[c] } as u32;
            grey.data[i * 3 + c] = ((v * a + 128 * (255 - a) + 127) / 255) as u8;
        }
    }
    let mut small = grey;
    for (w, h) in [(144, 128), (36, 32), (9, 8)] {
        small = crate::resize::resize_lanczos(&small, w, h);
    }
    let lum = |i: usize| {
        let p = &small.data[i * 3..i * 3 + 3];
        p[0] as f64 * 0.299 + p[1] as f64 * 0.587 + p[2] as f64 * 0.114
    };
    let mut bits = 0u64;
    for y in 0..8 {
        for k in 0..8 {
            bits = (bits << 1) | (lum(y * 9 + k) > lum(y * 9 + k + 1)) as u64;
        }
    }
    Signature { hash: format!("{bits:016x}"), aspect: img.width as f64 / img.height.max(1) as f64 }
}

/// Bits apart, or None when the aspects differ by more than the spec's
/// share (a different crop is a different shot whatever the hash says).
pub fn signature_distance(a: &Signature, b: &Signature) -> Option<u32> {
    let max_aspect = spec::f64_at(&["select", "sameShot", "maxAspectDiff"]);
    if (a.aspect - b.aspect).abs() / a.aspect.max(b.aspect) > max_aspect {
        return None;
    }
    let (x, y) = (u64::from_str_radix(&a.hash, 16).ok()?, u64::from_str_radix(&b.hash, 16).ok()?);
    Some((x ^ y).count_ones())
}

/// The first of `earlier` that `sig` repeats, by index.
pub fn same_shot(sig: &Signature, earlier: &[Signature]) -> Option<usize> {
    let max_bits = spec::f64_at(&["select", "sameShot", "maxBits"]) as u32;
    earlier.iter().position(|e| signature_distance(sig, e).is_some_and(|d| d <= max_bits))
}
