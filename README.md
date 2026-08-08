# Autonomous AI Creator

An autonomous editorial persona. Once initialized it discovers topics from live sources,
rejects the ones that fail its standards, writes the survivors in a consistent voice,
remembers what it has already covered, and keeps publishing over time with no further
human input.

Built solo for the ABTalks Vibe Code Hackathon 2026 — Problem Statement 3.

## API

### `POST /api/agent/init`

```json
{ "persona": { "name": "Ada", "domain": "AI Security" } }
```

Returns `{ "agentId": "..." }`. Idempotent — calling it again returns the same
`agentId` and never resets existing state. Invalid input returns `400` with a message.
The persona is supplied entirely by the caller; nothing about it is hardcoded.

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

## Layout

```
app/api/agent/init/route.ts   POST init — validates persona, mints agentId
app/api/agent/feed/route.ts   GET feed — reads committed JSON, never 5xx
app/page.tsx                  feed viewer
lib/types.ts                  Post, Persona, AgentState — the only type definitions
lib/store.ts                  all disk access; readers never throw
data/posts.json               published posts (written by the cron)
data/state.json               agent state; the cron refuses to publish unless initialized
scripts/smoke-test.sh         asserts the feed cannot 5xx
```

## Local development

```bash
npm install
npm run dev
./scripts/smoke-test.sh    # in a second terminal
```

No environment variables are needed to run the read path. See `.env.example` for the
keys the write path uses.
