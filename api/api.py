"""
Konakore API - Main application entry point.

This API follows Google AIP (API Improvement Proposals) standards for:
- Resource-oriented design (AIP-121)
- Standard methods (AIP-131 to AIP-135)
- Custom methods (AIP-136)
- Error handling (AIP-193)
"""
import logging
import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import GZipMiddleware
from dotenv import load_dotenv

# Import routers
from routers import posts, tags, users, stats, tasks, characters

load_dotenv()

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize FastAPI app
app = FastAPI(
    title="Konakore API",
    description="""
    API for managing posts, tags, and user preferences.
    
    This API follows Google AIP standards for RESTful design.
    
    ## Features
    - **Posts**: Manage and browse image posts
    - **Tags**: Browse and search tags
    - **Users**: User preferences and personalization
    
    ## Version
    All endpoints are versioned with the `/v1/` prefix.
    """,
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc"
)

# CORS middleware setup.
# Production traffic is same-origin through the nginx proxy, so these origins
# only matter for non-proxied dev access. Override with a comma-separated
# CORS_ORIGINS env var; an empty value falls back to the defaults.
origins = [
    o.strip()
    for o in (
        os.getenv("CORS_ORIGINS")
        or "http://localhost:5173,http://127.0.0.1:5173,http://192.168.0.110:5173"
    ).split(",")
    if o.strip()
]

# Add GZip middleware for response compression
app.add_middleware(GZipMiddleware, minimum_size=1000)

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register routers
app.include_router(posts.router)
app.include_router(tags.router)
app.include_router(users.router)
app.include_router(stats.router)
app.include_router(tasks.router)
app.include_router(characters.router)


@app.get("/")
def read_root():
    """
    API index page showing all available endpoints.
    
    This provides a quick overview of the API structure and available operations.
    For full API documentation, visit /docs (Swagger UI) or /redoc (ReDoc).
    """
    return {
        "message": "Konakore API is running",
        "version": "v1",
        "documentation": {
            "swagger": "/docs",
            "redoc": "/redoc",
            "openapi": "/openapi.json"
        },
        "endpoints": {
            "posts": {
                "GET /v1/posts": "List paginated posts (params: page, limit, liked)",
                "GET /v1/posts/{post_id}": "Get a specific post by ID",
                "POST /v1/posts/{post_id}:like": "Like a post (idempotent)",
                "POST /v1/posts/{post_id}:unlike": "Unlike a post (idempotent)"
            },
            "tags": {
                "GET /v1/tags": "List tags aggregated from posts (params: page, limit, liked)",
                "GET /v1/tags/{tag_id}": "Get a specific tag by ID",
                "POST /v1/tags:search": "Search tags and return related posts (body: query, page, pageSize, liked)"
            },
            "users": {
                "GET /v1/users/me/preferences": "Get current user's preference statistics"
            },
            "tasks": {
                "GET /v1/tasks": "List worker task progress and status"
            }
        },
        "examples": {
            "posts": "/v1/posts?page=1&limit=20",
            "liked_posts": "/v1/posts?liked=true&page=1&limit=20",
            "like_post": "POST /v1/posts/123:like",
            "unlike_post": "POST /v1/posts/123:unlike",
            "tags": "/v1/tags?page=1&limit=20",
            "search": "POST /v1/tags:search (body: {\"query\": \"landscape\", \"pageSize\": 10})",
            "preferences": "/v1/users/me/preferences"
        },
        "migration_notes": {
        }
    }
