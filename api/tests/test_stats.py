"""
/v1/stats, specified in docs/stats.md: post counts come from the
stats_posts view (as of its last refresh), like counts are live.
"""
import json


def add_posts(conn, ratings_by_id):
    with conn.cursor() as cur:
        for post_id, rating in ratings_by_id.items():
            cur.execute("INSERT INTO posts (id, raw_data) VALUES (%s, %s)",
                        (post_id, json.dumps({"id": post_id, "rating": rating})))


def like(conn, *post_ids):
    with conn.cursor() as cur:
        for post_id in post_ids:
            cur.execute("INSERT INTO post_likes (post_id) VALUES (%s)", (post_id,))


def refresh(conn):
    with conn.cursor() as cur:
        cur.execute("REFRESH MATERIALIZED VIEW stats_posts")


def test_overview_counts_posts_from_the_view_and_likes_live(client, db):
    add_posts(db, {100: "s", 200: "s", 300: "e"})
    refresh(db)
    like(db, 300)
    add_posts(db, {400: "q"})  # not refreshed yet

    body = client.get("/v1/stats/overview").json()
    assert (body["total_posts"], body["total_liked"]) == (3, 1)
    assert {r["rating"]: (r["total_count"], r["liked_count"]) for r in body["ratings"]} == \
        {"s": (2, 0), "e": (1, 1)}
    assert len(body["buckets"]) == 80
    assert sum(b["total_count"] for b in body["buckets"]) == 3


def test_distribution_covers_the_requested_range_newest_first(client, db):
    add_posts(db, {i: "s" for i in range(1000, 1800)})
    refresh(db)

    body = client.get("/v1/stats/distribution", params={"id_min": 1000, "id_max": 1399}).json()
    assert (body["id_min"], body["id_max"], body["global_id_min"], body["global_id_max"]) == (1000, 1399, 1000, 1799)
    assert body["bucket_width"] == 5 and body["can_zoom_in"] is False
    buckets = body["buckets"]
    assert (buckets[0]["id_start"], buckets[0]["id_end"], buckets[-1]["id_start"]) == (1395, 1399, 1000)
    assert all(b["total_count"] == 5 for b in buckets)
