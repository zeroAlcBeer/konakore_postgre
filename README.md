# konakore_postgre

Self-hosted konachan.net browser: syncs post/tag metadata into Postgres,
downloads liked images via aria2, and serves a React gallery with
tag-embedding-based similarity scoring (pgvector).

## Architecture

| Service    | Stack                        | Role                                                                 |
|------------|------------------------------|----------------------------------------------------------------------|
| `postgres` | pgvector/pgvector:pg14       | Single source of truth: posts, tags, task state, sparse tag embeddings |
| `api`      | Python / FastAPI             | REST API (`/v1/*`, Google AIP style) consumed by the frontend         |
| `worker`   | Go                           | Scheduled konachan sync, aria2 file downloads, embedding + user-profile vectors; HTTP control plane on `:8090` |
| `frontend` | React + Vite, served by nginx | Gallery UI; nginx also proxies `/api/` → api and `/konachan-proxy/` → konachan.net |

The api triggers the worker over HTTP (fire-and-forget); everything else
communicates through Postgres. The Python `scheduler/` and `file_sync/`
services that predated the Go worker were removed in 2026-07 — see git
history if you need them.

## Docs

| Topic | Doc |
|---|---|
| Stats page: data source, `stats_posts` view, refresh task | [docs/stats.md](docs/stats.md) |

## Development

```
make up           # local stack via docker-compose.yaml
make local        # frontend dev server against the remote API (frontend/.env)
make test-worker  # worker tests against a throwaway pgvector Postgres
make test-api     # api tests, same throwaway Postgres
make help         # everything else
```

## Deployment

Production runs as a Dockge stack on a Raspberry Pi
(`docker-compose.deployment.yaml`). Deploys are manual from a workstation:
`make release-{api,worker,frontend}` publishes an immutable git-SHA image
tag to the private Zot registry; pin that tag in the stack's `.env` (see
`.env.example`), then pull and recreate only that service. CI
(`.github/workflows/ci.yml`) only checks builds and tests.
