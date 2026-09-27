"""
Family-paginated post lists.

A family is every post sharing post_derived.family_id (parent/child groups,
maintained by the worker). List endpoints page by family: a page holds
`limit` families plus all of their members that match the list's filter,
so a group is never split across pages. Families are ordered by their
head, the newest matching member; members follow their head, newest first.

A filter is an SQL predicate template with its parameters. It may use
`{id}` for the post id and `{p}` for the posts row, e.g. "{p}.is_liked = TRUE".
posts is joined only when `{p}` is used: it is the wide table, and filters on
the id alone (tag, id range) run far faster over the narrow post_derived.
The filter is applied to members, so a partially matching family shows only
its matching members.
"""

SIMILARITY_EXPR = """
    CASE WHEN p.tag_embedding IS NOT NULL AND up.embedding IS NOT NULL
         THEN NULLIF(1 - (p.tag_embedding <=> up.embedding), 'NaN'::float8)
         ELSE NULL
    END AS similarity"""

NO_SIMILARITY_EXPR = "NULL::float8 AS similarity"


def _post_columns(with_similarity: bool) -> str:
    similarity = SIMILARITY_EXPR if with_similarity else NO_SIMILARITY_EXPR
    return f"p.id, p.raw_data, p.is_processed, p.is_liked, p.last_synced_at, d.family_id, {similarity}"


def fetch_all_families_page(cur, limit: int, offset: int):
    """Unfiltered feed: walks the precomputed family heads."""
    cur.execute(f"""
        WITH heads AS (
            SELECT post_id AS head_id, family_id
            FROM post_derived
            WHERE is_family_head
            ORDER BY post_id DESC
            LIMIT %s OFFSET %s
        )
        SELECT {_post_columns(True)}
        FROM heads h
        JOIN post_derived d ON d.family_id = h.family_id
        JOIN posts p ON p.id = d.post_id
        LEFT JOIN user_profile up ON up.id = 1
        ORDER BY h.head_id DESC, p.id DESC
    """, (limit, offset))
    return cur.fetchall()


def estimate_all_families_count(cur) -> int:
    """Planner estimate of the family count, avoiding a full count per page view."""
    cur.execute(
        "SELECT reltuples::bigint AS estimate FROM pg_class WHERE relname = 'idx_post_derived_heads'"
    )
    row = cur.fetchone()
    if row and row['estimate'] is not None and row['estimate'] >= 0:
        return row['estimate']
    # Estimate unavailable (index never analyzed) - fall back.
    cur.execute("SELECT COUNT(*) FROM post_derived WHERE is_family_head")
    return cur.fetchone()['count']


def _filter_sql(match: str, derived: str, posts: str):
    """Return (join, predicate) for `match` over the given table aliases."""
    join = f"JOIN posts {posts} ON {posts}.id = {derived}.post_id" if "{p}" in match else ""
    return join, match.format(id=f"{derived}.post_id", p=posts)


def fetch_filtered_families_page(cur, match: str, params: tuple, limit: int, offset: int,
                                 with_similarity: bool = True):
    """
    Page of families among posts matching `match`.

    A matching post heads its family when no newer member also matches; the
    NOT EXISTS form lets the planner stream heads in id order and stop at
    the LIMIT instead of aggregating every matching post first.
    """
    head_join, head_pred = _filter_sql(match, "d", "hp")
    newer_join, newer_pred = _filter_sql(match, "d2", "p2")
    _, member_pred = _filter_sql(match, "d", "p")
    cur.execute(f"""
        WITH heads AS (
            SELECT d.post_id AS head_id, d.family_id
            FROM post_derived d
            {head_join}
            WHERE {head_pred}
              AND NOT EXISTS (
                  SELECT 1
                  FROM post_derived d2
                  {newer_join}
                  WHERE d2.family_id = d.family_id
                    AND d2.post_id > d.post_id
                    AND {newer_pred}
              )
            ORDER BY d.post_id DESC
            LIMIT %s OFFSET %s
        )
        SELECT {_post_columns(with_similarity)}
        FROM heads h
        JOIN post_derived d ON d.family_id = h.family_id
        JOIN posts p ON p.id = d.post_id
        LEFT JOIN user_profile up ON up.id = 1
        WHERE {member_pred}
        ORDER BY h.head_id DESC, p.id DESC
    """, (*params, *params, limit, offset, *params))
    return cur.fetchall()


def count_filtered_families(cur, match: str, params: tuple) -> int:
    join, pred = _filter_sql(match, "d", "p")
    # GROUP BY instead of COUNT(DISTINCT): it can hash-aggregate, while
    # COUNT(DISTINCT) always sorts (spilling to disk for large tags).
    cur.execute(f"""
        SELECT COUNT(*) AS count
        FROM (
            SELECT d.family_id
            FROM post_derived d
            {join}
            WHERE {pred}
            GROUP BY d.family_id
        ) families
    """, params)
    return cur.fetchone()['count']
