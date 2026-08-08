import { promises as fs } from "node:fs";
import path from "node:path";

import type { Post } from "../lib/types.ts";

/**
 * data/posts.json — the published feed, written here and read by the API route.
 *
 * The write path owns this file; the read path only ever reads it. Posts are
 * append-only: the brief requires that anything previously returned by the feed
 * stays available forever, so nothing here removes or rewrites an entry.
 */

const POSTS_PATH = path.join(process.cwd(), "data", "posts.json");

/** Never throws. A corrupt file reads as empty rather than losing the append. */
export async function readPosts(): Promise<Post[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(POSTS_PATH, "utf8")) as { posts?: unknown };
    return Array.isArray(parsed.posts) ? (parsed.posts as Post[]) : [];
  } catch {
    return [];
  }
}

function newestFirst(posts: Post[]): Post[] {
  return posts.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** Titles of the most recent posts. Used by the judge to avoid re-covering a story. */
export async function recentTitles(limit = 10): Promise<string[]> {
  return newestFirst(await readPosts())
    .slice(0, limit)
    .map((post) => post.title || post.text.slice(0, 80));
}

/**
 * What the agent has recently said and how it said it. This is the persona's
 * accumulated state: the stances it has taken and the openings it has used.
 * Titles alone cannot stop it reaching for the same rhetorical move every time,
 * because the repetition lives in structure rather than subject.
 */
export interface RecentPost {
  title: string;
  stance: string;
  /** First few words, so it can avoid opening the same way twice. */
  opening: string;
}

export async function recentContext(limit = 6): Promise<RecentPost[]> {
  return newestFirst(await readPosts())
    .slice(0, limit)
    .map((post) => ({
      title: post.title || post.text.slice(0, 60),
      stance: post.stance ?? "unrecorded",
      opening: post.text.trim().split(/\s+/).slice(0, 8).join(" "),
    }));
}

/**
 * Appends one post. Newest first on disk, though the API sorts defensively
 * anyway rather than trusting file order.
 */
export async function appendPost(post: Post): Promise<void> {
  const existing = await readPosts();

  // Guard against a retried cycle double-publishing the same story.
  if (existing.some((entry) => entry.id === post.id)) return;

  const merged = [post, ...existing].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
  await fs.mkdir(path.dirname(POSTS_PATH), { recursive: true });
  await fs.writeFile(POSTS_PATH, `${JSON.stringify({ posts: merged }, null, 2)}\n`, "utf8");
}
