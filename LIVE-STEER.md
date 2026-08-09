# Live Steer cheat sheet

20 minutes, screen share, unseen feature request. Everything you need on one page.

## Start

```bash
npm run dev        # answering in ~4s cold, all routes warm in ~5s
```

Nothing else is needed to demo. The read path requires no keys.

## Which file

| Feature | File | What is in it |
|---|---|---|
| **Persona / voice** | `agent/write.ts` | voice rules, banned register, the five stances, length checks |
| **Domain → search terms** | `agent/domain-terms.ts` | profile table, generic fallback, `deriveQueryProfile()` |
| **Discovery** | `agent/discover.ts` | orchestration, `discoverWithReport()` |
| **Sources** | `agent/sources/hackernews.ts`, `agent/sources/arxiv.ts` | one file each, both normalize to `Candidate` |
| **Pre-filter** | `agent/filter.ts` | six gates, scoring, `canonicalUrl()`, drop reasons |
| **Editorial gate** | `agent/judge.ts` | the standards prompt, `judgeCandidates()`, rejection handling |
| **Providers / failover** | `agent/llm.ts` | `MODELS`, `PROVIDERS`, `generate()`, `parseJsonResponse()` |
| **Memory** | `agent/memory.ts` | `recallSimilar()`, `rememberPost()`, `sameStory()` |
| **One cycle** | `agent/run.ts` | the whole pipeline in reading order |
| **Feed endpoint** | `app/api/agent/feed/route.ts` | never 5xx — do not add calls here |
| **Init endpoint** | `app/api/agent/init/route.ts` | validation, idempotency, GitHub persistence |
| **Pages** | `app/page.tsx`, `app/rejections/page.tsx`, `app/status/page.tsx` | |
| **Disk reads (web)** | `lib/store.ts` | every reader is never-throw |
| **Types** | `lib/types.ts` | all of them, one file |
| **Schedule** | `.github/workflows/agent.yml` | cron, permissions, concurrency, commit |

## Three most likely surprise requests

**1. "Add a second persona / make it multi-agent."** Most likely, because the API takes an
agentId and currently ignores it. Where: `data/state.json` becomes a map keyed by agentId,
`lib/store.ts` gains a lookup, and `agent/run.ts` loops personas. The feed already accepts the
parameter — `app/api/agent/feed/route.ts` reads it and deliberately does not gate on it, so
turning that into a filter is a two-line change. **Say this out loud**: the ignore is
deliberate, so a wrong id never 404s the evaluator.

**2. "Add a new source" (RSS, GitHub trending, Reddit).** Where: one new file in
`agent/sources/` returning `{ candidates, failure }`, then one line in `agent/discover.ts`.
Nothing else changes — both existing sources already normalize to the same `Candidate` shape
and the pre-filter is source-agnostic. This is the cheapest possible request; do it live.

**3. "Change the editorial standards / make it stricter or add a topic it must cover."**
Where: `buildSystemPrompt()` in `agent/judge.ts` — the four standards are plain prose in one
template literal. Show the `/rejections` page afterwards to prove the change took effect. If
they ask for a *scoring* change instead, that is `scoreCandidate()` in `agent/filter.ts`.

Also plausible: "show the sources on the status page" (`app/status/page.tsx`), or "make it
post more often" (`.github/workflows/agent.yml` cron — but mention the token budget: 12
cycles/day is 41% of the Groq ceiling, 24 would be 82%).

## Things not to break under pressure

- **Never add a network or LLM call to `app/api/agent/feed/route.ts`.** It must not 5xx.
- Run `./scripts/smoke-test.sh` after any change to `lib/store.ts` or the routes.
- `npm test` is 70 tests and takes seconds.
- The persona must stay driven by `state.persona` — never hardcode a name or domain.

## If something breaks live

```bash
git stash          # undo everything, instantly
npm test           # 70 tests, seconds
./scripts/health.sh
```
