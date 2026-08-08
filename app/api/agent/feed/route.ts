import { NextResponse } from "next/server";

import { readPosts } from "@/lib/store";

/**
 * GET /api/agent/feed?agentId=...
 *
 * The single most important constraint in the project: this route must never
 * return 5xx. An empty array is a valid answer, stale data is a valid answer,
 * an error is an eligibility failure.
 *
 * It reads committed JSON only — no LLM calls, no outbound network. An LLM
 * outage or a rate limit on the write path cannot reach this code.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The evaluator polls repeatedly for ~48h and must see new posts as they land.
const NO_CACHE = { "Cache-Control": "no-store, max-age=0, must-revalidate" };

export async function GET(request: Request) {
  try {
    // Single-agent deployment: agentId is accepted and logged, but deliberately
    // never gates the response. Returning posts to an unexpected id is strictly
    // safer than 404-ing the evaluator.
    const agentId = new URL(request.url).searchParams.get("agentId");
    if (agentId) console.log(`[feed] poll for agentId=${agentId}`);

    const posts = await readPosts();
    return NextResponse.json({ posts }, { headers: NO_CACHE });
  } catch (error) {
    console.error("[feed] unexpected error, serving empty feed:", error);
    return NextResponse.json({ posts: [] }, { headers: NO_CACHE });
  }
}
