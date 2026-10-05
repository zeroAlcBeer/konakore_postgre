-- Migration 010: narrow per-post view for the stats page
--
-- See docs/stats.md. The unique index lets the worker refresh it
-- CONCURRENTLY, and serves the min/max id lookups.

CREATE MATERIALIZED VIEW stats_posts AS
SELECT id AS post_id, raw_data->>'rating' AS rating
FROM posts;

CREATE UNIQUE INDEX idx_stats_posts_post ON stats_posts (post_id);
