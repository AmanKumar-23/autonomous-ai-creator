import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { recordCycle } from "./cycles.ts";
import { discoverWithReport } from "./discover.ts";
import type { AgentState, CycleRecord, CycleStatus } from "../lib/types.ts";

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

  // Phase 3 judges these candidates and Phase 4 writes the post. Until then the
  // cycle stops here, having proved the loop runs unattended.
  await finish(
    "discovered",
    `Found ${report.candidates.length} candidate(s) worth judging, led by "${report.candidates[0].title}". Editorial judgment lands in the next phase.`,
    {
      domain,
      discovered,
      kept: report.candidates.length,
      dropped: report.dropped.length,
      failures: report.failures,
    },
  );
}

main().catch(async (error) => {
  // Last resort: log it and still exit 0, so a crash never turns into a red
  // schedule that masks whether the cron itself is alive.
  console.error("[cycle] unexpected failure:", error);
  process.exit(0);
});
