"""
/v1/characters, specified in docs/characters.md. The stats themselves are
tested in the worker (worker/character_stats_test.go); these tests cover
listing, filtering, paging and the detail shape.
"""
import json
import urllib.parse

import pytest

from routers.characters import MIN_LISTED_FAMILIES as MIN

CHARACTER, COPYRIGHT = 4, 3


class Library:
    """Builds tags and posts, then refreshes the views the API reads."""

    def __init__(self, conn):
        self.conn = conn
        self.tag_ids = {}
        self.next_post_id = 1

    def tag(self, name, type_=CHARACTER):
        if name not in self.tag_ids:
            tag_id = len(self.tag_ids) + 1
            with self.conn.cursor() as cur:
                cur.execute("INSERT INTO tags (id, name, count, type, ambiguous) VALUES (%s, %s, 0, %s, FALSE)",
                            (tag_id, name, type_))
            self.tag_ids[name] = tag_id
        return self.tag_ids[name]

    def post(self, *characters, work=None, rating="s"):
        """One post (its own family) with the given character tags."""
        post_id = self.next_post_id
        self.next_post_id += 1
        tag_ids = [self.tag(c) for c in characters]
        if work:
            tag_ids.append(self.tag(work, COPYRIGHT))
        raw = {"id": post_id, "rating": rating, "score": 0,
               "preview_url": f"https://konachan.net/preview/{post_id}.jpg",
               "sample_url": f"https://konachan.net/sample/{post_id}.jpg"}
        with self.conn.cursor() as cur:
            cur.execute("INSERT INTO posts (id, raw_data) VALUES (%s, %s)", (post_id, json.dumps(raw)))
            for tag_id in tag_ids:
                cur.execute("INSERT INTO post_tags (post_id, tag_id) VALUES (%s, %s)", (post_id, tag_id))
        return post_id

    def families(self, character, n, work=None):
        for _ in range(n):
            self.post(character, work=work)

    def refresh(self):
        with self.conn.cursor() as cur:
            cur.execute("SELECT refresh_post_families()")
            cur.execute("REFRESH MATERIALIZED VIEW character_stats")
            cur.execute("REFRESH MATERIALIZED VIEW character_cooccurrence")


@pytest.fixture
def lib(db):
    return Library(db)


def names(response):
    assert response.status_code == 200, response.text
    return [c["name"] for c in response.json()["characters"]]


def test_long_tail_threshold_is_20_families():
    assert MIN == 20  # docs/characters.md, API


def test_list_orders_by_families_then_name_and_hides_the_long_tail(client, lib):
    lib.families("dave", MIN + 1)
    lib.families("alice", MIN + 1)
    lib.families("bob", MIN)
    lib.families("carol", MIN - 1)
    lib.refresh()

    r = client.get("/v1/characters")
    assert names(r) == ["alice", "dave", "bob"]
    assert r.json()["pagination"]["total_items"] == 3


def test_list_pages(client, lib):
    for i, name in enumerate(["a", "b", "c"]):
        lib.families(name, MIN + 2 - i)
    lib.refresh()

    r = client.get("/v1/characters?page=2&limit=2")
    assert names(r) == ["c"]
    p = r.json()["pagination"]
    assert (p["current_page"], p["per_page"], p["total_items"], p["total_pages"], p["has_next"], p["has_prev"]) == \
        (2, 2, 3, 2, False, True)


def test_work_filter_lists_all_characters_of_that_work(client, lib):
    lib.post("alice", work="work_x")
    lib.post("bob", work="work_y")
    lib.refresh()

    assert names(client.get("/v1/characters", params={"work": "work_x"})) == ["alice"]


