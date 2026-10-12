"""
Characters router - the character page's list and detail.

Reads the character_stats / character_cooccurrence materialized views and
the owner's character_covers picks; definitions and API contract in
docs/characters.md.
"""
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Response
from psycopg2.extras import RealDictCursor
from pydantic import BaseModel

from models import (
    Character, CharacterCover, CharacterSummary, CooccurringCharacter,
    ListCharactersResponse, PaginationInfo,
)
from utils import get_db_connection

router = APIRouter(prefix="/v1/characters", tags=["characters"])

# The unfiltered list hides characters below this many families.
MIN_LISTED_FAMILIES = 300

SUMMARY_SQL = """
    SELECT t.id, t.name, s.family_count, w.name AS work,
           p.id AS cover_post_id,
           p.raw_data->>'preview_url' AS preview_url,
           p.raw_data->>'sample_url' AS sample_url,
           (p.raw_data->>'width')::int AS cover_width,
           (p.raw_data->>'height')::int AS cover_height
    FROM character_stats s
    JOIN tags t ON t.id = s.tag_id
    LEFT JOIN tags w ON w.id = s.work_tag_id
    LEFT JOIN character_covers cc ON cc.tag_id = s.tag_id
    LEFT JOIN posts p ON p.id = COALESCE(cc.post_id, s.cover_post_id)
"""


def _cover(row) -> Optional[CharacterCover]:
    if row["cover_post_id"] is None:
        return None
    return CharacterCover(post_id=row["cover_post_id"], preview_url=row["preview_url"], sample_url=row["sample_url"],
                          width=row["cover_width"], height=row["cover_height"])


def _summary(row) -> CharacterSummary:
    return CharacterSummary(name=row["name"], family_count=row["family_count"], work=row["work"], cover=_cover(row))


@router.get("", response_model=ListCharactersResponse)
def list_characters(
    work: Optional[str] = Query(default=None, description="Exact copyright tag name"),
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=24, ge=1, le=100),
):
    if work:
        where, params = " WHERE w.name = %s", [work]
    else:
        where, params = " WHERE s.family_count >= %s", [MIN_LISTED_FAMILIES]

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
            # Each peer's own cover: pick, else automatic (as in SUMMARY_SQL).
            cur.execute("""
                SELECT o.name, c.family_count,
                       p.id AS cover_post_id,
                       p.raw_data->>'preview_url' AS preview_url,
                       p.raw_data->>'sample_url' AS sample_url,
                       (p.raw_data->>'width')::int AS cover_width,
                       (p.raw_data->>'height')::int AS cover_height
                FROM character_cooccurrence c
                JOIN tags o ON o.id = c.other_tag_id
                LEFT JOIN character_stats os ON os.tag_id = c.other_tag_id
                LEFT JOIN character_covers cc ON cc.tag_id = c.other_tag_id
                LEFT JOIN posts p ON p.id = COALESCE(cc.post_id, os.cover_post_id)
                WHERE c.tag_id = %s
                ORDER BY c.family_count DESC, c.other_tag_id
            """, (row["id"],))
            cooccurring = [CooccurringCharacter(name=r["name"], family_count=r["family_count"], cover=_cover(r))
                           for r in cur.fetchall()]

    return Character(**_summary(row).model_dump(), cooccurring=cooccurring)


class SetCoverRequest(BaseModel):
    post_id: int


# Custom method (AIP-136); :path keeps names containing "/" matchable.
@router.post("/{name:path}:setCover", status_code=204)
def set_cover(name: str, body: SetCoverRequest):
    """Make a post carrying the character its cover (see Cover picks)."""
    with get_db_connection() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT 1 FROM posts WHERE id = %s", (body.post_id,))
            if cur.fetchone() is None:
                raise HTTPException(status_code=404, detail=f"Post {body.post_id} not found")
            cur.execute("""
                SELECT t.id, t.name FROM character_posts cp JOIN tags t ON t.id = cp.tag_id
                WHERE cp.post_id = %s
            """, (body.post_id,))
            on_post = {row["name"]: row["id"] for row in cur.fetchall()}
            # character_posts owns the definition, exclusions included.
            cur.execute("""
                SELECT 1 FROM character_posts cp JOIN tags t ON t.id = cp.tag_id WHERE t.name = %s LIMIT 1
            """, (name,))
            if cur.fetchone() is None:
                raise HTTPException(status_code=404, detail=f"Character {name!r} not found")
            if name not in on_post:
                raise HTTPException(status_code=400, detail=f"Post {body.post_id} does not show {name!r}")
            cur.execute("""
                INSERT INTO character_covers (tag_id, post_id) VALUES (%s, %s)
                ON CONFLICT (tag_id) DO UPDATE SET post_id = EXCLUDED.post_id, set_at = NOW()
            """, (on_post[name], body.post_id))
    return Response(status_code=204)
