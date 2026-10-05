"""
Pydantic models for API request and response validation.
Follows Google AIP standards for field naming and structure.
"""
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field, field_validator
from datetime import datetime


# ============================================================================
# Base Models
# ============================================================================

class Post(BaseModel):
    """Post resource representation."""
    id: int
    data: Dict[str, Any] = Field(..., description="Post data from external API")
    processed: bool = Field(default=False, description="Whether the post has been processed")
    liked: bool = Field(default=False, description="Whether the post is liked by the user")
    update_time: datetime = Field(..., description="Last sync timestamp")
    similarity: Optional[float] = Field(
        default=None,
        description="Cosine similarity between this post's tag embedding and the user profile, in [0,1]. NULL when either side has no embedding.",
    )
    family_id: Optional[int] = Field(
        default=None,
        description="Parent/child family this post belongs to; posts with the same value form one group. May name a post not stored locally.",
    )

    class Config:
        json_schema_extra = {
            "example": {
                "id": 123456,
                "data": {"title": "Example", "url": "https://example.com"},
                "processed": False,
                "liked": True,
                "update_time": "2024-01-01T00:00:00Z"
            }
        }


class Tag(BaseModel):
    """Tag resource representation."""
    id: int
    name: str
    count: int
    type: int
    ambiguous: bool
    update_time: datetime = Field(..., description="Last sync timestamp")

    class Config:
        json_schema_extra = {
            "example": {
                "id": 1,
                "name": "landscape",
                "count": 100,
                "type": 0,
                "ambiguous": False,
                "update_time": "2024-01-01T00:00:00Z"
            }
        }


class TagSummary(BaseModel):
    """Tag summary for aggregated queries."""
    name: str
    type: int
    count: int = Field(..., description="Number of occurrences in the filtered posts")

    class Config:
        json_schema_extra = {
            "example": {
                "name": "landscape",
                "type": 0,
                "count": 42
            }
        }


# ============================================================================
# Request Models
# ============================================================================

class ListPostsRequest(BaseModel):
    """Request model for listing posts."""
    page: int = Field(default=1, ge=1, description="Page number (1-indexed)")
    limit: int = Field(default=100, ge=1, le=500, description="Number of posts per page")
    liked: Optional[bool] = Field(default=None, description="Filter by liked status")

    @field_validator('limit')
    @classmethod
    def validate_limit(cls, v):
        """Ensure limit does not exceed maximum."""
        return min(v, 500)


class ListTagsRequest(BaseModel):
    """Request model for listing tags."""
    page: int = Field(default=1, ge=1, description="Page number (1-indexed)")
    limit: int = Field(default=100, ge=1, le=500, description="Number of posts to consider")
    liked: Optional[bool] = Field(default=None, description="Filter posts by liked status")

    @field_validator('limit')
    @classmethod
    def validate_limit(cls, v):
        """Ensure limit does not exceed maximum."""
        return min(v, 500)


class SearchTagsRequest(BaseModel):
    """Request model for searching tags."""
    q: str = Field(..., min_length=2, description="Search query (minimum 2 characters)")
    page: int = Field(default=1, ge=1, description="Page number (1-indexed)")
    limit: int = Field(default=100, ge=1, le=500, description="Number of posts per page")
    liked: Optional[bool] = Field(default=None, description="Filter by liked status")

    @field_validator('limit')
    @classmethod
    def validate_limit(cls, v):
        """Ensure limit does not exceed maximum."""
        return min(v, 500)


class ToggleLikeRequest(BaseModel):
    """Request model for toggling post like status."""
    # Currently a simple toggle, but can be extended in the future
    pass


# ============================================================================
# Response Models
# ============================================================================

class PaginationInfo(BaseModel):
    """Pagination metadata."""
    current_page: int
    per_page: int
    total_items: int
    total_pages: int
    has_next: bool
    has_prev: bool


class ListPostsResponse(BaseModel):
    """Response model for listing posts."""
    posts: List[Post]
    pagination: PaginationInfo


class ListTagsResponse(BaseModel):
    """Response model for listing tags (aggregated by posts range)."""
    tags: List[TagSummary]


class SearchTagsResponse(BaseModel):
    """Response model for searching tags."""
    posts: List[Post]
    pagination: PaginationInfo
    search_query: str


class GetPostResponse(BaseModel):
    """Response model for getting a single post."""
    post: Optional[Post] = None


class GetTagResponse(BaseModel):
    """Response model for getting a single tag."""
    tag: Optional[Tag] = None


class ToggleLikeResponse(BaseModel):
    """Response model for toggling post like status."""
    post_id: int
    liked: bool
    message: str


class UserPreferenceTag(BaseModel):
    """Tag preference information."""
    name: str
    liked_count: int
    global_count: int
    preference_ratio: float


