import { generate, parseJsonResponse } from "./llm.ts";
import type { Candidate, Persona } from "../lib/types.ts";

/**
 * Requirement 2: the agent decides what is worth publishing, and intentionally
 * rejects what is not.
 *
 * One LLM call per cycle judges the whole shortlist together. That is deliberate
 * and not just a token saving: "why this one over the others" can only be
 * answered by something that saw the others, so the rationale has to be produced
 * here, during judgment, rather than later while writing.
 *
 * The prompt is built around the persona supplied at init. Nothing about the
 * editorial standards is domain-specific — they are standards a good editor in
 * ANY field would hold, applied to whatever domain arrives.
 */

const MAX_CANDIDATES = 8;
const SNIPPET_CHARS = 220;

export interface JudgeRejection {
  id: string;
  title: string;
  url: string;
  reason: string;
}

export interface JudgeVerdict {
  /** Null when nothing cleared the bar. A cycle that publishes nothing is a valid cycle. */
  selected: Candidate | null;
  /** Why this topic, and why it matters now. Empty when nothing was selected. */
  rationale: string;
  rejections: JudgeRejection[];
  provider: string | null;
  /** Set when the call itself failed, as opposed to the agent choosing to reject. */
  error: string | null;
}

interface RawVerdict {
  selected_id?: unknown;
  why_selected?: unknown;
  why_now?: unknown;
  rejections?: unknown;
}

function buildSystemPrompt(persona: Persona): string {
  return `You are ${persona.name}, an editor who covers ${persona.domain}.

You are deciding which single story, if any, is worth publishing to your feed today.

Your standards, in order:
1. SUBSTANCE. A concrete development — a disclosed vulnerability, a shipped system, a
   result with evidence. Announcements, funding rounds, rebrands and opinion pieces with
   no new information are not developments.
2. RELEVANCE TO ${persona.domain.toUpperCase()}. Adjacent-but-not-really is a rejection.
   A story that merely mentions your field in passing does not belong to it.
3. TIMELINESS. There must be a reason it matters NOW rather than at any point in the
   last year.
4. SOMETHING TO SAY. You publish opinions, not summaries. If you have no view beyond
   restating the headline, reject it.

Reject aggressively. Most days most items fail these standards, and publishing nothing
is far better than publishing something thin — a feed of filler destroys the credibility
that makes your opinions worth reading. Selecting nothing is a legitimate and common
outcome. Do not select a weak item merely because it is the best of a weak set.

You must give a specific reason for every rejection. "Not relevant" is not a reason;
say what is actually wrong with it as a story for this feed.

Reply with JSON only, in exactly this shape:
{
  "selected_id": "<the id of the one item worth publishing, or null>",
  "why_selected": "<1-2 sentences: what makes this worth your readers' attention, and why it beat the others. Empty string if nothing selected.>",
  "why_now": "<1 sentence: why this matters at this moment. Empty string if nothing selected.>",
  "rejections": [ { "id": "<id>", "reason": "<specific reason this failed your standards>" } ]
}

Every candidate you do not select must appear in "rejections".`;
}

function buildUserPrompt(candidates: Candidate[], recentTitles: string[]): string {
  const list = candidates
    .map((candidate, index) => {
      const signals =
        candidate.source === "hackernews"
          ? `${candidate.signals.points ?? 0} points, ${candidate.signals.comments ?? 0} comments`
          : `arXiv ${candidate.signals.category ?? ""}`.trim();
      const snippet = candidate.snippet ? `\n   summary: ${candidate.snippet.slice(0, SNIPPET_CHARS)}` : "";
      return `${index + 1}. id: ${candidate.id}
   title: ${candidate.title}
   source: ${candidate.source} (${signals}), published ${candidate.publishedAt}${snippet}`;
    })
    .join("\n\n");

  // Compact memory, not full post bodies: enough to avoid repeating itself
  // without spending the cycle's token budget on history.
  const memory =
    recentTitles.length > 0
      ? `\n\nYou have already published these, most recent first. Do not cover the same story again, and do not repeat an angle you have just made:\n${recentTitles
          .map((title) => `- ${title}`)
          .join("\n")}`
      : "\n\nYou have not published anything yet. This would be your first post.";

  return `Today's candidates:\n\n${list}${memory}`;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Never throws. A provider outage or an unparseable reply produces a verdict
 * with an error and no selection, which the cycle records and moves on from.
 */
export async function judgeCandidates(
  persona: Persona,
  candidates: Candidate[],
  recentTitles: string[] = [],
): Promise<JudgeVerdict> {
  const shortlist = candidates.slice(0, MAX_CANDIDATES);

  if (shortlist.length === 0) {
    return { selected: null, rationale: "", rejections: [], provider: null, error: null };
  }

  const result = await generate({
    system: buildSystemPrompt(persona),
    user: buildUserPrompt(shortlist, recentTitles),
    json: true,
    temperature: 0.3,
    maxTokens: 1000,
  });

  if (!result.ok) {
    const error = result.attempts.map((a) => `${a.provider}: ${a.error}`).join("; ");
    return { selected: null, rationale: "", rejections: [], provider: null, error };
  }

  const raw = parseJsonResponse<RawVerdict>(result.text);
  if (!raw) {
    return {
      selected: null,
      rationale: "",
      rejections: [],
      provider: result.provider,
      error: "could not parse the judge's response as JSON",
    };
  }

  const selectedId = asText(raw.selected_id);
  // Only trust an id that is actually on the shortlist — a hallucinated id must
  // never become a post with fabricated sources.
  const selected = shortlist.find((candidate) => candidate.id === selectedId) ?? null;

  const rejections: JudgeRejection[] = Array.isArray(raw.rejections)
    ? raw.rejections.flatMap((entry): JudgeRejection[] => {
        if (!entry || typeof entry !== "object") return [];
        const record = entry as Record<string, unknown>;
        const id = asText(record.id);
        const candidate = shortlist.find((item) => item.id === id);
        if (!candidate || candidate.id === selected?.id) return [];
        return [
          {
            id,
            title: candidate.title,
            url: candidate.url,
            reason: asText(record.reason) || "did not meet the editorial bar",
          },
        ];
      })
    : [];

  // Anything the judge silently ignored is still a rejection; the log must
  // account for every candidate it was shown.
  for (const candidate of shortlist) {
    if (candidate.id === selected?.id) continue;
    if (rejections.some((rejection) => rejection.id === candidate.id)) continue;
    rejections.push({
      id: candidate.id,
      title: candidate.title,
      url: candidate.url,
      reason: "not chosen this cycle; the editor gave no specific objection",
    });
  }

  const whySelected = asText(raw.why_selected);
  const whyNow = asText(raw.why_now);
  const rationale = selected ? [whySelected, whyNow].filter(Boolean).join(" ") : "";

  return { selected, rationale, rejections, provider: result.provider, error: null };
}
