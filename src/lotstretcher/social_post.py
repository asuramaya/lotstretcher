"""
Short-form copy for the surfaces that aren't Marketplace.

facebook_post.py builds one post of about 2,500 characters, which is right
for a Marketplace listing where the reader has already clicked a specific
vehicle and wants the spec sheet. It is wrong everywhere else:

    Threads      500 characters, hard cap
    Instagram    2,200 allowed, but truncated at ~125 with "... more"
    Marketplace  no practical limit, reader is already committed

So the difference isn't length alone, it's what has to come FIRST. On
Marketplace the first three lines are a courtesy (greeting, vehicle,
address) because the reader is already looking at the car. On a feed the
first line is the only line most people read, so it has to carry the
vehicle and the reason to care, and the greeting moves to the end where it
becomes a call to action instead of a salutation.

Nothing here invents a claim. Every value is a scraped field, same as the
long post -- the only editorial decisions are ordering and what to drop
when the budget runs out (core/src/copy.rs::TRIM_ORDER).

Hashtags exist here and deliberately not in facebook_post.py: they're
expected on Threads and Instagram and read as spam on a Marketplace
listing, which is a merchandising difference between surfaces rather than
a formatting one.

The text itself is built by the core (core/src/copy.rs), the same code
the browser's copy.js calls, so the two surfaces post the same words;
tests/test_copy_parity.py holds the core to the Python this replaced.
"""
from __future__ import annotations

from lotstretcher.facebook_post import posts_for
from lotstretcher.scrape import Vehicle

THREADS_LIMIT = 500
# Instagram cuts the caption here with a "... more" link. Everything that
# has to be read without a tap must fit inside it.
INSTAGRAM_VISIBLE = 125
# Below this, the odometer is delivery mileage and saying it out loud
# reads as odd rather than informative. Keyed on the number rather than
# on condition=="New" so a new-but-high-mileage demo still shows its miles.
DELIVERY_MILEAGE_CEILING = 100
MAX_HASHTAGS = 14
# Past this a tag stops being searchable and starts looking like a mistake.
MAX_TAG_LENGTH = 28


def build_hashtags(v: Vehicle) -> list[str]:
    """Tags derived from what was scraped, most specific first, so that
    truncating to fit a character budget drops the least valuable end."""
    return list(posts_for(v)["hashtags"])


def build_threads_post(v: Vehicle) -> str:
    """A Threads post inside the 500-character cap: every candidate line
    assembled, then whole facts dropped in TRIM_ORDER until it fits,
    rather than the finished text truncated mid-sentence. Hashtags are
    added last and only with whatever budget survives."""
    return posts_for(v)["threads"]


def build_instagram_caption(v: Vehicle) -> str:
    """An Instagram caption: hook above the fold, detail below it, tags
    last. Instagram allows 2,200 characters, so nothing needs dropping;
    the whole job is ordering."""
    return posts_for(v)["instagram"]
