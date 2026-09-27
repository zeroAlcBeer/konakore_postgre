"""
Stats router - handles statistics and analytics endpoints.
"""
from collections import OrderedDict
from typing import Optional

from fastapi import APIRouter, Query
from psycopg2.extras import RealDictCursor
import time
import logging

from models import (
    StatsOverviewResponse, StatsDistributionBucket, StatsRatingBreakdown,
    StatsDistributionResponse
)
from utils import get_db_connection

# In-memory cache for stats overview
_stats_cache = {
    'result': None,
    'liked_count': None,  # cache key: invalidate when liked count changes
}

# LRU cache for distribution queries: key=(id_min, id_max, liked_count) -> result
_DIST_CACHE_MAX = 16
_dist_cache: OrderedDict = OrderedDict()

router = APIRouter(prefix="/v1/stats", tags=["stats"])
logger = logging.getLogger(__name__)

NUM_BUCKETS = 80
MIN_BUCKET_WIDTH = 300


@router.get("/overview", response_model=StatsOverviewResponse)
def get_stats_overview():
    """
    Get a comprehensive statistics overview in a single request.

    Returns:
    - Summary: total posts, total liked, like ratio
    - ID distribution: 80 equal-width buckets from min to max ID, newest first
    - Rating breakdown: count of s/q/e ratings for all posts and liked posts

    Results are cached in memory and invalidated when the liked count changes.
    """
    with get_db_connection() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # Check if cache is valid
            cur.execute("SELECT COUNT(*) as count FROM post_likes")
            liked_count = cur.fetchone()['count']

            if (_stats_cache['result'] is not None
                    and _stats_cache['liked_count'] == liked_count):
                return _stats_cache['result']

            # --- Summary ---
            cur.execute("SELECT COUNT(*) as count FROM posts")
            total_posts = cur.fetchone()['count']
            total_liked = liked_count
            ratio = round(total_liked / max(total_posts, 1), 4)

            # --- ID Distribution Buckets ---
            cur.execute("SELECT MIN(id) as min_id, MAX(id) as max_id FROM posts")
            range_row = cur.fetchone()
            min_id = range_row['min_id'] or 0
            max_id = range_row['max_id'] or 0

            buckets = []
            if total_posts > 0 and max_id > min_id:
                # Use width_bucket to assign each post to one of NUM_BUCKETS buckets
                # width_bucket(value, low, high, count) returns 1..count for values in [low, high)
                # and count+1 for values == high. We add 1 to max_id to make it inclusive.
                cur.execute("""
                    SELECT
                        width_bucket(id, %(min_id)s, %(max_id_exc)s, %(num_buckets)s) AS bucket,
                        COUNT(*) AS total_count,
                        COUNT(l.post_id) AS liked_count
                    FROM posts
                    LEFT JOIN post_likes l ON l.post_id = posts.id
                    GROUP BY bucket
                    ORDER BY bucket
                """, {
                    'min_id': min_id,
                    'max_id_exc': max_id + 1,
                    'num_buckets': NUM_BUCKETS,
                })

                bucket_rows = {row['bucket']: row for row in cur.fetchall()}
                bucket_width = (max_id - min_id + 1) / NUM_BUCKETS

                for i in range(1, NUM_BUCKETS + 1):
                    id_start = min_id + int((i - 1) * bucket_width)
                    id_end = min_id + int(i * bucket_width) - 1 if i < NUM_BUCKETS else max_id
                    row = bucket_rows.get(i)
                    buckets.append(StatsDistributionBucket(
                        id_start=id_start,
                        id_end=id_end,
                        total_count=row['total_count'] if row else 0,
                        liked_count=row['liked_count'] if row else 0,
                    ))

                # Newest first
                buckets.reverse()

            # --- Rating Breakdown ---
            cur.execute("""
                SELECT
                    raw_data->>'rating' AS rating,
                    COUNT(*) AS total_count,
                    COUNT(l.post_id) AS liked_count
                FROM posts
                LEFT JOIN post_likes l ON l.post_id = posts.id
                WHERE raw_data->>'rating' IS NOT NULL
                GROUP BY raw_data->>'rating'
                ORDER BY raw_data->>'rating'
            """)

            ratings = [
                StatsRatingBreakdown(
                    rating=row['rating'],
                    total_count=row['total_count'],
                    liked_count=row['liked_count'],
                )
                for row in cur.fetchall()
            ]

            result = StatsOverviewResponse(
                total_posts=total_posts,
                total_liked=total_liked,
                ratio=ratio,
                buckets=buckets,
                ratings=ratings,
                generated_at=time.time(),
            )

            # Update cache
            _stats_cache['result'] = result
            _stats_cache['liked_count'] = liked_count

            logger.info(
                f"[API] Stats overview: {total_posts} posts, {total_liked} liked, "
                f"{len(buckets)} buckets, {len(ratings)} ratings"
            )

            return result


