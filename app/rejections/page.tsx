import Link from "next/link";

import { readRejections, readState } from "@/lib/store";
import type { Rejection } from "@/lib/types";

/**
 * The public rejection log.
 *
 * Requirement 2 asks the agent to intentionally reject topics that fail its
 * standards. Publishing the reasons is the only way that claim is checkable —
 * a feed alone shows what was chosen, never what was turned down or why.
 */

export const dynamic = "force-dynamic";

function formatUtc(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(parsed);
}

function RejectionCard({ rejection }: { rejection: Rejection }) {
  return (
    <li className="rejection">
      <div className="rejection-head">
        <span className={`stage stage-${rejection.stage}`}>
          {rejection.stage === "editor" ? "editor" : "pre-filter"}
        </span>
        {rejection.rejectedAt ? (
          <time dateTime={rejection.rejectedAt}>{formatUtc(rejection.rejectedAt)} UTC</time>
        ) : null}
      </div>

      <h2>
        {rejection.url ? (
          <a href={rejection.url} target="_blank" rel="noopener noreferrer">
            {rejection.title}
          </a>
        ) : (
          rejection.title
        )}
      </h2>

      <p className="reason">{rejection.reason}</p>
    </li>
  );
}

export default async function RejectionsPage() {
  const [rejections, state] = await Promise.all([readRejections(), readState()]);

  const byEditor = rejections.filter((rejection) => rejection.stage === "editor");
  const byPrefilter = rejections.filter((rejection) => rejection.stage === "prefilter");

  return (
    <main className="page">
      <header className="masthead">
        <p className="eyebrow">Rejection log</p>
        <h1>What {state.persona ? state.persona.name : "the agent"} decided not to publish</h1>
        <p>
          Every topic considered and turned down, with the reason. Two stages: a deterministic
          pre-filter removes what is stale, off-domain or already covered, then the editor judges
          what survives against its own standards.
        </p>
        <div className="meta-row">
          <span>{byEditor.length} rejected by the editor</span>
          <span>{byPrefilter.length} filtered out</span>
          <Link href="/">Back to the feed</Link>
        </div>
      </header>

      {rejections.length === 0 ? (
        <div className="empty">
          <h2>Nothing rejected yet</h2>
          <p>
            The agent records every topic it turns down. Once it has run a cycle, its reasoning
            appears here.
          </p>
        </div>
      ) : (
        <>
          <section>
            <h3 className="section-title">Rejected by the editor</h3>
            {byEditor.length === 0 ? (
              <p className="section-empty">No editorial rejections recorded yet.</p>
            ) : (
              <ul className="rejection-list">
                {byEditor.map((rejection) => (
                  <RejectionCard key={`${rejection.cycleId}-${rejection.id}`} rejection={rejection} />
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="section-title">Removed by the pre-filter</h3>
            {byPrefilter.length === 0 ? (
              <p className="section-empty">No pre-filter rejections recorded yet.</p>
            ) : (
              <ul className="rejection-list">
                {byPrefilter.map((rejection) => (
                  <RejectionCard key={`${rejection.cycleId}-${rejection.id}`} rejection={rejection} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}
