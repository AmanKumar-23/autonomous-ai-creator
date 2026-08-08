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
