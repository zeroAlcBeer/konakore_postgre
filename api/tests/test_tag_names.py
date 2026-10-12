"""
/v1/tags/zh-names, specified in docs/tag-names.md. The import itself is
tested in the worker (worker/tag_names_test.go).
"""


def add(conn, tags, names):
    with conn.cursor() as cur:
        for i, name in enumerate(tags, start=1):
            cur.execute("INSERT INTO tags (id, name, count, type, ambiguous) VALUES (%s, %s, 0, 0, FALSE)", (i, name))
        for name, zh in names.items():
            cur.execute("INSERT INTO tag_names_zh (name, zh) VALUES (%s, %s)", (name, zh))


def test_only_tags_we_hold_with_a_name(db, client):
    add(db, ["flowers", "some_character", "no_name_tag"], {"flowers": "花朵", "some_character": "某角色", "unseen": "未见"})

    res = client.get("/v1/tags/zh-names")

    assert res.status_code == 200
    assert res.json() == {"flowers": "花朵", "some_character": "某角色"}


def test_etag_revalidation(db, client):
    add(db, ["flowers"], {"flowers": "花朵"})
    etag = client.get("/v1/tags/zh-names").headers["etag"]

    assert client.get("/v1/tags/zh-names", headers={"If-None-Match": etag}).status_code == 304

    with db.cursor() as cur:
        cur.execute("UPDATE tag_names_zh SET zh = '花' WHERE name = 'flowers'")
    res = client.get("/v1/tags/zh-names", headers={"If-None-Match": etag})
    assert res.status_code == 200 and res.json() == {"flowers": "花"}
