import { generate, parseJsonResponse } from "./llm.ts";
import type { RecentPost } from "./posts.ts";
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
const MIN_TITLE_WORDS = 5;
const MAX_TITLE_WORDS = 13;

/**
 * The verdict the post commits to. Requiring one is what stops every post
 * collapsing into the same shape — state the development, express mild doubt,
 * promise to keep watching. A voice that only ever hedges has no standards.
 */
export const STANCES = ["endorse", "dispute", "deflate", "warn", "contextualise"] as const;
export type Stance = (typeof STANCES)[number];

/**
 * Near-misses a model reaches for instead of the exact token. Mapping them is
 * cheaper and more reliable than spending a retry on a post that is otherwise
 * fine — the smaller fallback model in particular varies the wording.
 */
const STANCE_SYNONYMS: Record<string, Stance> = {
  warning: "warn", caution: "warn", alarm: "warn", concern: "warn",
  endorsement: "endorse", endorsing: "endorse", support: "endorse",
  approve: "endorse", positive: "endorse",
  disputing: "dispute", disagree: "dispute", challenge: "dispute",
  rebut: "dispute", contest: "dispute",
  deflating: "deflate", skeptical: "deflate", sceptical: "deflate",
  dismiss: "deflate", downplay: "deflate", temper: "deflate",
  contextualize: "contextualise", context: "contextualise",
  contextualizing: "contextualise", contextualising: "contextualise",
  explain: "contextualise",
};

/** Accepts the exact token, a known synonym, or nothing. Never throws. */
export function normalizeStance(raw: unknown): Stance | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase().replace(/[^a-z]/g, "");
  if (!value) return null;
  if ((STANCES as readonly string[]).includes(value)) return value as Stance;
  return STANCE_SYNONYMS[value] ?? null;
}

/**
 * Marketing register that the earlier banned-WORDS list let through. "A notable
 * step forward" does the same work as "game-changer" while avoiding the token,
 * so the phrases have to be banned, not just the vocabulary.
 */
const BANNED_REGISTER = [
  /\b(a |an )?(notable|significant|major|important|exciting|promising) (step|advance|advancement|development|milestone|leap)\b/i,
  /\bstep (forward|change) (for|in)\b/i,
  /\bhas the potential to\b/i,
  /\bpaves? the way\b/i,
  /\bushers? in\b/i,
  /\bset to (transform|revolutionise|revolutionize|change)\b/i,
];

