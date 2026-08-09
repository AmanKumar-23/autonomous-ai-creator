import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { recordCycle } from "./cycles.ts";
import { discoverWithReport } from "./discover.ts";
import { canonicalUrl } from "./filter.ts";
import { judgeCandidates } from "./judge.ts";
import { groupFor, isMemoryConfigured, memoryFailures, recallSimilar, rememberPost } from "./memory.ts";
import { appendPost, readPosts, recentContext, recentTitles } from "./posts.ts";
import { recordRejections, type RejectionRecord } from "./rejections.ts";
import { markSeen } from "./seen.ts";
import { writePost } from "./write.ts";
import type { AgentState, CycleRecord, CycleStatus, Post } from "../lib/types.ts";

/**
 * One cycle of the agent loop. Run by GitHub Actions on a schedule; this is the
 * whole of the write path's entry point.
 *
 *   read state -> discover -> (judge -> write, Phase 3/4) -> record the cycle
 *
 * Two rules govern this file:
 *
 *   1. Never publish before init. If data/state.json has no initialized agent,
 *      the cycle exits cleanly having published nothing, and says why.
 *   2. Never exit non-zero for an ordinary failure. A red workflow run every two
 *      hours is noise that hides a real problem, and the feed is unaffected
 *      either way — it serves whatever is already committed.
 */

const STATE_PATH = path.join(process.cwd(), "data", "state.json");

async function readState(): Promise<AgentState | null> {
  try {
    return JSON.parse(await fs.readFile(STATE_PATH, "utf8")) as AgentState;
  } catch (error) {
    console.error("[cycle] could not read state:", error);
    return null;
  }
}

