import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { discoverCandidates, discoverWithReport } from "./discover.ts";
import { deriveQueryProfile } from "./domain-terms.ts";
import { canonicalUrl, filterCandidates } from "./filter.ts";
import type { Candidate } from "../lib/types.ts";

/**
 * The contract under test is narrow and absolute: discovery never throws, no
 * matter what the network does. A cycle that dies on a bad response is a cycle
 * that publishes nothing, and the agent has to survive 48 unattended hours.
 *
 * Run with: npm test
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replaces fetch with a per-host scripted responder. */
function mockFetch(handler: (url: string, signal?: AbortSignal) => Promise<Response> | Response) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init?.signal ?? undefined);
  }) as typeof fetch;
}

/**
 * A slow response that aborts like the real fetch does. Simply sleeping is not
 * enough — it ignores the AbortSignal, so the request "succeeds" late and the
 * timeout path is never exercised.
 */
function slowResponse(ms: number, build: () => Response, signal?: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(build()), ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      reject(error);
    });
  });
}

const isHn = (url: string) => url.includes("algolia");

function hnPayload(hits: unknown[]): Response {
  return new Response(JSON.stringify({ hits }), { status: 200 });
}

function arxivPayload(entries: string): Response {
  return new Response(`<feed>${entries}</feed>`, { status: 200 });
}

function hnHit(overrides: Record<string, unknown> = {}) {
  return {
    objectID: "1",
    title: "Prompt injection attack found in popular model",
    url: "https://example.com/story",
    points: 100,
    num_comments: 20,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

const arxivEntry = (id: string, title: string) => `
  <entry>
    <id>http://arxiv.org/abs/${id}</id>
    <title>${title}</title>
    <summary>A study of adversarial attack and jailbreak vulnerability in models.</summary>
    <published>${new Date().toISOString()}</published>
    <arxiv:primary_category term="cs.CR"/>
  </entry>`;

describe("resilience — nothing here may throw", () => {
  it("survives a source returning 500", async () => {
    mockFetch((url) =>
      isHn(url) ? new Response("upstream error", { status: 500 }) : arxivPayload(arxivEntry("2401.1", "Adversarial attack survey")),
    );

    const report = await discoverWithReport("AI Security", { timeoutMs: 50 });
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0].source, "hackernews");
    // The healthy source still delivered.
    assert.ok(report.candidates.length > 0, "arxiv results should survive an HN failure");
  });

  it("survives a source timing out", async () => {
    mockFetch((url, signal) =>
      isHn(url)
        ? slowResponse(5000, () => hnPayload([hnHit()]), signal)
        : arxivPayload(arxivEntry("2401.2", "Jailbreak detection")),
    );

    const report = await discoverWithReport("AI Security", { timeoutMs: 30 });
    assert.equal(report.failures[0]?.source, "hackernews");
    assert.match(report.failures[0].error, /timeout/);
    assert.ok(report.candidates.length > 0);
  });

  it("returns an empty array when BOTH sources fail", async () => {
    mockFetch(() => new Response("down", { status: 503 }));

    const report = await discoverWithReport("AI Security", { timeoutMs: 50 });
    assert.equal(report.candidates.length, 0);
    assert.equal(report.failures.length, 2);
    // The empty result is still a well-formed report, not an exception.
    assert.equal(report.domain, "AI Security");
    assert.ok(Array.isArray(report.dropped));
  });

  it("survives malformed JSON and malformed XML", async () => {
    mockFetch((url) =>
      isHn(url)
        ? new Response("{not valid json", { status: 200 })
        : new Response("<<<garbage not xml", { status: 200 }),
    );

    const report = await discoverWithReport("AI Security", { timeoutMs: 50 });
    assert.equal(report.candidates.length, 0);
    assert.equal(report.failures.length, 2);
  });

  it("handles empty results from both sources", async () => {
    mockFetch((url) => (isHn(url) ? hnPayload([]) : arxivPayload("")));

    const report = await discoverWithReport("AI Security", { timeoutMs: 50 });
    assert.deepEqual(report.candidates, []);
    assert.deepEqual(report.failures, []);
  });

  it("survives fetch rejecting outright", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("network unreachable"))) as typeof fetch;

    const candidates = await discoverCandidates("AI Security");
    assert.deepEqual(candidates, []);
  });

  it("discoverCandidates never throws even on a hostile response", async () => {
    mockFetch(() => new Response(null, { status: 204 }));
    const candidates = await discoverCandidates("AI Security");
    assert.ok(Array.isArray(candidates));
  });
});

