# AI usage log

Every feature in the live demo, the prompt that produced it, and what I changed afterwards.

Tooling: Claude Code (Opus 5). Written as the work happened, not reconstructed — which is
why the failures are here too. Several sections exist only because something broke and the
fix is more interesting than the build.

## Find a feature

| If you are looking at… | Read |
|---|---|
| the feed, `/api/agent/feed`, the never-5xx guarantee | [Phase 1](#phase-1--feed-skeleton) |
| init persisting so the cron can see it | [Phase 1b](#phase-1b--durable-init-state) |
| where topics come from, the pre-filter | [Phase 2](#phase-2--topic-discovery) |
| the editorial gate, provider failover, the cron | [Phase 3](#phase-3--editorial-gate-provider-failover-and-the-cron) |
| the persona voice, stances, post format | [Phase 4](#phase-4--the-persona-writer-the-agent-publishes) |
| Breeth semantic memory | [Phase 5](#phase-5--memory-via-breeth) |
| `/rejections` and `/status`, unattended survival | [Phase 6](#phase-6--hardening-and-evidence-surfaces) |
| submission verification | [Phase 7](#phase-7--submission-readiness) |

## The failures, if you only read one thing

These are the sections where the interesting work is. Each is a real defect found by
running the system, not by reading it:

- **A safety net that was itself the failure mode** — a static JSON import made the feed
  return 500 on a corrupt data file, the exact eligibility failure it was meant to prevent.
  [Phase 1](#phase-1--feed-skeleton)
- **Substring matching poisoned relevance** — `"ai"` matched inside *training* and *domain*,
  so an AI Security feed kept a heart-failure paper. [Phase 2](#phase-2--topic-discovery)
- **One paper relevant to every domain at once** — a generic phrase counted as
  domain-specific, so the same study ranked for AI Security, Robotics and Quantum
  Computing. [Phase 2](#follow-up-cross-domain-contamination-found-by-reading-the-cli-output)
- **The agent published the press release and rejected the disclosure** — reproducibly,
  until the standards were reordered. [Phase 3 audit](#phase-3-audit--six-defects-found-and-fixed)
- **Strict JSON mode killed half the cycles** — Groq rejected the model's own output before
  our parser could recover it. [Phase 4](#the-bug-that-was-eating-cycles)
- **Memory that would have stopped all publishing** — Breeth returns facts regardless of
  relevance, so "any hit means duplicate" would have rejected everything.
  [Phase 5](#phase-5--memory-via-breeth)
- **A key check that asked the wrong question** — three rounds lost to a probe that proved
  authentication when we needed generation. [Phase 7](#phase-7--submission-readiness)
- **A model retired mid-build**, and an id duplicated in two places.
  [Phase 6](#part-c--unattended-survival)

---

## Phase 1 — Feed skeleton

**Goal:** get both required endpoints live and valid before any agent logic exists, so
Stage 1 eligibility is locked and everything afterwards is upside rather than risk.

**Requirements advanced:** the required API contract, plus the "working application"
expectation for Stage 1. Sets up requirement 6 (rationale + sources) in the data shape
and the viewer, though nothing generates them yet.

### Prompt given

> Read CLAUDE.md first, then build Phase 1: the feed skeleton.
>
> GOAL
> Get both required endpoints live on Vercel returning valid responses, before any
> agent logic exists. This locks Stage 1 eligibility so everything after it is upside
> rather than risk.
>
> BUILD
> 1. Next.js App Router + TypeScript project in this repo. Minimal deps.
> 2. `data/state.json` — `{ "initialized": false, "agentId": null, "persona": null, "initializedAt": null }`; `data/posts.json` — `{ "posts": [] }`
> 3. `POST /api/agent/init` — accepts `{ persona: { name, domain } }`; generates a stable agentId, writes state, returns `{ agentId }`; idempotent: if already initialized, return the SAME agentId, do not reset. The evaluator calls this once but a retry must not wipe state. Validates the body; on bad input return 400 with a clear message.
> 4. `GET /api/agent/feed?agentId=...` — returns `{ posts: [...] }` sorted newest-first by createdAt; returns `{ posts: [] }` when empty; MUST NOT throw. Wrap every read in try/catch and fall back to `{ posts: [] }`. A 5xx here is an eligibility failure. This is the single most important constraint in the project. No LLM calls, no external network calls. Reads committed files only.
> 5. A minimal viewer page at `/` that lists the feed with rationale and sources, plus an empty state. Stage 1 requires a "working application", not bare JSON. Keep it clean and readable — judges will screenshot this.
> 6. Types in one place: Post, Persona, AgentState. Everything imports from there.
>
> CONSTRAINTS
> - No secrets anywhere. Confirm .gitignore covers .env, .env.local, .mcp.json.
> - Small files, obvious names. I may need to navigate this under time pressure.
> - Commit in small logical steps as you go, not one commit at the end.
>
> WHEN DONE
> - Show me the exact curl commands to verify both endpoints locally.
> - Tell me what to do to deploy to Vercel.
> - Append a Phase 1 section to PROMPTS.md recording this prompt and what you built.
> - Audit: confirm the feed cannot 500, confirm nothing secret is committed, and name the single biggest remaining risk to a top-3 finish.
>
> Before you write any code, restate in three lines what you are about to build and
> which brief requirement each part satisfies. If anything here conflicts with
> CLAUDE.md or the brief, tell me instead of proceeding.

### What was generated

- `lib/types.ts` — `Persona`, `Source`, `Post`, `AgentState`, and an `EMPTY_STATE`
  constant. Contract fields are required; additive fields (`title`, `provider`) are
  optional so the wire shape from the brief always holds.
- `lib/store.ts` — the only module that touches disk. Validates and normalizes on read,
  filters out malformed posts, sorts newest-first, and never throws.
- `app/api/agent/init/route.ts` — body validation, idempotent agentId, 400 on bad input.
- `app/api/agent/feed/route.ts` — reads committed JSON, `no-store` cache headers, falls
  back to `{ posts: [] }` on any failure.
- `app/page.tsx`, `app/layout.tsx`, `app/globals.css` — feed viewer with a rationale
  callout, numbered sources and a real empty state; light and dark.
- `scripts/smoke-test.sh` — 14 assertions, including deliberately corrupting
  `data/posts.json` to prove the feed still answers 200.

### What I changed after the first pass

Three corrections, all found by testing rather than reading:

1. **The safety net was itself the failure mode.** The first version imported
   `data/posts.json` at the top of `lib/store.ts` as a fallback for a failed `fs` read.
   A static import is evaluated when the module loads, so a corrupt or missing data file
   threw *before* any `try/catch` and returned **HTTP 500** — verified against truncated
   JSON, `null`, an empty file and a deleted file. Because the cron rewrites that file
   every cycle, a single truncated commit would have taken the feed down for the entire
   48-hour evaluation window. Removed both static imports; every read now happens lazily
   inside `try/catch`. This is the exact eligibility failure the phase existed to prevent.
2. **Wrong file-tracing root.** A stray `package-lock.json` in a parent directory made
   Next infer the workspace root as `~`, which would have broken `data/**` tracing in the
   Vercel bundle. Pinned `outputFileTracingRoot` to the project directory.
3. **Next 15.1.6 shipped with a published CVE.** Upgraded to 15.5.23. The smoke test also
   originally restored only `posts.json`, leaving `state.json` initialized with a junk
   persona that could have been committed; it now backs up and restores both.

Also deviated from the prompt in two small places, deliberately:

- **`sources` is `{ title, url }`, not bare URL strings.** Both satisfy `sources[]`, and
  titles make the citation legible on the viewer page, which is where the human judging
  happens. The reader tolerates bare strings and normalizes them, so a hand-edited data
  file still works.
- **`init` accepts a flat `{ name, domain }` body** as well as the documented
  `{ persona: { ... } }`. The evaluator calls init exactly once; removing a way for that
  single call to fail on a shape mismatch costs nothing.

### Verified

`npm run build` clean, `tsc --noEmit` clean, 14/14 smoke assertions passing, viewer page
loads with zero console errors. The repo ships uninitialized with an empty feed.

### Known gap identified in this phase — since fixed, see Phase 1b

`POST /api/agent/init` wrote `data/state.json` to the local filesystem. On Vercel that
write cannot persist — serverless filesystems are read-only apart from `/tmp`, which is
per-instance and ephemeral. The GitHub Actions cron would therefore never observe the
evaluator's init, would correctly refuse to publish, and would produce zero posts across
the entire 48-hour evaluation window while every endpoint still returned a healthy 200.

---

## Phase 1b — Durable init state

**Goal:** close the persistence gap above, so the evaluator's init is actually visible to
the write path.

**Requirements advanced:** requirement 5 (autonomous publishing) — without this the agent
can never start. It is a prerequisite for the top-weighted judging criterion, autonomous
operation after init.

### Prompt given

> The Vercel import at vercel.com/new is still the next step, and the state-persistence
> gap in writeState() is still the thing to fix, complete these task

### What was built

`lib/github.ts` — durable state through the GitHub Contents API, the same
`data/state.json` the cron checks out.

- `readRemoteState()` returns the committed state plus the blob sha needed to update it.
- `writeRemoteState()` commits the new state and returns whether it landed, so init can
  log honestly rather than assume success.
- Both fail soft. No token, a rate limit or a GitHub outage degrades init; it never 5xx's.
- 8-second `AbortSignal.timeout` on both calls so a slow GitHub cannot hang the evaluator's
  single init request.

`app/api/agent/init/route.ts` now treats GitHub as authoritative when configured and falls
back to the local file otherwise. The disk write is kept because it is what makes local
development work; on Vercel it fails silently and is covered by the commit.

Config: `GITHUB_TOKEN` (required in Vercel), `GITHUB_REPO` and `GITHUB_BRANCH` (optional,
defaulted). Documented in `.env.example`.

### Why read remotely rather than trust the bundle

After init commits `state.json`, GitHub triggers a Vercel redeploy that takes roughly a
minute. During that window the bundled copy on disk still says `initialized: false`. An
init retry in that window would read the stale bundle, mint a second agentId and clobber
the persona. Reading through the API removes the race entirely.

### Verified end-to-end against the real GitHub API

Using the locally authenticated `gh` token, not a mock:

1. Init with no `GITHUB_TOKEN` — still returns an agentId, smoke test 14/14, feed untouched.
2. Init with a token — committed `9756aa6 Initialize agent as Ada (AI Security)`; the
   committed `state.json` carried the same agentId that was returned to the caller.
3. **The Vercel scenario:** local `state.json` reset to uninitialized while the remote
   stayed initialized, then init called again with a *different* persona. It returned the
   original agentId, left the stored persona as `Ada / AI Security`, and produced no second
   commit. This is the case that would have silently broken the run.

### Two mistakes worth recording

- **The first test was measuring the wrong server.** Port 3000 was still held by an earlier
  dev process, so the token-enabled instance quietly started on 3001 and the curl hit the
  old tokenless one. It read as "the GitHub write silently failed" when nothing had been
  exercised at all. Killed the stale listeners and re-ran on a clean port.
- **The reset commit was a no-op.** The commit intended to restore `state.json` to
  uninitialized contained no diff for that file, because it already matched at the commit's
  base. Rebasing then replayed nothing and the live test's initialized state survived onto
  `main`. Caught by reading the pushed file back from GitHub rather than trusting the push;
  fixed in a follow-up commit. The repo now ships uninitialized with an empty feed.

---

## Phase 2 — Topic discovery

**Goal:** the agent finds its own topics from live sources, with no LLM and no API keys.

**Requirements advanced:** requirement 1 (topic discovery from live sources). Seeds
requirement 2 by recording a reason for every discarded candidate, which the Phase 3
editorial gate and the public rejection log build on. Protects requirement 3 by deriving
all queries from the persona domain rather than a fixed topic list.

### Prompt given

> Read CLAUDE.md, then build Phase 2: topic discovery.
>
> GOAL — Satisfy brief requirement 1: the agent independently discovers AI/tech topics
> from live information sources. No LLM, no API keys, fully testable in isolation.
>
> BUILD
> 1. `agent/discover.ts` exporting `discoverCandidates(domain: string): Promise<Candidate[]>`
> 2. Two live sources queried in parallel: Hacker News Algolia (search_by_date, tags=story) capturing points and comment count; arXiv (cs.AI, cs.LG, cs.CR and whatever else fits) capturing abstract and submission date.
> 3. Queries must be DERIVED FROM THE PERSONA DOMAIN passed at init, not hardcoded. Build a small domain -> query-terms mapper with a sensible generic fallback. Hardcoding my own topic list here would fail the persona requirement later.
> 4. Normalise both sources into one Candidate type: id, title, url, source, publishedAt, snippet, signals { points?, comments?, category? }.
> 5. Deterministic pre-filter, no LLM: recency window (48h HN, 7d arXiv), domain relevance via term matching, drop unresolvable URLs and obvious noise, deduplicate by canonical URL and against `data/seen.json`, and record every DROPPED candidate with the reason.
> 6. Resilience: per-source timeout (~8s) and one retry with backoff; if one source fails continue with the other; never throw out of `discoverCandidates`; log failures structurally for `/status`.
> 7. An npm script (`npm run discover -- "AI Security"`) that prints ranked candidates plus the drop log.
> 8. Tests: a source returning 500, a source timing out, both failing, malformed JSON, empty results, duplicate URLs across sources. None of these may throw.
>
> CONSTRAINTS — No LLM calls and no API keys in this phase. Small files, obvious names.
> Commit in small logical steps.
>
> WHEN DONE — Show the command to run discovery for two different domains so I can confirm
> results change with the persona. Append a Phase 2 section to PROMPTS.md. Audit: confirm
> requirement 1 is met, confirm the feed endpoint is untouched and still cannot 500, and
> name the single biggest remaining risk to a top-3 finish.

### What was built

| file | role |
|---|---|
| `agent/domain-terms.ts` | persona domain to search terms and arXiv categories, with a generic fallback |
| `agent/http.ts` | the only network entry point: timeout, one retry, never throws |
| `agent/sources/hackernews.ts` | HN Algolia, `search_by_date`, points and comments as signal |
| `agent/sources/arxiv.ts` | arXiv Atom feed, regex-parsed, no XML dependency |
| `agent/filter.ts` | deterministic pre-filter, canonical URL, scoring, drop reasons |
| `agent/seen.ts` | `data/seen.json` memory; discovery reads, the judge writes |
| `agent/discover.ts` | orchestration; `discoverCandidates` and `discoverWithReport` |
| `agent/cli.ts` | `npm run discover -- "<domain>"` |
| `agent/discover.test.ts` | 18 tests, all failure modes |

Added `tsx` as the only new dependency, to run TypeScript under Node in CI.

### Deviation from the prompt, deliberate

The prompt specified `discoverCandidates(domain): Promise<Candidate[]>`, but requirements 5
and 6 also need the drop log and the source failures. Rather than change the agreed
signature, `discoverWithReport()` returns the full `DiscoveryReport` and
`discoverCandidates()` is a thin wrapper over it. Phase 3 and `/status` consume the report;
the pipeline can still use the simple signature.

### Bugs found by running it, not by reading it

1. **Substring matching poisoned relevance.** `"ai"` matched inside *training*, *domain*
   and *explain*, so an "AI Security" run kept a heart-failure feature-engineering paper
   and a study of mobile shopping apps in Nigeria, both ranked above real security stories.
   Fixed with whole-word matching, plus a generic-vocabulary rule: words like *ai*, *model*
   and *learning* contribute to the score but cannot on their own establish domain
   relevance. Same query afterwards: 36 kept became 13, with the top five all on-domain.
2. **An empty arXiv feed was reported as a source failure.** arXiv returns a well-formed
   feed with zero entries when a category has nothing new, which is normal on a quiet day.
   That would have shown a healthy source as broken on the `/status` page. Only a body that
   is not a feed at all counts as a failure now.
3. **A test that proved nothing.** The timeout test slept without honouring the
   `AbortSignal`, so the request simply succeeded late and the timeout path was never
   exercised. The mock now aborts the way a real fetch does.

### Verified

18/18 tests pass, `tsc --noEmit` clean, `npm run build` clean, and live runs against both
real APIs return sensible results that change with the domain:

- `AI Security` — prompt-injection disclosures, a sandbox escape, cs.CR papers
- `Robotics` — cs.RO humanoid loco-manipulation and world-model papers, Gemini Robotics
- `Quantum Computing` — matches no profile, so the generic fallback searches the domain's
  own words and still returns quantum stories

The pre-filter is a shortlist, not the editorial decision: a few weak items still get
through, and rejecting those on quality grounds is Phase 3's job.

### Follow-up: cross-domain contamination (found by reading the CLI output)

Running all three domains side by side exposed a bug the earlier fix had missed. One paper —
*Investigating Artificial Intelligence Digital Sovereignty in Mobile Shopping Apps: A Case
Study of Nigeria* — was ranked in the top ten for **AI Security, Robotics and Quantum
Computing at once**, and a handful of generic arXiv papers padded all three lists.

The cause: the generic-vocabulary guard was a list of single words (`ai`, `model`,
`learning`), but the baseline vocabulary injected the multi-word phrase
`"artificial intelligence"`, which the guard never recognised. It was therefore treated as a
domain-specific match, so any paper with "Artificial Intelligence" in its title cleared the
gate for every persona.

The word-list approach was the wrong shape: whether a term is generic depends on where it
came from, not how it is spelled. `QueryProfile` now carries two lists — `relevance`, which
admits a candidate, and `supporting`, which only affects ranking — and the guard is gone
from the filter entirely. A domain composed entirely of generic words (someone initializes
with domain "AI") still falls back to admitting on its own tokens rather than rejecting
everything.

Result: AI Security 13 to 11 kept, Robotics 10 to 8, Quantum 13 to 11, with the shared
false positives gone from all three and each list now internally coherent.

One apparent false positive was left in deliberately. *Show HN: Otaku - A Roleplay Terminal
Client* still passes for AI Security because its post genuinely discusses context
"injection". A keyword filter cannot separate that from prompt-injection research; doing so
needs judgment, which is what the Phase 3 editorial gate is for. Tightening the keyword list
to exclude it would start rejecting real security stories.

---

## Phase 3 — Editorial gate, provider failover, and the cron

**Prompt given:** "YOU HAVE ALL THE PRIVILEGES TO DO, SO WHATEVER THE ISSUE IS THERE FIX IT",
following an audit that named the missing cron as the single biggest risk to a top-3 finish.

**Requirements advanced:** requirement 2 (editorial judgment with intentional rejection),
requirement 5 (autonomous publishing over time), and the transparency half of requirement 6 —
the rationale now exists, produced at the moment of judgment.

### What was built

`.github/workflows/agent.yml` + `agent/run.ts` — the scheduled loop. Three details each of
which would have failed silently: `permissions: contents: write` (without it the commit is
rejected with no error), a concurrency group so overlapping cycles cannot fight over `data/`,
and rebase-retry on push because `POST /api/agent/init` also commits `state.json` from Vercel,
so the remote genuinely moves underneath the job. `run.ts` exits 0 even on failure — a red run
every two hours becomes wallpaper, and the feed is unaffected either way.

`agent/llm.ts` — one `generate()` with providers as configuration. Each provider declares how
to build its request and how to extract text; everything above sees one shape. Failover skips
providers with no key and returns `ok:false` rather than throwing when all tiers fail.
`parseJsonResponse` recovers JSON from code fences and surrounding prose, because models wrap
their output even when told not to, and burning a retry on that is wasteful.

`agent/judge.ts` — the editorial gate. The whole shortlist is judged in ONE call, deliberately:
"why this one over the others" can only be answered by something that saw the others, which is
why CLAUDE.md puts rationale generation in the judge rather than the writer.

`agent/rejections.ts` — persists both editor-stage and pre-filter-stage rejections, so the
public rejection log can show what was considered and why it was turned down.

### Two safeguards worth naming

- **A `selected_id` that is not on the shortlist is refused.** Without this, a hallucinated id
  becomes a published post citing a source the agent never actually saw. That is the single
  worst failure this system could have, because it looks completely normal in the feed.
- **Every candidate the model ignores is still logged as a rejection.** The log has to account
  for everything it was shown, or the rejection log quietly under-reports.

### Verified live, not mocked

Against the real Groq endpoint, on real discovered candidates, the gate:

- rejected the pre-filter's **top-ranked** item as "an opinion piece with no new information",
  proving it is not rubber-stamping the highest score
- rejected "Show HN: Otaku - A Roleplay Terminal Client", the false positive the keyword filter
  provably could not catch (its post genuinely discusses context "injection")
- selected a concrete disclosed vulnerability, with a rationale covering both why it was chosen
  over the alternatives and why it matters now
- cost 1427 tokens against a 5000-token budget per cycle

36/36 tests pass, including groq-to-gemini failover, a provider with no key, all providers
failing, empty completions, and unparseable replies.

### The cron is proven autonomous

`workflow_dispatch` succeeding does not prove the `schedule` trigger works — they are separate
mechanisms. The scheduled run fired on its own at 16:55Z for the 16:17 slot (GitHub delays
scheduled runs under load, routinely by 15-40 minutes), completed successfully, and committed
its cycle record back to the repo as `autonomous-ai-creator`. Two agent-authored commits now
exist that no human triggered.

### An operational mistake worth recording

I told the user to install API keys with `read -rs`. That captures arrow-key escape sequences
and bracketed-paste markers as literal characters, which silently corrupted both keys — the
Groq key came out 174 characters instead of 56, and the Gemini key came out as `[D`, the escape
sequence for left-arrow. The symptom was an HTTP 400 with an empty body, which reads as a
network fault rather than a bad key. Replaced with `scripts/add-key.sh`, which reads from the
macOS clipboard, strips escapes, validates prefix and length, and writes `.env.local` and the
GitHub secret from the same value so the two cannot drift — which is exactly how they had
drifted, since `gh secret set` alone does not touch the local file.

---

### Phase 3 audit — six defects found and fixed

**Prompt given:** *"Do not write any new features. This is an audit of Phase 3 only. Read
CLAUDE.md, then audit agent/judge.ts against brief requirement 2 and requirement 6… Rate the
rejection reasons yourself: are they substantive editorial judgments, or generic filler like
'not relevant enough'? Be blunt."*

Running the judge three times on an identical shortlist and reading the raw output exposed
six problems. The important one was not a crash:

1. **Timeliness was double-counted.** The pre-filter clears items at 48h, then the judge
   failed them *again* for being "from two days ago". Two of seven rejections were "passed
   the age gate, failing it anyway".
2. **Recency outranked substance, reproducibly.** The agent rejected a disclosed prompt-injection
   vulnerability in three named systems because it was two days old, and published
   *"OpenAI to pause some work"* — a statement of intent — because it was 19 hours newer.
   **It was rejecting the disclosure and publishing the press release, every single run.**
3. **4 of 12 candidates were never judged and never logged**, so the rejection log was not a
   complete record of what was considered.
4. **The pre-filter log was truncated** to 20 of 40 drops.
5. **Nothing read `data/rejections.json`** — the judgment existed but was invisible.
6. **No quality floor on reasons** — "not relevant" would have been stored as editorial reasoning.

The fix to 1 and 2 was one prompt edit: substance became explicitly the heaviest standard,
statements of intent were named as press releases, and timeliness was redefined as *why a
reader needs this now* with an explicit instruction that age is not the editor's to judge.
On the identical shortlist the verdict inverted — it now publishes the disclosure and rejects
the OpenAI story as *"a statement of intent… no concrete technical details"*, with zero
age-based rejections.

**A correction I had to make in the same audit.** I had claimed the judge "flips on rerun on
the same inputs" and called it the thing that worried me most. That was wrong. Three
consecutive runs on an identical shortlist produced the same selection; the earlier apparent
flip was between two *different discovery batches*. I had compared different inputs and
blamed the model.

---

## Phase 4 — The persona writer: the agent publishes

**Prompt given:** "GO" — build the writer so the agent actually publishes.

**Requirements advanced:** requirement 3 (consistent persona), requirement 4 (memory),
requirement 6 (rationale and sources on every post). Completes requirement 5 in practice,
since the loop now produces posts spread over time rather than stopping at a decision.

### What was built

`agent/write.ts` — the voice layer. The editorial rules live in the prompt; the persona's
name and domain are injected from init, so the same standards produce a coherent voice for
whatever domain arrives. The rules are deliberately mostly negative (a banned-words list, no
scene-setting openers, no summarising, no lists) because left alone a model writes hedged
marketing prose that reads identically for every topic — and a feed of that makes the
rejection log look arbitrary. A voice with no standards has no grounds to reject anything.

`agent/posts.ts` — append-only writes to `data/posts.json`, with an id guard so a retried
cycle cannot double-publish. Nothing removes or rewrites an entry, because the brief requires
previously returned posts to stay available forever.

Wiring in `run.ts`: recent post titles feed BOTH the judge and the writer, so the agent
neither covers the same story twice nor opens the same way twice. Everything judged in a
cycle is marked seen — the published story must never return, and re-judging the same
rejects every two hours would burn tokens and fill the rejection log with duplicates.

### Refusing to publish is a first-class outcome

A body outside 60-320 words, a missing title, or an unparseable reply all become "published
nothing" with the reason recorded. The feed is permanent; a half-written post is worse than
no post.

### Verified end to end against production, as the evaluator will experience it

1. `POST /api/agent/init` on the live Vercel URL with `{"persona":{"name":"Ada","domain":"AI Security"}}`
2. The init endpoint committed `state.json` to the repo through the GitHub API
3. The GitHub Actions cycle picked up that state, discovered 52 candidates, kept 12 after the
   pre-filter, judged them, published one and rejected 7
4. It committed the post as `autonomous-ai-creator` (`449f139`)
5. Vercel redeployed and served it on the live feed within 15 seconds, with every contract
   field present, `createdAt` in ISO 8601 UTC, and the source URL intact

Everything was then reset to empty so the evaluator's own init is the first one that counts.

### Two fixes the live runs forced

- arXiv timed out at the 8s default, which costs the entire source for that cycle. Raised to
  15s; arXiv is regularly slower than Hacker News.
- The first post came back as one block because the prompt asked for paragraphs without
  saying how to separate them. Now it asks explicitly for `\n\n`, which is what the viewer
  splits on.

43/43 tests pass, including one asserting the supplied persona reaches the prompt and no
other persona leaks in.

---

### Phase 4 audit — six voice defects, and the bug that was eating cycles

**Prompt given:** *"Is the persona built from the name and domain the evaluator sends at
POST /api/agent/init, or is any part of it hardcoded?… Then prove it: run a full cycle with
persona Ada/AI Security, and a second with Kenji/Robotics. Paste both posts in full."*

The hardcoding check passed: `agent/write.ts` interpolates `persona.name` and `persona.domain`
in exactly one place and nowhere else. Running both personas produced completely disjoint
subject matter, sources and vocabulary — the Robotics post contained no LLM talk at all.

But reading the two posts side by side showed the voice was **consistent in a way that
exposed it as a template**. Both used the same skepticism formula in the same paragraph
position and closed with the same watching-brief move. That is a rhetorical scaffold with the
nouns swapped, not a personality.

Six fixes: a required stance (endorse / dispute / deflate / warn / contextualise) shown
against recently used ones; a rule that the last sentence must *be* the judgment, with seven
retreat closers detected and retried; six banned register patterns because the banned-*words*
list let "a notable step forward" through; richer memory carrying stances and opening clauses
rather than titles; stance stored on the post so persona state accumulates; and title length
enforced. Measured across four consecutive posts afterwards: 3 distinct stances, 4 distinct
openings, 0 retreat closers, 0 marketing register.

#### The bug that was eating cycles

Verifying those fixes, the fourth post failed on **all three providers**. Groq returned
`HTTP 400 json_validate_failed` with `failed_generation` beginning with a backtick — the model
had wrapped its JSON in a markdown code fence, and Groq validates JSON server-side in
`json_object` mode, so it rejected the completion *before* `parseJsonResponse` (which strips
fences) could ever see it.

Production data later showed the real cost: of the two scheduled cycles that ran while
initialized, **one published and one lost its post entirely** — a 50% failure rate that every
green workflow run concealed.

The second cause was my own paragraph instruction, which asked for a blank line inside a JSON
string value; when the model emitted a literal newline the JSON became invalid. Fixed at both
ends: the prompt now demands the two-character escape and warns that a real line break
discards the post, and `generate()` treats a `json_validate_failed` 400 as recoverable by
retrying the *same* provider with the JSON constraint dropped.

---

## Phase 5 — Memory via Breeth

**Requirements advanced:** requirement 4 (memory) primarily; requirement 3 (continuity
gives the persona a past to refer to) and requirement 6 (the rationale can now say what a
story adds to earlier coverage).

### The docs check, before any code

The prompt required reading https://docs.thebreeth.com/ and stopping if only MCP were
documented. Breeth publishes a REST API, so MCP was not needed:

- `POST /v1/episodes` — `{ content, group_id, source_description, extract_intent }`
- `POST /v1/search` — `{ query, group_id, limit }` returning `{ edges: [{ fact, ... }] }`
- Auth: `Authorization: Bearer ck_live_...`
- Hybrid ranking: "BM25 + vector cosine + graph centrality"

### What the live API taught us that the docs did not

Both findings changed the design, and the first would have broken the feed:

1. **Search has no relevance cutoff and returns no similarity score.** Querying a group
   with a completely unrelated topic still returns whatever facts that group holds —
   verified: "humanoid robot loco-manipulation controller" returned prompt-injection
   edges. Treating "any hit" as a duplicate would have rejected every candidate as soon
   as memory contained anything, and the agent would have stopped publishing entirely.
   So Breeth supplies the semantic recall, and a conservative local check decides whether
   the recalled fact is genuinely the SAME story: two shared distinctive terms. One would
   suppress every later story about the same organisation; two catches "OpenAI ships agent
   SDK" against "new agent framework from OpenAI" while letting an unrelated OpenAI story
   through. Over-rejection costs a publishing cycle, which is the more expensive mistake.
2. **The post id does not survive fact extraction.** Episodes are distilled to facts, so
   identity is resolved locally against posts.json rather than read back out of Breeth.

### Where memory sits in the pipeline

`recallSimilar` runs BEFORE the editorial gate, so the editor never spends a decision —
or tokens — on ground already covered. Candidates it flags are rejected as "already
covered (see post <id>)" into the same rejection log the editor writes to. Survivors carry
their recalled facts into the judge, so `why_selected` can say what a story adds, and into
the writer, where a callback is offered but never mandated.

Note on ordering: the URL dedup in seen.json runs during discovery, ahead of memory, so a
story already published is blocked before Breeth is consulted. Memory earns its place on
the case URL matching cannot see — the same story, different words, different URL — which
is what `scripts/demo-memory.sh` demonstrates.

### Graceful degradation, verified rather than assumed

Every call has an 8-second timeout and is wrapped; failures are recorded structurally.
Two full cycles were run to prove availability is untouched:

- with a deliberately invalid key: `[memory] recall failed: HTTP 401` three times, and the
  cycle still published
- with no key at all: no memory calls attempted, and the cycle still published

### Verified end to end against the live API

`./scripts/demo-memory.sh` publishes a post about "OpenAI ships agent SDK", remembers it,
waits for Breeth's async extraction, then offers "New agent framework from OpenAI lets
assistants call external tools" at a DIFFERENT domain, alongside an unrelated robotics
story. Result: the reworded duplicate was caught, the unrelated story passed through.
That is the exact case from the brief that a Set of URLs cannot catch.

64/64 tests pass, including one asserting that a candidate is NOT flagged merely because
memory returned something — if that ever regresses, the agent silently stops publishing.

---

## Phase 6 — Hardening and evidence surfaces

**Requirements advanced:** requirement 2 (the editorial record becomes readable evidence
rather than a log), requirement 5 (unattended survival across the 48-hour window), and
requirement 6 (the tally and the per-cycle record make the reasoning auditable).

### What was already done when this phase was requested

The prompt asked for the `/rejections` and `/status` pages, `permissions: contents: write`,
a concurrency group, and timeouts on every external call. All of those already existed from
earlier phases, so this phase covered what was genuinely missing rather than rebuilding them.
The prompt also said 43 tests; the real number was 70.

### Part A — the rejection log became a standards record

It listed everything flat, which is a log, not evidence. It now groups by the standard a
topic failed — on a real cycle: 3 "not a real development", 30 "outside the domain", 1 "too
thin to have a view on", 1 "not a topic at all" — and carries the running tally: 41
considered, 1 published, 40 rejected, 2% acceptance. Each entry shows its source host,
timestamp, stage and the full reason.

### Part B — the status page answers the reliability questions

Added: whether the agent is initialized and when, first and most recent cycle timestamps,
time since the last successful publish, and each failover event with its reason rather than
only a count of tiers.

### Part C — unattended survival

**Model ids (C6).** `gemini-2.0-flash` appeared twice — in the tier name and in the request
URL — so a one-sided edit would have produced a chain that reported one model while calling
another. All ids now live in `MODELS` in `agent/llm.ts`, and `/status` derives its tier order
from `PROVIDERS` rather than repeating the names.

**State consistency (C2).** Audited rather than assumed. `markSeen` and `appendPost` both sit
after the writer-error return, so a failed write cannot consume its candidates — they stay
eligible next cycle. But `recordRejections` sits *before* it, so a repeatedly failing writer
would re-log the same rejections every two hours and inflate the grouped counts. Entries are
now deduplicated by stage and URL.

**Token budget (C5), measured rather than estimated.** Observed across live runs: judge
~2,200 tokens worst case, writer ~1,200. Per cycle: 3,400 published, 2,200 when nothing is
selected, 4,600 worst case including a style retry. At the configured 2-hour cadence that is
12 cycles/day = 40,800 typical and 55,200 worst case against Groq's 100K/day ceiling — 41%
and 55%. Across the full 48-hour window: 81,600 typical, 110,400 worst case against a 200K
two-day ceiling, so 55% at worst. Headroom is effectively doubled again because the two Groq
models have separate per-model quotas and the 8B is untouched until the 70B fails.

### Part D — the failure drill, actually run

1. **Tier 1 forced down** — `groq:llama-3.1-8b-instant` served both calls and published
   "AI Agents Impersonate Humans to Target Real People".
2. **All Groq tiers forced down** — this is where the prompt expected Gemini to publish, and
   it cannot: `gemini:gemini-2.0-flash` returned HTTP 429, because the key authenticates but
   the project has no free-tier allocation. The cycle failed cleanly, logged every provider's
   error, and the previously published post survived: 1 post before, 1 after.
3. **Feed after a total provider outage** — HTTP 200, still serving the existing post with a
   valid ISO 8601 UTC timestamp. Then `posts.json` corrupted five ways (truncated, `null`,
   empty, non-JSON, deleted) — HTTP 200 and `{"posts":[]}` every time, and the real post
   returned once restored.
4. **Cycle run before init** — status `not-initialized`, no LLM call attempted at all, posts
   unchanged.

70/70 tests still pass and the feed endpoint was not touched.

---

## Phase 7 — Submission readiness

**Prompt given:** *"Read CLAUDE.md, then execute Phase 7: submission readiness… Verify each
of these from outside my machine and my session… Scan the ENTIRE git history… Give me a
single go/no-go verdict."*

No features. Verification, and making the work legible to a judge with fifteen minutes.

### Stage 1, verified unauthenticated

Every check run with the GitHub token unset, against the public URLs:

- repo `HTTP 200`, API reports `visibility=public private=false`
- live demo `HTTP 200` cold with cache-busting, 1.4s, 7,621 bytes
- `GET /api/agent/feed` → `HTTP 200` `{"posts":[]}`
- `POST /api/agent/init` → `HTTP 200` `{"agentId":"77399455-…"}`
- `PROMPTS.md` raw → `HTTP 200`

### The full init-to-publish loop, proven on production

The Stage 1 init used persona `Stage1 / Verification`. The cycle after it published
**nothing** — the editor reviewed the single candidate that nonsense domain produced and
rejected it. That is correct behaviour but proves nothing about publishing, so it was redone
with `Ada / AI Security`: the next cycle published *"Kimi K3 AI Model Breach Exposes Security
Risk"* with a rationale, a real source URL and stance `warn`, served by
`groq:llama-3.3-70b-versatile`. State was then reset so the evaluator's init is the first.

A cycle run before init publishes nothing and never calls a provider at all.

### Secret sweep

Zero matches across **every blob in every commit** for Groq, Gemini, Breeth or GitHub token
patterns. The three live key values appear nowhere in the repo or its history. The one hit in
`PROMPTS.md` is `Bearer ck_live_...` — the Breeth docs auth-format placeholder, ellipsis
included. No `.env` file has ever been committed.

### A key check that asked the wrong question

The largest single time sink in this build, and worth recording because the lesson generalises.

`add-key.sh` verified a Gemini key by calling the **models list**. That proves the key
authenticates. It does not prove the project can generate. A key passed that check three
separate times and then returned `429 limit: 0` on every generation attempt — across two
different keys from two different Google projects on the same account, which is an
account-level restriction no new key can escape.

Worse, the Groq probe had the identical flaw: it hit `/v1/models`, so a key with an exhausted
daily quota would have passed exactly the same way. It only ever looked correct by luck.

Both probes now exercise the capability the agent actually depends on — `chat/completions` and
`generateContent` — and read their model ids out of `agent/llm.ts` so they cannot drift from
the real chain. `verify-keys.sh` distinguishes a dead optional tier from a broken required
one: Gemini failing reports the diagnosis and exits 0, because publishing works without it.

This is the same class of mistake as the stance bug in Phase 4, where I inspected a post
through the feed endpoint, saw the field stripped by the reader, and blamed the writer. Both
times the fix was to test the thing itself rather than something adjacent to it.
