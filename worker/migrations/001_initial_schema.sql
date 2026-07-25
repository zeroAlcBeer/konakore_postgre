-- Migration 001: Initial Schema

CREATE TABLE posts (
    id BIGINT PRIMARY KEY,
    raw_data JSONB NOT NULL,
    is_processed BOOLEAN DEFAULT FALSE,
    is_liked BOOLEAN DEFAULT FALSE,
    last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE tags (
    id BIGINT PRIMARY KEY,
    name TEXT NOT NULL,
    count INT NOT NULL,
    type INT NOT NULL,
    ambiguous BOOLEAN NOT NULL,
    last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE post_tags (
  post_id BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  tag_id  BIGINT NOT NULL REFERENCES tags(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (post_id, tag_id)
);
CREATE INDEX idx_post_tags_tag ON post_tags(tag_id);

-- A more flexible state table for managing multiple jobs
CREATE TABLE schedule_state (
    job_name TEXT PRIMARY KEY,
    state JSONB NOT NULL,
    last_run_at TIMESTAMPTZ
);

CREATE TABLE file_sync (
    id SERIAL PRIMARY KEY,
    post_id BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    download_url TEXT NOT NULL,
    expected_size BIGINT,
    actual_size BIGINT,
    file_path TEXT,
    file_ext TEXT,
    aria_log JSONB,
    sync_status TEXT DEFAULT 'PENDING', -- PENDING, DOWNLOADING, COMPLETE, DELETED
    is_deleted BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_file_sync_post_id ON file_sync(post_id);
CREATE INDEX idx_file_sync_sync_status ON file_sync(sync_status);

-- Seed the initial states for our sync jobs
INSERT INTO schedule_state (job_name, state)
VALUES
    ('backfill-all', '{"current_page": 1, "retries": 0, "is_active": true}'),
    ('sync-recent', '{"current_page": 1, "retries": 0}'),
    ('sync-tags', '{"current_page": 1, "retries": 0, "is_active": true}'),
    ('file-sync', '{"last_check": 0, "is_active": true}');

-- Other tables like `post_tags`, `likes` from previous plans go here.
