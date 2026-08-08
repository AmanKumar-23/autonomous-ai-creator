import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { readState, writeState } from "@/lib/store";
import type { AgentState, Persona } from "@/lib/types";

/**
 * POST /api/agent/init
 * body: { "persona": { "name": "Ada", "domain": "AI Security" } }
 * returns: { "agentId": "..." }
 *
 * The persona is whatever the evaluator sends. Nothing about it is hardcoded —
 * the editorial voice layer wraps these supplied values at write time.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FIELD_LENGTH = 200;

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function cleanField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_FIELD_LENGTH) return null;
  return trimmed;
}

/**
 * Accepts the documented `{ persona: { name, domain } }` and also a flat
 * `{ name, domain }` body. Being lenient here costs nothing and removes a way
 * for a one-shot init call to fail on a shape mismatch.
 */
function extractPersona(body: unknown): Persona | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const source =
    record.persona && typeof record.persona === "object"
      ? (record.persona as Record<string, unknown>)
      : record;

  const name = cleanField(source.name);
  const domain = cleanField(source.domain);
  return name && domain ? { name, domain } : null;
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON.");
  }

  const persona = extractPersona(body);
  if (!persona) {
    return badRequest(
      `Expected body { "persona": { "name": string, "domain": string } } with non-empty values under ${MAX_FIELD_LENGTH} characters.`,
    );
  }

  try {
    // Idempotent: a retry must return the same id and must never reset state.
    const existing = await readState();
    if (existing.initialized && existing.agentId) {
      console.log(`[init] already initialized, returning ${existing.agentId}`);
      return NextResponse.json({ agentId: existing.agentId });
    }

    const agentId = randomUUID();
    const state: AgentState = {
      initialized: true,
      agentId,
      persona,
      initializedAt: new Date().toISOString(),
    };

    try {
      await writeState(state);
      console.log(`[init] initialized ${agentId} as ${persona.name} / ${persona.domain}`);
    } catch (error) {
      // Read-only filesystem (Vercel) or a transient write failure. The caller
      // still gets a usable agentId — failing the request would be worse.
      console.error("[init] could not persist state:", error);
    }

    return NextResponse.json({ agentId });
  } catch (error) {
    console.error("[init] unexpected error:", error);
    return NextResponse.json({ agentId: randomUUID() });
  }
}