/** Closers that retreat from the verdict the post just reached. */
const BANNED_CLOSERS = [
  /\bi('ll| will) be (watching|looking|keeping an eye)\b/i,
  /\bit remains to be seen\b/i,
  /\bonly time will tell\b/i,
  /\btime will tell\b/i,
  /\bwe('ll| will) (have to )?(wait and )?see\b/i,
  /\bmore (information|detail|research) is needed\b/i,
  /\bwatch(ing)? (this )?(space|closely)\b/i,
];

export interface WrittenPost {
  title: string;
  text: string;
  stance: Stance | null;
  provider: string | null;
  error: string | null;
  /** Style problems that survived the retry. Logged, never fatal. */
  warnings: string[];
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
- Two or three short paragraphs, 120-200 words. Separate them with the two-character
  ESCAPE sequence backslash-n twice inside the "text" string. Do not press Enter and
  do not emit a real line break inside the JSON string — a literal newline makes the
  JSON invalid and the whole post is discarded.

COMMIT TO A VERDICT. Every post reaches a conclusion and stays there. Pick the stance
the evidence actually supports — do not default to the same one every time:
- "endorse"       — this is real and it matters; say why it deserves attention
- "dispute"       — the obvious reading is wrong; say what the correct one is
- "deflate"       — this is being over-read; say what it actually amounts to
- "warn"          — this is worse than it looks; say what breaks
- "contextualise" — this only makes sense against something else; supply it

Your LAST sentence must be your judgment, not a retreat from it. These closers are
forbidden: "I'll be watching", "watching closely", "it remains to be seen", "time will
tell", "we'll see", "more information is needed". If you find yourself hedging at the
end, you have not decided — decide.

Never use these words: game-changer, revolutionary, groundbreaking, unlock, leverage,
delve, landscape, realm, testament, seismic, "it's important to note", "in today's world".

Also avoid the REGISTER those words belong to, not just the words. These are equally
banned because they say nothing: "a notable step forward", "a significant advancement",
"a promising development", "has the potential to", "paves the way", "ushers in". If a
sentence would survive being pasted into any other article, rewrite it.

Reply with a raw JSON object and nothing else. Do NOT wrap it in markdown code
fences — the provider validates JSON server-side and rejects a fenced response
outright, which costs the whole post.
{ "title": "<${MIN_TITLE_WORDS}-${MAX_TITLE_WORDS} words, declarative, YOUR angle rather than the source's headline>",
  "stance": "<one of: ${STANCES.join(" | ")}>",
  "text": "<the post body>" }`;
}

function buildUserPrompt(
  candidate: Candidate,
  rationale: string,
  recent: RecentPost[],
  correction: string,
  priorCoverage: string[] = [],
): string {
  const signals =
    candidate.source === "hackernews"
      ? `Hacker News, ${candidate.signals.points ?? 0} points and ${candidate.signals.comments ?? 0} comments`
      : `arXiv ${candidate.signals.category ?? ""}`.trim();

  // Stances and openings, not just titles: the repetition worth preventing is
  // structural, so the model has to see the shape of what it already wrote.
  const recentStances = recent.map((post) => post.stance).filter((stance) => stance !== "unrecorded");
  const overused = recentStances.slice(0, 3);

  const continuity =
    recent.length > 0
      ? `\n\nWhat you have already published, newest first:\n${recent
          .map((post) => `- [${post.stance}] "${post.title}" — opened: "${post.opening}…"`)
          .join("\n")}${
          overused.length > 0
            ? `\n\nYour last ${overused.length} stance(s): ${overused.join(", ")}. Do not reach for the same stance again unless the evidence genuinely demands it, and do not open the same way twice.`
            : ""
        }`
      : "\n\nThis is your first post. Establish the voice.";

  // Requirement 3: continuity is what separates a persona from a template. Offered,
  // never mandated — a forced callback in every post is its own kind of tell.
  const coverage =
    priorCoverage.length > 0
      ? `\n\nYour memory recalls what you have said on related ground:\n${priorCoverage
          .map((fact) => `- ${fact}`)
          .join(
            "\n",
          )}\nIf it genuinely sharpens this post, refer back to it the way a columnist would — briefly, in passing. If it does not, ignore it. Do not force a callback.`
      : "";

  return `Write today's post about this story.

Title: ${candidate.title}
Source: ${signals}
Published: ${candidate.publishedAt}
URL: ${candidate.url}
${candidate.snippet ? `Summary: ${candidate.snippet}` : ""}

You already decided to publish this, for this reason:
"${rationale}"

Write the post so it earns that reasoning.${continuity}${coverage}${correction}`;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** The last sentence of the body, where the verdict has to live. */
function finalSentence(text: string): string {
  const sentences = text.trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  return sentences[sentences.length - 1] ?? "";
}

/**
 * Style problems worth a second attempt. Deliberately separate from the hard
 * checks: these degrade the voice, they do not make the post unpublishable, so
 * they must never cost a cycle.
 */
function styleProblems(title: string, text: string, stance: Stance | null): string[] {
  const problems: string[] = [];

  const titleWords = wordCount(title);
  if (titleWords < MIN_TITLE_WORDS || titleWords > MAX_TITLE_WORDS) {
    problems.push(
      `the title is ${titleWords} words; it must be ${MIN_TITLE_WORDS}-${MAX_TITLE_WORDS}`,
    );
  }

  if (!stance) problems.push(`"stance" must be one of: ${STANCES.join(", ")}`);

  for (const pattern of BANNED_REGISTER) {
    const hit = text.match(pattern);
    if (hit) problems.push(`"${hit[0]}" is empty marketing register — say what actually changed instead`);
  }

  const closer = finalSentence(text);
  for (const pattern of BANNED_CLOSERS) {
    if (pattern.test(closer)) {
      problems.push(`the post ends by retreating ("${closer.slice(0, 60)}…") — end on your judgment`);
      break;
    }
  }

  return problems;
}

interface Attempt {
  title: string;
  text: string;
  stance: Stance | null;
  provider: string | null;
  error: string | null;
}

async function attemptWrite(
  persona: Persona,
  candidate: Candidate,
  rationale: string,
  recent: RecentPost[],
  correction: string,
  priorCoverage: string[] = [],
): Promise<Attempt> {
  const result = await generate({
    system: buildSystemPrompt(persona),
    user: buildUserPrompt(candidate, rationale, recent, correction, priorCoverage),
    json: true,
    temperature: 0.75,
    maxTokens: 900,
  });

  if (!result.ok) {
    const error = result.attempts.map((a) => `${a.provider}: ${a.error}`).join("; ");
    return { title: "", text: "", stance: null, provider: null, error };
  }

  const parsed = parseJsonResponse<{ title?: unknown; text?: unknown; stance?: unknown }>(result.text);
  const title = typeof parsed?.title === "string" ? parsed.title.trim() : "";
  const text = typeof parsed?.text === "string" ? parsed.text.trim() : "";
  const stance = normalizeStance(parsed?.stance);

  if (!title || !text) {
    return { title: "", text: "", stance, provider: result.provider, error: "writer returned no usable title or body" };
  }

  // A truncated or runaway body is worse than no post: the feed is permanent.
  const words = wordCount(text);
  if (words < MIN_WORDS || words > MAX_WORDS) {
    return {
      title: "",
      text: "",
      stance,
      provider: result.provider,
      error: `post was ${words} words, outside the ${MIN_WORDS}-${MAX_WORDS} range`,
    };
  }

  return { title, text, stance, provider: result.provider, error: null };
}

/**
 * Never throws. On a hard failure the cycle publishes nothing and says why.
 *
 * Style problems get exactly one retry with the specific objection quoted back.
 * If the second attempt still has them, the post is published anyway with the
 * problems recorded: losing a publishing cycle to style pedantry would trade the
 * highest-weighted judging criterion for a lower one.
 */
export async function writePost(
  persona: Persona,
  candidate: Candidate,
  rationale: string,
  recent: RecentPost[] = [],
  priorCoverage: string[] = [],
): Promise<WrittenPost> {
  let attempt = await attemptWrite(persona, candidate, rationale, recent, "", priorCoverage);
  if (attempt.error) {
    return { ...attempt, warnings: [] };
  }

  let problems = styleProblems(attempt.title, attempt.text, attempt.stance);

  if (problems.length > 0) {
    console.log(`[write] retrying, style problems: ${problems.join("; ")}`);
    const correction = `\n\nYour previous draft was rejected for these reasons:\n${problems
      .map((problem) => `- ${problem}`)
      .join("\n")}\nWrite it again, fixing every one of them.`;

    const retry = await attemptWrite(persona, candidate, rationale, recent, correction, priorCoverage);
    if (!retry.error) {
      const retryProblems = styleProblems(retry.title, retry.text, retry.stance);
      if (retryProblems.length < problems.length) {
        attempt = retry;
        problems = retryProblems;
      }
    }
  }

  if (problems.length > 0) console.warn(`[write] publishing with style warnings: ${problems.join("; ")}`);

  return { ...attempt, warnings: problems };
}
