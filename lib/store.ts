import { promises as fs } from "node:fs";
import path from "node:path";

import { EMPTY_STATE, type AgentState, type Post, type Rejection, type Source } from "@/lib/types";

/**
 * All disk access for the read path goes through this file.
 *
 * Everything is read lazily inside a try/catch. There is deliberately NO
 * top-level `import ... from "@/data/posts.json"` fallback: a static import is
 * evaluated when the module loads, so a corrupt or missing data file would throw
 * before any handler code runs and produce a 5xx that no try/catch can intercept.
 * Since the cron rewrites posts.json on every cycle, one truncated commit would
 * otherwise take the feed down. Reading at call time keeps every failure catchable.
 */

const DATA_DIR = path.join(process.cwd(), "data");
export const POSTS_PATH = path.join(DATA_DIR, "posts.json");
export const STATE_PATH = path.join(DATA_DIR, "state.json");
export const REJECTIONS_PATH = path.join(DATA_DIR, "rejections.json");

async function readJson(filePath: string): Promise<unknown> {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function toSources(value: unknown): Source[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): Source[] => {
    if (entry && typeof entry === "object") {
      const { title, url } = entry as Record<string, unknown>;
      if (isNonEmptyString(url)) {
        return [{ title: isNonEmptyString(title) ? title : url, url }];
      }
    }
    // Tolerate a bare URL string so a hand-edited data file still renders.
    if (isNonEmptyString(entry)) return [{ title: entry, url: entry }];
    return [];
  });
}

/**
 * Keeps only entries that satisfy the required contract. A single malformed post
 * written by a future agent cycle must not take the whole feed down.
 */
function toPosts(value: unknown): Post[] {
  const list = Array.isArray(value)
    ? value
    : Array.isArray((value as { posts?: unknown })?.posts)
      ? (value as { posts: unknown[] }).posts
      : [];

  return list.flatMap((entry): Post[] => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (!isNonEmptyString(record.id)) return [];
    if (!isNonEmptyString(record.createdAt)) return [];
    if (!isNonEmptyString(record.text)) return [];

    const post: Post = {
      id: record.id,
      createdAt: record.createdAt,
      text: record.text,
      rationale: isNonEmptyString(record.rationale) ? record.rationale : "",
      sources: toSources(record.sources),
    };
    if (isNonEmptyString(record.title)) post.title = record.title;
    if (isNonEmptyString(record.provider)) post.provider = record.provider;
    return [post];
  });
}

function toState(value: unknown): AgentState {
  if (!value || typeof value !== "object") return { ...EMPTY_STATE };
  const record = value as Record<string, unknown>;
  const persona = record.persona as Record<string, unknown> | null | undefined;

  return {
    initialized: record.initialized === true,
    agentId: isNonEmptyString(record.agentId) ? record.agentId : null,
    persona:
      persona && isNonEmptyString(persona.name) && isNonEmptyString(persona.domain)
        ? { name: persona.name, domain: persona.domain }
        : null,
    initializedAt: isNonEmptyString(record.initializedAt) ? record.initializedAt : null,
  };
}

/** Newest first. Unparseable dates sort last rather than throwing. */
function newestFirst(posts: Post[]): Post[] {
  const timestamp = (post: Post): number => {
    const parsed = Date.parse(post.createdAt);
    return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
  };
  return [...posts].sort((a, b) => timestamp(b) - timestamp(a));
}

/** Never throws. Returns [] rather than failing the request. */
export async function readPosts(): Promise<Post[]> {
  try {
    return newestFirst(toPosts(await readJson(POSTS_PATH)));
  } catch (error) {
    console.error("[store] could not read posts, serving empty feed:", error);
    return [];
  }
}

/** Never throws. Returns the uninitialized state rather than failing the request. */
export async function readState(): Promise<AgentState> {
  try {
    return toState(await readJson(STATE_PATH));
  } catch (error) {
    console.error("[store] could not read state, treating as uninitialized:", error);
    return { ...EMPTY_STATE };
  }
}

/**
 * The public rejection log. Requirement 2 asks the agent to intentionally reject
 * topics that fail its standards; a rejection nobody can read is indistinguishable
 * from one that never happened. Never throws.
 */
export async function readRejections(): Promise<Rejection[]> {
  try {
    const parsed = (await readJson(REJECTIONS_PATH)) as { rejections?: unknown };
    if (!Array.isArray(parsed.rejections)) return [];

    return parsed.rejections
      .flatMap((entry): Rejection[] => {
        if (!entry || typeof entry !== "object") return [];
        const record = entry as Record<string, unknown>;
        if (!isNonEmptyString(record.title) || !isNonEmptyString(record.reason)) return [];
        return [
          {
            id: isNonEmptyString(record.id) ? record.id : record.title,
            title: record.title,
            url: isNonEmptyString(record.url) ? record.url : "",
            reason: record.reason,
            stage: record.stage === "editor" ? "editor" : "prefilter",
            rejectedAt: isNonEmptyString(record.rejectedAt) ? record.rejectedAt : "",
            cycleId: isNonEmptyString(record.cycleId) ? record.cycleId : "",
          },
        ];
      })
      .sort((a, b) => {
        const delta = Date.parse(b.rejectedAt) - Date.parse(a.rejectedAt);
        return Number.isNaN(delta) ? 0 : delta;
      });
  } catch (error) {
    console.error("[store] could not read rejections:", error);
    return [];
  }
}

/**
 * Throws if the filesystem is read-only — which is the case on Vercel, where only
 * /tmp is writable and it does not survive between invocations. Callers must treat
 * a failure here as non-fatal and still return a valid response.
 */
export async function writeState(state: AgentState): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
