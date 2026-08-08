import { deriveQueryProfile } from "./domain-terms.ts";
import { filterCandidates } from "./filter.ts";
import { readSeenUrls } from "./seen.ts";
import { fetchArxiv } from "./sources/arxiv.ts";
import { fetchHackerNews } from "./sources/hackernews.ts";
import type { Candidate, DiscoveryReport, SourceFailure } from "../lib/types.ts";

/**
 * Requirement 1: the agent finds its own topics from live sources.
 *
 * Hacker News and arXiv are queried in parallel with terms derived from the
 * persona domain supplied at init. Both normalize into one Candidate shape, so
 * nothing downstream knows or cares where an item came from.
 *
 * Nothing in here throws. A source that 500s, times out or returns nonsense is
 * recorded as a failure and the cycle continues with whatever the other one
 * returned — an empty list is a valid, honest result.
 */

export interface DiscoverOptions {
  timeoutMs?: number;
  hnMaxAgeHours?: number;
  arxivMaxAgeDays?: number;
  /** Overrides for tests; production reads data/seen.json. */
  seen?: Set<string>;
  now?: number;
}

/** Full result including the drop log and source failures. */
export async function discoverWithReport(
  domain: string,
  options: DiscoverOptions = {},
): Promise<DiscoveryReport> {
  const queriedAt = new Date().toISOString();
  const profile = deriveQueryProfile(domain);

  const [hn, arxiv] = await Promise.all([
    fetchHackerNews(profile.terms, {
      sinceHours: options.hnMaxAgeHours ?? 48,
      timeoutMs: options.timeoutMs,
    }).catch((error): { candidates: Candidate[]; failure: SourceFailure } => ({
      candidates: [],
      failure: { source: "hackernews", error: String(error), attempts: 0 },
    })),
    fetchArxiv(profile.categories, { timeoutMs: options.timeoutMs }).catch(
      (error): { candidates: Candidate[]; failure: SourceFailure } => ({
        candidates: [],
        failure: { source: "arxiv", error: String(error), attempts: 0 },
      }),
    ),
  ]);

  const failures = [hn.failure, arxiv.failure].filter((f): f is SourceFailure => f !== null);
  for (const failure of failures) {
    console.error(`[discover] source ${failure.source} failed: ${failure.error}`);
  }

  const seen = options.seen ?? (await readSeenUrls().catch(() => new Set<string>()));

  const { kept, dropped } = filterCandidates([...hn.candidates, ...arxiv.candidates], {
    relevance: profile.relevance,
    supporting: profile.supporting,
    hnMaxAgeHours: options.hnMaxAgeHours,
    arxivMaxAgeDays: options.arxivMaxAgeDays,
    seen,
    now: options.now,
  });

  console.log(
    `[discover] domain="${domain}" terms=[${profile.terms.join(", ")}] ` +
      `fetched=${hn.candidates.length + arxiv.candidates.length} kept=${kept.length} ` +
      `dropped=${dropped.length} failures=${failures.length}`,
  );

  return { domain, queriedAt, terms: profile.terms, candidates: kept, dropped, failures };
}

/** The signature the pipeline uses. Ranked best-first; never throws. */
export async function discoverCandidates(domain: string): Promise<Candidate[]> {
  try {
    return (await discoverWithReport(domain)).candidates;
  } catch (error) {
    console.error("[discover] unexpected failure, returning no candidates:", error);
    return [];
  }
}