describe("deduplication", () => {
  it("collapses the same URL arriving from both sources", async () => {
    const shared = "https://arxiv.org/abs/2401.99999";
    mockFetch((url) =>
      isHn(url)
        ? hnPayload([hnHit({ url: shared, title: "Adversarial attack on models" })])
        : arxivPayload(arxivEntry("2401.99999v1", "Adversarial attack on models")),
    );

    const report = await discoverWithReport("AI Security", { timeoutMs: 50, seen: new Set() });
    assert.equal(report.candidates.length, 1, "duplicate across sources should collapse to one");
    // Three HN term queries plus arXiv all return the same story, so several
    // duplicates are expected — what matters is that only one survives.
    assert.ok(report.dropped.filter((d) => d.reason === "duplicate").length >= 1);
  });

  it("treats tracking params, www and arXiv versions as the same URL", () => {
    assert.equal(
      canonicalUrl("https://www.Example.com/post/?utm_source=hn&ref=twitter"),
      canonicalUrl("https://example.com/post"),
    );
    assert.equal(canonicalUrl("https://arxiv.org/abs/2401.00001v3"), canonicalUrl("https://arxiv.org/abs/2401.00001"));
  });

  it("drops anything already in seen.json", async () => {
    mockFetch((url) => (isHn(url) ? hnPayload([hnHit({ url: "https://example.com/old" })]) : arxivPayload("")));

    const report = await discoverWithReport("AI Security", {
      timeoutMs: 50,
      seen: new Set([canonicalUrl("https://example.com/old")]),
    });
    assert.equal(report.candidates.length, 0);
    assert.equal(report.dropped[0].reason, "already-seen");
  });
});

describe("the pre-filter explains itself", () => {
  const base: Candidate = {
    id: "hackernews:1",
    title: "Prompt injection vulnerability disclosed",
    url: "https://example.com/a",
    source: "hackernews",
    publishedAt: new Date().toISOString(),
    snippet: "A new jailbreak exploit affecting model safety.",
    signals: { points: 50, comments: 10 },
  };
  const relevance = ["security", "injection", "jailbreak", "exploit", "ai"];

  it("records a reason for every drop", () => {
    const stale = { ...base, id: "2", url: "https://example.com/b", publishedAt: new Date(Date.now() - 10 * 86400_000).toISOString() };
    const offDomain = { ...base, id: "3", url: "https://example.com/c", title: "A recipe for sourdough", snippet: "bread" };
    const hiring = { ...base, id: "4", url: "https://example.com/d", title: "Ask HN: Who is hiring? (August 2026)" };
    const noUrl = { ...base, id: "5", url: "" };

    const { kept, dropped } = filterCandidates([base, stale, offDomain, hiring, noUrl], { relevance });

    assert.equal(kept.length, 1);
    assert.equal(dropped.length, 4);
    for (const drop of dropped) {
      assert.ok(drop.detail.length > 10, `"${drop.reason}" needs a human-readable detail`);
    }
    assert.deepEqual(
      dropped.map((d) => d.reason).sort(),
      ["no-url", "noise", "off-domain", "stale"],
    );
  });

  it("rejects an item matching only generic AI vocabulary", () => {
    // This is the real case that polluted an "AI Security" feed: a medical
    // paper whose abstract is full of AI words and no security words.
    const generic = {
      ...base,
      title: "A machine learning model for heart failure prediction",
      snippet: "We train a neural network on clinical data.",
    };
    const { kept, dropped } = filterCandidates([generic], {
      relevance: [...relevance, "model", "learning", "neural"],
    });
    assert.equal(kept.length, 0);
    assert.equal(dropped[0].reason, "off-domain");
    assert.match(dropped[0].detail, /generic/);
  });

  it("does not match a term inside a longer word", () => {
    const trap = { ...base, title: "Improvements to model training", snippet: "Domain adaptation explained." };
    const { kept } = filterCandidates([trap], { relevance: ["ai"] });
    assert.equal(kept.length, 0, '"ai" must not match training/domain/explained');
  });

  it("ranks higher-scoring candidates first", () => {
    const weak = { ...base, id: "6", url: "https://example.com/e", signals: { points: 1, comments: 0 }, snippet: "security" };
    const { kept } = filterCandidates([weak, base], { relevance });
    assert.ok((kept[0].score ?? 0) >= (kept[1].score ?? 0));
  });
});

describe("the persona drives the query", () => {
  it("derives different terms and categories per domain", () => {
    const security = deriveQueryProfile("AI Security");
    const robotics = deriveQueryProfile("Robotics");

    assert.ok(security.categories.includes("cs.CR"));
    assert.ok(robotics.categories.includes("cs.RO"));
    assert.notDeepEqual(security.terms, robotics.terms);
  });

  it("leads with the supplied domain verbatim", () => {
    assert.equal(deriveQueryProfile("Quantum Computing").terms[0], "Quantum Computing");
  });

  it("falls back sensibly for a domain matching no profile", () => {
    const profile = deriveQueryProfile("Underwater Basket Weaving");
    assert.ok(profile.terms.length > 0);
    assert.ok(profile.categories.length > 0);
    assert.ok(profile.relevance.includes("underwater"));
  });

  it("does not fall over on an empty domain", () => {
    const profile = deriveQueryProfile("");
    assert.ok(Array.isArray(profile.terms));
    assert.ok(profile.categories.length > 0);
  });
});
