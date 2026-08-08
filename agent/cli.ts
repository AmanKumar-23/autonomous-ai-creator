import { discoverWithReport } from "./discover.ts";
import type { DropReason } from "../lib/types.ts";

/**
 * Standalone discovery run, for eyeballing quality:
 *
 *   npm run discover -- "AI Security"
 *   npm run discover -- "Robotics"
 *
 * Prints the ranked candidates and the full drop log with reasons.
 */

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function age(iso: string): string {
  const hours = (Date.now() - Date.parse(iso)) / 3600_000;
  if (Number.isNaN(hours)) return "unknown";
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

async function main() {
  const domain = process.argv.slice(2).join(" ").trim();
  if (!domain) {
    console.error('Usage: npm run discover -- "AI Security"');
    process.exit(1);
  }

  const report = await discoverWithReport(domain);

  console.log(`\n${BOLD}Domain${RESET}  ${report.domain}`);
  console.log(`${BOLD}Terms${RESET}   ${report.terms.join(" | ")}`);
  console.log(`${BOLD}Time${RESET}    ${report.queriedAt}\n`);

  if (report.failures.length > 0) {
    console.log(`${BOLD}Source failures${RESET}`);
    for (const failure of report.failures) {
      console.log(`  ${failure.source}: ${failure.error} (after ${failure.attempts} attempts)`);
    }
    console.log();
  }

  console.log(`${BOLD}Kept — ${report.candidates.length} candidates, best first${RESET}`);
  if (report.candidates.length === 0) {
    console.log(`  ${DIM}nothing cleared the pre-filter this run${RESET}`);
  }
  report.candidates.forEach((candidate, index) => {
    const signals =
      candidate.source === "hackernews"
        ? `${candidate.signals.points ?? 0} pts, ${candidate.signals.comments ?? 0} comments`
        : (candidate.signals.category ?? "arxiv");
    console.log(`\n  ${index + 1}. [${candidate.score?.toFixed(3)}] ${candidate.title}`);
    console.log(`     ${DIM}${candidate.source} · ${age(candidate.publishedAt)} · ${signals}${RESET}`);
    console.log(`     ${DIM}${candidate.url}${RESET}`);
  });

  const byReason = new Map<DropReason, number>();
  for (const drop of report.dropped) {
    byReason.set(drop.reason, (byReason.get(drop.reason) ?? 0) + 1);
  }

  console.log(`\n\n${BOLD}Dropped — ${report.dropped.length}${RESET}`);
  if (byReason.size > 0) {
    const summary = [...byReason.entries()].map(([reason, count]) => `${reason}: ${count}`).join("  ");
    console.log(`  ${DIM}${summary}${RESET}\n`);
  }
  for (const drop of report.dropped) {
    console.log(`  ${DIM}[${drop.reason}]${RESET} ${drop.candidate.title.slice(0, 70)}`);
    console.log(`     ${DIM}${drop.detail}${RESET}`);
  }
  console.log();
}

main().catch((error) => {
  // discoverWithReport does not throw, so this is belt and braces.
  console.error("discovery failed:", error);
  process.exit(1);
});
