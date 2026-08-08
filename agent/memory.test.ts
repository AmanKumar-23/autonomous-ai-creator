import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { groupFor, recallSimilar, rememberPost, sameStory } from "./memory.ts";
import type { Candidate, Post } from "../lib/types.ts";

/**
 * Two things are being protected here.
 *
 * Correctness: the same story told in different words must be caught, and an
 * unrelated story must not be.
 *
 * Availability: Breeth going down must never stop a publish. Every failure mode
 * has to end in "no memory, carry on", not an exception.
 */

const realFetch = globalThis.fetch;
const realEnv = { ...process.env };

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...realEnv };
});

function candidate(id: string, title: string, snippet = ""): Candidate {
  return {
    id,
    title,
    url: `https://example.com/${id}`,
    source: "hackernews",
    publishedAt: new Date().toISOString(),
    snippet,
    signals: {},
  };
}

function mockSearch(facts: string[]) {
  process.env.BREETH_API_KEY = "ck_live_test";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ edges: facts.map((fact) => ({ fact })) }), { status: 200 })) as typeof fetch;
}

describe("semantic sameness, not string matching", () => {
  it("catches the same story told in different words", () => {
    // The exact case from the brief that a URL Set cannot catch.
    assert.equal(sameStory("OpenAI shipped an agent SDK", "New agent framework from OpenAI"), true);
  });

  it("catches a rephrased vulnerability disclosure", () => {
    assert.equal(
      sameStory(
        "Ollama and Gemma4 exposed to prompt injection",
        "Prompt Injection Vulnerability in Ollama, Gemma4 and HuggingFace's Transformers",
      ),
      true,
    );
  });

  it("does not treat an unrelated story as covered", () => {
    assert.equal(
      sameStory("Ollama and Gemma4 exposed to prompt injection", "Humanoid loco-manipulation world model"),
      false,
    );
  });

  it("does not suppress every later story about the same organisation", () => {
    // One shared name is not enough — otherwise the second OpenAI story ever
    // discovered would be silently unpublishable.
    assert.equal(sameStory("OpenAI shipped an agent SDK", "OpenAI raises a funding round"), false);
  });

  it("namespaces memory per agent", () => {
    assert.equal(groupFor("abc-123"), "aac-abc-123");
    assert.notEqual(groupFor("abc-123"), groupFor("def-456"));
    assert.ok(groupFor(null).length > 0);
  });
});

describe("recall marks prior coverage", () => {
  it("flags a candidate whose ground was already covered", async () => {
    mockSearch(["Ollama and Gemma4 exposed to prompt injection"]);
    const hits = await recallSimilar(
      [candidate("a", "Prompt injection found in Ollama and Gemma4")],
      { groupId: "g" },
    );
    assert.equal(hits.get("a")?.covered, true);
    assert.equal(hits.get("a")?.facts.length, 1);
  });

  it("does NOT flag a candidate merely because memory returned something", async () => {
    // The live API returns facts regardless of relevance. If this ever regresses,
    // the agent silently stops publishing.
    mockSearch(["Ollama and Gemma4 exposed to prompt injection"]);
    const hits = await recallSimilar([candidate("b", "Humanoid robot loco-manipulation controller")], {
      groupId: "g",
    });
    assert.equal(hits.get("b")?.covered, false);
  });

  it("resolves the earlier post id locally, since Breeth drops it", async () => {
    mockSearch(["Ollama and Gemma4 exposed to prompt injection"]);
    const prior: Post[] = [
      {
        id: "post-42",
        createdAt: new Date().toISOString(),
        title: "Ollama and Gemma4 exposed to prompt injection",
        text: "…",
        rationale: "…",
        sources: [{ title: "Ollama prompt injection", url: "https://example.com/x" }],
      },
    ];
    const hits = await recallSimilar([candidate("c", "Prompt injection in Ollama and Gemma4")], {
      groupId: "g",
      priorPosts: prior,
    });
    assert.equal(hits.get("c")?.relatedPostId, "post-42");
  });
});

describe("a memory outage must never stop a publish", () => {
  const one = [candidate("a", "Prompt injection in Ollama")];

  it("returns empty when Breeth 500s", async () => {
    process.env.BREETH_API_KEY = "ck_live_test";
    globalThis.fetch = (async () => new Response("down", { status: 500 })) as typeof fetch;
    assert.equal((await recallSimilar(one, { groupId: "g" })).size, 0);
  });

  it("returns empty when Breeth is unreachable", async () => {
    process.env.BREETH_API_KEY = "ck_live_test";
    globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;
    assert.equal((await recallSimilar(one, { groupId: "g" })).size, 0);
  });

  it("returns empty on malformed JSON", async () => {
    process.env.BREETH_API_KEY = "ck_live_test";
    globalThis.fetch = (async () => new Response("{not json", { status: 200 })) as typeof fetch;
    assert.equal((await recallSimilar(one, { groupId: "g" })).size, 0);
  });

  it("does not call the API at all without a key", async () => {
    delete process.env.BREETH_API_KEY;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    assert.equal((await recallSimilar(one, { groupId: "g" })).size, 0);
    assert.equal(called, false);
  });

  it("rememberPost reports failure instead of throwing", async () => {
    process.env.BREETH_API_KEY = "ck_live_test";
    globalThis.fetch = (async () => new Response("nope", { status: 503 })) as typeof fetch;

    const post: Post = {
      id: "p1",
      createdAt: new Date().toISOString(),
      title: "A title",
      text: "Body",
      rationale: "Because",
      sources: [{ title: "s", url: "https://example.com" }],
    };
    assert.equal(await rememberPost(post, "Ada", "g"), false);
  });

  it("rememberPost succeeds on a healthy response", async () => {
    process.env.BREETH_API_KEY = "ck_live_test";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, episode_name: "api_1" }), { status: 200 })) as typeof fetch;

    const post: Post = {
      id: "p1",
      createdAt: new Date().toISOString(),
      title: "A title",
      text: "Body",
      rationale: "Because",
      sources: [{ title: "s", url: "https://example.com" }],
      stance: "warn",
    };
    assert.equal(await rememberPost(post, "Ada", "g"), true);
  });
});
