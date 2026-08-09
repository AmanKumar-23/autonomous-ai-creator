import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * data/rejections.json — every topic the agent considered and turned down,
 * with the reason it gave.
 *
 * Requirement 2 asks the agent to intentionally reject topics that fail its
 * standards. A rejection that nobody can see is indistinguishable from one that
 * never happened, so this file is written on every cycle and served publicly.
 */

const REJECTIONS_PATH = path.join(process.cwd(), "data", "rejections.json");

/**
 * Capped per stage rather than overall. A cycle produces a handful of editorial
 * rejections and up to forty deterministic ones, so a single shared cap would
 * let pre-filter noise evict the editor's reasoning within a few hours — and the
 * editor's reasoning is the entire point of the log.
 */
const MAX_EDITOR_ENTRIES = 200;
const MAX_PREFILTER_ENTRIES = 200;

export interface RejectionRecord {
  id: string;
  title: string;
  url: string;
  reason: string;
  /** "editor" when the LLM judged it, "prefilter" when a deterministic rule did. */
  stage: "editor" | "prefilter";
  /** ISO 8601 UTC. */
  rejectedAt: string;
  cycleId: string;
}

/** Never throws. */
export async function readRejections(): Promise<RejectionRecord[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(REJECTIONS_PATH, "utf8")) as { rejections?: unknown };
    return Array.isArray(parsed.rejections) ? (parsed.rejections as RejectionRecord[]) : [];
  } catch {
    return [];
  }
}

/**
 * Newest first, capped independently per stage, and deduplicated by URL.
 *
 * The dedup matters for unattended running: rejections are recorded before the
 * writer runs, so a cycle that keeps failing to write would re-log the same
 * candidates every two hours and slowly fill the log — and the grouped counts
 * on /rejections — with the same items. Keeping the newest entry per URL bounds
 * that permanently.
 */
export async function recordRejections(entries: RejectionRecord[]): Promise<void> {
  if (entries.length === 0) return;
  const existing = await readRejections();

  const seen = new Set<string>();
  const all = [...entries, ...existing].filter((entry) => {
    const key = `${entry.stage}:${(entry.url || entry.title).toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const keep = (stage: RejectionRecord["stage"], limit: number) =>
    all.filter((entry) => entry.stage === stage).slice(0, limit);

  const merged = [...keep("editor", MAX_EDITOR_ENTRIES), ...keep("prefilter", MAX_PREFILTER_ENTRIES)].sort(
    (a, b) => Date.parse(b.rejectedAt) - Date.parse(a.rejectedAt),
  );
  await fs.mkdir(path.dirname(REJECTIONS_PATH), { recursive: true });
  await fs.writeFile(REJECTIONS_PATH, `${JSON.stringify({ rejections: merged }, null, 2)}\n`, "utf8");
}
