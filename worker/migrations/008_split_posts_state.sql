-- Migration 008: move user state and derived data off posts (expand step)
--
-- posts becomes an upstream mirror only (id, raw_data, last_synced_at):
--   is_liked      -> post_likes            (user state, written by the API)
--   is_processed  -> post_derived          (derived: post_tags built from
--   tag_embedding -> post_derived           the current raw_data; embedding)
--
-- This step copies the data and switches the code to the new tables but
-- keeps the old posts columns, mirrored for likes, so an older api/worker
-- image keeps working during the rollout and after a rollback. Migration
-- 009 drops the old columns once the new code is accepted.

-- User state -----------------------------------------------------------------

CREATE TABLE post_likes (
    post_id  BIGINT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
    liked_at TIMESTAMPTZ DEFAULT NOW()  -- NULL for likes made before this table
);

INSERT INTO post_likes (post_id, liked_at)
SELECT id, NULL FROM posts WHERE is_liked;

-- Derived data ---------------------------------------------------------------

-- is_processed: post_tags reflect the current raw_data.
ALTER TABLE post_derived
    ADD COLUMN is_processed  BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN tag_embedding sparsevec(32000);

UPDATE post_derived d
SET is_processed = COALESCE(p.is_processed, FALSE), tag_embedding = p.tag_embedding
FROM posts p
WHERE p.id = d.post_id;

-- Work queues of the post-tags and embeddings jobs.
CREATE INDEX idx_post_derived_unprocessed ON post_derived (post_id) WHERE NOT is_processed;
CREATE INDEX idx_post_derived_embedding_pending ON post_derived (post_id)
    WHERE is_processed AND tag_embedding IS NULL;

-- The posts trigger now also owns the "rebuild tags" reset the worker's
-- upsert used to do, so every writer gets it. It fires only when the tags
-- change (post_tags and the embedding depend on nothing else in raw_data),
-- and it clears the embedding too: before, an embedding computed while a
-- fresh upload had few tags was never recomputed after its tags filled in.
CREATE OR REPLACE FUNCTION sync_post_derived_parent() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    new_parent   BIGINT := NULLIF((NEW.raw_data->>'parent_id')::bigint, NEW.id);
    tags_changed BOOLEAN;
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO post_derived (post_id, parent_id, family_id, is_family_head, is_processed)
        VALUES (NEW.id, new_parent, NEW.id, TRUE, FALSE)
        ON CONFLICT (post_id) DO UPDATE
            SET parent_id = EXCLUDED.parent_id, is_processed = FALSE, tag_embedding = NULL;
        RETURN NULL;
    END IF;

    tags_changed := OLD.raw_data->>'tags' IS DISTINCT FROM NEW.raw_data->>'tags';
    UPDATE post_derived
    SET parent_id     = new_parent,
        is_processed  = is_processed AND NOT tags_changed,
        tag_embedding = CASE WHEN tags_changed THEN NULL ELSE tag_embedding END
    WHERE post_id = NEW.id
      AND (parent_id IS DISTINCT FROM new_parent OR tags_changed);
    RETURN NULL;
END $$;

-- Repair: recompute embeddings that came out empty (see above).
UPDATE post_derived SET tag_embedding = NULL WHERE tag_embedding::text = '{}/32000';

-- Transitional likes mirror (dropped in 009) ---------------------------------
-- Each side writes the other only when it differs, so the pair terminates.

CREATE FUNCTION mirror_legacy_is_liked() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.is_liked THEN
        INSERT INTO post_likes (post_id) VALUES (NEW.id) ON CONFLICT (post_id) DO NOTHING;
    ELSE
        DELETE FROM post_likes WHERE post_id = NEW.id;
    END IF;
    RETURN NULL;
END $$;

CREATE TRIGGER posts_mirror_legacy_is_liked
    AFTER INSERT OR UPDATE OF is_liked ON posts
    FOR EACH ROW WHEN (NEW.is_liked IS NOT NULL)
    EXECUTE FUNCTION mirror_legacy_is_liked();

CREATE FUNCTION mirror_post_likes_to_legacy() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE posts SET is_liked = TRUE WHERE id = NEW.post_id AND is_liked IS DISTINCT FROM TRUE;
    ELSE
        UPDATE posts SET is_liked = FALSE WHERE id = OLD.post_id AND is_liked IS DISTINCT FROM FALSE;
    END IF;
    RETURN NULL;
END $$;

CREATE TRIGGER post_likes_mirror_to_legacy
    AFTER INSERT OR DELETE ON post_likes
    FOR EACH ROW EXECUTE FUNCTION mirror_post_likes_to_legacy();

ANALYZE post_likes;
ANALYZE post_derived;
