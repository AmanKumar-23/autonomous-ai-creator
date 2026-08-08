import type { Candidate, Post } from "../lib/types.ts";

/**
 * Requirement 4: memory, via Breeth (https://api.thebreeth.com/v1).
 *
 * Why a memory layer rather than the Set of URLs in seen.ts: string matching
 * cannot tell that "OpenAI ships agent SDK" and "new agent framework from
 * OpenAI" are the same story. Breeth's search is hybrid BM25 + vector cosine, so
 * it recalls prior coverage by meaning. Verified against the live API: a query
 * sharing almost no words with the stored episode still recalled it.
 *
 * TWO THINGS THE LIVE API TAUGHT US, which shape everything below.
 *
 * 1. Search has no relevance cutoff and returns no score. Querying a group with
 *    an unrelated topic still returns whatever facts that group holds. Treating
 *    "any hit" as a duplicate would therefore reject every candidate as soon as
 *    memory contained anything, and the agent would stop publishing. So Breeth
 *    supplies the semantic recall and a local check decides whether the recalled
 *    fact is genuinely the SAME story.
 * 2. The post id does not survive fact extraction. Episodes are distilled into
 *    facts like "Ollama and Gemma4 exposed to prompt injection", so identity is
 *    resolved locally against posts.json rather than read back out of Breeth.
 *
 * Nothing here throws, and nothing here is required for a publish. Breeth being
 * down degrades quality — the agent falls back to URL dedup — and never
 * degrades availability.
 */

const API = "https://api.thebreeth.com/v1";
const TIMEOUT_MS = 8000;
const SEARCH_LIMIT = 8;

/** Distinctive terms two texts must share before they count as the same story. */
const MIN_SHARED_TERMS = 2;

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "have", "has", "are", "was",
  "were", "will", "into", "over", "under", "about", "after", "before", "their",
  "your", "our", "its", "it's", "new", "now", "how", "why", "what", "when", "more",
  "than", "then", "they", "them", "some", "just", "also", "been", "being", "said",
  "says", "using", "used", "make", "makes", "made", "post", "posts", "published",
]);

export interface MemoryHit {
  /** True only when a recalled fact is genuinely the same story. */
  covered: boolean;
  /** What the agent previously said about this ground, in its own words. */
  facts: string[];
  /** Resolved locally: Breeth cannot return it. */
  relatedPostId: string | null;
  relatedTitle: string | null;
}

export interface MemoryFailure {
  operation: "remember" | "recall";
  error: string;
}

/** Structured, so /status can show when memory was unavailable. */
export const memoryFailures: MemoryFailure[] = [];

function apiKey(): string | null {
  const key = process.env.BREETH_API_KEY?.trim();
  return key ? key : null;
}

export function isMemoryConfigured(): boolean {
  return apiKey() !== null;
}

/** One namespace per agent, so a reused Breeth account cannot cross-contaminate. */
export function groupFor(agentId: string | null): string {
  return agentId ? `aac-${agentId}` : "autonomous-ai-creator";
}

function record(operation: MemoryFailure["operation"], error: string): void {
  memoryFailures.push({ operation, error });
  console.error(`[memory] ${operation} failed: ${error}`);
}

async function call<T>(path: string, body: unknown, operation: MemoryFailure["operation"]): Promise<T | null> {
  const key = apiKey();
  if (!key) {
    record(operation, "no BREETH_API_KEY configured");
    return null;
  }

  try {
    const response = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      record(operation, `HTTP ${response.status}`);
      return null;
    }
    return (await response.json()) as T;
  } catch (error) {
    const message =
      error instanceof Error
        ? error.name === "TimeoutError" || error.name === "AbortError"
          ? `timeout after ${TIMEOUT_MS}ms`
          : error.message
        : String(error);
    record(operation, message);
    return null;
  }
}

/** Content words long enough to identify a subject. */
function distinctiveTerms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s'-]/g, " ")
      .split(/\s+/)
      .map((word) => word.replace(/^['-]+|['-]+$/g, ""))
      .filter((word) => word.length >= 4 && !STOP_WORDS.has(word)),
  );
}

