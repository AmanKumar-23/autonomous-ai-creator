import { readPosts, readState } from "@/lib/store";
import type { Post } from "@/lib/types";

/**
 * The feed viewer. Reads the committed data directly rather than calling its own
 * API, so the page has no network dependency and cannot fail on a cold start.
 */

export const dynamic = "force-dynamic";

function formatUtc(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(parsed);
}

function PostCard({ post }: { post: Post }) {
  return (
    <article className="post">
      <p className="post-time">
        <time dateTime={post.createdAt}>{formatUtc(post.createdAt)} UTC</time>
      </p>

      {post.title ? <h2>{post.title}</h2> : null}

      <div className="post-text">
        {post.text.split(/\n{2,}/).map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))}
      </div>

      {post.rationale ? (
        <div className="rationale">
          <h3>Why this, why now</h3>
          <p>{post.rationale}</p>
        </div>
      ) : null}

      {post.sources.length > 0 ? (
        <div className="sources">
          <h3>Sources</h3>
          <ol>
            {post.sources.map((source, index) => (
              <li key={`${source.url}-${index}`}>
                <a href={source.url} target="_blank" rel="noopener noreferrer">
                  {source.title}
                </a>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </article>
  );
}

function EmptyState({ initialized }: { initialized: boolean }) {
  return (
    <div className="empty">
      <h2>{initialized ? "No posts published yet" : "Awaiting initialization"}</h2>
      <p>
        {initialized
          ? "The agent is running. It reviews live sources on a schedule and publishes only when a topic clears its editorial bar, so an empty feed means nothing has earned a post yet."
          : "This agent publishes nothing until it is initialized. Send a persona to POST /api/agent/init to start it."}
      </p>
    </div>
  );
}

export default async function HomePage() {
  const [posts, state] = await Promise.all([readPosts(), readState()]);
  const persona = state.persona;

  return (
    <main className="page">
      <header className="masthead">
        <p className="eyebrow">Autonomous AI Creator</p>
        <h1>
          {persona ? persona.name : "Uninitialized agent"}
          {persona ? (
            <>
              {" on "}
              <span className="domain">{persona.domain}</span>
            </>
          ) : null}
        </h1>
        <p>
          Discovers topics from live sources, rejects what does not meet its standards, and
          publishes on its own schedule.
        </p>
        <div className="meta-row">
          <span>{posts.length === 1 ? "1 post" : `${posts.length} posts`}</span>
          <span>Status: {state.initialized ? "running" : "awaiting init"}</span>
          {state.initializedAt ? <span>Since {formatUtc(state.initializedAt)} UTC</span> : null}
        </div>
      </header>

      {posts.length > 0 ? (
        <div className="feed">
          {posts.map((post) => (
            <PostCard key={post.id} post={post} />
          ))}
        </div>
      ) : (
        <EmptyState initialized={state.initialized} />
      )}

      <footer className="footer">
        Feed API: <code>GET /api/agent/feed?agentId=…</code>
      </footer>
    </main>
  );
}
