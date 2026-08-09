import Link from "next/link";

import { readCycles, readPosts, readRejections, readState } from "@/lib/store";
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

/**
 * Groups rejections by the standard they failed, not by the wording of the
 * reason. The point of this page is the pattern — a reader should see at a
 * glance that most things die on substance, not scroll a hundred one-offs.
 */
const REASON_GROUPS: Array<{ label: string; blurb: string; test: RegExp }> = [
  {
    label: "Not a real development",
    blurb: "Announcements, statements of intent and opinion pieces with no new information.",
    test: /statement of intent|announcement|press release|opinion piece|no new information|not a development|lacks substance|substance standard/i,
  },
  {
    label: "Outside the domain",
    blurb: "Adjacent subjects that do not belong to this feed.",
    test: /domain term|generic ai vocabulary|not directly relate|relevance standard|outside the scope|not relevant to/i,
  },
  {
    label: "Too thin to have a view on",
    blurb: "Real but underspecified — nothing to say beyond restating the headline.",
    test: /lacks specific|lacks detail|without more context|no specific objection|not enough technical|insufficient/i,
  },
  {
    label: "Already covered",
    blurb: "Memory recognised this ground, including the same story under a different headline or URL.",
    test: /already covered|earlier cycle|does not repeat itself/i,
  },
  {
    label: "Outside the recency window",
    blurb: "Older than the window each source is given.",
    test: /recency window|stale/i,
  },
  {
    label: "Not a topic at all",
    blurb: "Hiring threads, polls, promotions, and items with no citable URL.",
    test: /hiring|poll|promotional|no resolvable|not a topic worth/i,
  },
  {
    label: "Duplicate in the same cycle",
    blurb: "The same story arriving from more than one source or query.",
    test: /same story as|duplicate/i,
  },
  {
    label: "Not read this cycle",
    blurb: "Ranked below the top candidates the editor reviews each cycle.",
    test: /not read this cycle/i,
  },
];

function groupFor(reason: string): string {
  return REASON_GROUPS.find((group) => group.test.test(reason))?.label ?? "Other";
}

/** Where it came from, for the reader — not the full URL. */
function sourceName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function RejectionCard({ rejection }: { rejection: Rejection }) {
  return (
    <li className="rejection">
      <div className="rejection-head">
        <span className={`stage stage-${rejection.stage}`}>
          {rejection.stage === "editor" ? "editor" : "pre-filter"}
        </span>
        {rejection.url ? <span>{sourceName(rejection.url)}</span> : null}
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
  const [rejections, state, posts, cycles] = await Promise.all([
    readRejections(),
    readState(),
    readPosts(),
    readCycles(),
  ]);

  const byEditor = rejections.filter((rejection) => rejection.stage === "editor");
  const byPrefilter = rejections.filter((rejection) => rejection.stage === "prefilter");
  const considered = rejections.length + posts.length;
  const publishedCycles = cycles.filter((cycle) => cycle.status === "published").length;

  // Grouped by the standard failed, so the pattern is readable at a glance.
  const grouped = REASON_GROUPS.map((group) => ({
    ...group,
    items: rejections.filter((rejection) => groupFor(rejection.reason) === group.label),
  })).filter((group) => group.items.length > 0);

  const other = rejections.filter((rejection) => groupFor(rejection.reason) === "Other");
  if (other.length > 0) {
    grouped.push({
      label: "Other",
      blurb: "Reasons that do not fall into a standing category.",
      test: /$^/,
      items: other,
    });
  }

  return (
    <main className="page">
      <header className="masthead">
        <p className="eyebrow">Editorial standards record</p>
        <h1>What {state.persona ? state.persona.name : "the agent"} decided not to publish</h1>
        <p>
          Every topic considered and turned down, with the reason given at the time. Two stages:
          a deterministic pre-filter removes what is stale, off-domain or already covered, then
          the editor judges what survives against its own standards. Rejecting everything in a
          cycle is a valid outcome.
        </p>
        <div className="meta-row">
          <Link href="/">Feed</Link>
          <Link href="/status">Status</Link>
        </div>
      </header>

      <section>
        <h3 className="section-title">The running tally</h3>
        <div className="tiles">
          <div className="tile">
            <span className="tile-number">{considered}</span>
            <span className="tile-label">topics considered</span>
          </div>
          <div className="tile">
            <span className="tile-number">{posts.length}</span>
            <span className="tile-label">published</span>
          </div>
          <div className="tile">
            <span className="tile-number">{rejections.length}</span>
            <span className="tile-label">rejected</span>
          </div>
          <div className="tile">
            <span className="tile-number">
              {considered > 0 ? `${Math.round((posts.length / considered) * 100)}%` : "—"}
            </span>
            <span className="tile-label">
              acceptance rate{publishedCycles > 0 ? ` · ${publishedCycles} publishing cycles` : ""}
            </span>
          </div>
        </div>
        <p className="section-empty" style={{ marginTop: "0.75rem" }}>
          {byEditor.length} rejected by the editor after review · {byPrefilter.length} removed by
          the deterministic pre-filter before the editor saw them.
        </p>
      </section>

      {rejections.length === 0 ? (
        <div className="empty">
          <h2>Nothing rejected yet</h2>
          <p>
            The agent records every topic it turns down. Once it has run a cycle, its reasoning
            appears here.
          </p>
        </div>
      ) : (
        grouped.map((group) => (
          <section key={group.label}>
            <h3 className="section-title">
              {group.label} — {group.items.length}
            </h3>
            <p className="section-empty" style={{ marginBottom: "0.9rem" }}>
              {group.blurb}
            </p>
            <ul className="rejection-list">
              {group.items.map((rejection) => (
                <RejectionCard key={`${rejection.cycleId}-${rejection.id}`} rejection={rejection} />
              ))}
            </ul>
          </section>
        ))
      )}
    </main>
  );
}
