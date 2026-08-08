import { EMPTY_STATE, type AgentState } from "@/lib/types";

/**
 * Durable state for the deployed app.
 *
 * Why this exists: POST /api/agent/init runs on Vercel, where the filesystem is
 * read-only apart from /tmp and /tmp does not survive between invocations. A
 * local write is therefore invisible to the GitHub Actions cron, which would see
 * initialized:false and refuse to publish for the whole evaluation window.
 *
 * So init reads and writes data/state.json through the GitHub Contents API —
 * the exact file the cron checks out. Reading remotely also keeps init idempotent
 * during the ~1 minute between the commit and Vercel finishing its redeploy,
 * when the bundled copy on disk is still stale.
 *
 * Every function here fails soft. A missing token, a rate limit or a GitHub
 * outage must degrade init, never break it.
 */

const API = "https://api.github.com";
const STATE_PATH = "data/state.json";
const TIMEOUT_MS = 8000;

function repo(): string {
  return process.env.GITHUB_REPO || "AmanKumar-23/autonomous-ai-creator";
}

function branch(): string {
  return process.env.GITHUB_BRANCH || "main";
}

function token(): string | null {
  const value = process.env.GITHUB_TOKEN?.trim();
  return value ? value : null;
}

/** False when no token is configured — local dev falls back to the disk write. */
export function isRemoteConfigured(): boolean {
  return token() !== null;
}

function headers(auth: string) {
  return {
    Authorization: `Bearer ${auth}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "autonomous-ai-creator",
  };
}

/**
 * Current committed state plus the blob sha needed to update it.
 * Returns null when unconfigured or unreachable — callers treat that as "unknown".
 */
export async function readRemoteState(): Promise<{ state: AgentState; sha: string } | null> {
  const auth = token();
  if (!auth) return null;

  try {
    const url = `${API}/repos/${repo()}/contents/${STATE_PATH}?ref=${encodeURIComponent(branch())}`;
    const response = await fetch(url, {
      headers: headers(auth),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      console.error(`[github] read state failed: HTTP ${response.status}`);
      return null;
    }

    const body = (await response.json()) as { content?: string; sha?: string };
    if (!body.content || !body.sha) return null;

    const decoded = Buffer.from(body.content, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as Partial<AgentState>;

    return {
      sha: body.sha,
      state: {
        initialized: parsed.initialized === true,
        agentId: typeof parsed.agentId === "string" ? parsed.agentId : null,
        persona:
          parsed.persona &&
          typeof parsed.persona.name === "string" &&
          typeof parsed.persona.domain === "string"
            ? { name: parsed.persona.name, domain: parsed.persona.domain }
            : null,
        initializedAt:
          typeof parsed.initializedAt === "string" ? parsed.initializedAt : null,
      },
    };
  } catch (error) {
    console.error("[github] read state error:", error);
    return null;
  }
}

/**
 * Commits the new state. Returns whether it landed, so init can report honestly
 * rather than claiming a persistence that did not happen.
 */
export async function writeRemoteState(state: AgentState, sha?: string): Promise<boolean> {
  const auth = token();
  if (!auth) return false;

  try {
    const content = Buffer.from(`${JSON.stringify(state, null, 2)}\n`, "utf8").toString("base64");
    const response = await fetch(`${API}/repos/${repo()}/contents/${STATE_PATH}`, {
      method: "PUT",
      headers: { ...headers(auth), "Content-Type": "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        message: `Initialize agent as ${state.persona?.name} (${state.persona?.domain})`,
        content,
        branch: branch(),
        ...(sha ? { sha } : {}),
      }),
    });

    if (!response.ok) {
      console.error(`[github] write state failed: HTTP ${response.status}`);
      return false;
    }

    console.log(`[github] committed ${STATE_PATH} for agent ${state.agentId}`);
    return true;
  } catch (error) {
    console.error("[github] write state error:", error);
    return false;
  }
}

export { EMPTY_STATE };