@router.get("/distribution", response_model=StatsDistributionResponse)
def get_stats_distribution(
    id_min: Optional[int] = Query(None, description="Lower bound of ID range"),
    id_max: Optional[int] = Query(None, description="Upper bound of ID range"),
):
    """
    Get ID distribution buckets for a specific range. Used for zoom functionality.
    Returns NUM_BUCKETS equal-width buckets within [id_min, id_max], newest first.
    Results are LRU-cached (keyed by id_min, id_max, liked_count).
    """
    with get_db_connection() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # Get global range
            cur.execute("SELECT MIN(id) as min_id, MAX(id) as max_id FROM posts")
            range_row = cur.fetchone()
            global_min = range_row['min_id'] or 0
            global_max = range_row['max_id'] or 0

            # Resolve actual query range
            q_min = id_min if id_min is not None else global_min
            q_max = id_max if id_max is not None else global_max

            # Get current liked count for cache key
            cur.execute("SELECT COUNT(*) as count FROM post_likes")
            liked_count = cur.fetchone()['count']

            cache_key = (q_min, q_max, liked_count)
            if cache_key in _dist_cache:
                _dist_cache.move_to_end(cache_key)
                return _dist_cache[cache_key]

            buckets = []
            bucket_width = 0.0
            if global_max > global_min and q_max > q_min:
                bucket_width = (q_max - q_min + 1) / NUM_BUCKETS

                cur.execute("""
                    SELECT
                        width_bucket(id, %(q_min)s, %(q_max_exc)s, %(num_buckets)s) AS bucket,
                        COUNT(*) AS total_count,
                        COUNT(l.post_id) AS liked_count
                    FROM posts
                    LEFT JOIN post_likes l ON l.post_id = posts.id
                    WHERE id >= %(q_min)s AND id <= %(q_max)s
                    GROUP BY bucket
                    ORDER BY bucket
                """, {
                    'q_min': q_min,
                    'q_max_exc': q_max + 1,
                    'q_max': q_max,
                    'num_buckets': NUM_BUCKETS,
                })

                bucket_rows = {row['bucket']: row for row in cur.fetchall()}

                for i in range(1, NUM_BUCKETS + 1):
                    b_start = q_min + int((i - 1) * bucket_width)
                    b_end = q_min + int(i * bucket_width) - 1 if i < NUM_BUCKETS else q_max
                    row = bucket_rows.get(i)
                    buckets.append(StatsDistributionBucket(
                        id_start=b_start,
                        id_end=b_end,
                        total_count=row['total_count'] if row else 0,
                        liked_count=row['liked_count'] if row else 0,
                    ))

                # Newest first
                buckets.reverse()

            result = StatsDistributionResponse(
                buckets=buckets,
                id_min=q_min,
                id_max=q_max,
                global_id_min=global_min,
                global_id_max=global_max,
                bucket_width=bucket_width,
                can_zoom_in=bucket_width >= MIN_BUCKET_WIDTH,
                generated_at=time.time(),
            )

            # LRU cache insert
            _dist_cache[cache_key] = result
            if len(_dist_cache) > _DIST_CACHE_MAX:
                _dist_cache.popitem(last=False)

            logger.info(
                f"[API] Distribution: range [{q_min}, {q_max}], "
                f"bucket_width={bucket_width:.1f}, can_zoom={result.can_zoom_in}"
            )

            return result
