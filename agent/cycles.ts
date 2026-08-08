import { promises as fs } from "node:fs";
import path from "node:path";

import type { CycleRecord } from "../lib/types.ts";

/**
 * data/cycles.json — the operational log the cron appends to on every run.
 *
 * This is what proves the agent is running on its own: a judge can see cycles
 * arriving on a schedule, including the ones that decided not to publish. It is
 * also the data source for the /status page.
 */

const CYCLES_PATH = path.join(process.cwd(), "data", "cycles.json");
const MAX_RECORDS = 200;

/** Never throws. A missing or corrupt log reads as empty. */
export async function readCycles(): Promise<CycleRecord[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(CYCLES_PATH, "utf8")) as { cycles?: unknown };
    return Array.isArray(parsed.cycles) ? (parsed.cycles as CycleRecord[]) : [];
  } catch {
    return [];
  }
}

/** Newest first, capped so the file cannot grow without bound. */
export async function recordCycle(record: CycleRecord): Promise<void> {
  const existing = await readCycles();
  const merged = [record, ...existing].slice(0, MAX_RECORDS);
  await fs.mkdir(path.dirname(CYCLES_PATH), { recursive: true });
  await fs.writeFile(CYCLES_PATH, `${JSON.stringify({ cycles: merged }, null, 2)}\n`, "utf8");
}
