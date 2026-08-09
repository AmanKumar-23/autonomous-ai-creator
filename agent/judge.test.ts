import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { judgeCandidates } from "./judge.ts";
import { generate, parseJsonResponse } from "./llm.ts";
import type { Candidate, Persona } from "../lib/types.ts";

/**
 * The failover chain and the judge's output validation. These are the two
 * places where a quiet bug turns into 48 hours of an empty or wrong feed.
 */

const realFetch = globalThis.fetch;
const realEnv = { ...process.env };

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...realEnv };
});

function mockFetch(handler: (url: string) => Promise<Response> | Response) {
  globalThis.fetch = (async (input: string | URL | Request) =>
    handler(typeof input === "string" ? input : input.toString())) as typeof fetch;
}

const isGroq = (url: string) => url.includes("groq.com");

const groqReply = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 42 } }), { status: 200 });

const geminiReply = (text: string) =>
  new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { totalTokenCount: 42 } }),
    { status: 200 },
  );

const persona: Persona = { name: "Ada", domain: "AI Security" };

function candidate(id: string, title: string): Candidate {
  return {
    id,
    title,
    url: `https://example.com/${id}`,
    source: "hackernews",
    publishedAt: new Date().toISOString(),
    snippet: "A disclosed vulnerability.",
    signals: { points: 10, comments: 2 },
  };
}

describe("provider failover", () => {
  it("uses groq when it works", async () => {
    process.env.GROQ_API_KEY = "k";
    process.env.GEMINI_API_KEY = "k";
    mockFetch((url) => (isGroq(url) ? groqReply("hello") : geminiReply("should not be used")));

    const result = await generate({ system: "s", user: "u" });
    assert.equal(result.ok, true);
    assert.match(result.provider ?? "", /^groq:/);
    assert.equal(result.text, "hello");
  });

  it("falls over to gemini when groq returns 429", async () => {
    process.env.GROQ_API_KEY = "k";
    process.env.GEMINI_API_KEY = "k";
    mockFetch((url) =>
      isGroq(url) ? new Response("rate limited", { status: 429 }) : geminiReply("from gemini"),
    );

    const result = await generate({ system: "s", user: "u" });
    assert.match(result.provider ?? "", /^gemini:/);
    assert.equal(result.text, "from gemini");
    assert.equal(result.attempts[0].ok, false);
    assert.match(result.attempts[0].error ?? "", /429/);
  });

  it("skips a provider with no key rather than calling it", async () => {
    delete process.env.GROQ_API_KEY;
    process.env.GEMINI_API_KEY = "k";
    let groqCalled = false;
    mockFetch((url) => {
      if (isGroq(url)) groqCalled = true;
      return geminiReply("from gemini");
    });

    const result = await generate({ system: "s", user: "u" });
    assert.equal(groqCalled, false);
    assert.match(result.provider ?? "", /^gemini:/);
    assert.match(result.attempts[0].error ?? "", /no key/);
  });

  it("reports failure when every provider fails, without throwing", async () => {
    process.env.GROQ_API_KEY = "k";
    process.env.GEMINI_API_KEY = "k";
    mockFetch(() => new Response("down", { status: 500 }));

    const result = await generate({ system: "s", user: "u" });
    assert.equal(result.ok, false);
    assert.equal(result.text, null);
    assert.ok(result.attempts.length >= 2);
  });

  it("treats an empty completion as a failure and moves on", async () => {
    process.env.GROQ_API_KEY = "k";
    process.env.GEMINI_API_KEY = "k";
    mockFetch((url) => (isGroq(url) ? groqReply("   ") : geminiReply("real content")));

    const result = await generate({ system: "s", user: "u" });
    assert.match(result.provider ?? "", /^gemini:/);
  });

  it("survives fetch rejecting outright", async () => {
    process.env.GROQ_API_KEY = "k";
    delete process.env.GEMINI_API_KEY;
    globalThis.fetch = (() => Promise.reject(new Error("socket hang up"))) as typeof fetch;

    const result = await generate({ system: "s", user: "u" });
    assert.equal(result.ok, false);
  });
});

describe("JSON recovery", () => {
  it("parses a bare object", () => {
    assert.deepEqual(parseJsonResponse('{"a":1}'), { a: 1 });
  });
  it("recovers from a fenced code block", () => {
    assert.deepEqual(parseJsonResponse('```json\n{"a":1}\n```'), { a: 1 });
  });
  it("recovers from surrounding prose", () => {
    assert.deepEqual(parseJsonResponse('Sure! Here is the result:\n{"a":1}\nHope that helps.'), { a: 1 });
  });
  it("returns null for unusable text", () => {
    assert.equal(parseJsonResponse("no json at all"), null);
    assert.equal(parseJsonResponse(null), null);
  });
});

