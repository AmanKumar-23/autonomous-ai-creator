#!/usr/bin/env bash
# Guards the one constraint that decides eligibility: the feed must never 5xx.
#
#   npm run dev            # in another terminal
#   ./scripts/smoke-test.sh [base-url]
#
# Re-run this after ANY change to lib/store.ts or the routes. It corrupts
# data/posts.json on purpose and restores it at the end.

set -uo pipefail
BASE="${1:-http://localhost:3000}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POSTS="$DIR/data/posts.json"
STATE="$DIR/data/state.json"
POSTS_BACKUP="$(mktemp)"
STATE_BACKUP="$(mktemp)"
PASS=0
FAIL=0

# Both files are restored: this script initializes the agent and corrupts the
# feed on purpose, and neither may be left behind for someone to commit.
cleanup() {
  cp "$POSTS_BACKUP" "$POSTS"
  cp "$STATE_BACKUP" "$STATE"
  rm -f "$POSTS_BACKUP" "$STATE_BACKUP"
}
trap cleanup EXIT

cp "$POSTS" "$POSTS_BACKUP"
cp "$STATE" "$STATE_BACKUP"

expect() { # expect <label> <expected-code> <actual-code>
  if [ "$2" = "$3" ]; then
    printf '  \033[32mPASS\033[0m  %-42s %s\n' "$1" "$3"; PASS=$((PASS + 1))
  else
    printf '  \033[31mFAIL\033[0m  %-42s got %s, want %s\n' "$1" "$3" "$2"; FAIL=$((FAIL + 1))
  fi
}

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "Smoke testing $BASE"
echo
echo "Contract:"
expect "GET feed with agentId"      200 "$(code "$BASE/api/agent/feed?agentId=test")"
expect "GET feed without agentId"   200 "$(code "$BASE/api/agent/feed")"
expect "GET viewer page"            200 "$(code "$BASE/")"
expect "POST init valid persona"    200 "$(code -X POST "$BASE/api/agent/init" -H 'Content-Type: application/json' -d '{"persona":{"name":"Smoke","domain":"Testing"}}')"
expect "POST init malformed JSON"   400 "$(code -X POST "$BASE/api/agent/init" -H 'Content-Type: application/json' -d '{oops')"
expect "POST init missing domain"   400 "$(code -X POST "$BASE/api/agent/init" -H 'Content-Type: application/json' -d '{"persona":{"name":"Smoke"}}')"

echo
echo "Feed must survive a broken data file (never 5xx):"
for payload in '{"posts": [ TRUNCATED' 'null' '"bare string"' '{"posts":"not-an-array"}' '[]' ''; do
  printf '%s' "$payload" > "$POSTS"
  label="$(printf '%s' "${payload:-<empty file>}" | cut -c1-28)"
  expect "posts.json = $label" 200 "$(code "$BASE/api/agent/feed")"
done

rm -f "$POSTS"
expect "posts.json deleted" 200 "$(code "$BASE/api/agent/feed")"
expect "viewer page, posts.json deleted" 200 "$(code "$BASE/")"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
