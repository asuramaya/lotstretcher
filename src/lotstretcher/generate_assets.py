#!/usr/bin/env python3
"""
Generate composition assets (backgrounds, later borders) via Recraft and
register them in assets/manifest.json.

Usage:
    generate_assets.py background "a sleek futuristic car showroom, empty, wide reflective floor" \\
        --name "Futuristic Showroom" --tags showroom sci-fi

Each run is exactly one paid Recraft API call ($0.035 at the default model).
Nothing here runs as a side effect of lotstretcher.py -- generation is always an
explicit, separate step.
"""
from __future__ import annotations

import argparse

from lotstretcher.imaging.generate import (CATEGORY_PROMPTS, DEFAULT_MODEL, DEFAULT_SIZE, OPENROUTER_MODEL, PROVIDERS,
                                           generate_background, generate_set)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="kind", required=True)

    bg = sub.add_parser("background", help="Generate and register a background image")
    bg.add_argument("prompt", help="Image generation prompt")
    bg.add_argument("--name", required=True, help="Display name (also used to derive the filename)")
    bg.add_argument("--tags", nargs="*", default=[], help="Tags for lookup, e.g. showroom sci-fi")
    bg.add_argument("--model", default=None, help=f"Default: {DEFAULT_MODEL} (recraft) or {OPENROUTER_MODEL} (openrouter)")
    bg.add_argument("--size", default=DEFAULT_SIZE, help="Recraft only")
    bg.add_argument("--provider", default="recraft", choices=PROVIDERS)
    bg.add_argument("--category", default=None, help="The category the app groups the tile under")
    bg.add_argument("--studio", action="store_true", help="Ship it with the site (build-studio.py exports it)")
    bg.add_argument("--hosted", action="store_true", help="The site loads it from the CDN (build-studio.py --hosted-base)")

    st = sub.add_parser("set", help="Generate a categorised set of backgrounds for the studio")
    st.add_argument("--categories", nargs="+", default=list(CATEGORY_PROMPTS), choices=list(CATEGORY_PROMPTS))
    st.add_argument("--count", type=int, default=2, help="Images per category (default: 2)")
    st.add_argument("--provider", default="openrouter", choices=PROVIDERS)
    st.add_argument("--model", default=None)
    st.add_argument("--no-hosted", action="store_true", help="Ship the bytes with the site instead of the CDN")
    st.add_argument("--dry-run", action="store_true", help="Print the plan; call nothing")

    args = parser.parse_args()

    if args.kind == "background":
        kw = {"model": args.model} if args.model else {}
        if args.provider == "recraft":
            kw["size"] = args.size
        path = generate_background(args.prompt, args.name, args.tags, provider=args.provider, category=args.category,
                                   studio=args.studio, hosted=args.hosted, **kw)
        print(f"Saved: {path}")
    elif args.kind == "set":
        kw = {"model": args.model} if args.model else {}
        paths = generate_set(args.categories, args.count, provider=args.provider, hosted=not args.no_hosted,
                             dry_run=args.dry_run, **kw)
        if not args.dry_run:
            print(f"{len(paths)} background(s) registered; run web/build-studio.py to export them")


if __name__ == "__main__":
    main()
