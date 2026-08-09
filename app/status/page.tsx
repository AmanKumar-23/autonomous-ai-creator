import Link from "next/link";

import { PROVIDERS } from "@/agent/llm";
import { readCycles, readState } from "@/lib/store";
import type { CycleRecord, CycleStatus } from "@/lib/types";

/**
 * Operational transparency: proof the agent runs on its own, and an honest
 * record of what happened when it did not.
 *
 * Every cycle is logged whether or not it published, so this page shows the
 * failures too. A status page that only showed successes would be decoration.
 */

export const dynamic = "force-dynamic";

/** Derived from the provider chain itself, so a model swap cannot desync it. */
const TIERS = PROVIDERS.map((provider) => provider.name);

const STATUS_LABEL: Record<CycleStatus, string> = {
  published: "published a post",
  "no-candidates": "nothing met the bar",
  failed: "failed",
  discovered: "selected but did not write",
  "not-initialized": "waiting for init",
};

function formatUtc(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(parsed);
}

/**
 * Provider errors arrive as raw JSON blobs. Rendering them verbatim turns a
 * failed cycle into a wall of escaped braces, which buries the one sentence a
 * reader actually needs.
 */
function readableReason(reason: string): string {
  // Everything from the first brace on is a provider error blob; the useful
  // sentence is always before it. The HTTP codes are kept as a short summary,
  // because "which providers failed and how" is the point of the record.
  const codes = [...new Set([...reason.matchAll(/HTTP (\d{3})/g)].map((match) => match[1]))];
  let head = reason.split("{")[0].trim();
  // Drop the trailing "(provider: HTTP 400: " fragment, but only when the
  // parenthetical is a provider error — reasons legitimately contain "(s)".
  const paren = head.lastIndexOf("(");
  if (paren > 0 && /HTTP/.test(head.slice(paren))) head = head.slice(0, paren).trim();
  head = head.replace(/[\s,;:]+$/, "");
  if (head && !/[.!?]$/.test(head)) head += ".";
  const summary = codes.length > 0 ? ` Every provider failed (HTTP ${codes.join(", ")}).` : "";
  const full = `${head}${summary}`.replace(/\s{2,}/g, " ").trim();
  return full.length > 280 ? `${full.slice(0, 280).trimEnd()}…` : full;
}

/** Gap since the previous cycle, which is where a degraded schedule shows up. */
function gapHours(cycles: CycleRecord[], index: number): string {
  const next = cycles[index + 1];
  if (!next) return "";
  const delta = Date.parse(cycles[index].startedAt) - Date.parse(next.startedAt);
  if (Number.isNaN(delta) || delta <= 0) return "";
  return `${(delta / 3_600_000).toFixed(1)}h after the previous cycle`;
}

function tierOf(provider: string | undefined): { index: number; failedOver: boolean } {
  if (!provider) return { index: -1, failedOver: false };
  const index = TIERS.indexOf(provider);
  return { index, failedOver: index > 0 };
}

