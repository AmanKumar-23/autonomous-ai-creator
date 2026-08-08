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

# Ask the provider whether the key works, rather than guessing from its prefix.
# Key formats change (Gemini keys are no longer always AIza…), so authentication
# is the only check worth trusting. Nothing is written unless this passes.
echo "checking the key against $NAME's provider..."
case "$NAME" in
  GROQ_API_KEY)
    RESPONSE="$(curl -s --max-time 25 https://api.groq.com/openai/v1/models \
      -H "Authorization: Bearer ${KEY}")"
    printf '%s' "$RESPONSE" | grep -q '"data"' \
      || { echo "FAIL: Groq rejected this key: $(printf '%s' "$RESPONSE" | head -c 160)"; exit 1; } ;;
  GEMINI_API_KEY)
    RESPONSE="$(curl -s --max-time 25 https://generativelanguage.googleapis.com/v1beta/models \
      -H "x-goog-api-key: ${KEY}")"
    printf '%s' "$RESPONSE" | grep -q '"models"' \
      || { echo "FAIL: Google rejected this key: $(printf '%s' "$RESPONSE" | head -c 160)"; exit 1; } ;;
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
