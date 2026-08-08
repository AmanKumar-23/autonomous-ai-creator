import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { writePost } from "./write.ts";
import type { Candidate, Persona } from "../lib/types.ts";

/**
 * The writer is the last gate before something becomes permanent in the feed.
 * Anything it cannot produce cleanly must become "published nothing", never a
 * half-written post.
 */

const realFetch = globalThis.fetch;
const realEnv = { ...process.env };

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...realEnv };
});

function mockGroq(content: string) {
  process.env.GROQ_API_KEY = "k";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 10 } }), {
      status: 200,
    })) as typeof fetch;
}

const persona: Persona = { name: "Ada", domain: "AI Security" };
const candidate: Candidate = {
  id: "hackernews:1",
  title: "Prompt injection flaw disclosed",
  url: "https://example.com/story",
  source: "hackernews",
  publishedAt: new Date().toISOString(),
  snippet: "Researchers demonstrated exfiltration.",
  signals: { points: 40, comments: 9 },
};

const body = (words: number) => Array.from({ length: words }, (_, i) => `word${i}`).join(" ");

describe("the writer", () => {
  it("returns a title and body on a good response", async () => {
    mockGroq(JSON.stringify({ title: "A clear declarative title", text: body(150) }));
    const post = await writePost(persona, candidate, "because it matters");
    assert.equal(post.error, null);
    assert.equal(post.title, "A clear declarative title");
    assert.match(post.provider ?? "", /^groq:/);
  });

  it("refuses a body that is too short to be a post", async () => {
    mockGroq(JSON.stringify({ title: "Title", text: "Too short." }));
    const post = await writePost(persona, candidate, "r");
    assert.ok(post.error);
    assert.equal(post.text, "");
  });

  it("refuses a runaway body", async () => {
    mockGroq(JSON.stringify({ title: "Title", text: body(500) }));
    const post = await writePost(persona, candidate, "r");
    assert.match(post.error ?? "", /outside the/);
  });

  it("refuses a response with no title", async () => {
    mockGroq(JSON.stringify({ text: body(150) }));
    const post = await writePost(persona, candidate, "r");
    assert.match(post.error ?? "", /no usable title/);
  });

  it("recovers a fenced JSON response", async () => {
    mockGroq("```json\n" + JSON.stringify({ title: "Fenced title", text: body(150) }) + "\n```");
    const post = await writePost(persona, candidate, "r");
    assert.equal(post.error, null);
    assert.equal(post.title, "Fenced title");
  });

  it("reports an error rather than throwing when every provider fails", async () => {
    process.env.GROQ_API_KEY = "k";
    delete process.env.GEMINI_API_KEY;
    globalThis.fetch = (async () => new Response("down", { status: 500 })) as typeof fetch;

    const post = await writePost(persona, candidate, "r");
    assert.ok(post.error);
    assert.equal(post.text, "");
  });

  it("passes the persona's own name and domain into the prompt", async () => {
    process.env.GROQ_API_KEY = "k";
    let sentBody = "";
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      sentBody = String(init.body);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: "t", text: body(150) }) } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await writePost({ name: "Kepler", domain: "Robotics" }, candidate, "r");
    assert.match(sentBody, /Kepler/, "the supplied persona name must reach the prompt");
    assert.match(sentBody, /Robotics/, "the supplied domain must reach the prompt");
    assert.doesNotMatch(sentBody, /\bAda\b/, "no other persona should leak in");
  });
});
