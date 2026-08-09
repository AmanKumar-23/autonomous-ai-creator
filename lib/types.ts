/**
 * Every type in the project lives here. Routes, the viewer page and the agent
 * scripts all import from this file so the wire shape has exactly one definition.
 */

/** Supplied by the evaluator at init. Never hardcoded. */
export interface Persona {
  name: string;
  domain: string;
}

/** A citation backing a post. Requirement 6: every post exposes its sources. */
export interface Source {
  title: string;
  url: string;
}

/**
 * The public post shape returned by GET /api/agent/feed.
 * `id`, `createdAt`, `text`, `rationale` and `sources` are the contract fields
 * from the brief; anything added later must stay optional so the contract holds.
 */
export interface Post {
  /** Unique and stable for the lifetime of the feed. */
  id: string;
  /** ISO 8601 UTC, e.g. 2026-08-08T14:03:00.000Z */
  createdAt: string;
  /** The published body, written in the persona's voice. */
  text: string;
  /** Why this topic was selected and why it matters now. Produced by the judge step. */
  rationale: string;
  sources: Source[];
  /** Short headline for the viewer page. Optional: not part of the required contract. */
  title?: string;
  /** Which LLM provider served this cycle. Optional: powers the /status page. */
  provider?: string;
  /** The verdict this post committed to. Optional: feeds voice continuity. */
  stance?: string;
}

/** Persisted in data/state.json. The cron refuses to publish unless initialized. */
export interface AgentState {
  initialized: boolean;
  agentId: string | null;
  persona: Persona | null;
  /** ISO 8601 UTC timestamp of the first successful init. */
  initializedAt: string | null;
}

export const EMPTY_STATE: AgentState = {
  initialized: false,
  agentId: null,
  persona: null,
  initializedAt: null,
};

/* ------------------------------------------------------------------ *
 * Discovery (Phase 2). Both live sources normalize into one Candidate
 * so nothing downstream needs to know where an item came from.
 * ------------------------------------------------------------------ */

export type SourceName = "hackernews" | "arxiv";

export interface Candidate {
  /** Stable per source, e.g. "hackernews:38912345" or "arxiv:2401.00001v1". */
  id: string;
  title: string;
  url: string;
  source: SourceName;
  /** ISO 8601 UTC. */
  publishedAt: string;
  snippet: string;
  signals: {
    points?: number;
    comments?: number;
    /** arXiv primary category, e.g. cs.CR */
    category?: string;
  };
  /** Deterministic rank from recency, engagement and term overlap. */
  score?: number;
}

/** Why the deterministic pre-filter discarded something. No LLM involved. */
export type DropReason =
  | "no-url"
  | "stale"
  | "off-domain"
  | "noise"
  | "duplicate"
  | "already-seen";

export interface DroppedCandidate {
  candidate: Candidate;
  reason: DropReason;
  /** Human-readable specifics, surfaced by the rejection log in Phase 3. */
  detail: string;
}

/** A source that failed after its retry. Discovery continues without it. */
export interface SourceFailure {
  source: SourceName;
  error: string;
  attempts: number;
}

/**
 * One run of the agent loop, recorded whether or not it published. This is the
 * evidence of autonomous operation and the data behind the /status page.
 */
export type CycleStatus =
  | "not-initialized"
  | "no-candidates"
  | "discovered"
  | "published"
  | "failed";

export interface CycleRecord {
  id: string;
  /** ISO 8601 UTC. */
  startedAt: string;
  finishedAt: string;
  status: CycleStatus;
  /** Plain-language explanation of what the cycle decided and why. */
  reason: string;
  domain: string | null;
  discovered: number;
  kept: number;
  dropped: number;
  failures: SourceFailure[];
  /** Which LLM provider served this cycle, once Phase 3 exists. */
  provider?: string;
  /** Whether Breeth answered this cycle. Absent on cycles that never called it. */
  memory?: { available: boolean; failures: number };
}

/**
 * A topic the agent considered and turned down. "editor" means the LLM judged it
 * against the persona's standards; "prefilter" means a deterministic rule did.
 */
export interface Rejection {
  id: string;
  title: string;
  url: string;
  reason: string;
  stage: "editor" | "prefilter";
  /** ISO 8601 UTC. */
  rejectedAt: string;
  cycleId: string;
}

export interface DiscoveryReport {
  domain: string;
  /** ISO 8601 UTC. */
  queriedAt: string;
  /** Query terms derived from the domain — proves the persona drove the search. */
  terms: string[];
  candidates: Candidate[];
  dropped: DroppedCandidate[];
  failures: SourceFailure[];
}
