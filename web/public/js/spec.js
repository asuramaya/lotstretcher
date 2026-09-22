/* Loader for shared/pipeline-spec.json, the same file the Python
 * pipeline reads through src/lotstretcher/spec.py.
 *
 * WHY: the two surfaces are necessarily two implementations, but they
 * must not be two SPECIFICATIONS. This client used to carry its own
 * JavaScript copies of HERO_STILL_FORMATS, VIDEO_FORMATS, the palette
 * bands, the glow colours and the cutout gates. Nothing would have
 * caught those drifting from the Python except someone noticing that
 * the website and the CLI produced different output, which is the kind
 * of bug a customer finds rather than a test.
 *
 * The spec is fetched once at startup and awaited before anything reads
 * it, so no module has to hold a stale default. */

const SPEC_URL = 'spec/pipeline-spec.json';

let spec = null;
let loading = null;

export async function loadSpec() {
  if (spec) return spec;
  if (loading) return loading;
  loading = fetch(SPEC_URL)
    .then((r) => {
      if (!r.ok) throw new Error(`${r.status} loading the pipeline spec`);
      return r.json();
    })
    .then((json) => { spec = json; loading = null; return spec; });
  return loading;
}

/* Supply the spec directly, for code running outside a page: the parity
 * tests run the JS normalisers under node against the same file. */
export function loadSpecFrom(json) {
  spec = json;
  return spec;
}

/* Synchronous read, for code that runs after loadSpec() has resolved.
 * Throws rather than returning a default, because a silent fallback is
 * exactly the drift this file exists to prevent: the browser would carry
 * on with a number the Python side does not have. */
export function get(...path) {
  if (!spec) throw new Error('pipeline spec not loaded yet -- await loadSpec() first');
  let node = spec;
  for (const key of path) {
    if (node == null || !(key in node)) {
      throw new Error(`pipeline spec is missing ${path.join('.')}`);
    }
    node = node[key];
  }
  return node;
}

/* Same as get(), but tolerates absence. Only for values that genuinely
 * have a browser-only meaning. */
export function maybe(path, fallback) {
  try { return get(...path); } catch { return fallback; }
}

export function isLoaded() { return spec !== null; }

/* {name: {size, label, note, ...}} for heroStillFormats or videoFormats. */
export function formats(section) {
  return get(section, 'formats');
}

export function defaultFormat(section) {
  return get(section, 'default');
}
