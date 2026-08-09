#!/usr/bin/env bash
# Proves each configured key actually answers, by calling the provider.
#
#   ./scripts/verify-keys.sh
#
# A key that is present but malformed looks identical to a working one until
# the agent tries to publish at 3am. Never prints a key value.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

[ -f .env.local ] || { echo "no .env.local — run ./scripts/add-key.sh GROQ_API_KEY"; exit 1; }
set -a && source .env.local && set +a

FAIL=0
GEMINI_DEAD=0

echo "Key shapes"
for name in GROQ_API_KEY GEMINI_API_KEY BREETH_API_KEY; do
  value="${!name:-}"
  if [ -z "$value" ]; then
    printf "  %-16s not set\n" "$name"
  else
    printf "  %-16s %s chars, starts %s\n" "$name" "${#value}" "${value:0:4}"
  fi
done

if [ -n "${GROQ_API_KEY:-}" ]; then
  echo
  QMODEL="$(grep -oE 'groqPrimary: "[^"]+"' agent/llm.ts | grep -oE '"[^"]+"' | tr -d '"')"
  echo "Groq — ${QMODEL}"
  body="$(curl -s --max-time 25 https://api.groq.com/openai/v1/chat/completions \
    -H "Authorization: Bearer ${GROQ_API_KEY}" -H "Content-Type: application/json" \
    -d "{\"model\":\"${QMODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with the single word OK\"}],\"max_tokens\":5}")"
  if printf '%s' "$body" | grep -q '"content"'; then
    echo "  PASS  replied: $(printf '%s' "$body" | sed -n 's/.*"content":"\([^"]*\)".*/\1/p' | head -1)"
  else
    echo "  FAIL  $(printf '%s' "$body" | head -c 200)"
    FAIL=1
  fi
fi

if [ -n "${GEMINI_API_KEY:-}" ]; then
  echo
  echo "Gemini"
  # Generation, not the models list: a key can list 42 models and generate none.
  GMODEL="$(grep -oE 'gemini: "[^"]+"' agent/llm.ts | grep -oE '"[^"]+"' | tr -d '"')"
  body="$(curl -s --max-time 30 "https://generativelanguage.googleapis.com/v1beta/models/${GMODEL}:generateContent" \
    -H "x-goog-api-key: ${GEMINI_API_KEY}" -H "Content-Type: application/json" \
    -d '{"contents":[{"role":"user","parts":[{"text":"Reply with the single word OK"}]}],"generationConfig":{"maxOutputTokens":10}}')"
  if printf '%s' "$body" | grep -q '"candidates"'; then
    echo "  PASS  ${GMODEL} generated a reply"
  else
    echo "  FAIL  ${GMODEL} authenticates but cannot generate"
    echo "        $(printf '%s' "$body" | tr -d '\n' | grep -oE 'limit: [0-9]+, model: [a-z0-9.-]+' | head -1)"
    GEMINI_DEAD=1
  fi
fi

if [ -n "${BREETH_API_KEY:-}" ]; then
  echo
  echo "Breeth"
  BODY="$(curl -s --max-time 25 -X POST https://api.thebreeth.com/v1/search \
    -H "Authorization: Bearer ${BREETH_API_KEY}" -H "Content-Type: application/json" \
    -d '{"query":"connectivity check","limit":1}')"
  if printf '%s' "$BODY" | grep -q '"edges"'; then
    echo "  PASS  POST /v1/search answered"
  else
    echo "  FAIL  $(printf '%s' "$BODY" | head -c 160)"
    FAIL=1
  fi
fi

echo
if [ "$FAIL" -eq 0 ] && [ "$GEMINI_DEAD" -eq 0 ]; then
  echo "Every configured provider can generate."
elif [ "$FAIL" -eq 0 ]; then
  # Gemini is tier 3 and optional; the agent publishes fine without it.
  echo "Groq can generate, so publishing works. Gemini is a dead tier — a limit of 0"
  echo "means that Google project has no free-tier allocation, and a new key from the"
  echo "same account will behave identically. Enabling billing is the only fix."
else
  echo "A provider the agent depends on cannot generate — publishing will fail."
  echo "Re-copy the key and run ./scripts/add-key.sh <NAME>"
fi
exit "$FAIL"
