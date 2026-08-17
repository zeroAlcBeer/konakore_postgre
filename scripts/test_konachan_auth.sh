#!/usr/bin/env bash
# Verify konachan.net API credentials can fetch explicit/questionable posts
# that are hidden from anonymous guests.
#
# Usage:
#   ./scripts/test_konachan_auth.sh              # loads ./.env.konachan
#   ENV_FILE=path/to/env ./scripts/test_konachan_auth.sh
#
# It performs a few tiny requests (auth vs no-auth) and prints the returned post
# counts and rating mix, so you can confirm 'q'/'e' posts come back with auth.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env.konachan}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "env file not found: $ENV_FILE" >&2
  exit 1
fi
# Parse KEY=VALUE lines WITHOUT executing the file, so special characters in
# the password (spaces, $, quotes, etc.) can't break sourcing or run commands.
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  [[ "$line" != *=* ]] && continue
  key="${line%%=*}"
  val="${line#*=}"
  key="${key//[[:space:]]/}"
  # strip one layer of surrounding single or double quotes, if present
  if [[ "$val" == \"*\" || "$val" == \'*\' ]]; then
    val="${val:1:${#val}-2}"
  fi
  case "$key" in
    KONACHAN_LOGIN|KONACHAN_PASSWORD_HASH|KONACHAN_PASSWORD|KONACHAN_CF_CLEARANCE|KONACHAN_USER_AGENT)
      printf -v "$key" '%s' "$val" ;;
  esac
done < "$ENV_FILE"

: "${KONACHAN_LOGIN:?set KONACHAN_LOGIN in $ENV_FILE}"

HASH="${KONACHAN_PASSWORD_HASH:-}"
if [[ -z "$HASH" ]]; then
  if [[ -n "${KONACHAN_PASSWORD:-}" ]]; then
    HASH="$(printf 'So-I-Heard-You-Like-Mupkids-?--%s--' "$KONACHAN_PASSWORD" | shasum | awk '{print $1}')"
  else
    echo "set KONACHAN_PASSWORD_HASH or KONACHAN_PASSWORD in $ENV_FILE" >&2
    exit 1
  fi
fi

BASE="https://konachan.net/post.json"
# A known explicit post already in the DB; guests get 0 results for it.
PROBE_ID="${PROBE_ID:-405244}"

summarize() { # reads JSON on stdin
  python3 -c '
import sys, json
from collections import Counter
try:
    d = json.load(sys.stdin)
except Exception as e:
    print("  (non-JSON response:", str(e)[:80], ")"); sys.exit()
c = Counter(p.get("rating") for p in d)
print(f"  count={len(d)} ratings={dict(c)}")
'
}

echo "== 1) anonymous: recent range id:406000..406120 =="
curl -s -A "konakore-auth-test" "$BASE?limit=100&tags=id:406000..406120" | summarize

echo "== 2) authenticated: recent range id:406000..406120 =="
curl -s -A "konakore-auth-test" \
  --data-urlencode "login=$KONACHAN_LOGIN" \
  --data-urlencode "password_hash=$HASH" \
  --data-urlencode "limit=100" \
  --data-urlencode "tags=id:406000..406120" \
  -G "$BASE" | summarize

echo "== 3) authenticated: known explicit post id:$PROBE_ID (guest returns 0) =="
curl -s -A "konakore-auth-test" \
  --data-urlencode "login=$KONACHAN_LOGIN" \
  --data-urlencode "password_hash=$HASH" \
  --data-urlencode "tags=id:$PROBE_ID" \
  -G "$BASE" | summarize

echo
echo "If (2) and (3) show q/e ratings (and more posts than (1)), auth works."

# ─── konachan.com behind Cloudflare (real explicit source) ───────────────────
CF="${KONACHAN_CF_CLEARANCE:-}"
UA="${KONACHAN_USER_AGENT:-}"
if [[ -n "$CF" && -n "$UA" ]]; then
  COM="https://konachan.com/post.json"
  echo
  echo "== 4) konachan.com via cf_clearance: newest rating:e =="
  curl -s -A "$UA" \
    --cookie "cf_clearance=$CF" \
    --data-urlencode "login=$KONACHAN_LOGIN" \
    --data-urlencode "password_hash=$HASH" \
    --data-urlencode "limit=5" \
    --data-urlencode "tags=rating:e order:id_desc" \
    -G "$COM" | summarize

  echo "== 5) konachan.com via cf_clearance: recent range id:406000..406120 =="
  curl -s -A "$UA" \
    --cookie "cf_clearance=$CF" \
    --data-urlencode "login=$KONACHAN_LOGIN" \
    --data-urlencode "password_hash=$HASH" \
    --data-urlencode "limit=100" \
    --data-urlencode "tags=id:406000..406120" \
    -G "$COM" | summarize

  echo
  echo "If (4)/(5) show q/e ratings, konachan.com is the working source for the"
  echo "missing posts and the cf_clearance cookie is valid."
else
  echo
  echo "(Skipping konachan.com test: set KONACHAN_CF_CLEARANCE and KONACHAN_USER_AGENT"
  echo " in $ENV_FILE to try the explicit source.)"
fi
