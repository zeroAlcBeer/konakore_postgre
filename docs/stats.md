# Stats page data

The stats page (`/stats`, `api/routers/stats.py`) shows post and like
counts: totals, an id histogram that can be zoomed down to a 300-id bucket
width, and a breakdown by rating. This doc owns where those numbers come
from.

## Source

- **Posts**: the materialized view `stats_posts` (`post_id`, `rating`), one
  narrow row per post. Histogram buckets are arbitrary id ranges, so the
  view keeps posts rather than pre-aggregated buckets; scanning it avoids
  reading the wide `posts` rows and their JSON.
- **Likes**: `post_likes`, joined at query time.

Every request queries these directly; the api keeps no cache.

## Freshness

The worker task `matviews` (`worker/jobs_matviews.go`) runs
`REFRESH MATERIALIZED VIEW CONCURRENTLY` on every view in its list every
10 minutes (the character page's views share it, see
[characters.md](characters.md)). Post counts therefore lag syncs by at most 10 minutes; like
counts are always current.
