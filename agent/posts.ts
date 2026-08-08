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

/** Titles of the most recent posts, for continuity and repetition checks. */
export async function recentTitles(limit = 10): Promise<string[]> {
  const posts = await readPosts();
  return posts
    .slice()
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit)
    .map((post) => post.title || post.text.slice(0, 80));
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
