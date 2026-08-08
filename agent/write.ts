import { generate, parseJsonResponse } from "./llm.ts";
import type { Candidate, Persona } from "../lib/types.ts";

/**
 * Requirement 3: a consistent editorial voice with real opinions.
 *
 * The voice rules below are the editorial layer; the persona's name and domain
 * come from whatever the evaluator sent to init and are injected into it. That
 * separation is the point — the same standards produce a coherent Ada on AI
 * Security or a coherent voice on Robotics, without either being hardcoded.
 *
 * The rules are mostly negative on purpose. Left alone, models write hedged
 * marketing prose that reads identically for every topic, and a feed of that
 * makes the rejections in the log look arbitrary: a voice with no standards has
 * no grounds to reject anything.
 */

const MIN_WORDS = 60;
const MAX_WORDS = 320;

export interface WrittenPost {
  title: string;
  text: string;
  provider: string | null;
  error: string | null;
}

function buildSystemPrompt(persona: Persona): string {
  return `You are ${persona.name}. You write a short, opinionated feed about ${persona.domain}.

How you write:
- First person. You hold positions and you state them plainly.
- Open with the claim or the consequence. Never open with scene-setting like
  "In the fast-moving world of..." or "As AI continues to evolve...".
- Be concrete. Name the system, the mechanism, the number. Vagueness is the enemy.
- You are skeptical by default. If something is overhyped, underspecified, or a
  vendor announcement wearing a research costume, say so directly.
- You are not a summariser. The reader can click the link. Give them the judgment
  they cannot get from the source itself: what it means, what it changes, what to
  watch for, or why the obvious reading is wrong.
- Flowing prose. No headings, no bullet points, no lists, no emoji, no hashtags.
- Two or three short paragraphs, 120-200 words. Separate paragraphs with a blank
  line (\n\n) inside the "text" value — the feed renders them as paragraphs.

Words you never use: game-changer, revolutionary, groundbreaking, unlock, leverage,
delve, landscape, realm, testament, seismic, "it's important to note", "in today's
world". If a sentence would survive being pasted into any other article, rewrite it.

Reply with JSON only:
{ "title": "<6-12 words, declarative, YOUR angle rather than the source's headline>",
  "text": "<the post body>" }`;
}

function buildUserPrompt(
  candidate: Candidate,
  rationale: string,
  recentTitles: string[],
): string {
  const signals =
    candidate.source === "hackernews"
      ? `Hacker News, ${candidate.signals.points ?? 0} points and ${candidate.signals.comments ?? 0} comments`
      : `arXiv ${candidate.signals.category ?? ""}`.trim();

  // The rationale is passed in rather than regenerated: it was produced during
  // judgment, when the alternatives were visible, and the post has to agree with it.
  const continuity =
    recentTitles.length > 0
      ? `\n\nYour recent posts, newest first. Do not repeat these angles, and do not open the same way twice:\n${recentTitles
          .map((title) => `- ${title}`)
          .join("\n")}`
      : "\n\nThis is your first post. Establish the voice.";

  return `Write today's post about this story.

Title: ${candidate.title}
Source: ${signals}
Published: ${candidate.publishedAt}
URL: ${candidate.url}
${candidate.snippet ? `Summary: ${candidate.snippet}` : ""}

You already decided to publish this, for this reason:
"${rationale}"

Write the post so it earns that reasoning.${continuity}`;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Never throws. On any failure the cycle publishes nothing and says why. */
export async function writePost(
  persona: Persona,
  candidate: Candidate,
  rationale: string,
  recentTitles: string[] = [],
): Promise<WrittenPost> {
  const result = await generate({
    system: buildSystemPrompt(persona),
    user: buildUserPrompt(candidate, rationale, recentTitles),
    json: true,
    temperature: 0.75,
    maxTokens: 900,
  });

  if (!result.ok) {
    return {
      title: "",
      text: "",
      provider: null,
      error: result.attempts.map((a) => `${a.provider}: ${a.error}`).join("; "),
    };
  }

  const parsed = parseJsonResponse<{ title?: unknown; text?: unknown }>(result.text);
  const title = typeof parsed?.title === "string" ? parsed.title.trim() : "";
  const text = typeof parsed?.text === "string" ? parsed.text.trim() : "";

  if (!title || !text) {
    return { title: "", text: "", provider: result.provider, error: "writer returned no usable title or body" };
  }

  // A truncated or runaway body is worse than no post: the feed is permanent.
  const words = wordCount(text);
  if (words < MIN_WORDS || words > MAX_WORDS) {
    return {
      title: "",
      text: "",
      provider: result.provider,
      error: `post was ${words} words, outside the ${MIN_WORDS}-${MAX_WORDS} range`,
    };
  }

  return { title, text, provider: result.provider, error: null };
}
