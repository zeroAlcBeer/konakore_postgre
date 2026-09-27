"""
Users router - handles all user-related endpoints.
"""
from fastapi import APIRouter, Query
from psycopg2.extras import RealDictCursor
import time
import logging

from models import (
    UserPreferencesResponse, UserPreferenceTag, UserPreferencesStats,
    ListLikedPostsResponse, LikedPostItem, PaginationInfo,
)
from utils import get_db_connection

router = APIRouter(prefix="/v1/users", tags=["users"])
logger = logging.getLogger(__name__)


@router.get("/me/preferences", response_model=UserPreferencesResponse)
def get_current_user_preferences():
    """
    Get current user's preference statistics based on liked posts.
    
    Returns tag statistics from liked posts for personalized sorting and recommendations.
    This endpoint uses '/me' as an alias for the current user (following resource naming best practices).
    
    In a multi-tenant system, this would use authentication to identify the user.
    Currently returns preferences for the single implicit user.
    """
    with get_db_connection() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # Get tag statistics from liked posts
            cur.execute("""
                SELECT 
                    t.name,
                    t.type,
                    COUNT(pt.post_id) as liked_count,
                    t.count as global_count,
                    CASE 
                        WHEN t.type = 0 THEN 'GENERAL'
                        WHEN t.type = 1 THEN 'ARTIST'
                        WHEN t.type = 3 THEN 'COPYRIGHT'
                        WHEN t.type = 4 THEN 'CHARACTER'
                        WHEN t.type = 6 THEN 'COMPANY'
                        ELSE 'OTHER'
                    END as type_name
                FROM tags t
                JOIN post_tags pt ON t.id = pt.tag_id
                JOIN post_likes l ON l.post_id = pt.post_id
                GROUP BY t.id, t.name, t.type, t.count
                HAVING COUNT(pt.post_id) >= 2  -- Only include tags appearing at least twice
                ORDER BY t.type, COUNT(pt.post_id) DESC
            """)
            
            preferences = cur.fetchall()
            
            # Group by type
            preferences_by_type = {}
            total_stats = {
                'total_liked_posts': 0,
                'types': {}
            }
            
            for pref in preferences:
                type_name = pref['type_name']
                if type_name not in preferences_by_type:
                    preferences_by_type[type_name] = []
                    total_stats['types'][type_name] = {
                        'total_tags': 0,
                        'total_occurrences': 0
                    }
                
                preferences_by_type[type_name].append(UserPreferenceTag(
                    name=pref['name'],
                    liked_count=pref['liked_count'],
                    global_count=pref['global_count'],
                    preference_ratio=round(pref['liked_count'] / max(pref['global_count'], 1) * 100, 4)
                ))
                
                total_stats['types'][type_name]['total_tags'] += 1
                total_stats['types'][type_name]['total_occurrences'] += pref['liked_count']
            
            # Get total liked posts count
            cur.execute("SELECT COUNT(*) as count FROM post_likes")
            total_stats['total_liked_posts'] = cur.fetchone()['count']
            
            return UserPreferencesResponse(
                preferences_by_type=preferences_by_type,
                statistics=UserPreferencesStats(**total_stats),
                generated_at=time.time()
            )


@router.get("/me/liked-posts", response_model=ListLikedPostsResponse)
def get_current_user_liked_posts(
    page: int = Query(default=1, ge=1, description="Page number (1-indexed)"),
    limit: int = Query(default=3000, ge=1, le=5000, description="Number of posts per page (default 3000, max 5000)"),
    fields: str = Query(default="tags,score,rating", description="Comma-separated fields to return")
):
    """
    Get current user's liked posts for TF-IDF learning and preference modeling.
    
    Returns lightweight post data with only the requested fields to minimize data transfer.
    Default limit is 3000 posts which should be sufficient for building accurate user profiles.
    
    Recommended client-side caching: 30 minutes (same as preferences endpoint).
    
    Fields:
    - tags: Space-separated tag string (required for TF-IDF)
    - score: Post score/popularity
    - rating: Content rating (s=safe, q=questionable, e=explicit)
    
    In a multi-tenant system, this would use authentication to identify the user.
    Currently returns liked posts for the single implicit user.
    """
    # Enforce limit
    limit = min(limit, 5000)
    offset = (page - 1) * limit
    
    # Parse requested fields
    requested_fields = set(fields.split(','))
    
    with get_db_connection() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # Get total count
            cur.execute("SELECT COUNT(*) as count FROM post_likes")
            result = cur.fetchone()
            total_count = result['count'] if result else 0
            
            # Get liked posts with raw_data
            cur.execute("""
                SELECT p.id, p.raw_data
                FROM post_likes l
                JOIN posts p ON p.id = l.post_id
                ORDER BY p.id DESC
                LIMIT %s OFFSET %s
            """, (limit, offset))
            
            db_posts = cur.fetchall()
            
            # Extract only requested fields from raw_data
            posts = []
            for row in db_posts:
                post_data = {'id': row['id']}
                raw = row['raw_data']
                
                # tags field is required for TF-IDF
                if 'tags' in requested_fields:
                    post_data['tags'] = raw.get('tags', '')
                else:
                    post_data['tags'] = ''  # Always include tags field
                
                if 'score' in requested_fields:
                    post_data['score'] = raw.get('score', 0)
                
                if 'rating' in requested_fields:
                    post_data['rating'] = raw.get('rating', 's')
                
                posts.append(LikedPostItem(**post_data))
            
            # Calculate pagination
            total_pages = (total_count + limit - 1) // limit if total_count > 0 else 0
            
            pagination = PaginationInfo(
                current_page=page,
                per_page=limit,
                total_items=total_count,
                total_pages=total_pages,
                has_next=page < total_pages,
                has_prev=page > 1
            )
            
            return ListLikedPostsResponse(posts=posts, pagination=pagination)