def test_item_carries_work_and_cover(client, lib):
    cover = lib.post("alice", work="work_x")
    lib.post("bob", rating="e")
    lib.refresh()

    alice = client.get("/v1/characters", params={"work": "work_x"}).json()["characters"][0]
    assert alice == {
        "name": "alice", "family_count": 1, "work": "work_x",
        "cover": {"post_id": cover,
                  "preview_url": f"https://konachan.net/preview/{cover}.jpg",
                  "sample_url": f"https://konachan.net/sample/{cover}.jpg"},
    }
    bob = client.get("/v1/characters/bob").json()
    assert bob["work"] is None and bob["cover"] is None


def test_detail_includes_cooccurring_characters(client, lib):
    for _ in range(2):
        lib.post("saber_(fate)", "rin")
    lib.post("saber_(fate)", "sakura")
    lib.refresh()

    r = client.get("/v1/characters/" + urllib.parse.quote("saber_(fate)", safe=""))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == "saber_(fate)" and body["family_count"] == 3
    assert body["cooccurring"] == [{"name": "rin", "family_count": 2}, {"name": "sakura", "family_count": 1}]


def test_detail_accepts_a_slash_in_the_name(client, lib):
    lib.post("a/b")
    lib.refresh()

    assert client.get("/v1/characters/" + urllib.parse.quote("a/b", safe="")).status_code == 200


def test_detail_404s_for_unknown_and_excluded_names(client, lib):
    lib.post("alice", "tagme_(character)")
    lib.refresh()

    assert client.get("/v1/characters/nobody").status_code == 404
    assert client.get("/v1/characters/" + urllib.parse.quote("tagme_(character)", safe="")).status_code == 404


def set_cover(client, name, post_id):
    return client.post(f"/v1/characters/{urllib.parse.quote(name, safe='')}:setCover", json={"post_id": post_id})


def cover_id(client, name):
    return client.get(f"/v1/characters/{urllib.parse.quote(name, safe='')}").json()["cover"]["post_id"]


def test_set_cover_overrides_the_automatic_one_at_once(client, lib):
    auto = lib.post("alice")
    explicit = lib.post("alice", rating="e")
    later = lib.post("alice", "tagme_(character)", rating="q")  # excluded tags do not count
    lib.refresh()
    assert cover_id(client, "alice") == auto

    assert set_cover(client, "alice", explicit).status_code == 204
    assert cover_id(client, "alice") == explicit  # no view refresh needed

    assert set_cover(client, "alice", later).status_code == 204
    assert cover_id(client, "alice") == later


def test_set_cover_accepts_group_shots_for_the_named_character(client, lib):
    alice_auto = lib.post("alice")
    bob_auto = lib.post("bob")
    group = lib.post("alice", "bob")
    lib.refresh()

    assert set_cover(client, "alice", group).status_code == 204
    assert cover_id(client, "alice") == group
    assert cover_id(client, "bob") == bob_auto  # only the named character changes
    assert alice_auto != group


def test_set_cover_rejects_foreign_and_unknown(client, lib):
    lib.post("alice")
    foreign = lib.post("bob")
    lib.refresh()

    assert set_cover(client, "alice", foreign).status_code == 400
    assert set_cover(client, "nobody", foreign).status_code == 404
    assert set_cover(client, "tagme_(character)", foreign).status_code == 404
    assert set_cover(client, "alice", 999999).status_code == 404


def test_post_characters_lists_only_characters(client, lib):
    group = lib.post("alice", "bob", "tagme_(character)", work="work_x")
    lib.tag("scenery", 0)
    with lib.conn.cursor() as cur:
        cur.execute("INSERT INTO posts (id, raw_data) VALUES (500, %s)", (json.dumps({"id": 500, "rating": "s"}),))
        cur.execute("INSERT INTO post_tags (post_id, tag_id) VALUES (500, %s)", (lib.tag_ids["scenery"],))
    lib.refresh()

    assert client.get(f"/v1/posts/{group}/characters").json() == {"characters": ["alice", "bob"]}
    assert client.get("/v1/posts/500/characters").json() == {"characters": []}
    assert client.get("/v1/posts/999999/characters").status_code == 404