async function main() {
  const startedAt = new Date().toISOString();
  const id = randomUUID();

  const finish = async (
    status: CycleStatus,
    reason: string,
    extra: Partial<CycleRecord> = {},
  ) => {
    const record: CycleRecord = {
      id,
      startedAt,
      finishedAt: new Date().toISOString(),
      status,
      reason,
      domain: null,
      discovered: 0,
      kept: 0,
      dropped: 0,
      failures: [],
      ...extra,
    };
    await recordCycle(record).catch((error) =>
      console.error("[cycle] could not write cycle log:", error),
    );
    console.log(`[cycle] ${status}: ${reason}`);
  };

  const state = await readState();

  // Rule 1: nothing happens until the evaluator initializes the agent.
  if (!state?.initialized || !state.agentId || !state.persona) {
    await finish(
      "not-initialized",
      "No initialized agent in data/state.json, so nothing was published. The agent waits for POST /api/agent/init.",
    );
    return;
  }

  const { name, domain } = state.persona;
  console.log(`[cycle] running as ${name} on ${domain}`);

  const report = await discoverWithReport(domain);
  const discovered = report.candidates.length + report.dropped.length;

  if (report.candidates.length === 0) {
    await finish(
      "no-candidates",
      report.failures.length > 0
        ? `Discovery found nothing publishable; ${report.failures.length} source(s) failed.`
        : "Discovery found nothing that cleared the pre-filter. An empty cycle is a valid outcome.",
      {
        domain,
        discovered,
        kept: 0,
        dropped: report.dropped.length,
        failures: report.failures,
      },
    );
    return;
  }

  // Requirement 4: what it has already published shapes what it does next.
  // Compact titles rather than full bodies, to keep the cycle inside its budget.
  const memory = await recentTitles(10).catch(() => [] as string[]);
  // The writer needs the shape of what it already wrote, not just the subjects.
  const voiceMemory = await recentContext(6).catch(() => []);

  // Requirement 4: semantic recall runs BEFORE the editorial gate, so the editor
  // never spends a decision on ground the agent has already covered.
  const groupId = groupFor(state.agentId);
  const priorPosts = await readPosts().catch(() => []);
  const recalled = await recallSimilar(report.candidates, { groupId, priorPosts });

  const alreadyCovered = report.candidates.filter((c) => recalled.get(c.id)?.covered);
  const freshCandidates = report.candidates.filter((c) => !recalled.get(c.id)?.covered);

  // Anything still worth judging carries its prior context, so the editor can
  // weigh "this extends what we said" against "this repeats it".
  const priorContext = freshCandidates.flatMap((c) => {
    const hit = recalled.get(c.id);
    return hit && hit.facts.length > 0 ? [{ id: c.id, facts: hit.facts }] : [];
  });

  const verdict = await judgeCandidates(state.persona, freshCandidates, memory, priorContext);
  const now = new Date().toISOString();

  // Memory rejections join the same log as the editor's, with the earlier post.
  const memoryRejections: RejectionRecord[] = alreadyCovered.map((c) => {
    const hit = recalled.get(c.id);
    const reference = hit?.relatedPostId ? ` (see post ${hit.relatedPostId})` : "";
    return {
      id: c.id,
      title: c.title,
      url: c.url,
      reason: `already covered${reference}: memory recalls "${hit?.facts[0] ?? ""}"`,
      stage: "editor" as const,
      rejectedAt: now,
      cycleId: id,
    };
  });

  // Log what the deterministic filter dropped alongside what the editor turned
  // down: together they are the full record of what was considered.
  //
  // Hacker News is queried with several terms, so the same story arrives more than
  // once and is dropped once per copy. Collapsing to one entry per canonical URL
  // keeps the log a record of decisions rather than of retries. Anything that
  // reached the editor is excluded outright — a story cannot honestly appear as
  // filtered out when it was in fact judged, or published.
  const judged = new Set(
    [verdict.selected, ...verdict.rejections, ...alreadyCovered]
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .map((entry) => canonicalUrl(entry.url)),
  );
  const loggedPrefilter = new Set<string>();

  const prefilterLog: RejectionRecord[] = report.dropped.flatMap((drop) => {
    const key = canonicalUrl(drop.candidate.url);
    if (judged.has(key) || loggedPrefilter.has(key)) return [];
    loggedPrefilter.add(key);
    return [
      {
        id: drop.candidate.id,
        title: drop.candidate.title,
        url: drop.candidate.url,
        reason: drop.detail,
        stage: "prefilter" as const,
        rejectedAt: now,
        cycleId: id,
      },
    ];
  });

  const rejectionLog: RejectionRecord[] = [
    ...memoryRejections,
    ...verdict.rejections.map((rejection) => ({
      ...rejection,
      stage: "editor" as const,
      rejectedAt: now,
      cycleId: id,
    })),
    ...prefilterLog,
  ];
  await recordRejections(rejectionLog).catch((error) =>
    console.error("[cycle] could not write rejection log:", error),
  );

  const common = {
    domain,
    discovered,
    kept: report.candidates.length,
    dropped: report.dropped.length + alreadyCovered.length,
    failures: report.failures,
    ...(verdict.provider ? { provider: verdict.provider } : {}),
    // Recorded per cycle so /status can show when memory was unavailable.
    memory: { available: isMemoryConfigured() && memoryFailures.length === 0, failures: memoryFailures.length },
  };

  if (verdict.error) {
    await finish("failed", `Editorial judgment could not run (${verdict.error}). Nothing was published.`, common);
    return;
  }

  if (!verdict.selected) {
    await finish(
      "no-candidates",
      `The editor reviewed ${report.candidates.length} candidate(s) and rejected all of them. Publishing nothing is preferable to publishing filler.`,
      common,
    );
    return;
  }

    const selectedMemory = recalled.get(verdict.selected.id)?.facts ?? [];
  const written = await writePost(
    state.persona,
    verdict.selected,
    verdict.rationale,
    voiceMemory,
    selectedMemory,
  );

  if (written.error) {
    await finish(
      "failed",
      `Selected "${verdict.selected.title}" but the post could not be written (${written.error}). Nothing was published.`,
      common,
    );
    return;
  }

  const post: Post = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    title: written.title,
    text: written.text,
    // Produced during judgment, when the alternatives were visible.
    rationale: verdict.rationale,
    sources: [{ title: verdict.selected.title, url: verdict.selected.url }],
    ...(written.provider ? { provider: written.provider } : {}),
    ...(written.stance ? { stance: written.stance } : {}),
  };

  await appendPost(post);

  // Everything judged this cycle is now spent: the published story must never
  // return, and re-judging the same rejects every two hours would burn tokens
  // and fill the rejection log with duplicates.
  await rememberPost(post, state.persona.name, groupId).catch((error) =>
    console.error("[cycle] could not write to memory:", error),
  );

  await markSeen([
    { url: verdict.selected.url, title: verdict.selected.title },
    ...verdict.rejections.map((rejection) => ({ url: rejection.url, title: rejection.title })),
  ]).catch((error) => console.error("[cycle] could not update seen memory:", error));

  await finish(
    "published",
    `Published "${written.title}" and rejected ${verdict.rejections.length} other candidate(s).`,
    { ...common, ...(written.provider ? { provider: written.provider } : {}) },
  );
}

main().catch(async (error) => {
  // Last resort: log it and still exit 0, so a crash never turns into a red
  // schedule that masks whether the cron itself is alive.
  console.error("[cycle] unexpected failure:", error);
  process.exit(0);
});
