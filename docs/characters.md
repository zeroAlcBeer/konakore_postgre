# Character stats

The character page browses the mirror by character: which characters have
the most posts, which work each belongs to, a cover image, and who else
appears with them. This doc owns the definitions, the data layer, the API
and the UI.

## Definitions

All counts cover every mirrored post (not only likes) and count
**families** (`post_derived.family_id`), the same unit the post lists page
by. A family counts for a tag when at least one of its posts carries it.

- **Character**: a tag with `tags.type = 4`, except `tagme_(character)`
  (a placeholder) and `artoria_pendragon_(all)` (an umbrella tag that
  duplicates the per-variant tags). Excluded tags appear nowhere in the
  stats, also not as a co-occurring character.
- **Work**: the copyright tag (`type = 3`) that appears on the same post as
  the character in the most families; ties go to the lower tag id. NULL when
  the character never appears with a copyright tag.
- **Cover**: the owner's pick when there is one (see Cover picks), else one
  post rated `s`, picked by, in order:
  1. the post's only character tag is this character;
  2. the post has none of `2girls`, `group`, `chibi`, `sketch`,
     `monochrome`, `no_humans`;
  3. higher konachan `score`;
  4. newer post id.

  NULL when the character has no `s` post and no pick. Two characters may
  share an automatic cover; preferring single-character posts keeps that
  rare, so there is no cross-character dedupe.
- **Co-occurring characters**: other characters on the same post, counted
  by families, the top 10 per character (ties go to the lower tag id).

Why these signals: konachan's general vocabulary is small (745 tags in use)
and does not use Danbooru's `solo` / `1girl` / `comic` / `text`, so "single
character" is read from the character tags themselves. Nearly every post is
landscape (26 portrait posts out of 336k), so covers are not cropped by
composition.

## Storage and refresh

Migration `011_character_stats.sql` creates two materialized views:

| View | Row | Columns |
|---|---|---|
| `character_stats` | one per character with at least one post | `tag_id`, `family_count`, `work_tag_id`, `cover_post_id` |
| `character_cooccurrence` | one per (character, co-occurring character), top 10 | `tag_id`, `other_tag_id`, `family_count` |

Both are in the list of the worker task `matviews`
(`worker/jobs_matviews.go`), which runs `REFRESH MATERIALIZED VIEW
CONCURRENTLY` every 10 minutes, so readers are never blocked and the data
lags writes by at most 10 minutes.

At design time (2026-10) the mirror had 34,543 characters with posts
(after the exclusions), 10,781 of them with at least 5 families. Building
both views took 7 s on the production Pi.

## Cover picks

The owner can make any post that carries a character's tag, of any rating
and whoever else is in it, that character's cover. Picks are user state, so they live in
their own table, not in the views: `character_covers` (`tag_id` primary
key, `post_id`, `set_at`; migration `012_character_covers.sql`). A new pick
replaces the old one and takes effect at once, without waiting for a view
refresh. Deleting the post deletes the pick, and the automatic cover
returns.

Which character a pick is for comes from where it is made, never from a
picker (see the lightbox button under UI).

## API

`api/routers/characters.py`. Characters are addressed by tag name; clients
URL-encode it (names contain `(`, `)`, `:`).

`GET /v1/characters` lists characters by `family_count` descending, then
name. Parameters:

- `work`: exact copyright tag name; only characters whose work it is.
- `page` (from 1), `limit` (1-100, default 24).

Without `work` the list holds only characters with at least 300 families
(131 when this was set, 2026-10); finding any other character is the gallery's tag
search. With `work` it holds all of that work's characters.
Response: `characters` plus the usual `pagination`. Each item:

```json
{
  "name": "hatsune_miku",
  "family_count": 13861,
  "work": "vocaloid",
  "cover": {"post_id": 123, "preview_url": "https://...", "sample_url": "https://...", "width": 1920, "height": 1080}
}
```

`work` and `cover` are null when the character has none (see
Definitions); `cover` is the pick when one is set. `width` and `height` are
the post's own pixel size (null when upstream has none), so a client can lay
covers out by shape before the images load. Image URLs are the upstream ones from the post's raw data;
the frontend maps them as it does for posts.

