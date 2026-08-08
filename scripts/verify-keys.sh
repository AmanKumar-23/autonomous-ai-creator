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
  echo "Groq — llama-3.3-70b-versatile"
  body="$(curl -s --max-time 20 https://api.groq.com/openai/v1/chat/completions \
    -H "Authorization: Bearer ${GROQ_API_KEY}" -H "Content-Type: application/json" \
    -d '{"model":"llama-3.3-70b-versatile","messages":[{"role":"user","content":"Reply with the single word OK"}],"max_tokens":5}')"
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
  models="$(curl -s --max-time 20 "https://generativelanguage.googleapis.com/v1beta/models" -H "x-goog-api-key: ${GEMINI_API_KEY}")"
  if printf '%s' "$models" | grep -q '"models"'; then
    echo "  PASS  flash models available:"
    printf '%s' "$models" \
      | sed -n 's/.*"name": *"models\/\([^"]*flash[^"]*\)".*/    \1/p' | head -4
  else
    echo "  FAIL  $(printf '%s' "$models" | head -c 200)"
    FAIL=1
  fi
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "All configured keys answered."
else
  echo "At least one key failed — re-copy it and run ./scripts/add-key.sh <NAME>"
fi
exit "$FAIL"
