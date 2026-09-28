-- Migration 009: drop the legacy posts columns (contract step of 008)
--
-- api and worker read and write only post_likes / post_derived since 008.
-- After this, posts holds upstream data only: id, raw_data, last_synced_at.
-- Images older than 008 no longer run against this schema.
--
-- DROP COLUMN only marks the columns dropped; their space is reclaimed when
-- the rows are rewritten (VACUUM FULL posts, run by hand - VACUUM cannot run
-- inside the migration transaction).

DROP TRIGGER posts_mirror_legacy_is_liked ON posts;
DROP TRIGGER post_likes_mirror_to_legacy ON post_likes;
DROP FUNCTION mirror_legacy_is_liked();
DROP FUNCTION mirror_post_likes_to_legacy();

-- Also drops idx_posts_liked and idx_posts_embedding_pending.
ALTER TABLE posts
    DROP COLUMN is_liked,
    DROP COLUMN is_processed,
    DROP COLUMN tag_embedding;