class UserPreferencesByType(BaseModel):
    """User preferences grouped by tag type."""
    tags: List[UserPreferenceTag]


class UserPreferencesStats(BaseModel):
    """Overall statistics for user preferences."""
    total_liked_posts: int
    types: Dict[str, Dict[str, int]]


class UserPreferencesResponse(BaseModel):
    """Response model for user preferences."""
    preferences_by_type: Dict[str, List[UserPreferenceTag]]
    statistics: UserPreferencesStats
    generated_at: float


class LikedPostItem(BaseModel):
    """Lightweight representation of a liked post for TF-IDF learning."""
    id: int
    tags: str = Field(..., description="Space-separated tag string")
    score: Optional[int] = Field(default=0, description="Post score")
    rating: Optional[str] = Field(default='s', description="Content rating (s/q/e)")

    class Config:
        json_schema_extra = {
            "example": {
                "id": 123456,
                "tags": "artist_name 1girl solo long_hair",
                "score": 100,
                "rating": "s"
            }
        }


class ListLikedPostsResponse(BaseModel):
    """Response model for listing liked posts."""
    posts: List[LikedPostItem]
    pagination: PaginationInfo


class ErrorDetail(BaseModel):
    """Error detail structure following AIP-193."""
    code: str
    message: str
    details: Optional[Dict[str, Any]] = None


class ApiIndexResponse(BaseModel):
    """Response model for API index endpoint."""
    message: str
    version: str
    endpoints: Dict[str, Dict[str, str]]
    examples: Dict[str, str]


class StatsDistributionBucket(BaseModel):
    """A single bucket in the ID distribution histogram."""
    id_start: int
    id_end: int
    total_count: int
    liked_count: int


class StatsRatingBreakdown(BaseModel):
    """Rating counts for all posts and liked posts."""
    rating: str = Field(..., description="Content rating: s (safe), q (questionable), e (explicit)")
    total_count: int
    liked_count: int


class StatsOverviewResponse(BaseModel):
    """Response model for stats overview endpoint."""
    total_posts: int
    total_liked: int
    ratio: float
    buckets: List[StatsDistributionBucket]
    ratings: List[StatsRatingBreakdown]
    generated_at: float


class StatsDistributionResponse(BaseModel):
    """Response model for parameterized distribution query."""
    buckets: List[StatsDistributionBucket]
    id_min: int
    id_max: int
    global_id_min: int
    global_id_max: int
    bucket_width: float
    can_zoom_in: bool = Field(..., description="False when bucket width < 300")
    generated_at: float


class CharacterCover(BaseModel):
    """Cover post of a character; URLs are the upstream ones from raw_data."""
    post_id: int
    preview_url: Optional[str] = None
    sample_url: Optional[str] = None


class CharacterSummary(BaseModel):
    """A character in a list (definitions: docs/characters.md)."""
    name: str
    family_count: int
    work: Optional[str] = None
    cover: Optional[CharacterCover] = None


class CooccurringCharacter(BaseModel):
    name: str
    family_count: int = Field(..., description="Families shared with the character")
    cover: Optional[CharacterCover] = None


class Character(CharacterSummary):
    cooccurring: List[CooccurringCharacter]


class ListCharactersResponse(BaseModel):
    characters: List[CharacterSummary]
    pagination: PaginationInfo


class TaskStateResponse(BaseModel):
    """Worker task state with progress data."""
    id: str
    name: str
    type: str
    category: str = ""
    status: str
    desired_status: str
    progress_pct: float
    current_value: Optional[int] = None
    total_value: Optional[int] = None
    unit: Optional[str] = None
    state: Dict[str, Any] = Field(default_factory=dict)
    config: Dict[str, Any] = Field(default_factory=dict)
    error_message: Optional[str] = None
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    last_run_at: Optional[datetime] = None
    next_run_at: Optional[datetime] = None
    updated_at: datetime


# ============================================================================
# Helper Functions
# ============================================================================

def db_post_to_api(db_row: dict) -> dict:
    """
    Convert database post row to API Post model format.
    Maps database field names (is_liked, is_processed, last_synced_at, raw_data)
    to API field names (liked, processed, update_time, data).
    """
    return {
        "id": db_row["id"],
        "data": db_row["raw_data"],
        "processed": db_row.get("is_processed", False),
        "liked": db_row.get("is_liked", False),
        "update_time": db_row["last_synced_at"],
        "similarity": db_row.get("similarity"),
        "family_id": db_row.get("family_id"),
    }


def db_tag_to_api(db_row: dict) -> dict:
    """
    Convert database tag row to API Tag model format.
    Maps database field names (last_synced_at) to API field names (update_time).
    """
    return {
        "id": db_row["id"],
        "name": db_row["name"],
        "count": db_row["count"],
        "type": db_row["type"],
        "ambiguous": db_row["ambiguous"],
        "update_time": db_row["last_synced_at"]
    }
