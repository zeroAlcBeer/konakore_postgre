"""
Characters router - the character page's list and detail.

Reads the character_stats / character_cooccurrence materialized views;
definitions and API contract in docs/characters.md.
"""
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from psycopg2.extras import RealDictCursor

from models import (
    Character, CharacterCover, CharacterSummary, CooccurringCharacter,
    ListCharactersResponse, PaginationInfo,
)
from utils import get_db_connection

router = APIRouter(prefix="/v1/characters", tags=["characters"])

# The unfiltered list hides characters below this many families.
MIN_LISTED_FAMILIES = 5

SUMMARY_SQL = """
    SELECT t.id, t.name, s.family_count, w.name AS work,
           p.id AS cover_post_id,
           p.raw_data->>'preview_url' AS preview_url,
           p.raw_data->>'sample_url' AS sample_url
    FROM character_stats s
    JOIN tags t ON t.id = s.tag_id
    LEFT JOIN tags w ON w.id = s.work_tag_id
    LEFT JOIN posts p ON p.id = s.cover_post_id
"""


def _like_pattern(q: str) -> str:
    """Substring pattern for ILIKE ... ESCAPE '\\'; spaces match '_'."""
    escaped = q.replace(" ", "_").replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _summary(row) -> CharacterSummary:
    cover = None
    if row["cover_post_id"] is not None:
        cover = CharacterCover(post_id=row["cover_post_id"], preview_url=row["preview_url"],
                               sample_url=row["sample_url"])
    return CharacterSummary(name=row["name"], family_count=row["family_count"], work=row["work"], cover=cover)


@router.get("", response_model=ListCharactersResponse)
def list_characters(
    q: Optional[str] = Query(default=None, description="Substring of the tag name; spaces match '_'"),
    work: Optional[str] = Query(default=None, description="Exact copyright tag name"),
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=24, ge=1, le=100),
):
    conditions, params = [], []
    if q:
        conditions.append("t.name ILIKE %s ESCAPE '\\'")
        params.append(_like_pattern(q))
    if work:
        conditions.append("w.name = %s")
        params.append(work)
    if not conditions:
        conditions.append("s.family_count >= %s")
        params.append(MIN_LISTED_FAMILIES)
    where = " WHERE " + " AND ".join(conditions)

    with get_db_connection() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(f"SELECT COUNT(*) AS n FROM ({SUMMARY_SQL}{where}) q", params)
            total = cur.fetchone()["n"]
            cur.execute(f"{SUMMARY_SQL}{where} ORDER BY s.family_count DESC, t.name LIMIT %s OFFSET %s",
                        params + [limit, (page - 1) * limit])
            rows = cur.fetchall()

    total_pages = (total + limit - 1) // limit
    return ListCharactersResponse(
        characters=[_summary(row) for row in rows],
        pagination=PaginationInfo(current_page=page, per_page=limit, total_items=total,
                                  total_pages=total_pages, has_next=page < total_pages, has_prev=page > 1),
    )


# :path so names containing "/" still match.
@router.get("/{name:path}", response_model=Character)
def get_character(name: str):
    with get_db_connection() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(f"{SUMMARY_SQL} WHERE t.name = %s", (name,))
            row = cur.fetchone()
            if row is None:
                raise HTTPException(status_code=404, detail=f"Character {name!r} not found")
            cur.execute("""
                SELECT o.name, c.family_count
                FROM character_cooccurrence c
                JOIN tags o ON o.id = c.other_tag_id
                WHERE c.tag_id = %s
                ORDER BY c.family_count DESC, c.other_tag_id
            """, (row["id"],))
            cooccurring = [CooccurringCharacter(**r) for r in cur.fetchall()]

    return Character(**_summary(row).model_dump(), cooccurring=cooccurring)
