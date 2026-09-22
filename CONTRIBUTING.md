# Contributing to lotstretcher

Thank you for your interest in contributing to **lotstretcher**!

## Development Setup

1. **Clone the repository**:
   ```bash
   git clone https://github.com/your-org/lotstretcher.git
   cd lotstretcher
   ```

2. **Set up a virtual environment** (Python 3.11+ required):
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   pip install --upgrade pip
   pip install -e ".[dev]"
   playwright install chromium
   ```

3. **System Dependencies**:
   - Ensure `ffmpeg` is installed on your system if you are testing video generation.

## Project Guidelines

- **One App, Two Hosts**: the browser client in `web/` is the *same files* whether `lotstretcher.org` serves it from a CDN or `lotstretcher-serve` mounts it locally. There is no second build and no "server edition" of the UI. A fix lands in both at once, and a control added to one appears in the other because it is the other. What differs is **capabilities, not code**: the app asks its host `/capabilities` and unlocks what that host can actually do, so gated features (scraping, inventory sync, batch, GPU upscaling) live in the same source as everything else and are switched off when a browser is on its own. Add a control to the UI and to the CLI in the same change; they are two doors onto one pipeline.
- **One Specification**: two implementations (Python and JavaScript) are unavoidable; two specifications are not. Every constant both sides need lives in `shared/pipeline-spec.json` and is READ by both, through `src/lotstretcher/spec.py` and `web/public/js/spec.js`. Never retype a value into the other language. `tests/test_spec_parity.py` enforces this and will fail if a format size reappears as a literal in `options.js`. After editing the spec, run `python3 web/sync-spec.py`.
- **No Admin UI On The Self-Hosted Side**: the browser client above is a deliberate, separate product surface. That is *not* an invitation to bolt dashboards, admin panels, or management consoles onto the CLI or server mode, nor to add vector search / RAG layers. An API surface for programmatic integration is a different thing from an operator UI, and the self-hosted side stays headless.
- **Resilient Scraping**: Dealership websites are dynamic and frequently sit behind Cloudflare challenges. Scrapers must fail gracefully without throwing uncaught exceptions on missing optional fields.
- **Dealer-Agnostic Core**: Keep core post generators and composition logic dealer-agnostic via `dealer_config.py`. Never hardcode dealership-specific names, addresses, or phone numbers in library modules.

## Testing

Run all unit tests and regression test suites before submitting a pull request:

```bash
# 1. Run unit tests
pytest tests/

# 2. Run scrape regression tests (against checked-in HTML fixtures)
python scrape_regression.py

# 3. Run imaging regression tests (if GPU/models are available)
python regression.py
```

When adding support for a new vehicle edge case or CMS feature, add a corresponding test under `tests/` or a new fixture under `scrape_fixtures/`.

## Adding a CMS Extractor

If adding support for a new dealership CMS platform (e.g., Dealer.com, CDK Global, DealerOn):
1. Register the extractor in `scrape.py` using `register_extractor(name, marker, validator)`.
2. Ensure `normalize_vehicle()` cleanly maps the CMS payload to the unified `Vehicle` dataclass.
3. Add a test fixture under `scrape_fixtures/` and a test case in `scrape_regression.py` and `tests/test_scrape.py`.

## Pull Request Checklist

- [ ] All unit tests pass (`pytest tests/`).
- [ ] Scrape regression passes (`python scrape_regression.py`).
- [ ] No hardcoded dealer specifics added to core modules.
- [ ] New features or config options are documented in `README.md`.
