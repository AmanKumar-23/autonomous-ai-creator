#!/usr/bin/env bash
# Guards the one constraint that decides eligibility: the feed must never 5xx.
#
#   npm run dev                                  # in another terminal
#   ./scripts/smoke-test.sh                      # against localhost
#   ./scripts/smoke-test.sh https://your.app     # safe: destructive checks skipped
#   ./scripts/smoke-test.sh https://your.app --force   # only if you mean it
#
# TWO CHECKS ARE DESTRUCTIVE AND RUN ONLY AGAINST LOCALHOST:
#
#   1. POST /api/agent/init with a test persona. Against production this really
#      initializes the agent and commits it — it once set the live persona to
#      "Smoke / Testing". During the evaluation window that would overwrite the
#      evaluator's persona and their agentId would stop matching.
#   2. Corrupting data/posts.json. That only proves anything about a server
#      reading THIS working copy; against a remote target it mutates local files
#      while testing something else entirely.
#
# Everything else runs against any URL, so the never-5xx guarantee is still
# checked wherever you point it.

set -uo pipefail

BASE="http://localhost:3000"
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -*) echo "unknown option: $arg"; exit 1 ;;
    *) BASE="$arg" ;;
  esac
done

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POSTS="$DIR/data/posts.json"
STATE="$DIR/data/state.json"
PASS=0
FAIL=0
SKIPPED=0

# Is the target this machine? Only then may we mutate local files or init.
case "$BASE" in
  http://localhost:*|http://127.0.0.1:*|http://0.0.0.0:*|https://localhost:*) LOCAL=1 ;;
  *) LOCAL=0 ;;
esac
DESTRUCTIVE=$(( LOCAL == 1 || FORCE == 1 ? 1 : 0 ))

expect() { # expect <label> <expected-code> <actual-code>
  if [ "$2" = "$3" ]; then
    printf '  \033[32mPASS\033[0m  %-42s %s\n' "$1" "$3"; PASS=$((PASS + 1))
  else
    printf '  \033[31mFAIL\033[0m  %-42s got %s, want %s\n' "$1" "$3" "$2"; FAIL=$((FAIL + 1))
  fi
}

skip() { # skip <label> <why>
  printf '  \033[33mSKIP\033[0m  %-42s %s\n' "$1" "$2"; SKIPPED=$((SKIPPED + 1))
}

code() { curl -s -o /dev/null -w '%{http_code}' --max-time 25 "$@"; }

echo "Smoke testing $BASE"
if [ "$DESTRUCTIVE" -eq 1 ] && [ "$LOCAL" -eq 0 ]; then
  echo "  --force given: destructive checks WILL run against a remote target."
elif [ "$LOCAL" -eq 0 ]; then
  echo "  Remote target: destructive checks are skipped. Pass --force to override."
fi
echo

# Local files are only touched when the destructive checks can run.
if [ "$DESTRUCTIVE" -eq 1 ]; then
  POSTS_BACKUP="$(mktemp)"
  STATE_BACKUP="$(mktemp)"
  cleanup() {
    cp "$POSTS_BACKUP" "$POSTS" 2>/dev/null
    cp "$STATE_BACKUP" "$STATE" 2>/dev/null
    rm -f "$POSTS_BACKUP" "$STATE_BACKUP"
  }
  trap cleanup EXIT
  cp "$POSTS" "$POSTS_BACKUP"
  cp "$STATE" "$STATE_BACKUP"
fi

echo "Contract:"
expect "GET feed with agentId"      200 "$(code "$BASE/api/agent/feed?agentId=test")"
expect "GET feed without agentId"   200 "$(code "$BASE/api/agent/feed")"
expect "GET viewer page"            200 "$(code "$BASE/")"

if [ "$DESTRUCTIVE" -eq 1 ]; then
  expect "POST init valid persona"  200 "$(code -X POST "$BASE/api/agent/init" -H 'Content-Type: application/json' -d '{"persona":{"name":"Smoke","domain":"Testing"}}')"
else
  skip "POST init valid persona" "would initialize the live agent"
fi

# Rejecting bad input changes nothing, so it is safe anywhere.
expect "POST init malformed JSON"   400 "$(code -X POST "$BASE/api/agent/init" -H 'Content-Type: application/json' -d '{oops')"
expect "POST init missing domain"   400 "$(code -X POST "$BASE/api/agent/init" -H 'Content-Type: application/json' -d '{"persona":{"name":"Smoke"}}')"

echo
if [ "$DESTRUCTIVE" -eq 1 ]; then
  echo "Feed must survive a broken data file (never 5xx):"
  for payload in '{"posts": [ TRUNCATED' 'null' '"bare string"' '{"posts":"not-an-array"}' '[]' ''; do
    printf '%s' "$payload" > "$POSTS"
    label="$(printf '%s' "${payload:-<empty file>}" | cut -c1-28)"
    expect "posts.json = $label" 200 "$(code "$BASE/api/agent/feed")"
  done

  rm -f "$POSTS"
  expect "posts.json deleted" 200 "$(code "$BASE/api/agent/feed")"
  expect "viewer page, posts.json deleted" 200 "$(code "$BASE/")"
else
  echo "Feed availability under repeated polling (remote-safe subset):"
  skip "corrupt data/posts.json" "needs a server reading this working copy"
  # The evaluator polls repeatedly for ~48h, so prove it answers consistently.
  for i in 1 2 3 4 5; do
    expect "feed poll $i of 5" 200 "$(code "$BASE/api/agent/feed?agentId=poll$i")"
  done
  expect "rejection log" 200 "$(code "$BASE/rejections")"
  expect "status page"   200 "$(code "$BASE/status")"
fi

echo
printf '%s passed, %s failed' "$PASS" "$FAIL"
[ "$SKIPPED" -gt 0 ] && printf ', %s skipped as unsafe for this target' "$SKIPPED"
echo
[ "$FAIL" -eq 0 ] || exit 1
