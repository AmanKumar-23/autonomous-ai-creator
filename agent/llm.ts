/**
 * One generate() for every LLM call in the project. Providers are configuration,
 * not code paths.
 *
 * The reason is operational, not aesthetic: during the Live Steer round there
 * are 20 minutes to change behaviour, and editing the same prompt logic in three
 * provider-shaped branches is how that round is lost. Each provider declares how
 * to build its request and how to pull the text out of its response; everything
 * above this file sees one shape.
 *
 * Failover runs top to bottom and skips providers with no key. If every tier
 * fails, the caller gets ok:false and the cycle skips — the feed is untouched
 * either way, because the read path never calls this.
 */

const TIMEOUT_MS = 20000;

/**
 * Every model id in one place. Google retired a model mid-build once already,
 * and a literal buried in provider code is a silent failure at 3am — the id
 * appeared twice for Gemini (in the tier name AND the URL), so a one-sided edit
 * would have produced a chain that reports one model while calling another.
 *
 * To swap a model, change it here and nowhere else.
 */
export const MODELS = {
  groqPrimary: "llama-3.3-70b-versatile",
  groqFallback: "llama-3.1-8b-instant",
  gemini: "gemini-2.0-flash",
} as const;

export interface GenerateOptions {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  /** Ask the provider for a JSON object rather than prose. */
  json?: boolean;
}

export interface ProviderAttempt {
  provider: string;
  ok: boolean;
  error?: string;
  tokens?: number;
}

export interface GenerateResult {
  ok: boolean;
  text: string | null;
  /** Which tier actually served this call — surfaced on /status. */
  provider: string | null;
  attempts: ProviderAttempt[];
}

interface ProviderConfig {
  name: string;
  envKey: string;
  /** Builds the HTTP call. Everything provider-shaped lives here. */
  request: (options: GenerateOptions, apiKey: string) => { url: string; init: RequestInit };
  /** Normalizes the response to plain text at the boundary. */
  parse: (body: unknown) => { text: string | null; tokens?: number };
}

/**
 * Groq's free tier meters tokens per model per day, so a second model is real
 * additional headroom rather than the same bucket under another name — which is
 * what makes this a meaningful fallback when the 70B model hits its daily cap.
 */
function groq(model: string): ProviderConfig {
  return {
    name: `groq:${model}`,
    envKey: "GROQ_API_KEY",
    request: (options, apiKey) => ({
      url: "https://api.groq.com/openai/v1/chat/completions",
      init: {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: options.system },
            { role: "user", content: options.user },
          ],
          max_tokens: options.maxTokens ?? 1200,
          temperature: options.temperature ?? 0.7,
          ...(options.json ? { response_format: { type: "json_object" } } : {}),
        }),
      },
    }),
    parse: (body) => {
      const data = body as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { total_tokens?: number };
      };
      return {
        text: data.choices?.[0]?.message?.content ?? null,
        tokens: data.usage?.total_tokens,
      };
    },
  };
}

export const PROVIDERS: ProviderConfig[] = [
  // Best quality first, then a smaller model on a separate per-model quota.
  groq(MODELS.groqPrimary),
  groq(MODELS.groqFallback),
  {
    // Kept as a last tier: it authenticates but currently reports a free-tier
    // limit of 0, so it only helps if that quota is ever granted. A fast 429 on
    // the way past costs nothing.
    name: `gemini:${MODELS.gemini}`,
    envKey: "GEMINI_API_KEY",
    request: (options, apiKey) => ({
      url: `https://generativelanguage.googleapis.com/v1beta/models/${MODELS.gemini}:generateContent?key=${apiKey}`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: options.system }] },
          contents: [{ role: "user", parts: [{ text: options.user }] }],
          generationConfig: {
            maxOutputTokens: options.maxTokens ?? 1200,
            temperature: options.temperature ?? 0.7,
            ...(options.json ? { responseMimeType: "application/json" } : {}),
          },
        }),
      },
    }),
    parse: (body) => {
      const data = body as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        usageMetadata?: { totalTokenCount?: number };
      };
      return {
        text: data.candidates?.[0]?.content?.parts?.[0]?.text ?? null,
        tokens: data.usageMetadata?.totalTokenCount,
      };
    },
  },
];

/** Never throws. Walks the failover chain and reports what each tier did. */
export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  const attempts: ProviderAttempt[] = [];

  for (const provider of PROVIDERS) {
    const apiKey = process.env[provider.envKey]?.trim();
    if (!apiKey) {
      attempts.push({ provider: provider.name, ok: false, error: "no key configured" });
      continue;
    }

    try {
      const { url, init } = provider.request(options, apiKey);
      let response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });

      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 400);

        // Strict JSON mode rejects a completion the model got slightly wrong —
        // most often a literal newline inside a string — and returns 400 before
        // we ever see the text. Observed killing one initialized cycle in two.
        // Retrying the same provider WITHOUT the JSON constraint gets us the raw
        // completion, which parseJsonResponse can recover from fences or prose.
        if (response.status === 400 && options.json && /json_validate_failed|Failed to generate JSON/i.test(detail)) {
          console.warn(`[llm] ${provider.name} rejected its own JSON; retrying unconstrained`);
          const relaxed = provider.request({ ...options, json: false }, apiKey);
          response = await fetch(relaxed.url, {
            ...relaxed.init,
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
        }

        if (!response.ok) {
          attempts.push({
            provider: provider.name,
            ok: false,
            error: `HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
          });
          continue;
        }
      }

      const { text, tokens } = provider.parse(await response.json());
      if (!text || !text.trim()) {
        attempts.push({ provider: provider.name, ok: false, error: "empty completion" });
        continue;
      }

      attempts.push({ provider: provider.name, ok: true, tokens });
      console.log(`[llm] ${provider.name} served the call (${tokens ?? "?"} tokens)`);
      return { ok: true, text, provider: provider.name, attempts };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.name === "TimeoutError" || error.name === "AbortError"
            ? `timeout after ${TIMEOUT_MS}ms`
            : error.message
          : String(error);
      attempts.push({ provider: provider.name, ok: false, error: message });
    }
  }

  console.error("[llm] every provider failed:", attempts.map((a) => `${a.provider}=${a.error}`).join(", "));
  return { ok: false, text: null, provider: null, attempts };
}

/**
 * Models wrap JSON in prose or fences even when asked not to. Recovering the
 * object is cheaper than burning a retry, and a failed parse is not an error
 * worth crashing a cycle over.
 */
export function parseJsonResponse<T>(text: string | null): T | null {
  if (!text) return null;

  const candidates = [
    text,
    text.replace(/^[\s\S]*?```(?:json)?\s*/i, "").replace(/```[\s\S]*$/, ""),
    text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
  ];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && typeof parsed === "object") return parsed as T;
    } catch {
      // try the next recovery strategy
    }
  }
  return null;
}
