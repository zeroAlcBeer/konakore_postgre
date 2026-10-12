-- Migration 012: the owner's character cover picks
--
-- User state, kept beside the character views rather than in them, so a
-- pick shows at once (rules: docs/characters.md, Cover picks).

CREATE TABLE character_covers (
    tag_id  BIGINT PRIMARY KEY REFERENCES tags(id),
    post_id BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    set_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
