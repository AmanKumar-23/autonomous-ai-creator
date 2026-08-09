# Autonomous AI Creator

An autonomous editorial persona. Once initialized it discovers topics from live sources,
rejects the ones that fail its standards, writes the survivors in a consistent voice,
remembers what it has already covered, and keeps publishing over time with no further
human input.

Built solo for the ABTalks Vibe Code Hackathon 2026 — Problem Statement 3.

**Live:** https://autonomous-ai-creator-theta.vercel.app
· [feed](https://autonomous-ai-creator-theta.vercel.app/)
· [rejection log](https://autonomous-ai-creator-theta.vercel.app/rejections)
· [status](https://autonomous-ai-creator-theta.vercel.app/status)

---

## The six required capabilities

| # | Requirement | Where it lives | How to see it |
|---|---|---|---|
| 1 | **Topic discovery** from live sources | `agent/discover.ts`, `agent/sources/` — Hacker News (Algolia) and arXiv, queried in parallel | `npm run discover -- "AI Security"` |
| 2 | **Editorial judgment** with intentional rejection | `agent/filter.ts` (deterministic) then `agent/judge.ts` (LLM) | `/rejections` — every discarded topic with its reason |
| 3 | **Consistent persona** with distinct opinions | `agent/write.ts` — voice rules are fixed, name and domain come from init | Read two posts in the feed |
| 4 | **Memory** to avoid repetition | `agent/memory.ts` (Breeth, semantic) + `agent/seen.ts` (URL) | `./scripts/demo-memory.sh` |
| 5 | **Autonomous publishing** spread over time | `.github/workflows/agent.yml` → `agent/run.ts`, every 2 hours | `/status` — every cycle, including the ones that published nothing |
| 6 | **Publishing rationale** with sources | Produced in `agent/judge.ts`, returned on every post | Any post's `rationale` and `sources[]` |

Queries, standards and voice are all built around the persona supplied at init. **Nothing
about the persona is hardcoded** — `agent/write.ts` interpolates `persona.name` and
`persona.domain` in exactly one place, and `agent/domain-terms.ts` derives search terms and
arXiv categories from whatever domain arrives, with a generic fallback for one it has no
profile for.

---

## API

### `POST /api/agent/init`

```json
{ "persona": { "name": "Ada", "domain": "AI Security" } }
```

Returns `{ "agentId": "..." }`. Idempotent — calling it again returns the same
`agentId` and never resets existing state. Invalid input returns `400` with a message.
The persona is supplied entirely by the caller; nothing about it is hardcoded.

State is persisted by committing `data/state.json` through the GitHub Contents API
rather than writing to disk. On Vercel the filesystem is read-only apart from an
ephemeral `/tmp`, so a local write would be discarded and the cron would never observe
the init. Reading remotely also keeps init idempotent during the minute or so between
that commit and Vercel finishing its redeploy, while the bundled copy is still stale.
This needs `GITHUB_TOKEN` set in Vercel; without it init still returns an agentId and
the feed is unaffected, but nothing is persisted.

### `GET /api/agent/feed?agentId=...`

```json
{ "posts": [ { "id": "...", "createdAt": "2026-08-08T11:00:00.000Z", "text": "...", "rationale": "...", "sources": [ { "title": "...", "url": "..." } ] } ] }
```

Reverse chronological, unique `id` per post, `createdAt` in ISO 8601 UTC, and
`{ "posts": [] }` when empty. Published posts stay available permanently.

## Architecture

Two paths that share no failure mode.

| | |
|---|---|
| **Write path** | GitHub Actions cron → `agent/` → discover → dedupe → judge → write → commit `data/posts.json` |
| **Read path** | Next.js routes on Vercel → read committed JSON → serve |

The read path makes no LLM calls and no outbound network calls. An LLM outage, a rate
limit or a bad prompt cannot break the feed — the worst case is that no new post appears
and the existing feed continues to serve.

---

## What one cycle does

`agent/run.ts` runs the whole loop. It refuses to publish before init, and exits 0 even on
failure — a red workflow run every two hours becomes noise that hides a real problem, and
the feed is unaffected either way.

**1 · Discover.** Both sources are queried in parallel with terms derived from the domain.
Each has its own timeout and one retry; if one fails the cycle continues with the other,
and both failing yields an empty list rather than an exception.

**2 · Recall.** `recallSimilar` asks Breeth what the agent has already said about each
candidate, *before* the editor spends a decision on it.

**3 · The two-stage editorial gate.** This is the part worth understanding.

*Stage one is deterministic* (`agent/filter.ts`) — no LLM, no keys. Six gates in order:
unresolvable URL, noise patterns (hiring threads, polls, promos), recency window (48h for
HN, 7d for arXiv), domain relevance, already-seen, and duplicate-in-cycle. Survivors are
scored on recency, engagement and term overlap, but **score only ranks — it never admits or
rejects**. Its job is to produce a defensible shortlist cheaply.

*Stage two is the editor* (`agent/judge.ts`) — one LLM call judges the whole shortlist
together. That is deliberate: "why this one over the others" can only be answered by
something that saw the others, which is why the rationale is produced here rather than
later while writing. It weighs substance, domain relevance, why-it-matters-now and whether
there is anything to say, and is instructed to reject aggressively. **Rejecting everything
is a valid outcome**, recorded as such, and the cycle publishes nothing.

Two safeguards: a `selected_id` that is not on the shortlist is refused, so a hallucinated
id can never become a post citing a source that was never considered; and any candidate the
model silently ignores is still logged as a rejection, so the log accounts for everything.

**4 · Write.** `agent/write.ts` turns the selection into a post in the persona's voice. It
must commit to one of five stances (endorse, dispute, deflate, warn, contextualise) and is
shown the stances it used recently so it does not reach for the same one every time. Style
problems get one retry with the objection quoted back; if the retry does not improve on
them the post publishes anyway with the problems recorded, because losing a publishing
cycle to style would trade the highest-weighted judging criterion for a lower one.

**5 · Remember and commit.** The post is stored in Breeth, everything judged this cycle is
marked seen, and the cycle record, rejection log and post are committed back to the repo.
Vercel redeploys and serves them.

---

## Provider failover

One `generate()` in `agent/llm.ts` with providers as configuration, not separate code
paths. Failover runs top to bottom and skips tiers with no key.

| Tier | Provider | State |
|---|---|---|
| 1 | `groq:llama-3.3-70b-versatile` | working — serves almost every cycle |
| 2 | `groq:llama-3.1-8b-instant` | working — separate per-model daily quota on Groq's free tier, so it is real headroom rather than the same bucket renamed |
| 3 | `gemini:gemini-2.0-flash` | **effectively dead.** The key authenticates, but `generateContent` returns HTTP 429 with `limit: 0` — the Google project has no free-tier allocation, so retrying never succeeds. It is kept in the chain because a fast 429 costs nothing and it starts working the moment quota is granted. |

**So the real failover is two Groq models on one account.** If that account is rate-limited
account-wide, publishing stops until it recovers. `/status` shows which tier served each
cycle, so a failover is visible rather than inferred.

There is one more recovery worth knowing about: Groq validates JSON server-side in
`json_object` mode and returns HTTP 400 if the model's output is malformed — which happened
in production and cost a cycle its post. A `json_validate_failed` 400 now retries the *same*
provider with the JSON constraint dropped, and the object is recovered from fences or prose.

---

## Memory

Two layers, doing different jobs.

**URL dedup** (`agent/seen.ts`) runs inside discovery and blocks anything already covered at
the same address. Cheap, exact, and it runs first.

**Semantic memory** (`agent/memory.ts`, Breeth) catches what URL matching cannot: the same
story told in different words at a different address. Breeth's search is hybrid BM25 +
vector cosine, so "OpenAI ships agent SDK" recalls "new agent framework from OpenAI".

Two things about the live API shaped the implementation, and the first would have broken the
feed if it had been missed:

- **Search has no relevance cutoff and returns no similarity score.** Querying a group with
  a completely unrelated topic still returns whatever facts that group holds. Treating "any
  hit" as a duplicate would have rejected every candidate as soon as memory contained
  anything, and the agent would have stopped publishing. So Breeth supplies the semantic
  recall and a conservative local check decides whether the recalled fact is genuinely the
  *same story* — two shared distinctive terms. One would suppress every later story about
  the same organisation.
- **The post id does not survive fact extraction**, so identity is resolved locally against
  `posts.json` rather than read back out of Breeth.

Memory never blocks a publish. Every call has an 8-second timeout and is wrapped; on failure
the cycle falls back to URL dedup and continues. Verified with an invalid key and with no key
at all — both published.

---

## Pages

| Route | What it is for |
|---|---|
| `/` | The feed: posts with rationale and sources, and an honest empty state before init |
| `/rejections` | Every topic considered and turned down, split by stage — the editor's reasoning and the deterministic filter's. Requirement 2 asks for demonstrated judgment; a rejection nobody can read is indistinguishable from one that never happened |
| `/status` | Every cycle including the ones that published nothing: status breakdown, which provider served each cycle and whether that was a failover, memory availability, source failures, and the gap between cycles |

---

## Layout

```
app/api/agent/init/route.ts   POST init — validates persona, mints agentId
app/api/agent/feed/route.ts   GET feed — reads committed JSON, never 5xx
app/page.tsx                  feed viewer
app/rejections/page.tsx       public rejection log
app/status/page.tsx           operational status
lib/types.ts                  every type in the project
lib/store.ts                  all disk access for the read path; readers never throw
lib/github.ts                 durable state via the GitHub API (init persistence)
agent/run.ts                  one cycle: the write path's entry point
agent/discover.ts             orchestrates discovery
agent/sources/                hackernews.ts, arxiv.ts
agent/domain-terms.ts         persona domain → search terms and arXiv categories
agent/filter.ts               deterministic pre-filter, scoring, drop reasons
agent/judge.ts                the editorial gate
agent/write.ts                the persona voice layer
agent/llm.ts                  one generate() with providers as config
agent/memory.ts               Breeth semantic memory
agent/seen.ts                 URL-level dedup
agent/cycles.ts               operational log
agent/rejections.ts           rejection log
data/*.json                   posts, state, seen, rejections, cycles
```

## Scripts

```bash
./scripts/health.sh          # one command: is the run on track?
./scripts/verify-keys.sh     # prove every configured provider still answers
./scripts/demo-memory.sh     # semantic dedup, end to end against the live Breeth API
./scripts/smoke-test.sh      # assert the feed cannot 5xx, including corrupt data files
./scripts/add-key.sh NAME    # add an API key from the clipboard, verified before it is stored
npm run discover -- "..."    # run discovery standalone and eyeball the shortlist
npm run cycle                # run one full cycle locally
npm test                     # 66 tests
```

`health.sh` is the one to run during the evaluation window. It checks the endpoints, whether
the cron is actually firing, what the cycles are deciding, and whether the repo is in a clean
state — a green workflow run is not proof of publishing, since a cycle can succeed while
producing nothing.

## Local development

```bash
npm install
npm run dev
./scripts/smoke-test.sh    # in a second terminal
```

No environment variables are needed to run the read path. See `.env.example` for the
keys the write path uses: `GROQ_API_KEY`, `GEMINI_API_KEY`, `BREETH_API_KEY` and
`GITHUB_TOKEN`. All are read from `process.env` only and never committed.

To watch a full cycle locally, init and run one — then undo it, because the repo must ship
uninitialized so the evaluator's init is the first that counts:

```bash
curl -X POST http://localhost:3000/api/agent/init \
  -H 'Content-Type: application/json' \
  -d '{"persona":{"name":"Ada","domain":"AI Security"}}'
npm run cycle
git checkout data/          # required before submitting
```

---

## Known limitations

Stated plainly, because a reviewer will find them anyway.

- **Gemini is a dead tier** (see above). Real failover is two Groq models on one account.
- **GitHub delays and drops scheduled runs.** Observed gaps of 2.9–3.7 hours against a
  2-hour cron. Over a 48-hour window expect roughly 15–20 posts rather than 24, unevenly
  spaced. This is GitHub's scheduler, not the agent.
- **Semantic memory only adds value on the different-URL case.** URL dedup runs first
  during discovery, so a story already published never reaches Breeth. In a routine cycle
  you will not see memory rejections; `demo-memory.sh` is where the behaviour is visible.
- **`stance` is occasionally absent** on a published post when the fallback model serves the
  write call and omits it. The post still publishes — style never costs a cycle — but the
  voice-continuity signal is weaker for that post.
- **The pre-filter is a shortlist, not the decision.** Weak items still reach the editor;
  rejecting them on quality grounds is the editor's job, and those rejections are logged.
