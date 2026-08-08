# CLAUDE.md — Autonomous AI Creator

## Who I am and what this is

I am Aman Kumar, competing **solo** in the ABTalks Vibe Code Hackathon 2026.
I am building **Problem Statement 3: Autonomous AI Creator**.

**Deadline: Sunday 9 August, 8:00 PM IST. Hard lock.**

My goal is not participation. It is a **top-3 finish plus the "Best use of Breeth" sponsor prize**.
Optimise every decision for that outcome. When a tradeoff appears between "more features" and
"more reliable + more clearly meets the rubric", always choose the second.

---

## The brief (verbatim requirements)

Build an autonomous AI/tech persona that, once initialized, independently:
discovers topics from live sources, decides whether they are worth publishing, writes in a
consistent editorial voice, remembers what it already published, and keeps publishing over
time with **zero further human input**.

### Six mandatory capabilities

1. **Topic discovery** — from the web or another live information source.
2. **Editorial judgment** — must *intentionally reject* topics that fail its standards.
3. **Consistent persona** — stable writing style, interests, distinct editorial opinions, coherent voice.
4. **Memory** — remembers published content to maintain continuity and avoid repetition.
5. **Autonomous publishing** — spread over time, NOT all generated at once.
6. **Publishing rationale** — every post returns why the topic was selected, why it is
   relevant now, and its sources.

### Required API

```
POST /api/agent/init
  body: { "persona": { "name": "Ada", "domain": "AI Security" } }
  returns: { "agentId": "abc-123" }

GET /api/agent/feed?agentId=abc-123
  returns: { "posts": [ { id, createdAt, text, rationale, sources[] } ] }
```

Feed rules: reverse chronological (newest first), unique `id` per post, `createdAt` as
ISO 8601 UTC, previously returned posts stay available forever, and `{ "posts": [] }` when empty.

### Evaluation protocol

The evaluator calls `init` **exactly once**, at an unknown time after my deadline.
Then it polls `feed` repeatedly for roughly **48 hours**. No prompts, no intervention.
New posts must appear during that window without me touching anything.

### Judging criteria (in priority order)

Autonomous operation after init → quality of editorial decision-making → persona consistency →
effective use of memory → transparency of rationale → overall coherence of the feed.

---

## Architecture (decided — do not redesign without telling me why)

Two paths that never share a failure mode.

**Write path** — GitHub Actions cron → `agent/run.js` → discover → dedupe → judge → write →
commit `data/posts.json` to the repo.

**Read path** — Next.js API routes on Vercel → read committed JSON → serve.

The read path performs **no LLM calls and no network calls to providers**. It only reads data
that is already committed. This means an LLM outage, a rate limit, or a bad prompt can never
break the feed endpoint.

### Stack

- Next.js (App Router) + TypeScript, deployed on Vercel free tier
- Node scripts under `agent/` run by GitHub Actions cron
- Storage: `data/posts.json` and `data/state.json` committed to the repo
- Memory: **Breeth** (`https://mcp.thebreeth.com/mcp`) for semantic dedup — this is the
  sponsor prize hook, use it properly, not decoratively

### LLM providers — failover chain

```
Tier 1  Groq        llama-3.3-70b-versatile   (verified working, free)
Tier 2  Gemini      flash variant             (free, key pending)
Tier 3  paid key    only if both above fail
Tier 4  skip cycle, log it, serve existing feed unchanged
```

Implement this as ONE `generate()` function with providers as config. Never three code paths —
during the Live Steer round I have 20 minutes and cannot edit the same logic in three places.
Normalise every provider response to a single internal shape at the boundary.

**Groq free tier ceiling: ~100K tokens/day.** This is the real constraint, not request count.
Budget ~5K tokens per cycle. At a 2-hour cadence that is ~12 cycles/day ≈ 60K tokens/day —
comfortable. Do not send full post history as context; send compact summaries.

### Environment variables

`GROQ_API_KEY`, `GEMINI_API_KEY`, `BREETH_API_KEY` — read from `process.env` only.
In CI they come from GitHub Secrets. Locally from `.env.local`, which is gitignored.

