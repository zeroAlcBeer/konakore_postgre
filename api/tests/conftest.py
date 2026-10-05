"""
DB fixtures: each test gets a fresh database built from the worker's
migrations. TEST_DATABASE_URL is a superuser URL (`make test-api` starts a
throwaway Postgres); DB tests are skipped without it.
"""
import os
import pathlib
import time
import urllib.parse

import psycopg2
import pytest
from fastapi.testclient import TestClient

import utils

MIGRATIONS = pathlib.Path(__file__).resolve().parents[2] / "worker" / "migrations"


@pytest.fixture
def db(monkeypatch):
    admin_url = os.environ.get("TEST_DATABASE_URL")
    if not admin_url:
        pytest.skip("TEST_DATABASE_URL not set")
    url = urllib.parse.urlparse(admin_url)
    name = f"konakore_api_test_{time.time_ns()}"

    admin = psycopg2.connect(admin_url.split("?")[0])
    admin.autocommit = True
    admin.cursor().execute(f"CREATE DATABASE {name}")

    conn = psycopg2.connect(host=url.hostname, port=url.port, user=url.username,
                            password=url.password, dbname=name)
    conn.autocommit = True
    with conn.cursor() as cur:
        for migration in sorted(MIGRATIONS.glob("*.sql")):
            cur.execute(migration.read_text())

    for key, value in {"POSTGRES_HOST": url.hostname, "POSTGRES_PORT": str(url.port),
                       "POSTGRES_USER": url.username, "POSTGRES_PASSWORD": url.password,
                       "POSTGRES_DB": name}.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(utils, "_pool", None)

    yield conn

    if utils._pool is not None:
        utils._pool.closeall()
    conn.close()
    admin.cursor().execute(f"DROP DATABASE {name} WITH (FORCE)")
    admin.close()


@pytest.fixture
def client(db):
    from api import app
    return TestClient(app)
