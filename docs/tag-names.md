# Chinese tag names

Every tag the UI shows (characters, works, general tags) gets its Chinese
name from one table. This doc owns where the names come from, how they
reach the database and the frontend, and how to refresh them.

## Source

[amenorira/danbooru-tags-data-zh](https://github.com/amenorira/danbooru-tags-data-zh)
(MIT; notice in `worker/assets/NOTICE.md`): Danbooru's general, copyright and
character tags with more than 50 images, each with a Chinese name, aliases
and notes. It is the only source; its name for a tag is used as is.

The dataset has a single maintainer, so it is pinned to one commit
(`REVISION` in `scripts/build_tag_names.py`) and shipped inside the worker
image; nothing fetches it at runtime.

## Rules

- A tag's name is the dataset's `zh` for that tag, unchanged.
- Konachan sometimes spells a tag the way Danbooru lists it as an alias
  (`flowers` for `flower`, `nopan` for `no_panties`). An alias that looks
  like a tag name (lowercase ASCII) and is not itself a dataset tag takes
  the name of its tag; when several tags list it, the one with the most
  images wins.
- A tag the dataset does not name has no Chinese name; the UI shows its tag
  name.

## Data flow

1. `uv run scripts/build_tag_names.py` downloads the pinned CSVs and writes
   `worker/assets/tag_names_zh.json.gz` (`{source, revision, names}`), which
   is committed.
2. The worker embeds that file. At startup, when its revision differs from
   the one in `tag_names_zh_revision`, it replaces every row of
   `tag_names_zh (name, zh)` in one transaction (migration 013). A failed
   import stops the worker.
3. `GET /v1/tags/zh-names` returns `{tag name: Chinese name}` for the tags
   in `tags` that have one, with an ETag; the browser revalidates it on
   each load (`Cache-Control: no-cache`).
4. The frontend loads that map once (`TagManager`) and every component
   looks names up in it.

## Refreshing

1. Set `REVISION` in `scripts/build_tag_names.py` to the new commit and run
   it; check the printed count against the previous one.
2. Commit the script and the data file, then `make release-worker` and
   deploy the worker. The new revision is imported on its first start.
