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
const MAX_ENTRIES = 300;

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

/** Newest first, capped. */
export async function recordRejections(entries: RejectionRecord[]): Promise<void> {
  if (entries.length === 0) return;
  const existing = await readRejections();
  const merged = [...entries, ...existing].slice(0, MAX_ENTRIES);
  await fs.mkdir(path.dirname(REJECTIONS_PATH), { recursive: true });
  await fs.writeFile(REJECTIONS_PATH, `${JSON.stringify({ rejections: merged }, null, 2)}\n`, "utf8");
}