/**
 * Do a recalled fact and a candidate describe the same story?
 *
 * Requiring two shared distinctive terms is deliberately conservative. One
 * shared term ("OpenAI") would suppress every later story about the same
 * organisation; two catches "OpenAI ships agent SDK" against "new agent
 * framework from OpenAI" while letting an unrelated OpenAI story through.
 * Over-rejection costs a publishing cycle, which is the more expensive mistake.
 */
export function sameStory(factText: string, candidateText: string): boolean {
  const factTerms = distinctiveTerms(factText);
  const candidateTerms = distinctiveTerms(candidateText);
  let shared = 0;
  for (const term of candidateTerms) if (factTerms.has(term)) shared++;
  return shared >= MIN_SHARED_TERMS;
}

interface SearchResponse {
  edges?: Array<{ fact?: string }>;
}

/**
 * Called BEFORE the editorial gate. For each candidate, what have we already
 * said about this ground? Never throws; an unreachable Breeth yields an empty
 * map and the pipeline continues on URL dedup alone.
 */
export async function recallSimilar(
  candidates: Candidate[],
  options: { groupId: string; priorPosts?: Post[] },
): Promise<Map<string, MemoryHit>> {
  const hits = new Map<string, MemoryHit>();
  if (candidates.length === 0 || !isMemoryConfigured()) return hits;

  const priorPosts = options.priorPosts ?? [];

  await Promise.all(
    candidates.map(async (candidate) => {
      const query = `${candidate.title}. ${candidate.snippet}`.slice(0, 400);
      const response = await call<SearchResponse>(
        "/search",
        { query, group_id: options.groupId, limit: SEARCH_LIMIT },
        "recall",
      );
      if (!response) return;

      const facts = (response.edges ?? [])
        .map((edge) => (typeof edge.fact === "string" ? edge.fact.trim() : ""))
        .filter(Boolean);
      if (facts.length === 0) return;

      // Breeth recalls by meaning; this decides whether it is the same story.
      const matching = facts.filter((fact) => sameStory(fact, candidate.title));

      // Identity has to come from our own records — Breeth drops the post id.
      let relatedPostId: string | null = null;
      let relatedTitle: string | null = null;
      for (const post of priorPosts) {
        const haystack = `${post.title ?? ""} ${post.sources.map((s) => s.title).join(" ")}`;
        if (sameStory(haystack, candidate.title)) {
          relatedPostId = post.id;
          relatedTitle = post.title ?? null;
          break;
        }
      }

      hits.set(candidate.id, {
        covered: matching.length > 0,
        facts: (matching.length > 0 ? matching : facts).slice(0, 3),
        relatedPostId,
        relatedTitle,
      });
    }),
  );

  return hits;
}

/**
 * Called after a successful publish. Stores the topic, the angle taken, the key
 * entities and the post id as prose, because Breeth has no metadata field —
 * only content, group_id and a 120-character source_description.
 */
export async function rememberPost(
  post: Post,
  personaName: string,
  groupId: string,
): Promise<boolean> {
  if (!isMemoryConfigured()) return false;

  const sources = post.sources.map((source) => source.title).join("; ");
  const content = [
    `${personaName} published post ${post.id} titled "${post.title ?? ""}".`,
    `Angle taken: ${post.stance ?? "unstated"}.`,
    `Topic: ${post.text.slice(0, 400)}`,
    sources ? `Based on: ${sources}.` : "",
    `Reason for publishing: ${post.rationale.slice(0, 300)}`,
  ]
    .filter(Boolean)
    .join(" ");

  const response = await call<{ ok?: boolean }>(
    "/episodes",
    { content, group_id: groupId, source_description: `${personaName} feed post`.slice(0, 120) },
    "remember",
  );

  if (response?.ok) {
    console.log(`[memory] remembered post ${post.id}`);
    return true;
  }
  return false;
}
