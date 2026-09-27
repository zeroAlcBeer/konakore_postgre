-- Migration 006: post families (parent/child groups) as derived data
--
-- posts stays a mirror of upstream data. Anything computed from
-- posts.raw_data lives in post_derived, one row per post, so it can be
-- rebuilt without touching posts and its writes do not rewrite the wide
-- posts rows.
--
-- A family is every post connected through parent_id. family_id is the
-- chain's root: the topmost local ancestor, or the parent id itself when
-- that parent is not in the local database (siblings still group). For a
-- parent_id cycle it is the smallest id in the cycle. The family head is
-- its newest member (largest id); lists order families by their head.

CREATE TABLE post_derived (
    post_id        BIGINT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
    parent_id      BIGINT,             -- raw_data.parent_id, NULL when absent or self
    family_id      BIGINT NOT NULL,    -- may name a post that is not stored locally
    is_family_head BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX idx_post_derived_family ON post_derived (family_id, post_id);

-- Unfiltered feed: one entry per family, newest first. Its reltuples also
-- serves as the family-count estimate.
CREATE INDEX idx_post_derived_heads ON post_derived (post_id DESC) WHERE is_family_head;

-- Keep parent_id in step with raw_data for every writer of posts.
-- A new row starts as its own one-post family until the next refresh,
-- which keeps it visible without ever giving a family two heads.
CREATE FUNCTION sync_post_derived_parent() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO post_derived (post_id, parent_id, family_id, is_family_head)
    VALUES (NEW.id, NULLIF((NEW.raw_data->>'parent_id')::bigint, NEW.id), NEW.id, TRUE)
    ON CONFLICT (post_id) DO UPDATE SET parent_id = EXCLUDED.parent_id
    WHERE post_derived.parent_id IS DISTINCT FROM EXCLUDED.parent_id;
    RETURN NULL;
END $$;

CREATE TRIGGER posts_sync_derived_parent
    AFTER INSERT OR UPDATE OF raw_data ON posts
    FOR EACH ROW EXECUTE FUNCTION sync_post_derived_parent();

-- Recompute family_id / is_family_head for all posts from parent_id.
-- Reads only the narrow post_derived table (~1.5s for 336k posts) and
-- writes only rows whose values changed. Returns the number of rows changed.
CREATE FUNCTION refresh_post_families() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
    changed integer;
BEGIN
    -- The recompute is global; concurrent runs would only repeat the work.
    PERFORM pg_advisory_xact_lock(hashtext('refresh_post_families'));

    WITH RECURSIVE walk (post_id, cur, parent, depth, path) AS (
        SELECT post_id, post_id, parent_id, 0, ARRAY[post_id]
        FROM post_derived
        WHERE parent_id IS NOT NULL
        UNION ALL
        SELECT w.post_id, d.post_id, d.parent_id, w.depth + 1, w.path || d.post_id
        FROM walk w
        JOIN post_derived d ON d.post_id = w.parent
        WHERE NOT d.post_id = ANY (w.path)
    ),
    last_step AS (
        -- The walk stops at a root (parent NULL), a parent missing locally,
        -- or a parent already on the path (a cycle).
        SELECT DISTINCT ON (post_id) post_id, cur, parent, path
        FROM walk
        ORDER BY post_id, depth DESC
    ),
    family AS (
        SELECT d.post_id,
               CASE
                   WHEN l.post_id IS NULL OR l.parent IS NULL THEN COALESCE(l.cur, d.post_id)
                   WHEN l.parent = ANY (l.path)
                       THEN (SELECT min(x) FROM unnest(l.path[array_position(l.path, l.parent):]) AS x)
                   ELSE l.parent
               END AS family_id
        FROM post_derived d
        LEFT JOIN last_step l ON l.post_id = d.post_id
    ),
    target AS (
        SELECT post_id, family_id,
               post_id = max(post_id) OVER (PARTITION BY family_id) AS is_family_head
        FROM family
    )
    UPDATE post_derived d
    SET family_id = t.family_id, is_family_head = t.is_family_head
    FROM target t
    WHERE d.post_id = t.post_id
      AND (d.family_id IS DISTINCT FROM t.family_id
           OR d.is_family_head IS DISTINCT FROM t.is_family_head);

    GET DIAGNOSTICS changed = ROW_COUNT;
    RETURN changed;
END $$;

-- Backfill existing posts, then compute their families.
INSERT INTO post_derived (post_id, parent_id, family_id, is_family_head)
SELECT id, NULLIF((raw_data->>'parent_id')::bigint, id), id, TRUE
FROM posts;

ANALYZE post_derived;
SELECT refresh_post_families();
ANALYZE post_derived;
