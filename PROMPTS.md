# AI usage log

A record of the prompts used to build this project, what they produced, and what I
changed afterwards. Maintained as the work happens so any feature in the live demo can
be traced back to the prompt that built it.

Tooling: Claude Code (Opus 5).

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
