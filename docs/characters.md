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
- **Cover**: one post rated `s`, picked by, in order:
  1. the post's only character tag is this character;
  2. the post has none of `2girls`, `group`, `chibi`, `sketch`,
     `monochrome`, `no_humans`;
  3. higher konachan `score`;
  4. newer post id.

  NULL when the character has no `s` post. Two characters may share a
  cover; preferring single-character posts keeps that rare, so there is no
  cross-character dedupe.
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

## API

`api/routers/characters.py`. Characters are addressed by tag name; clients
URL-encode it (names contain `(`, `)`, `:`).

`GET /v1/characters` lists characters by `family_count` descending, then
name. Parameters:

- `work`: exact copyright tag name; only characters whose work it is.
- `page` (from 1), `limit` (1-100, default 24).

Without `work` the list holds only characters with at least 20 families
(3,065 at design time); finding any other character is the gallery's tag
search. With `work` it holds all of that work's characters.
Response: `characters` plus the usual `pagination`. Each item:

```json
{
  "name": "hatsune_miku",
  "family_count": 13861,
  "work": "vocaloid",
  "cover": {"post_id": 123, "preview_url": "https://...", "sample_url": "https://..."}
}
```

`work` and `cover` are null when the character has none (see
Definitions). Image URLs are the upstream ones from the post's raw data;
the frontend maps them as it does for posts.

`GET /v1/characters/{name}` returns the same fields plus `cooccurring`:
up to 10 `{"name", "family_count"}` items, most families first. 404 when
the name is not a character with posts, including the excluded tags, so it
also answers "is this tag a character".

The character's posts are not part of this API: the gallery's tag search
(`POST /v1/tags:search`) shows them, paged by family.

## UI

A character's posts have one URL: the gallery's tag search, `/?tag=<name>`
(`/favorites?tag=<name>` for likes). Every way to a character leads there:
the character cards, the co-occurring chips, the search bar and the tags in
the lightbox. The search tag lives in the URL, so back, reload and links
keep it.

**Characters tab** (`frontend/src/pages/CharactersPage.jsx`, `/characters`):
an index of cards, no search box. The work filter and the page live in the
URL (`?work=`, `?page=`). Each card: the cover (`sample_url`, else
`preview_url`) cropped to 3:2, the Chinese name when the translation table
has one and the tag name, the work (clicking it sets the work filter), and
the family count. Clicking the card opens `/?tag=<name>`.

**Character info bar** (`frontend/src/components/CharacterInfoBar.jsx`):
under the gallery's search bar, in both the gallery and the favorites,
whenever the searched tag is a character (`GET /v1/characters/{name}`
returns it). It shows the Chinese and tag names, the work (linking to
`/characters?work=`), the site-wide family count (labelled as site-wide,
since the favorites grid shows fewer), and the co-occurring characters as
chips that switch the search to them. Nothing shows for other tags, for no
search, or while the lookup is in flight.
