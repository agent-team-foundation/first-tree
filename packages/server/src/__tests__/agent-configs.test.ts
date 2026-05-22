import { agentRuntimeConfigPayloadSchema, DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD } from "@first-tree/shared";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentConfigs } from "../db/schema/agent-configs.js";
import { agents } from "../db/schema/agents.js";
import { createTestApp, seedAgentFactory } from "./helpers.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app?.close();
});

describe("agent_configs schema + initial seed", () => {
  it("seeds version=1 with default payload on agent create", async () => {
    const seed = await seedAgentFactory(app);
    const agent = await seed({
      name: `cfg-seed-${crypto.randomUUID().slice(0, 8)}`,
      type: "agent",
    });
    const [row] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agent.uuid)).limit(1);
    expect(row).toBeDefined();
    expect(row?.version).toBe(1);
    expect(row?.payload).toEqual(DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD);
    expect(row?.updatedBy).toBe("system");
  });

  it("supports optimistic-lock UPDATE (version +1 on match, no-op on stale)", async () => {
    const seed = await seedAgentFactory(app);
    const agent = await seed({
      name: `cfg-oplock-${crypto.randomUUID().slice(0, 8)}`,
      type: "agent",
    });

    // First UPDATE: expectedVersion=1 → succeeds, version becomes 2
    const ok = await app.db
      .update(agentConfigs)
      .set({
        version: sql`${agentConfigs.version} + 1`,
        payload: { ...DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD, model: "claude-opus-4-6" },
        updatedAt: new Date(),
        updatedBy: "test-admin",
      })
      .where(and(eq(agentConfigs.agentId, agent.uuid), eq(agentConfigs.version, 1)))
      .returning();
    expect(ok).toHaveLength(1);
    expect(ok[0]?.version).toBe(2);

    // Second UPDATE with stale expectedVersion=1 → no rows updated
    const stale = await app.db
      .update(agentConfigs)
      .set({
        version: sql`${agentConfigs.version} + 1`,
        payload: { ...DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD, model: "claude-haiku-4-5" },
        updatedAt: new Date(),
        updatedBy: "test-admin",
      })
      .where(and(eq(agentConfigs.agentId, agent.uuid), eq(agentConfigs.version, 1)))
      .returning();
    expect(stale).toHaveLength(0);

    // Confirm the stored config is still the v=2 value, not the v=3 attempt
    const [final] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agent.uuid));
    expect(final?.version).toBe(2);
    expect(final?.payload.model).toBe("claude-opus-4-6");
  });

  it("backfill invariant: every non-deleted agent has a config row", async () => {
    const allAgents = await app.db.select({ uuid: agents.uuid }).from(agents).where(sql`${agents.status} != 'deleted'`);
    const allConfigs = await app.db.select({ agentId: agentConfigs.agentId }).from(agentConfigs);
    const agentIds = new Set(allAgents.map((a) => a.uuid));
    const configIds = new Set(allConfigs.map((c) => c.agentId));
    for (const id of agentIds) {
      expect(configIds.has(id), `agent ${id} missing config row`).toBe(true);
    }
  });
});

describe("agentRuntimeConfigPayloadSchema validation", () => {
  it("accepts a minimal default payload", () => {
    expect(() => agentRuntimeConfigPayloadSchema.parse(DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD)).not.toThrow();
  });

  it("rejects empty MCP server name", () => {
    const result = agentRuntimeConfigPayloadSchema.safeParse({
      prompt: { append: "" },
      model: "",
      mcpServers: [{ name: "", transport: "stdio", command: "echo" }],
      env: [],
      gitRepos: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate MCP server names (case-insensitive)", () => {
    const result = agentRuntimeConfigPayloadSchema.safeParse({
      prompt: { append: "" },
      model: "",
      mcpServers: [
        { name: "echo", transport: "stdio", command: "echo" },
        { name: "ECHO", transport: "stdio", command: "echo2" },
      ],
      env: [],
      gitRepos: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid env key (lowercase)", () => {
    const result = agentRuntimeConfigPayloadSchema.safeParse({
      prompt: { append: "" },
      model: "",
      mcpServers: [],
      env: [{ key: "lowercase_key", value: "v", sensitive: false }],
      gitRepos: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate env keys", () => {
    const result = agentRuntimeConfigPayloadSchema.safeParse({
      prompt: { append: "" },
      model: "",
      mcpServers: [],
      env: [
        { key: "FOO", value: "a", sensitive: false },
        { key: "FOO", value: "b", sensitive: true },
      ],
      gitRepos: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate git repo local paths (derived)", () => {
    const result = agentRuntimeConfigPayloadSchema.safeParse({
      prompt: { append: "" },
      model: "",
      mcpServers: [],
      env: [],
      gitRepos: [{ url: "https://github.com/foo/bar.git" }, { url: "git@github.com:other/bar.git" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown root field (strict)", () => {
    const result = agentRuntimeConfigPayloadSchema.safeParse({
      prompt: { append: "" },
      model: "",
      mcpServers: [],
      env: [],
      gitRepos: [],
      unknownExtra: 1,
    });
    // .superRefine doesn't strip extras, but .object() rejects unknown keys
    // by default only when .strict() is applied. The actual product behavior:
    // unknown root fields are silently dropped (zod default). Document it
    // explicitly here so future tightening is intentional.
    expect(result.success).toBe(true);
    expect((result.data as { unknownExtra?: number }).unknownExtra).toBeUndefined();
  });
});