describe("the editorial gate", () => {
  const shortlist = [candidate("a", "Story A"), candidate("b", "Story B"), candidate("c", "Story C")];

  it("selects a candidate and pairs it with a rationale", async () => {
    process.env.GROQ_API_KEY = "k";
    mockFetch(() =>
      groqReply(
        JSON.stringify({
          selected_id: "b",
          why_selected: "It discloses a concrete vulnerability.",
          why_now: "Patches ship this week.",
          rejections: [
            { id: "a", reason: "an announcement, not a development" },
            { id: "c", reason: "no new information" },
          ],
        }),
      ),
    );

    const verdict = await judgeCandidates(persona, shortlist);
    assert.equal(verdict.selected?.id, "b");
    assert.match(verdict.rationale, /concrete vulnerability/);
    assert.match(verdict.rationale, /Patches ship this week/);
    assert.equal(verdict.rejections.length, 2);
  });

  it("accepts a decision to publish nothing", async () => {
    process.env.GROQ_API_KEY = "k";
    mockFetch(() =>
      groqReply(
        JSON.stringify({
          selected_id: null,
          why_selected: "",
          why_now: "",
          rejections: shortlist.map((c) => ({ id: c.id, reason: "thin" })),
        }),
      ),
    );

    const verdict = await judgeCandidates(persona, shortlist);
    assert.equal(verdict.selected, null);
    assert.equal(verdict.rationale, "");
    assert.equal(verdict.rejections.length, 3);
    assert.equal(verdict.error, null, "rejecting everything is a decision, not an error");
  });

  it("refuses an id the model invented", async () => {
    // Critical: a hallucinated id must never become a post citing a source that
    // was never in the shortlist.
    process.env.GROQ_API_KEY = "k";
    mockFetch(() =>
      groqReply(JSON.stringify({ selected_id: "does-not-exist", why_selected: "x", why_now: "y", rejections: [] })),
    );

    const verdict = await judgeCandidates(persona, shortlist);
    assert.equal(verdict.selected, null);
  });

  it("logs a rejection for every candidate the model ignored", async () => {
    process.env.GROQ_API_KEY = "k";
    mockFetch(() =>
      groqReply(JSON.stringify({ selected_id: "a", why_selected: "x", why_now: "y", rejections: [] })),
    );

    const verdict = await judgeCandidates(persona, shortlist);
    assert.equal(verdict.rejections.length, 2, "b and c must still be accounted for");
    assert.ok(verdict.rejections.every((r) => r.reason.length > 0));
  });

  it("returns an error rather than a selection when every provider fails", async () => {
    process.env.GROQ_API_KEY = "k";
    mockFetch(() => new Response("down", { status: 503 }));

    const verdict = await judgeCandidates(persona, shortlist);
    assert.equal(verdict.selected, null);
    assert.ok(verdict.error);
  });

  it("survives an unparseable reply", async () => {
    process.env.GROQ_API_KEY = "k";
    mockFetch(() => groqReply("I have decided to publish story B, it is the best one."));

    const verdict = await judgeCandidates(persona, shortlist);
    assert.equal(verdict.selected, null);
    assert.match(verdict.error ?? "", /parse/);
  });

  it("does not call a provider at all when there is nothing to judge", async () => {
    let called = false;
    mockFetch(() => {
      called = true;
      return groqReply("{}");
    });

    const verdict = await judgeCandidates(persona, []);
    assert.equal(called, false, "an empty shortlist must not spend tokens");
    assert.equal(verdict.selected, null);
  });
});

describe("strict JSON mode rejecting its own output", () => {
  it("retries the same provider unconstrained rather than failing over", async () => {
    // Observed in production: Groq returned 400 json_validate_failed and the
    // cycle published nothing. The recovery must happen on the same tier.
    process.env.GROQ_API_KEY = "k";
    delete process.env.GEMINI_API_KEY;

    let call = 0;
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      call++;
      const sentJsonMode = String(init.body).includes("response_format");
      if (sentJsonMode) {
        return new Response(
          JSON.stringify({ error: { code: "json_validate_failed", message: "Failed to generate JSON." } }),
          { status: 400 },
        );
      }
      // Unconstrained retry: fenced output, which parseJsonResponse recovers.
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '```json\n{"ok":true}\n```' } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await generate({ system: "s", user: "u", json: true });
    assert.equal(result.ok, true, "the unconstrained retry should succeed");
    assert.match(result.provider ?? "", /^groq:/);
    assert.equal(call, 2, "exactly one retry on the same provider");
    assert.deepEqual(parseJsonResponse(result.text), { ok: true });
  });

  it("does not drop the JSON constraint for an ordinary 400", async () => {
    // An ordinary 400 should fail over across the two Groq tiers, but must never
    // relax the JSON requirement — that recovery is only for json_validate_failed.
    process.env.GROQ_API_KEY = "k";
    delete process.env.GEMINI_API_KEY;
    const bodies: string[] = [];
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 });
    }) as unknown as typeof fetch;

    const result = await generate({ system: "s", user: "u", json: true });
    assert.equal(result.ok, false);
    assert.ok(
      bodies.every((body) => body.includes("response_format")),
      "every attempt must still have asked for JSON",
    );
  });
});
