"""
Posts router - handles all post-related endpoints.
"""
from fastapi import APIRouter, HTTPException, Query
from psycopg2.extras import RealDictCursor
from typing import Optional
import logging

from models import (
    ListPostsResponse, Post, PaginationInfo,
    GetPostResponse, ToggleLikeResponse,
    db_post_to_api
)
from utils import get_db_connection, trigger_file_sync, trigger_profile_update
from families import (
    LIKED_MATCH, post_columns,
    fetch_all_families_page, estimate_all_families_count,
    fetch_filtered_families_page, count_filtered_families,
)

router = APIRouter(prefix="/v1/posts", tags=["posts"])
logger = logging.getLogger(__name__)


@router.get("", response_model=ListPostsResponse)
def list_posts(
    page: int = Query(default=1, ge=1, description="Page number (1-indexed)"),
    limit: int = Query(default=100, ge=1, le=500, description="Number of posts per page"),
    liked: Optional[bool] = Query(default=None, description="true: only liked posts"),
):
    """
    List posts with pagination.

    Pages by family (see families.py): `limit` and the totals count
    families, and each page carries every matching member of its families.
    """
    offset = (page - 1) * limit

    with get_db_connection() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            if liked:
                total_count = count_filtered_families(cur, LIKED_MATCH, ())
                db_posts = fetch_filtered_families_page(cur, LIKED_MATCH, (), limit, offset)
            else:
                # No filter - page over precomputed family heads.
                total_count = estimate_all_families_count(cur)
                db_posts = fetch_all_families_page(cur, limit, offset)

            # Convert to API models
            posts = [Post(**db_post_to_api(row)) for row in db_posts]
            
            # Calculate pagination
            total_pages = (total_count + limit - 1) // limit
            
            pagination = PaginationInfo(
                current_page=page,
                per_page=limit,
                total_items=total_count,
                total_pages=total_pages,
                has_next=page < total_pages,
                has_prev=page > 1
            )
            
            return ListPostsResponse(posts=posts, pagination=pagination)


@router.get("/sandbox", response_model=ListPostsResponse)
def list_posts_sandbox(
    id_min: int = Query(..., ge=1, description="Minimum post ID (inclusive)"),
    id_max: int = Query(..., ge=1, description="Maximum post ID (inclusive)"),
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=100, ge=1, le=500),
    liked: Optional[bool] = Query(default=None, description="Filter by liked status"),
):
    """
    List posts within a specific ID range, paged by family (see families.py).
    Used for sandbox mode when navigating from Stats distribution chart.
    """
    if id_min > id_max:
        raise HTTPException(status_code=400, detail="id_min must be <= id_max")

    limit = min(limit, 500)
    offset = (page - 1) * limit

    with get_db_connection() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            match = "{id} >= %s AND {id} <= %s"
            if liked is True:
                match += " AND " + LIKED_MATCH
            params = (id_min, id_max)
            total_count = count_filtered_families(cur, match, params)
            db_posts = fetch_filtered_families_page(cur, match, params, limit, offset)
            posts = [Post(**db_post_to_api(row)) for row in db_posts]
            total_pages = (total_count + limit - 1) // limit

            pagination = PaginationInfo(
                current_page=page,
                per_page=limit,
                total_items=total_count,
                total_pages=total_pages,
                has_next=page < total_pages,
                has_prev=page > 1
            )

            return ListPostsResponse(posts=posts, pagination=pagination)


@router.get("/page-for-id")
def get_page_for_id(
    id: int = Query(..., description="Target post ID to locate"),
    limit: int = Query(default=100, ge=1, le=500, description="Page size"),
    liked: Optional[bool] = Query(default=None, description="Filter by liked status"),
):
    """
    Calculate which page a given post ID would appear on.
    Gallery is ordered by id DESC, so posts with id > target appear before it.
    Returns { page, position } where position is the 0-based offset.
    """
    limit = min(limit, 500)
    with get_db_connection() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            if liked is True:
                cur.execute("SELECT COUNT(*) as count FROM post_likes WHERE post_id > %s", (id,))
            else:
                cur.execute("SELECT COUNT(*) as count FROM posts WHERE id > %s", (id,))
            position = cur.fetchone()['count']
            page = position // limit + 1
            return {"page": page, "position": position}


@router.get("/{post_id}/characters")
def get_post_characters(post_id: int):
    """The post's characters, as defined in docs/characters.md."""
    with get_db_connection() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT 1 FROM posts WHERE id = %s", (post_id,))
            if cur.fetchone() is None:
                raise HTTPException(status_code=404, detail=f"Post with id {post_id} not found")
            cur.execute("""
                SELECT t.name FROM character_posts cp JOIN tags t ON t.id = cp.tag_id
                WHERE cp.post_id = %s ORDER BY t.name
            """, (post_id,))
            return {"characters": [row["name"] for row in cur.fetchall()]}


@router.get("/{post_id}", response_model=GetPostResponse)
def get_post(post_id: int):
    """Get a specific post by ID."""
    with get_db_connection() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                f"""SELECT {post_columns()}
                   FROM posts p
                   LEFT JOIN post_derived d ON d.post_id = p.id
                   LEFT JOIN user_profile up ON up.id = 1
                   WHERE p.id = %s""",
                (post_id,)
            )
            db_post = cur.fetchone()
            
            if not db_post:
                raise HTTPException(status_code=404, detail=f"Post with id {post_id} not found")
            
            post = Post(**db_post_to_api(db_post))
            return GetPostResponse(post=post)


@router.post("/{post_id}:like", response_model=ToggleLikeResponse)
def like_post(post_id: int):
    """
    Like a post (custom method following AIP-136).
    
    This is an idempotent operation - liking an already liked post has no effect.
    Triggers file sync service when a post is newly liked.
    """
    with get_db_connection() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT 1 FROM posts WHERE id = %s", (post_id,))
            if not cur.fetchone():
                raise HTTPException(
                    status_code=404,
                    detail=f"Post with id {post_id} not found"
                )

            cur.execute(
                "INSERT INTO post_likes (post_id) VALUES (%s) ON CONFLICT (post_id) DO NOTHING RETURNING post_id",
                (post_id,)
            )
            was_already_liked = cur.fetchone() is None
            conn.commit()
            if not was_already_liked:
                trigger_profile_update(post_id)

                # Trigger file_sync service for newly liked post
                trigger_success = trigger_file_sync("start")
                if trigger_success:
                    logger.info(f"[API] File sync triggered for liked post {post_id}")
                else:
                    logger.warning(f"[API] Failed to trigger file sync for post {post_id}, but like operation succeeded")
            
            return ToggleLikeResponse(
                post_id=post_id,
                liked=True,
                message="Post liked successfully" if not was_already_liked else "Post already liked"
            )


@router.post("/{post_id}:unlike", response_model=ToggleLikeResponse)
def unlike_post(post_id: int):
    """
    Unlike a post (custom method following AIP-136).
    
    This is an idempotent operation - unliking an already unliked post has no effect.
    """
    with get_db_connection() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT 1 FROM posts WHERE id = %s", (post_id,))
            if not cur.fetchone():
                raise HTTPException(
                    status_code=404,
                    detail=f"Post with id {post_id} not found"
                )

            cur.execute("DELETE FROM post_likes WHERE post_id = %s RETURNING post_id", (post_id,))
            was_liked = cur.fetchone() is not None
            conn.commit()
            if was_liked:
                trigger_profile_update(post_id)

            return ToggleLikeResponse(
                post_id=post_id,
                liked=False,
                message="Post unliked successfully" if was_liked else "Post already unliked"
            )
