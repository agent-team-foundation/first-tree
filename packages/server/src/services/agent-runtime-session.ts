import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";

export const AGENT_RUNTIME_SESSION_METADATA_KEY = "runtimeSession";

type AgentRuntimeSessionMetadata = {
  clientId: string;
  tokenHash: string;
  boundAt: string;
};

export type BindAgentRuntimeSessionResult = {
  token: string;
  reused: boolean;
};

function mintRuntimeSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashRuntimeSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function getAgentRuntimeSessionMetadata(metadata: unknown): AgentRuntimeSessionMetadata | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>)[AGENT_RUNTIME_SESSION_METADATA_KEY];
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<AgentRuntimeSessionMetadata>;
  if (
    typeof candidate.clientId !== "string" ||
    typeof candidate.tokenHash !== "string" ||
    typeof candidate.boundAt !== "string"
  ) {
    return null;
  }
  return candidate as AgentRuntimeSessionMetadata;
}

export async function bindAgentRuntimeSession(
  db: Database,
  agentId: string,
  clientId: string,
  presentedToken?: string,
): Promise<BindAgentRuntimeSessionResult> {
  const [existing] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(
      and(
        eq(agents.uuid, agentId),
        eq(agents.clientId, clientId),
        eq(agents.status, "active"),
        sql`EXISTS (
          SELECT 1 FROM ${clients}
          WHERE ${clients.id} = ${clientId}
            AND ${clients.retiredAt} IS NULL
        )`,
      ),
    )
    .limit(1);
  if (!existing) {
    throw new Error(`Agent "${agentId}" is no longer active on client "${clientId}"`);
  }

  const existingBinding = getAgentRuntimeSessionMetadata(existing.metadata);
  if (
    presentedToken &&
    existingBinding?.clientId === clientId &&
    timingSafeStringEqual(existingBinding.tokenHash, hashRuntimeSessionToken(presentedToken))
  ) {
    return { token: presentedToken, reused: true };
  }

  const token = mintRuntimeSessionToken();
  const nextBinding: AgentRuntimeSessionMetadata = {
    clientId,
    tokenHash: hashRuntimeSessionToken(token),
    boundAt: new Date().toISOString(),
  };
  const [row] = await db
    .update(agents)
    .set({
      metadata: sql`jsonb_set(${agents.metadata}, '{runtimeSession}', ${JSON.stringify(nextBinding)}::jsonb, true)`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agents.uuid, agentId),
        eq(agents.clientId, clientId),
        eq(agents.status, "active"),
        sql`EXISTS (
          SELECT 1 FROM ${clients}
          WHERE ${clients.id} = ${clientId}
            AND ${clients.retiredAt} IS NULL
        )`,
      ),
    )
    .returning({ uuid: agents.uuid });
  if (!row) {
    throw new Error(`Agent "${agentId}" is no longer active on client "${clientId}"`);
  }
  return { token, reused: false };
}

export async function revokeAgentRuntimeSession(
  db: Database,
  agentId: string,
  expectedClientId?: string,
): Promise<boolean> {
  const where =
    expectedClientId === undefined
      ? eq(agents.uuid, agentId)
      : and(eq(agents.uuid, agentId), eq(agents.clientId, expectedClientId));
  const [row] = await db
    .update(agents)
    .set({
      metadata: sql`${agents.metadata} - ${AGENT_RUNTIME_SESSION_METADATA_KEY}`,
      updatedAt: new Date(),
    })
    .where(where)
    .returning({ uuid: agents.uuid });
  return row !== undefined;
}

export async function revokeAgentRuntimeSessionIfTokenMatches(
  db: Database,
  agentId: string,
  clientId: string,
  token: string,
): Promise<boolean> {
  const tokenHash = hashRuntimeSessionToken(token);
  const [row] = await db
    .update(agents)
    .set({
      metadata: sql`${agents.metadata} - ${AGENT_RUNTIME_SESSION_METADATA_KEY}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agents.uuid, agentId),
        eq(agents.clientId, clientId),
        sql`${agents.metadata}->'runtimeSession'->>'clientId' = ${clientId}`,
        sql`${agents.metadata}->'runtimeSession'->>'tokenHash' = ${tokenHash}`,
      ),
    )
    .returning({ uuid: agents.uuid });
  return row !== undefined;
}

export async function validateAgentRuntimeSession(
  db: Database,
  agentId: string,
  clientId: string,
  token: string,
): Promise<boolean> {
  const [row] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(
      and(
        eq(agents.uuid, agentId),
        eq(agents.clientId, clientId),
        eq(agents.status, "active"),
        sql`EXISTS (
          SELECT 1 FROM ${clients}
          WHERE ${clients.id} = ${clientId}
            AND ${clients.retiredAt} IS NULL
        )`,
      ),
    )
    .limit(1);
  const binding = getAgentRuntimeSessionMetadata(row?.metadata);
  if (!binding || binding.clientId !== clientId) return false;
  return timingSafeStringEqual(binding.tokenHash, hashRuntimeSessionToken(token));
}
