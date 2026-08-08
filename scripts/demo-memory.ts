import { randomUUID } from "node:crypto";

import { recallSimilar, rememberPost } from "../agent/memory.ts";
import type { Candidate, Post } from "../lib/types.ts";

/**
 * Driver for demo-memory.sh. Two runs share a Breeth namespace: the first
 * publishes and remembers, the second offers the same story in different words
 * at a different URL and must be recognised as already covered.
 */

const groupId = process.argv[2];
const phase = process.argv[3];

const ORIGINAL: Candidate = {
  id: "hackernews:demo-1",
  title: "OpenAI ships agent SDK for building autonomous tool-using assistants",
  url: "https://example.com/openai-agent-sdk",
  source: "hackernews",
  publishedAt: new Date().toISOString(),
  snippet: "OpenAI released a software development kit for building agents that call tools.",
  signals: { points: 300, comments: 120 },
};

/** Same event, different words, different URL. URL dedup cannot see this. */
const REWORDED: Candidate = {
  id: "hackernews:demo-2",
  title: "New agent framework from OpenAI lets assistants call external tools",
  url: "https://different-site.example.org/openai-framework-launch",
  source: "hackernews",
  publishedAt: new Date().toISOString(),
  snippet: "The lab has put out a toolkit for autonomous assistants that invoke APIs.",
  signals: { points: 88, comments: 41 },
};

const UNRELATED: Candidate = {
  id: "hackernews:demo-3",
  title: "Humanoid robot achieves stable loco-manipulation on uneven terrain",
  url: "https://example.com/robot-locomotion",
  source: "hackernews",
  publishedAt: new Date().toISOString(),
  snippet: "A controller for walking while carrying objects.",
  signals: { points: 150, comments: 30 },
};

async function main() {
  if (phase === "first") {
    const post: Post = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      title: "OpenAI's agent SDK is a bid to own the tool-calling layer",
      text: "OpenAI shipped an SDK for building tool-using agents. The interesting part is not the code, it is the positioning.",
      rationale: "Chosen because it is a concrete release rather than an announcement of intent.",
      sources: [{ title: ORIGINAL.title, url: ORIGINAL.url }],
      stance: "contextualise",
    };

    console.log(`published: "${post.title}"`);
    console.log(`  source: ${ORIGINAL.url}`);
    const ok = await rememberPost(post, "Ada", groupId);
    console.log(`  remembered in Breeth: ${ok}`);
    return;
  }

  const candidates = [REWORDED, UNRELATED];
  const hits = await recallSimilar(candidates, { groupId });

  for (const candidate of candidates) {
    const hit = hits.get(candidate.id);
    const covered = hit?.covered ?? false;
    console.log(`\n"${candidate.title}"`);
    console.log(`  url: ${candidate.url}`);
    console.log(`  VERDICT: ${covered ? "ALREADY COVERED — rejected before the editor saw it" : "fresh — passed to the editorial gate"}`);
    if (hit && hit.facts.length > 0) {
      console.log(`  memory recalls: ${hit.facts.slice(0, 2).join(" | ")}`);
    }
  }

  const rewordedCovered = hits.get(REWORDED.id)?.covered ?? false;
  const unrelatedCovered = hits.get(UNRELATED.id)?.covered ?? false;

  console.log("\n--------------------------------------------------------------");
  console.log(`reworded duplicate caught : ${rewordedCovered ? "YES" : "NO"}  (want YES)`);
  console.log(`unrelated story suppressed: ${unrelatedCovered ? "YES" : "NO"}  (want NO)`);
  console.log(
    rewordedCovered && !unrelatedCovered
      ? "semantic dedup working: caught the rewrite, let the unrelated story through"
      : "NOT working as intended",
  );
}

main();
