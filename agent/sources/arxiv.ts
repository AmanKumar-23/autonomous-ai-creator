import { fetchText } from "../http.ts";
import type { Candidate, SourceFailure } from "../../lib/types.ts";

/**
 * arXiv Atom API. No key required.
 *
 * Queried by category, newest first. The categories come from the persona
 * domain (cs.CR for a security persona, cs.RO for robotics), and the relevance
 * pre-filter narrows further against title and abstract. Querying by category
 * rather than by keyword means a narrow domain still returns something to
 * judge, instead of an empty result that looks like a broken source.
 *
 * The Atom feed is parsed with regex rather than an XML dependency: the schema
 * is small, fixed, and this keeps the agent dependency-free. Every extraction
 * tolerates a missing field.
 */

const ENDPOINT = "https://export.arxiv.org/api/query";
const MAX_RESULTS = 30;

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function tidy(text: string): string {
  return decodeEntities(text).replace(/\s+/g, " ").trim();
}

function extract(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return match ? tidy(match[1]) : "";
}

function parseEntries(xml: string): Candidate[] {
  const blocks = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];

  return blocks.flatMap((block): Candidate[] => {
    const rawId = extract(block, "id");
    const title = extract(block, "title");
    const published = extract(block, "published");
    if (!rawId || !title || !published) return [];

    const timestamp = Date.parse(published);
    if (Number.isNaN(timestamp)) return [];

    // http://arxiv.org/abs/2401.00001v1 -> 2401.00001v1
    const paperId = rawId.split("/abs/")[1] ?? rawId;

    const primary =
      block.match(/<arxiv:primary_category[^>]*term="([^"]+)"/)?.[1] ??
      block.match(/<category[^>]*term="([^"]+)"/)?.[1] ??
      undefined;

    return [
      {
        id: `arxiv:${paperId}`,
        title,
        url: `https://arxiv.org/abs/${paperId}`,
        source: "arxiv",
        publishedAt: new Date(timestamp).toISOString(),
        snippet: extract(block, "summary").slice(0, 500),
        signals: { category: primary },
      },
    ];
  });
}

/** Never throws. Returns whatever parsed, plus a failure if nothing did. */
export async function fetchArxiv(
  categories: string[],
  options: { timeoutMs?: number } = {},
): Promise<{ candidates: Candidate[]; failure: SourceFailure | null }> {
  const cats = categories.slice(0, 3);
  if (cats.length === 0) return { candidates: [], failure: null };

  const searchQuery = cats.map((category) => `cat:${category}`).join(" OR ");
  const url =
    `${ENDPOINT}?search_query=${encodeURIComponent(searchQuery)}` +
    `&sortBy=submittedDate&sortOrder=descending&max_results=${MAX_RESULTS}`;

  const result = await fetchText(url, { timeoutMs: options.timeoutMs });

  if (!result.ok || !result.body) {
    return {
      candidates: [],
      failure: {
        source: "arxiv",
        error: result.error ?? "unknown error",
        attempts: result.attempts,
      },
    };
  }

  const candidates = parseEntries(result.body);

  // A 200 that yields nothing parseable is a failure worth surfacing, not silence.
  if (candidates.length === 0 && !result.body.includes("<entry>")) {
    return {
      candidates: [],
      failure: { source: "arxiv", error: "no parseable entries in feed", attempts: result.attempts },
    };
  }

  return { candidates, failure: null };
}
