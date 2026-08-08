import { fetchText, parseJson } from "../http.ts";
import type { Candidate, SourceFailure } from "../../lib/types.ts";

/**
 * Hacker News via the Algolia API. No key required.
 *
 * search_by_date rather than relevance-sorted search: the agent is looking for
 * what is happening now, and a highly-ranked story from 2019 is not news.
 */

const ENDPOINT = "https://hn.algolia.com/api/v1/search_by_date";
const HITS_PER_TERM = 20;

interface AlgoliaHit {
  objectID?: string;
  title?: string;
  url?: string;
  story_text?: string;
  points?: number;
  num_comments?: number;
  created_at?: string;
}

interface AlgoliaResponse {
  hits?: AlgoliaHit[];
}

function toCandidate(hit: AlgoliaHit): Candidate | null {
  if (!hit.objectID || !hit.title) return null;

  // Ask stories have no url; link to the HN discussion so the source resolves.
  const url = hit.url?.trim() || `https://news.ycombinator.com/item?id=${hit.objectID}`;
  const publishedAt = hit.created_at ? new Date(hit.created_at).toISOString() : "";
  if (!publishedAt || Number.isNaN(Date.parse(publishedAt))) return null;

  return {
    id: `hackernews:${hit.objectID}`,
    title: hit.title.trim(),
    url,
    source: "hackernews",
    publishedAt,
    snippet: (hit.story_text ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500),
    signals: {
      points: typeof hit.points === "number" ? hit.points : 0,
      comments: typeof hit.num_comments === "number" ? hit.num_comments : 0,
    },
  };
}

/**
 * Runs one search per term in parallel and merges. Never throws — a failure is
 * reported, not raised.
 */
export async function fetchHackerNews(
  terms: string[],
  options: { sinceHours?: number; timeoutMs?: number } = {},
): Promise<{ candidates: Candidate[]; failure: SourceFailure | null }> {
  const sinceHours = options.sinceHours ?? 48;
  const cutoff = Math.floor((Date.now() - sinceHours * 3600_000) / 1000);
  const queries = terms.slice(0, 3);

  if (queries.length === 0) {
    return { candidates: [], failure: null };
  }

  const results = await Promise.all(
    queries.map(async (term) => {
      const url =
        `${ENDPOINT}?tags=story` +
        `&query=${encodeURIComponent(term)}` +
        `&hitsPerPage=${HITS_PER_TERM}` +
        `&numericFilters=${encodeURIComponent(`created_at_i>${cutoff}`)}`;
      return fetchText(url, { timeoutMs: options.timeoutMs });
    }),
  );

  const candidates: Candidate[] = [];
  const errors: string[] = [];
  let attempts = 0;

  for (const result of results) {
    attempts = Math.max(attempts, result.attempts);
    if (!result.ok) {
      errors.push(result.error ?? "unknown error");
      continue;
    }
    const parsed = parseJson<AlgoliaResponse>(result.body);
    if (!parsed || !Array.isArray(parsed.hits)) {
      errors.push("malformed JSON response");
      continue;
    }
    for (const hit of parsed.hits) {
      const candidate = toCandidate(hit);
      if (candidate) candidates.push(candidate);
    }
  }

  // Only a total failure counts: partial results are still useful.
  const failure =
    candidates.length === 0 && errors.length > 0
      ? { source: "hackernews" as const, error: errors[0], attempts }
      : null;

  return { candidates, failure };
}
