"""
Tags router - handles all tag-related endpoints.
"""
from fastapi import APIRouter, HTTPException, Query, Body, Request, Response
from psycopg2.extras import RealDictCursor
from typing import Optional
from pydantic import BaseModel, Field
import hashlib
import json
import logging

from models import (
    ListTagsResponse, TagSummary, Tag,
    GetTagResponse, SearchTagsResponse, Post, PaginationInfo,
    db_post_to_api, db_tag_to_api
)
from utils import get_db_connection
from families import (
    LIKED_MATCH, NOT_LIKED_MATCH, fetch_filtered_families_page, count_filtered_families,
)

router = APIRouter(prefix="/v1/tags", tags=["tags"])
logger = logging.getLogger(__name__)


class SearchTagsRequestBody(BaseModel):
    """Request body for searching tags."""
    query: str = Field(..., min_length=2, description="Search query (minimum 2 characters)")
    page: int = Field(default=1, ge=1, description="Page number (1-indexed)")
    page_size: int = Field(default=100, ge=1, le=500, description="Number of posts per page", alias="pageSize")
    liked: Optional[bool] = Field(default=None, description="Filter by liked status")
    
    class Config:
        populate_by_name = True


@router.get("", response_model=ListTagsResponse)
def list_tags(
    page: int = Query(default=1, ge=1, description="Page number (1-indexed)"),
    limit: int = Query(default=100, ge=1, le=500, description="Number of posts to consider"),
    liked: Optional[bool] = Query(default=None, description="Filter posts by liked status")
):
    """
    List tags aggregated from a range of posts.
    
    Returns tag statistics for the specified posts range.
    This is useful for getting tag distribution across recent or liked posts.
    """
    # Limit enforcement
    limit = min(limit, 500)
    offset = (page - 1) * limit
    
    # Convert liked parameter
    liked_filter = None
    if liked is not None:
        liked_filter = bool(liked)
    
    with get_db_connection() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # Get posts in the specified range
            if liked_filter is True:
                cur.execute(
                    "SELECT post_id AS id FROM post_likes ORDER BY post_id DESC LIMIT %s OFFSET %s",
                    (limit, offset)
                )
            else:
                cur.execute(
                    "SELECT id FROM posts ORDER BY id DESC LIMIT %s OFFSET %s",
                    (limit, offset)
                )
            
            posts = cur.fetchall()
            if not posts:
                return ListTagsResponse(tags=[])
            
            post_ids = [post['id'] for post in posts]
            
            # Query tags associated with these posts
            placeholders = ','.join(['%s'] * len(post_ids))
            cur.execute(
                f"""
                SELECT 
                    t.name,
                    t.type,
                    COUNT(pt.post_id) as count
                FROM tags t
                JOIN post_tags pt ON t.id = pt.tag_id
                WHERE pt.post_id IN ({placeholders})
                GROUP BY t.id, t.name, t.type
                ORDER BY count DESC, t.name ASC
                """,
                post_ids
            )
            
            db_tags = cur.fetchall()
            tags = [TagSummary(**tag) for tag in db_tags]
            
            return ListTagsResponse(tags=tags)


@router.get("/zh-names")
def get_zh_names(request: Request):
    """
    Chinese names of the tags we hold, as {tag name: Chinese name}; tags
    without one are absent. Source and rules: docs/tag-names.md.
    """
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT n.name, n.zh FROM tag_names_zh n JOIN tags t ON t.name = n.name ORDER BY n.name")
            body = json.dumps(dict(cur.fetchall()), ensure_ascii=False, separators=(",", ":")).encode()

    etag = '"' + hashlib.md5(body).hexdigest() + '"'
    headers = {"ETag": etag, "Cache-Control": "no-cache"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return Response(content=body, media_type="application/json", headers=headers)


@router.get("/{tag_id}", response_model=GetTagResponse)
def get_tag(tag_id: int):
    """Get a specific tag by ID."""
    with get_db_connection() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT id, name, count, type, ambiguous, last_synced_at FROM tags WHERE id = %s",
                (tag_id,)
            )
            db_tag = cur.fetchone()
            
            if not db_tag:
                raise HTTPException(status_code=404, detail=f"Tag with id {tag_id} not found")
            
            tag = Tag(**db_tag_to_api(db_tag))
            return GetTagResponse(tag=tag)


@router.post(":search", response_model=SearchTagsResponse)
def search_tags(request: SearchTagsRequestBody = Body(...)):
    """
    Search tags and return associated posts (custom method following AIP-136).
    
    Performs exact match on tag name and returns paginated posts.
    This is a POST endpoint to support complex search parameters in the request body.
    """
    # Validate and extract parameters
    query = request.query.strip()
    page = request.page
    page_size = min(request.page_size, 500)
    offset = (page - 1) * page_size
    liked_filter = request.liked
    
    with get_db_connection() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # Exact match on tag name
            cur.execute(
                "SELECT id FROM tags WHERE name = %s",
                (query,)
            )
            tag = cur.fetchone()
            
            if not tag:
                # Return empty result for non-existent tag
                return SearchTagsResponse(
                    posts=[],
                    pagination=PaginationInfo(
                        current_page=page,
                        per_page=page_size,
                        total_items=0,
                        total_pages=0,
                        has_next=False,
                        has_prev=False
                    ),
                    search_query=query
                )
            
            tag_id = tag["id"]

            # Paged by family (see families.py); only tagged members are shown.
            match = "EXISTS (SELECT 1 FROM post_tags pt WHERE pt.post_id = {id} AND pt.tag_id = %s)"
            if liked_filter is True:
                match += " AND " + LIKED_MATCH
            elif liked_filter is False:
                match += " AND " + NOT_LIKED_MATCH
            params = (tag_id,)
            total_count = count_filtered_families(cur, match, params)
            # Search results never carried similarity; keep that behavior.
            db_posts = fetch_filtered_families_page(
                cur, match, params, page_size, offset, with_similarity=False
            )

            # Convert to API models
            posts = [Post(**db_post_to_api(row)) for row in db_posts]
            
            # Calculate pagination
            total_pages = (total_count + page_size - 1) // page_size
            
            pagination = PaginationInfo(
                current_page=page,
                per_page=page_size,
                total_items=total_count,
                total_pages=total_pages,
                has_next=page < total_pages,
                has_prev=page > 1
            )
            
            return SearchTagsResponse(
                posts=posts,
                pagination=pagination,
                search_query=query
            )
