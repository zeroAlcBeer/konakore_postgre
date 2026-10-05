# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One person, the owner, running it at home. They browse a mirror of an
anime wallpaper booru (konachan) for pleasure and keep the images they
like. Used in a desktop browser on a Mac (mouse, large screen) and in a
tablet browser (touch, portrait or landscape, no hover).

## Product Purpose

konakore mirrors konachan's post and tag metadata into a local database
and serves a gallery over it: browse every post, search by tag, like
posts (liked images are downloaded locally), see how likes spread over the
archive (stats), and browse by character. Success is the owner finding
images they want to look at, faster and more pleasantly than on the
upstream site.

## Positioning

A private, fast, family-aware view of one booru: parent/child post groups
collapse into one entry, a tag-embedding similarity score ranks posts
against the owner's likes, and characters are first-class (counts,
works, covers, co-occurrence) rather than just tags.

## Operating Context

Self-hosted on a home server on the LAN; the owner deploys manually.
Browsing is leisure, not work: sessions are open-ended wandering through
images. The character index is for discovery, opened to find a character
worth looking at, not to look one up (lookup is the gallery's tag search).

## Capabilities and Constraints

- Content is konachan's: almost every image is a landscape wallpaper
  (26 portrait posts out of 336k). Covers and thumbnails come through the
  frontend's `/konachan-proxy`; upstream `preview_url` is small,
  `sample_url` is large.
- Posts carry ratings s / q / e. Automatic character covers are rated s;
  the owner may pick any post carrying the character as its cover.
- Character data (family count, work, cover, co-occurring characters) is
  defined in docs/characters.md; the index lists characters with at least
  20 families (about 3,000).
- Chinese names come from a third-party translation table loaded in the
  frontend; many characters have none and show their tag name.
- UI languages: Chinese (primary) and English.
- Frontend: React 19 + MUI, Vite; served by nginx in a container.

## Brand Commitments

None beyond the name konakore. The owner allowed the character surfaces
to be redone entirely.

## Evidence on Hand

The live mirror: 336k posts, real character stats and covers via
`/api/v1/characters`. No testimonials or external users exist.

## Product Principles

- The images are the content; interface chrome stays out of their way.
- One URL per result set: a character's posts are the gallery's tag search.
- Counts are honest about their scope (site-wide versus liked).
- Nothing upstream is rewritten; derived data stays derived.
