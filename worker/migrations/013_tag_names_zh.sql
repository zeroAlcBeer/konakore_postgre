-- Migration 013: Chinese tag names
--
-- Imported by the worker at startup from worker/assets/tag_names_zh.json.gz;
-- rules and refresh procedure in docs/tag-names.md. Keyed by tag name, not
-- tags.id: the table also covers tags konachan has not shown us yet.

CREATE TABLE tag_names_zh (
    name TEXT PRIMARY KEY,
    zh   TEXT NOT NULL
);

-- The data revision tag_names_zh holds; one row.
CREATE TABLE tag_names_zh_revision (
    revision    TEXT NOT NULL,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
