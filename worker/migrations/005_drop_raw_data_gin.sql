-- Migration 005: drop the unused GIN index on posts.raw_data
--
-- The index was created by hand (it is in no earlier migration), had zero
-- scans in production, and took ~347 MB - a third of the posts table.
-- No query filters raw_data with a GIN-capable operator (@>, ?, ?|, ?&),
-- and every non-HOT update of posts had to re-insert all of the row's JSON
-- keys into it.

DROP INDEX IF EXISTS idx_posts_raw_data_gin;