`GET /v1/characters/{name}` returns the same fields plus `cooccurring`:
up to 10 `{"name", "family_count", "cover"}` items, most families first,
where `family_count` counts the families shared with the character and
`cover` is that character's own cover (pick or automatic, same shape as
above, null when none). 404 when
the name is not a character with posts, including the excluded tags, so it
also answers "is this tag a character".

`POST /v1/characters/{name}:setCover` with `{"post_id": 123}` sets the
pick and returns 204. 404 when the name is not a character or the post
does not exist; 400 when the post does not carry the
character's tag.

`GET /v1/posts/{id}/characters` returns `{"characters": ["name", ...]}`: the
characters on that post, by the definition above. 404 for an unknown post.

The character's posts are not part of this API: the gallery's tag search
(`POST /v1/tags:search`) shows them, paged by family.

## UI

A character's posts have one URL: the gallery's tag search, `/?tag=<name>`
(`/favorites?tag=<name>` for likes). Every way to a character leads there:
the character cards, the co-occurring chips, the search bar and the tags in
the lightbox. The search tag lives in the URL, so back, reload and links
keep it.

**Characters tab** (`frontend/src/pages/CharactersPage.jsx`, `/characters`):
a masonry of covers in pages of 40 (`?page=`, page links at the foot), in
rank order. Columns: 4 from 1200px wide, else 3 (two columns are too few for
the balancing below to close the gap a wide tile leaves). Each tile is
one column wide and as tall as its cover's shape (`cover.width` /
`cover.height`, 3:2 when unknown) and goes to the shortest column. Each
tile shows the cover cropped to fill, and over a dark fade at its foot the
Chinese name (else the tag name), the family count and the work. The work
filter (`?work=`, set from the info bar's work link) shows as a chip that
clears it. Clicking a tile opens `/?tag=<name>`.

The page breathes: every 4 seconds one tile, chosen uniformly among the
others, spans two columns at twice the size, up to 3 at once; when a fourth
grows the oldest shrinks back. Later tiles reflow down. A wide tile lands
where its two columns end closest together, and before it does both
columns' tiles since their last such line stretch or squeeze (0.8x to
1.25x of their natural height, covers crop) to meet on one line, so no
holes open inside the masonry; the bottom edge is levelled the same way
within that bound and may stay ragged when the gap is larger. Moves animate
(transforms only, 700 ms). It pauses while the tab is hidden and for 10
seconds after a touch, and never runs with reduced motion. Layout code:
`frontend/src/utils/masonry.js`.

**Character info bar** (`frontend/src/components/CharacterInfoBar.jsx`):
under the gallery's search bar, in both the gallery and the favorites,
whenever the searched tag is a character (`GET /v1/characters/{name}`
returns it). A banner the width of the gallery shows the character's cover,
cropped to fill behind a dark fade on its left, and over the fade the
Chinese name (else the tag name) large, the tag name, the work (linking to
`/characters?work=`) and the site-wide family count (labelled as
site-wide, since the favorites grid shows fewer). An icon button at the
banner's top right opens the cover post (`cover.post_id`) in the gallery's
own lightbox as a one-slide gallery, with everything the lightbox has for
any post: the caption with its tags and info, like, set as cover,
slideshow, fullscreen and zoom. The grid's gallery comes back when it
closes. The button is absent when the character has no cover. Under the banner, with
no heading, one scrollable row of buttons for the co-occurring characters:
each a small round crop of their cover, their name and the shared family
count; pressing one switches the search to them. Nothing shows for other
tags, for no search, or while the lookup is in flight.

**Set as cover** (lightbox toolbar, `frontend/src/hooks/usePhotoSwipe.js`):
shown when the current post has at least one character
(`GET /v1/posts/{id}/characters`), hidden otherwise. The pick is for the
character the gallery is searching (`?tag=`) when the post shows it, else
for the post's only character; it confirms in the lightbox. A post with
several characters, opened outside a search for one of them, shows an error
pointing to that character's search instead.

**Character info bar** (`frontend/src/components/CharacterInfoBar.jsx`):
under the gallery's search bar, in both the gallery and the favorites,
whenever the searched tag is a character (`GET /v1/characters/{name}`
returns it). It shows the Chinese and tag names, the work (linking to
`/characters?work=`), the site-wide family count (labelled as site-wide,
since the favorites grid shows fewer), and the co-occurring characters as
chips that switch the search to them. Nothing shows for other tags, for no
search, or while the lookup is in flight.
