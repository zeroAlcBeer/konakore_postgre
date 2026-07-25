-- Migration 004: partial index for liked posts + planner stats refresh
--
-- The liked-posts list and its COUNT(*) previously scanned all of posts
-- (~333k rows) for ~3k liked rows. A partial index over is_liked = TRUE
-- serves both the ORDER BY id DESC page reads and the exact count.
--
-- ANALYZE is included because production was found with never-analyzed
-- stats (n_live_tup=69 vs 333k real rows) after a stats reset, leaving
-- the planner blind on every posts query.

CREATE INDEX IF NOT EXISTS idx_posts_liked
    ON posts (id DESC)
    WHERE is_liked = TRUE;

ANALYZE posts;
