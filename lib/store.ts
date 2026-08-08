import { promises as fs } from "node:fs";
import path from "node:path";

import bundledPosts from "@/data/posts.json";
import bundledState from "@/data/state.json";
import { EMPTY_STATE, type AgentState, type Post, type Source } from "@/lib/types";

/**
 * All disk access for the read path goes through this file.
 *
 * Two layers of defence, because a 5xx on the feed is an eligibility failure:
 *   1. read the committed file from disk at runtime (freshest — the cron commits here)
 *   2. if that fails for any reason, fall back to the copy bundled at build time
 *   3. if that is also unusable, return empty — never throw
 */

const DATA_DIR = path.join(process.cwd(), "data");
export const POSTS_PATH = path.join(DATA_DIR, "posts.json");
export const STATE_PATH = path.join(DATA_DIR, "state.json");

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
  } catch {
    try {
      return newestFirst(toPosts(bundledPosts));
    } catch {
      return [];
    }
  }
}

/** Never throws. Returns the uninitialized state rather than failing the request. */
export async function readState(): Promise<AgentState> {
  try {
    return toState(await readJson(STATE_PATH));
  } catch {
    try {
      return toState(bundledState);
    } catch {
      return { ...EMPTY_STATE };
    }
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
