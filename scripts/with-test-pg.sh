#!/usr/bin/env bash
# Run a command against a throwaway pgvector Postgres, exporting
# TEST_DATABASE_URL (a superuser URL; tests create their own databases).
# The container is removed afterwards, whatever the command's result.
set -euo pipefail
NAME=konakore-test-pg
PORT=${TEST_PG_PORT:-55432}

docker rm -fv "$NAME" >/dev/null 2>&1 || true
# tmpfs overrides the image's VOLUME directive so no anonymous volume leaks
# (docker rm -f on a --rm container does not remove anonymous volumes)
docker run -d --rm --name "$NAME" -e POSTGRES_PASSWORD=test -p "$PORT:5432" \
    --tmpfs /var/lib/postgresql/data pgvector/pgvector:pg14 >/dev/null
trap 'docker rm -fv "$NAME" >/dev/null' EXIT
until docker exec "$NAME" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1; do sleep 1; done

export TEST_DATABASE_URL="postgres://postgres:test@localhost:$PORT/postgres?sslmode=disable"
"$@"
