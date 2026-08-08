import type { Candidate, DroppedCandidate, DropReason } from "../lib/types.ts";

/**
 * Deterministic pre-filter. No LLM, no keys, no network.
 *
 * Its job is to hand the Phase 3 editorial gate a short list worth spending a
 * token budget on, and to explain every discard. Those explanations become the
 * public rejection log, so "detail" is written to be read by a human.
 */

export interface FilterOptions {
  /** Domain-specific terms. A match here admits the candidate. */
  relevance: string[];
  /** General AI vocabulary. Affects ranking only, never admission. */
  supporting?: string[];
  hnMaxAgeHours?: number;
  arxivMaxAgeDays?: number;
  /** Canonical URLs already seen in previous cycles. */
  seen?: Set<string>;
  now?: number;
}

/** Titles that are never worth an editorial opinion. */
const NOISE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bwho is hiring\b|\bwho wants to be hired\b|\bfreelancer\b.*\bseeking\b/i, label: "hiring thread" },
  { pattern: /^ask hn:\s*(poll|which|what should i)\b/i, label: "poll or open-ended ask" },
  { pattern: /^poll:/i, label: "poll" },
  { pattern: /\bshow hn: my (first|new) (side )?project\b/i, label: "personal project showcase" },
  { pattern: /\b(deal|discount|coupon|sale|black friday)\b/i, label: "promotional" },
];

/**
 * Strips the parts of a URL that vary without changing the destination, so the
 * same story arriving from two sources collapses to one entry.
 */
export function canonicalUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    url.protocol = "https:";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_") || ["ref", "source", "fbclid", "gclid"].includes(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }
    // arXiv versions are the same paper.
    url.pathname = url.pathname.replace(/\/$/, "").replace(/^(\/abs\/\d+\.\d+)v\d+$/, "$1");
    return url.toString();
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

function ageHours(candidate: Candidate, now: number): number {
  const published = Date.parse(candidate.publishedAt);
  if (Number.isNaN(published)) return Number.POSITIVE_INFINITY;
  return (now - published) / 3600_000;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whole-word matching. Substring matching is what let "ai" match "training",
 * "domain" and "explain", which pulled unrelated papers into the feed.
 */
function termMatches(haystack: string, term: string): boolean {
  const needle = term.toLowerCase();
  if (needle.includes(" ")) return haystack.includes(needle);
  return new RegExp(`\\b${escapeRegex(needle)}\\b`).test(haystack);
}

interface RelevanceHits {
  /** Matches on domain-specific terms. These are what admit a candidate. */
  specific: string[];
  /** Matches on general AI vocabulary. Ranking only. */
  generic: string[];
}

function relevanceHits(
  candidate: Candidate,
  relevance: string[],
  supporting: string[],
): RelevanceHits {
  const haystack = `${candidate.title} ${candidate.snippet}`.toLowerCase();
  const hit = (term: string) => term.length > 1 && termMatches(haystack, term);
  return { specific: relevance.filter(hit), generic: supporting.filter(hit) };
}

/**
 * Admission requires a domain-specific match. Only when a domain has no
 * specific terms at all does supporting vocabulary get to decide, so a caller
 * that passes just generic words still gets results instead of silence.
 */
function isRelevant(hits: RelevanceHits, relevance: string[]): boolean {
  return relevance.length > 0 ? hits.specific.length > 0 : hits.generic.length > 0;
}

/**
 * Recency, engagement and domain overlap. Deterministic so the same inputs
 * always rank the same way — a judge can re-run it and see what the agent saw.
 */
export function scoreCandidate(
  candidate: Candidate,
  relevance: string[],
  now: number,
  supporting: string[] = [],
): number {
  const hours = ageHours(candidate, now);
  const recency = Math.max(0, 1 - hours / (24 * 7));
  // Domain-specific matches are worth three times a generic vocabulary match.
  const hits = relevanceHits(candidate, relevance, supporting);
  const relevanceScore = Math.min(1, (hits.specific.length * 1.5 + hits.generic.length * 0.5) / 5);

  const points = candidate.signals.points ?? 0;
  const comments = candidate.signals.comments ?? 0;
  // Log scale: the gap between 5 and 50 points matters far more than 500 to 1000.
  const engagement = Math.min(1, Math.log10(1 + points + comments * 2) / 3);

  return Number((recency * 0.35 + relevanceScore * 0.45 + engagement * 0.2).toFixed(4));
}

export interface FilterResult {
  kept: Candidate[];
  dropped: DroppedCandidate[];
}

export function filterCandidates(candidates: Candidate[], options: FilterOptions): FilterResult {
  const now = options.now ?? Date.now();
  const hnMaxAgeHours = options.hnMaxAgeHours ?? 48;
  const arxivMaxAgeDays = options.arxivMaxAgeDays ?? 7;
  const seen = options.seen ?? new Set<string>();
  const supporting = options.supporting ?? [];

  const kept: Candidate[] = [];
  const dropped: DroppedCandidate[] = [];
  const seenThisCycle = new Map<string, Candidate>();

  const drop = (candidate: Candidate, reason: DropReason, detail: string) =>
    dropped.push({ candidate, reason, detail });

  for (const candidate of candidates) {
    if (!candidate.url || !/^https?:\/\//i.test(candidate.url)) {
      drop(candidate, "no-url", "no resolvable http(s) URL to cite as a source");
      continue;
    }

    const noise = NOISE_PATTERNS.find(({ pattern }) => pattern.test(candidate.title));
    if (noise) {
      drop(candidate, "noise", `matched the ${noise.label} pattern, not a topic worth an opinion`);
      continue;
    }

    const hours = ageHours(candidate, now);
    const limit = candidate.source === "arxiv" ? arxivMaxAgeDays * 24 : hnMaxAgeHours;
    if (hours > limit) {
      const age =
        candidate.source === "arxiv"
          ? `${Math.round(hours / 24)}d old, limit ${arxivMaxAgeDays}d`
          : `${Math.round(hours)}h old, limit ${hnMaxAgeHours}h`;
      drop(candidate, "stale", `outside the recency window (${age})`);
      continue;
    }

    const hits = relevanceHits(candidate, options.relevance, supporting);
    if (!isRelevant(hits, options.relevance)) {
      const detail =
        hits.generic.length > 0
          ? `only generic AI vocabulary matched (${hits.generic.slice(0, 3).join(", ")}), nothing specific to the domain`
          : "no domain term appears in the title or abstract";
      drop(candidate, "off-domain", detail);
      continue;
    }

    const canonical = canonicalUrl(candidate.url);

    if (seen.has(canonical)) {
      drop(candidate, "already-seen", "covered in an earlier cycle; the feed does not repeat itself");
      continue;
    }

    const existing = seenThisCycle.get(canonical);
    if (existing) {
      drop(candidate, "duplicate", `same story as "${existing.title}" from ${existing.source}`);
      continue;
    }

    candidate.score = scoreCandidate(candidate, options.relevance, now, supporting);
    seenThisCycle.set(canonical, candidate);
    kept.push(candidate);
  }

  kept.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return { kept, dropped };
}
