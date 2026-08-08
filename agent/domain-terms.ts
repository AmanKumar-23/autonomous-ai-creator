/**
 * Turns the persona domain supplied at init into search terms and arXiv
 * categories.
 *
 * This file is the reason the agent is not secretly about my interests. The
 * evaluator may send "AI Security", "Robotics" or something we never
 * anticipated, and discovery has to follow it. Nothing here is a topic list —
 * it is a mapping FROM whatever arrives, with a generic fallback that still
 * works for a domain no profile matches.
 */

export interface QueryProfile {
  /** Free-text terms for the Hacker News search. */
  terms: string[];
  /** arXiv categories, e.g. cs.CR. */
  categories: string[];
  /** Terms used by the relevance filter to score title + snippet overlap. */
  relevance: string[];
}

interface Profile {
  /** Any of these appearing in the domain selects this profile. */
  triggers: string[];
  terms: string[];
  categories: string[];
  relevance: string[];
}

const PROFILES: Profile[] = [
  {
    triggers: ["security", "safety", "privacy", "adversarial", "alignment", "cyber", "threat"],
    terms: ["AI security", "prompt injection", "model jailbreak", "adversarial attack"],
    categories: ["cs.CR", "cs.AI", "cs.LG"],
    relevance: [
      "security", "vulnerability", "attack", "exploit", "adversarial", "jailbreak",
      "injection", "privacy", "safety", "alignment", "threat", "malicious", "breach",
      "backdoor", "poisoning", "red team", "cve",
    ],
  },
  {
    triggers: ["robot", "embodied", "autonomous vehicle", "drone", "manipulation"],
    terms: ["robotics", "embodied AI", "robot learning"],
    categories: ["cs.RO", "cs.AI", "cs.LG"],
    relevance: [
      "robot", "robotic", "embodied", "manipulation", "locomotion", "actuator",
      "grasping", "navigation", "drone", "autonomous vehicle", "sim2real",
    ],
  },
  {
    triggers: ["language", "nlp", "llm", "chatbot", "translation", "text"],
    terms: ["large language model", "LLM", "language model research"],
    categories: ["cs.CL", "cs.AI", "cs.LG"],
    relevance: [
      "language model", "llm", "nlp", "transformer", "token", "prompt", "chatbot",
      "gpt", "claude", "gemini", "llama", "fine-tuning", "rag", "context window",
    ],
  },
  {
    triggers: ["vision", "image", "video", "multimodal", "diffusion", "generative art"],
    terms: ["computer vision", "multimodal model", "image generation"],
    categories: ["cs.CV", "cs.AI", "cs.LG"],
    relevance: [
      "vision", "image", "video", "multimodal", "diffusion", "segmentation",
      "detection", "generative", "rendering", "3d", "visual",
    ],
  },
  {
    triggers: ["agent", "autonomy", "tool use", "orchestration", "multi-agent"],
    terms: ["AI agents", "agentic workflow", "tool use LLM"],
    categories: ["cs.MA", "cs.AI", "cs.LG"],
    relevance: [
      "agent", "agentic", "autonomous", "tool use", "orchestration", "workflow",
      "planning", "reasoning", "mcp", "function calling",
    ],
  },
  {
    triggers: ["policy", "regulation", "governance", "ethic", "law", "society"],
    terms: ["AI regulation", "AI governance", "AI policy"],
    categories: ["cs.CY", "cs.AI"],
    relevance: [
      "policy", "regulation", "governance", "ethics", "law", "compliance",
      "act", "legislation", "accountability", "bias", "fairness", "audit",
    ],
  },
  {
    triggers: ["infrastructure", "hardware", "chip", "gpu", "systems", "compute", "inference"],
    terms: ["AI infrastructure", "GPU compute", "inference optimization"],
    categories: ["cs.AR", "cs.DC", "cs.LG"],
    relevance: [
      "gpu", "chip", "hardware", "inference", "training", "cluster", "compute",
      "kernel", "cuda", "latency", "throughput", "quantization", "serving",
    ],
  },
  {
    triggers: ["data", "database", "retrieval", "search", "vector"],
    terms: ["vector database", "retrieval augmented generation", "data infrastructure"],
    categories: ["cs.IR", "cs.DB", "cs.LG"],
    relevance: [
      "database", "retrieval", "search", "vector", "embedding", "index", "query",
      "rag", "corpus", "dataset",
    ],
  },
];

/** Applied to every domain so general AI/tech news is never entirely missed. */
const BASELINE_RELEVANCE = ["ai", "artificial intelligence", "machine learning", "model", "research"];

const STOP_WORDS = new Set(["and", "the", "of", "for", "in", "on", "with", "a", "an", "to"]);

/** Lowercased, punctuation-free words from the domain, minus filler. */
export function domainTokens(domain: string): string[] {
  return domain
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

/**
 * Never throws and never returns an empty profile: an unrecognised domain still
 * searches for its own words, which is exactly what a human would do.
 */
export function deriveQueryProfile(domain: string): QueryProfile {
  const raw = (domain || "").trim();
  const normalized = raw.toLowerCase();
  const tokens = domainTokens(raw);

  const matched = PROFILES.filter((profile) =>
    profile.triggers.some((trigger) => normalized.includes(trigger)),
  );

  if (matched.length === 0) {
    // Unknown domain: search the domain itself and its individual words, and
    // fall back to the broad AI categories so arXiv still returns something.
    return {
      terms: unique([raw, ...tokens]).slice(0, 3),
      categories: ["cs.AI", "cs.LG"],
      relevance: unique([...tokens, ...BASELINE_RELEVANCE]),
    };
  }

  return {
    // The domain itself leads: it is the most faithful expression of the persona.
    terms: unique([raw, ...matched.flatMap((p) => p.terms)]).slice(0, 3),
    categories: unique(matched.flatMap((p) => p.categories)).slice(0, 3),
    relevance: unique([...tokens, ...matched.flatMap((p) => p.relevance), ...BASELINE_RELEVANCE]),
  };
}
