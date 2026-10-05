"""
Stats router - handles statistics and analytics endpoints.

Posts are read from the stats_posts materialized view and likes from
post_likes; see docs/stats.md.
"""
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

router = APIRouter(prefix="/v1/stats", tags=["stats"])
logger = logging.getLogger(__name__)

NUM_BUCKETS = 80
MIN_BUCKET_WIDTH = 300


def _id_range(cur):
    cur.execute("SELECT MIN(post_id) AS min_id, MAX(post_id) AS max_id FROM stats_posts")
    row = cur.fetchone()
    return row['min_id'] or 0, row['max_id'] or 0


def _id_buckets(cur, q_min: int, q_max: int):
    """NUM_BUCKETS equal-width buckets over [q_min, q_max], newest first."""
    if q_max <= q_min:
        return [], 0.0
    bucket_width = (q_max - q_min + 1) / NUM_BUCKETS
    # width_bucket returns 1..count for [low, high); high is q_max + 1 to include q_max.
    cur.execute("""
        SELECT
            width_bucket(s.post_id, %(q_min)s, %(q_max_exc)s, %(num_buckets)s) AS bucket,
            COUNT(*) AS total_count,
            COUNT(l.post_id) AS liked_count
        FROM stats_posts s
        LEFT JOIN post_likes l ON l.post_id = s.post_id
        WHERE s.post_id BETWEEN %(q_min)s AND %(q_max)s
        GROUP BY bucket
    """, {'q_min': q_min, 'q_max': q_max, 'q_max_exc': q_max + 1, 'num_buckets': NUM_BUCKETS})
    rows = {row['bucket']: row for row in cur.fetchall()}

    buckets = []
    for i in range(NUM_BUCKETS, 0, -1):
        row = rows.get(i)
        buckets.append(StatsDistributionBucket(
            id_start=q_min + int((i - 1) * bucket_width),
            id_end=q_min + int(i * bucket_width) - 1 if i < NUM_BUCKETS else q_max,
            total_count=row['total_count'] if row else 0,
            liked_count=row['liked_count'] if row else 0,
        ))
    return buckets, bucket_width


@router.get("/overview", response_model=StatsOverviewResponse)
def get_stats_overview():
    """
    Get a comprehensive statistics overview in a single request.

    Returns:
    - Summary: total posts, total liked, like ratio
    - ID distribution: 80 equal-width buckets from min to max ID, newest first
    - Rating breakdown: count of s/q/e ratings for all posts and liked posts
    """
    with get_db_connection() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                SELECT (SELECT COUNT(*) FROM stats_posts) AS total_posts,
                       (SELECT COUNT(*) FROM post_likes) AS total_liked
            """)
            totals = cur.fetchone()
            total_posts, total_liked = totals['total_posts'], totals['total_liked']

            buckets, _ = _id_buckets(cur, *_id_range(cur))

            cur.execute("""
                SELECT s.rating, COUNT(*) AS total_count, COUNT(l.post_id) AS liked_count
                FROM stats_posts s
                LEFT JOIN post_likes l ON l.post_id = s.post_id
                WHERE s.rating IS NOT NULL
                GROUP BY s.rating
                ORDER BY s.rating
            """)
            ratings = [StatsRatingBreakdown(**row) for row in cur.fetchall()]

            return StatsOverviewResponse(
                total_posts=total_posts,
                total_liked=total_liked,
                ratio=round(total_liked / max(total_posts, 1), 4),
                buckets=buckets,
                ratings=ratings,
                generated_at=time.time(),
            )


@router.get("/distribution", response_model=StatsDistributionResponse)
def get_stats_distribution(
    id_min: Optional[int] = Query(None, description="Lower bound of ID range"),
    id_max: Optional[int] = Query(None, description="Upper bound of ID range"),
):
    """
    Get ID distribution buckets for a specific range. Used for zoom functionality.
    Returns NUM_BUCKETS equal-width buckets within [id_min, id_max], newest first.
    """
    with get_db_connection() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            global_min, global_max = _id_range(cur)
            q_min = id_min if id_min is not None else global_min
            q_max = id_max if id_max is not None else global_max
            buckets, bucket_width = _id_buckets(cur, q_min, q_max)

            return StatsDistributionResponse(
                buckets=buckets,
                id_min=q_min,
                id_max=q_max,
                global_id_min=global_min,
                global_id_max=global_max,
                bucket_width=bucket_width,
                can_zoom_in=bucket_width >= MIN_BUCKET_WIDTH,
                generated_at=time.time(),
            )
