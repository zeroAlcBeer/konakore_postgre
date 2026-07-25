-- Migration 003: pgvector tag embeddings (sparse, monotonic dim allocation)
--
-- Requires the pgvector extension. Switch the postgres image to
-- pgvector/pgvector:pg14 before applying.
--
-- Vocabulary stats at design time:
--   N = 16,121 tags with count >= 10 AND name NOT LIKE 'tagme%'
--   ~12.72 tags per post on average (very sparse → sparsevec)
--
-- The column dimension upper bound is set to 32,000 to leave room for
-- monotonic dim growth (new popular tags crossing the count >= 10 threshold).
-- pgvector sparsevec stores only non-zero entries, so the upper bound has
-- effectively zero storage cost.

CREATE EXTENSION IF NOT EXISTS vector;

-- Tag vocabulary: maps each qualifying tag to a stable dimension index.
-- dim is allocated monotonically and never reused. When a tag falls below
-- the count threshold we mark is_active = FALSE but keep its dim ("dead dim"),
-- which costs nothing in sparse storage and avoids recomputing every post.
CREATE TABLE tag_vocabulary (
    dim         INTEGER PRIMARY KEY,
    tag_id      BIGINT NOT NULL REFERENCES tags(id),
    idf         DOUBLE PRECISION NOT NULL,
    type_weight DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tag_id)
);

CREATE INDEX idx_tag_vocabulary_active
    ON tag_vocabulary(dim)
    WHERE is_active = TRUE;

-- Vocabulary metadata: tracks the next-free dim and the post-count snapshot
-- used as the IDF base. Single row, id = 1.
CREATE TABLE tag_vocabulary_meta (
    id           INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    dim_count    INTEGER NOT NULL DEFAULT 0,
    active_count INTEGER NOT NULL DEFAULT 0,
    total_posts  BIGINT  NOT NULL DEFAULT 0,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO tag_vocabulary_meta (id) VALUES (1)
    ON CONFLICT (id) DO NOTHING;

-- Per-post sparse tag embedding. NULL until the embedding worker fills it.
ALTER TABLE posts
    ADD COLUMN tag_embedding sparsevec(32000);

-- Index to speed up "find unembedded posts" worker polling.
CREATE INDEX idx_posts_embedding_pending
    ON posts(id)
    WHERE is_processed = TRUE AND tag_embedding IS NULL;

-- User profile vector (single-user). Updated incrementally on like/unlike.
CREATE TABLE user_profile (
    id          INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    embedding   sparsevec(32000),
    liked_count INTEGER NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO user_profile (id, liked_count) VALUES (1, 0)
    ON CONFLICT (id) DO NOTHING;
