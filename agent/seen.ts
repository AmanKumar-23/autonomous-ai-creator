import { promises as fs } from "node:fs";
import path from "node:path";

import { canonicalUrl } from "./filter.ts";

/**
 * data/seen.json — the agent's short-term memory of what it has already
 * considered, so the same story does not resurface every two hours.
 *
 * Discovery only READS this. Marking happens after the editorial gate decides,
 * because a topic dropped for being stale might be worth revisiting, whereas
 * one that was judged and published must never come back. Phase 3 owns the write.
 *
 * This is deliberately not the whole memory story: string-level URL matching
 * cannot tell that "OpenAI ships agent SDK" and "new agent framework from
 * OpenAI" are the same event. Semantic dedup via Breeth lands in Phase 5.
 */

const SEEN_PATH = path.join(process.cwd(), "data", "seen.json");
const MAX_ENTRIES = 500;

export interface SeenEntry {
  url: string;
  title: string;
  /** ISO 8601 UTC. */
  seenAt: string;
}

/** Never throws. A missing or corrupt file means "nothing seen yet". */
export async function readSeen(): Promise<SeenEntry[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(SEEN_PATH, "utf8")) as { entries?: unknown };
    if (!Array.isArray(parsed.entries)) return [];
    return parsed.entries.flatMap((entry): SeenEntry[] => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as Record<string, unknown>;
      if (typeof record.url !== "string" || !record.url) return [];
      return [
        {
          url: record.url,
          title: typeof record.title === "string" ? record.title : "",
          seenAt: typeof record.seenAt === "string" ? record.seenAt : "",
        },
      ];
    });
  } catch {
    return [];
  }
}

/** Canonical URLs, ready to hand to the filter. */
export async function readSeenUrls(): Promise<Set<string>> {
  return new Set((await readSeen()).map((entry) => canonicalUrl(entry.url)));
}

/**
 * Appends entries, newest first, capped so the file cannot grow without bound
 * across a long run. Throws on a read-only filesystem — but this only ever runs
 * in GitHub Actions, never in a Vercel request.
 */
export async function markSeen(entries: Array<{ url: string; title: string }>): Promise<void> {
  const existing = await readSeen();
  const known = new Set(existing.map((entry) => canonicalUrl(entry.url)));
  const now = new Date().toISOString();

  const additions = entries
    .filter((entry) => entry.url && !known.has(canonicalUrl(entry.url)))
    .map((entry) => ({ url: entry.url, title: entry.title, seenAt: now }));

  if (additions.length === 0) return;

  const merged = [...additions, ...existing].slice(0, MAX_ENTRIES);
  await fs.mkdir(path.dirname(SEEN_PATH), { recursive: true });
  await fs.writeFile(SEEN_PATH, `${JSON.stringify({ entries: merged }, null, 2)}\n`, "utf8");
}