---

## Non-negotiable rules

**Never let the feed endpoint return 5xx.** Empty array is valid. Stale data is valid.
An error is a Stage 1 eligibility failure and scores zero regardless of code quality.

**Never hardcode the persona.** The evaluator sends `name` and `domain` in the init body.
Build the system prompt as my editorial-voice layer wrapped around *their* supplied values.
Many entrants will hardcode their own persona and silently fail this.

**Never publish before init.** Every cron cycle checks `data/state.json` for an initialized
agent first. If absent, exit cleanly with a logged reason and publish nothing.

**Never put a secret in the repo.** Public repo. Keys only in GitHub Secrets and `.env.local`.
Check `.gitignore` covers `.env`, `.env.local`, `.mcp.json`. If I ever paste a key into chat,
tell me to rotate it immediately.

**Never generate all posts at once.** Requirement 5 is explicit. One post per cycle, maximum.

**Rationale is generated during judgment, not during writing.** "Why this over other candidates"
requires knowing the other candidates — that information only exists inside the judge step.

---

## Stage 2 authenticity — this affects how we commit

An automated + manual review flags: repos created before kickoff, a huge first commit, flat
commit history followed by one big final commit, and an AI usage log that does not match the
implemented features.

So:

- **Commit after every meaningful unit of work.** Small, frequent, descriptive messages.
  Never batch a day's work into one commit.
- **Maintain `PROMPTS.md` as we go.** After each significant task, append a section: the
  feature, the prompt I gave, what was generated, what I changed. It must be possible for a
  reviewer to pick any feature in the live demo and find the prompts that built it.
  Remind me to update it if I forget for more than ~30 minutes of work.

---

## Build phases

1. **Feed skeleton** — both endpoints live on Vercel returning valid empty responses.
   Satisfies Stage 1 eligibility before any agent exists. Everything after is upside.
2. **Discovery** — HN Algolia API + arXiv. No LLM, no key.
3. **Editorial gate** — deterministic pre-filter, then one LLM call returning structured JSON
   with a decision and reasoning. Prompt it to reject aggressively.
4. **Persona + write** — voice layer over the supplied persona.
5. **Memory via Breeth** — semantic dedup before judging. String matching is insufficient:
   "OpenAI ships agent SDK" and "new agent framework from OpenAI" are the same story.
6. **Cron + hardening** — schedule, failover, viewer page, end-to-end test.

The GitHub Actions job that commits needs `permissions: contents: write` or the commit
silently fails.

---

## Differentiators to build deliberately

These are where a winning entry separates from a working one:

- **Public rejection log.** A `/rejections` route showing every considered-and-rejected topic
  with its reason. Requirement 2 asks for demonstrated editorial judgment — this is direct
  evidence, and almost nobody will do it.
- **Visible provider failover.** A `/status` page: cycles run, which provider served each,
  failovers, skipped cycles. Proves autonomous reliability in one screenshot.
- **A persona with real opinions.** A voice that has standards is what makes rejection
  believable. Generic enthusiasm reads as a template.
- **Stage 1 needs a "working application."** Bare JSON endpoints may not qualify — ship a
  minimal feed viewer page too.

---

## How to work with me

**Verify direction before building.** At the start of each phase, restate in two or three
lines what you are about to build and which brief requirement it satisfies. If my request
drifts from the six requirements or from the deadline, say so directly rather than complying.

**Audit at the end of each phase.** Run through: which of the six requirements does this
advance, does the feed still return valid JSON, is anything committed that shouldn't be, is
`PROMPTS.md` current, and what is the single highest remaining risk to a top-3 finish.

**Prefer working and simple over ambitious and fragile.** I am solo, against teams of three,
with a hard deadline and a 48-hour unattended run after it. Reliability is the differentiator.

**Keep the codebase navigable.** If I reach the top 6, I get an unseen feature request and 20
minutes to implement it live on a screen share. If I cannot locate a feature in 30 seconds, I
lose that round. Small files, obvious names, no cleverness.

**Tell me when I am wrong.** I would rather be corrected now than lose on a technicality.
