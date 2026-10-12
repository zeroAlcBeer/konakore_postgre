-- Migration 011: character stats for the character page
--
-- Definitions (character, family count, work, cover, co-occurrence) are
-- owned by docs/characters.md. Both materialized views carry a unique
-- index so the worker can REFRESH ... CONCURRENTLY without blocking reads.

-- Every (post, character) pair with the post's family; excluded tags are
-- dropped here so they appear nowhere downstream.
CREATE VIEW character_posts AS
SELECT pt.post_id, pt.tag_id, d.family_id
FROM post_tags pt
JOIN tags t ON t.id = pt.tag_id
JOIN post_derived d ON d.post_id = pt.post_id
WHERE t.type = 4
  AND t.name NOT IN ('tagme_(character)', 'artoria_pendragon_(all)');

CREATE MATERIALIZED VIEW character_stats AS
WITH counts AS (
    SELECT tag_id, count(DISTINCT family_id) AS family_count
    FROM character_posts
    GROUP BY tag_id
),
work AS (
    SELECT DISTINCT ON (cp.tag_id) cp.tag_id, pt.tag_id AS work_tag_id
    FROM character_posts cp
    JOIN post_tags pt ON pt.post_id = cp.post_id
    JOIN tags t ON t.id = pt.tag_id AND t.type = 3
    GROUP BY cp.tag_id, pt.tag_id
    ORDER BY cp.tag_id, count(DISTINCT cp.family_id) DESC, pt.tag_id
),
characters_per_post AS (
    SELECT post_id, count(*) AS n FROM character_posts GROUP BY post_id
),
penalized AS (
    SELECT DISTINCT pt.post_id
    FROM post_tags pt
    JOIN tags t ON t.id = pt.tag_id
    WHERE t.name IN ('2girls', 'group', 'chibi', 'sketch', 'monochrome', 'no_humans')
),
cover AS (
    SELECT DISTINCT ON (cp.tag_id) cp.tag_id, cp.post_id AS cover_post_id
    FROM character_posts cp
    JOIN posts p ON p.id = cp.post_id
    JOIN characters_per_post n ON n.post_id = cp.post_id
    LEFT JOIN penalized x ON x.post_id = cp.post_id
    WHERE p.raw_data->>'rating' = 's'
    ORDER BY cp.tag_id,
             n.n = 1 DESC,
             x.post_id IS NULL DESC,
             (p.raw_data->>'score')::int DESC NULLS LAST,
             cp.post_id DESC
)
SELECT c.tag_id, c.family_count, w.work_tag_id, v.cover_post_id
FROM counts c
LEFT JOIN work w USING (tag_id)
LEFT JOIN cover v USING (tag_id);

CREATE UNIQUE INDEX idx_character_stats_tag ON character_stats (tag_id);

CREATE MATERIALIZED VIEW character_cooccurrence AS
SELECT tag_id, other_tag_id, family_count
FROM (
    SELECT a.tag_id, b.tag_id AS other_tag_id,
           count(DISTINCT a.family_id) AS family_count,
           row_number() OVER (PARTITION BY a.tag_id
                              ORDER BY count(DISTINCT a.family_id) DESC, b.tag_id) AS rank
    FROM character_posts a
    JOIN character_posts b ON b.post_id = a.post_id AND b.tag_id <> a.tag_id
    GROUP BY a.tag_id, b.tag_id
) ranked
WHERE rank <= 10;

CREATE UNIQUE INDEX idx_character_cooccurrence_pair ON character_cooccurrence (tag_id, other_tag_id);
