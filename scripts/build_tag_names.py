"""
Build worker/assets/tag_names_zh.json.gz, the Chinese tag names the worker
imports at startup. Rules and refresh procedure: docs/tag-names.md.

    uv run scripts/build_tag_names.py
"""
import csv
import gzip
import io
import json
import pathlib
import re
import urllib.request

REPO = "amenorira/danbooru-tags-data-zh"
REVISION = "5805e4700f52dbe66567b84a157e29a41b3a5bcc"
FILES = ["general.csv", "copyright.csv", "character.csv"]
MIN_ROWS = {"general.csv": 25000, "copyright.csv": 7000, "character.csv": 30000}

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "worker" / "assets" / "tag_names_zh.json.gz"

# An alias that looks like a tag name: konachan's spelling of a Danbooru tag.
TAG_LIKE = re.compile(r"[a-z0-9_().:'!&/+-]+")


def fetch(name):
    url = f"https://raw.githubusercontent.com/{REPO}/{REVISION}/tags/{name}"
    with urllib.request.urlopen(url, timeout=60) as resp:
        text = resp.read().decode("utf-8-sig")
    rows = list(csv.DictReader(io.StringIO(text)))
    if len(rows) < MIN_ROWS[name]:
        raise SystemExit(f"{name}: only {len(rows)} rows, expected at least {MIN_ROWS[name]}")
    return rows


def main():
    rows = []
    for name in FILES:
        for r in fetch(name):
            tag = r["tag"].strip()
            if not tag:
                continue
            rows.append({
                "tag": tag,
                "zh": r["zh"].strip(),
                "count": int(r["count"] or 0),
                "aliases": [a.strip() for a in r["aliases"].split("|") if a.strip()],
            })

    names = {r["tag"]: r["zh"] for r in rows if r["zh"]}

    # Konachan spells some tags the way Danbooru's aliases do (flowers -> flower);
    # an alias takes the name of its most-used tag and never shadows a real tag.
    tags = {r["tag"] for r in rows}
    for r in sorted(rows, key=lambda r: -r["count"]):
        if r["tag"] not in names:
            continue
        for alias in r["aliases"]:
            if alias != r["tag"] and TAG_LIKE.fullmatch(alias) and alias not in tags and alias not in names:
                names[alias] = names[r["tag"]]

    data = {"source": REPO, "revision": REVISION, "names": dict(sorted(names.items()))}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(gzip.compress(json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode(), 9, mtime=0))
    print(f"{len(names)} names, {OUT.stat().st_size // 1024} KiB -> {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
