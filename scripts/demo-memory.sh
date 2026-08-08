#!/usr/bin/env bash
# Proves semantic dedup end to end against the live Breeth API.
#
#   ./scripts/demo-memory.sh
#
# Publishes a post, remembers it, then offers the SAME story reworded with a
# different URL. String matching cannot catch it; Breeth does. Restores every
# data file afterwards.

set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR" || exit 1

[ -f .env.local ] && { set -a; . ./.env.local; set +a; }
[ -n "${BREETH_API_KEY:-}" ] || { echo "no BREETH_API_KEY — run ./scripts/add-key.sh BREETH_API_KEY"; exit 1; }

BACKUP="$(mktemp -d)"
cp data/*.json "$BACKUP/"
restore() { cp "$BACKUP"/*.json data/; rm -rf "$BACKUP"; echo; echo "data restored"; }
trap restore EXIT

GROUP="aac-demo-$(date +%s)"

echo "Using an isolated Breeth namespace: $GROUP"
echo
echo "=============================================================="
echo "STEP 1 — publish a post and remember it"
echo "=============================================================="
npx tsx scripts/demo-memory.ts "$GROUP" first

echo
echo "waiting 20s for Breeth to finish extracting facts (async pipeline)"
sleep 20

echo
echo "=============================================================="
echo "STEP 2 — offer the SAME story, reworded, at a different URL"
echo "=============================================================="
npx tsx scripts/demo-memory.ts "$GROUP" second
