#!/usr/bin/env bash
# Adds an API key to .env.local AND to GitHub Secrets, from the macOS clipboard.
#
#   1. copy the key from the provider's console
#   2. ./scripts/add-key.sh GROQ_API_KEY
#
# Reading from the clipboard rather than the terminal is the whole point:
# typing or pasting into `read` captures arrow-key escape sequences and
# bracketed-paste markers as literal characters, which silently corrupts the
# key and produces an HTTP 400 with an empty body that looks like a network
# fault. The key is never printed and never enters shell history.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

NAME="${1:-}"
REPO="AmanKumar-23/autonomous-ai-creator"
ENV_FILE=".env.local"

if [ -z "$NAME" ]; then
  echo "Usage: ./scripts/add-key.sh GROQ_API_KEY|GEMINI_API_KEY|BREETH_API_KEY"
  exit 1
fi

if ! command -v pbpaste > /dev/null; then
  echo "pbpaste not found — this script is macOS only."
  exit 1
fi

# Strip ANSI escapes, bracketed-paste markers, then every whitespace character.
KEY="$(pbpaste \
  | sed -e $'s/\x1b\\[[0-9;]*[a-zA-Z~]//g' -e 's/\[20[01]~//g' \
  | tr -d '[:space:]')"

if [ -z "$KEY" ]; then
  echo "Clipboard is empty. Copy the key first, then re-run."
  exit 1
fi

if [ "${#KEY}" -lt 20 ] || [ "${#KEY}" -gt 200 ]; then
  echo "FAIL: ${#KEY} characters is not a plausible key length — the paste was mangled."
  exit 1
fi

# Ask the provider whether the key can do THE THING WE NEED, not merely whether
# it authenticates. A Gemini key passed a models-list check three separate times
# and then returned 429 limit:0 on every generation — the project had no
# free-tier allocation at all. Listing models proves nothing about generating.
# So each probe exercises the capability the agent actually depends on.
#
# Model ids are read from agent/llm.ts so this cannot drift from the real chain.
echo "checking the key against $NAME's provider..."
case "$NAME" in
  GROQ_API_KEY)
    MODEL="$(grep -oE 'groqPrimary: "[^"]+"' agent/llm.ts | grep -oE '"[^"]+"' | tr -d '"')"
    RESPONSE="$(curl -s --max-time 30 https://api.groq.com/openai/v1/chat/completions \
      -H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" \
      -d "{\"model\":\"${MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply OK\"}],\"max_tokens\":5}")"
    printf '%s' "$RESPONSE" | grep -q '"content"' \
      || { echo "FAIL: Groq could not GENERATE with this key (${MODEL}):"; echo "      $(printf '%s' "$RESPONSE" | tr -d '\n' | head -c 220)"; exit 1; } ;;
  GEMINI_API_KEY)
    MODEL="$(grep -oE 'gemini: "[^"]+"' agent/llm.ts | grep -oE '"[^"]+"' | tr -d '"')"
    RESPONSE="$(curl -s --max-time 30 "https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent" \
      -H "x-goog-api-key: ${KEY}" -H "Content-Type: application/json" \
      -d '{"contents":[{"role":"user","parts":[{"text":"Reply OK"}]}],"generationConfig":{"maxOutputTokens":10}}')"
    printf '%s' "$RESPONSE" | grep -q '"candidates"' \
      || { echo "FAIL: Gemini authenticates but cannot GENERATE (${MODEL}):"; echo "      $(printf '%s' "$RESPONSE" | tr -d '\n' | grep -oE '\"message\": \"[^\"]{0,160}' | head -1)"; echo "      A limit of 0 means the Google project has no free-tier allocation."; exit 1; } ;;
  BREETH_API_KEY)
    # POST /v1/search is the read probe: it proves auth without writing an
    # episode. GET /v1/episodes is not it — the collection path only accepts
    # POST and answers 405, which reads like a failure when the key is fine.
    RESPONSE="$(curl -s --max-time 25 -X POST https://api.thebreeth.com/v1/search \
      -H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" \
      -d '{"query":"connectivity check","limit":1}')"
    printf '%s' "$RESPONSE" | grep -q '"edges"' \
      || { echo "FAIL: Breeth rejected this key: $(printf '%s' "$RESPONSE" | head -c 160)"; exit 1; } ;;
esac
echo "provider accepted the key"

touch "$ENV_FILE"
# Replace any existing line for this key rather than appending a duplicate.
grep -v "^${NAME}=" "$ENV_FILE" > "${ENV_FILE}.tmp" 2>/dev/null || true
printf '%s=%s\n' "$NAME" "$KEY" >> "${ENV_FILE}.tmp"
mv "${ENV_FILE}.tmp" "$ENV_FILE"
echo "wrote $NAME to $ENV_FILE (${#KEY} chars)"

if command -v gh > /dev/null; then
  if printf '%s' "$KEY" | gh secret set "$NAME" --repo "$REPO" > /dev/null 2>&1; then
    echo "set $NAME as a GitHub Actions secret on $REPO"
  else
    echo "WARNING: could not set the GitHub secret — run 'gh auth status'"
  fi
fi

unset KEY
echo "done. verify with: ./scripts/verify-keys.sh"