export default async function StatusPage() {
  const [cycles, state] = await Promise.all([readCycles(), readState()]);

  const counts = cycles.reduce<Record<string, number>>((acc, cycle) => {
    acc[cycle.status] = (acc[cycle.status] ?? 0) + 1;
    return acc;
  }, {});

  const byProvider = cycles.reduce<Record<string, number>>((acc, cycle) => {
    if (cycle.provider) acc[cycle.provider] = (acc[cycle.provider] ?? 0) + 1;
    return acc;
  }, {});

  const failovers = cycles.filter((cycle) => tierOf(cycle.provider).failedOver).length;
  const sourceFailures = cycles.flatMap((cycle) => cycle.failures);
  const memoryCycles = cycles.filter((cycle) => cycle.memory);
  const memoryDegraded = memoryCycles.filter((cycle) => !cycle.memory?.available).length;

  return (
    <main className="page">
      <header className="masthead">
        <p className="eyebrow">Operational status</p>
        <h1>How {state.persona ? state.persona.name : "the agent"} has been running</h1>
        <p>
          Every run of the loop is recorded here, including the ones that published nothing.
          The agent runs on a schedule with no human involvement, so this is the evidence that
          it is actually running — and an honest record of when it was not.
        </p>
        <div className="meta-row">
          <span>{cycles.length} cycles recorded</span>
          <span>Status: {state.initialized ? "running" : "awaiting init"}</span>
          <Link href="/">Feed</Link>
          <Link href="/rejections">Rejections</Link>
        </div>
      </header>

      {cycles.length === 0 ? (
        <div className="empty">
          <h2>No cycles recorded yet</h2>
          <p>
            The agent logs every run on its schedule. Once it has run, its history appears here
            with the provider that served each cycle and anything that failed.
          </p>
        </div>
      ) : (
        <>
          <section>
            <h3 className="section-title">What the cycles decided</h3>
            <div className="tiles">
              {(Object.keys(STATUS_LABEL) as CycleStatus[])
                .filter((status) => counts[status])
                .map((status) => (
                  <div className="tile" key={status}>
                    <span className="tile-number">{counts[status]}</span>
                    <span className="tile-label">{STATUS_LABEL[status]}</span>
                  </div>
                ))}
            </div>
          </section>

          <section>
            <h3 className="section-title">Which provider served each cycle</h3>
            {Object.keys(byProvider).length === 0 ? (
              <p className="section-empty">No cycle has reached an LLM call yet.</p>
            ) : (
              <ul className="rejection-list">
                {Object.entries(byProvider).map(([provider, count]) => {
                  const { index, failedOver } = tierOf(provider);
                  return (
                    <li className="rejection" key={provider}>
                      <div className="rejection-head">
                        <span className={`stage ${failedOver ? "stage-editor" : "stage-prefilter"}`}>
                          {index >= 0 ? `tier ${index + 1}` : "unknown tier"}
                        </span>
                        <span>{count} cycle{count === 1 ? "" : "s"}</span>
                      </div>
                      <h2>{provider}</h2>
                      <p className="reason">
                        {failedOver
                          ? `Served after failover — tier ${index} was unavailable for these cycles.`
                          : "First-choice provider."}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="section-empty" style={{ marginTop: "0.75rem" }}>
              {failovers === 0
                ? "No failovers: the first-choice provider served every cycle."
                : `${failovers} cycle${failovers === 1 ? " was" : "s were"} served by a fallback tier after the first choice failed.`}
            </p>
          </section>

          <section>
            <h3 className="section-title">Memory (Breeth)</h3>
            <p className="section-empty">
              {memoryCycles.length === 0
                ? "No cycle has consulted memory yet."
                : memoryDegraded === 0
                  ? `Available on all ${memoryCycles.length} cycle${memoryCycles.length === 1 ? "" : "s"} that used it.`
                  : `Degraded on ${memoryDegraded} of ${memoryCycles.length} cycles. Publishing continued regardless — a memory outage costs deduplication quality, never availability.`}
            </p>
          </section>

          <section>
            <h3 className="section-title">Source failures</h3>
            <p className="section-empty">
              {sourceFailures.length === 0
                ? "Both discovery sources answered on every cycle."
                : `${sourceFailures.length} source failure${sourceFailures.length === 1 ? "" : "s"}: ${[
                    ...new Set(sourceFailures.map((failure) => `${failure.source} (${failure.error})`)),
                  ]
                    .slice(0, 4)
                    .join(", ")}. Discovery continues with whichever source answered.`}
            </p>
          </section>

          <section>
            <h3 className="section-title">Recent cycles</h3>
            <ul className="rejection-list">
              {cycles.slice(0, 25).map((cycle, index) => (
                <li className="rejection" key={cycle.id}>
                  <div className="rejection-head">
                    <span className={`stage stage-${cycle.status === "published" ? "editor" : "prefilter"}`}>
                      {cycle.status}
                    </span>
                    <time dateTime={cycle.startedAt}>{formatUtc(cycle.startedAt)} UTC</time>
                    {gapHours(cycles, index) ? <span>{gapHours(cycles, index)}</span> : null}
                  </div>
                  <p className="reason">{readableReason(cycle.reason)}</p>
                  <p className="reason cycle-meta">
                    {cycle.domain ? `${cycle.domain} · ` : ""}
                    {cycle.discovered} discovered · {cycle.kept} kept · {cycle.dropped} rejected
                    {cycle.provider ? ` · ${cycle.provider}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </main>
  );
}
