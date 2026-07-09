import { defaultRuntimeConfigPayload } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { agentConfigs } from "../db/schema/agent-configs.js";
import { agents } from "../db/schema/agents.js";
import { createConfigService } from "../services/config-service.js";
import { seedAgentFactory, useTestApp } from "./helpers.js";

const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("config service edge coverage", () => {
  const getApp = useTestApp();

  it("surfaces missing config rows and orphan config runtime provider lookups", async () => {
    const app = getApp();
    const orphanAgentId = `orphan-${crypto.randomUUID()}`;

    await expect(app.configService.get(`missing-${crypto.randomUUID()}`)).rejects.toThrow(/Agent config/);

    await app.db.insert(agentConfigs).values({
      agentId: orphanAgentId,
      version: 1,
      payload: defaultRuntimeConfigPayload("claude-code"),
      updatedBy: "test",
    });

    await expect(app.configService.dryRun(orphanAgentId, { model: "claude-opus-4-6" })).rejects.toThrow(
      new RegExp(`Agent "${orphanAgentId}" not found`),
    );
  });

  it("coalesces valid queued writes and drains all pending agents via flush()", async () => {
    const app = getApp();
    const seedAgent = await seedAgentFactory(app);
    const agentA = await seedAgent({ name: `cfg-coalesce-a-${crypto.randomUUID().slice(0, 8)}` });
    const agentB = await seedAgent({ name: `cfg-coalesce-b-${crypto.randomUUID().slice(0, 8)}` });

    await expect(
      app.configService.update(agentA.uuid, { expectedVersion: 1, payload: { model: "claude-opus-4-6" } }, "test"),
    ).resolves.toMatchObject({ version: 2 });

    const queuedA1 = app.configService.update(
      agentA.uuid,
      { expectedVersion: 2, payload: { model: "claude-sonnet-4-6" } },
      "test-a1",
    );
    const queuedA2 = app.configService.update(
      agentA.uuid,
      { expectedVersion: 2, payload: { env: [{ key: "COALESCED", value: "1", sensitive: false }] } },
      "test-a2",
    );

    await app.configService.flush(agentA.uuid);
    const [resultA1, resultA2] = await Promise.all([queuedA1, queuedA2]);
    expect(resultA1.version).toBe(3);
    expect(resultA2.version).toBe(3);
    expect(resultA2.payload).toMatchObject({
      model: "claude-sonnet-4-6",
      env: [{ key: "COALESCED", value: "1", sensitive: false }],
    });

    await expect(
      app.configService.update(agentB.uuid, { expectedVersion: 1, payload: { model: "claude-opus-4-6" } }, "test"),
    ).resolves.toMatchObject({ version: 2 });

    const queuedB = app.configService.update(
      agentB.uuid,
      { expectedVersion: 2, payload: { model: "claude-haiku-4-5" } },
      "test-b",
    );

    await app.configService.flush();
    await expect(queuedB).resolves.toMatchObject({
      version: 3,
      payload: expect.objectContaining({ model: "claude-haiku-4-5" }),
    });
  });

  it("rejects queued writes when the config row disappears before flush", async () => {
    const app = getApp();
    const seedAgent = await seedAgentFactory(app);
    const agent = await seedAgent({ name: `cfg-missing-flush-${crypto.randomUUID().slice(0, 8)}` });

    await app.configService.update(agent.uuid, { expectedVersion: 1, payload: { model: "claude-opus-4-6" } }, "test");
    const queued = app.configService
      .update(agent.uuid, { expectedVersion: 2, payload: { model: "claude-sonnet-4-6" } }, "test")
      .catch((err: unknown) => err);

    await app.db.delete(agentConfigs).where(eq(agentConfigs.agentId, agent.uuid));
    await app.configService.flush(agent.uuid);

    await expect(queued).resolves.toMatchObject({ message: expect.stringContaining("Agent config") });
  });

  it("rejects queued writes when the agent row disappears before the coalesced commit", async () => {
    const app = getApp();
    const seedAgent = await seedAgentFactory(app);
    const agent = await seedAgent({ name: `cfg-agent-gone-${crypto.randomUUID().slice(0, 8)}` });

    await app.configService.update(agent.uuid, { expectedVersion: 1, payload: { model: "claude-opus-4-6" } }, "test");
    const queued = app.configService
      .update(agent.uuid, { expectedVersion: 2, payload: { model: "claude-sonnet-4-6" } }, "test")
      .catch((err: unknown) => err);

    await app.db.delete(agents).where(eq(agents.uuid, agent.uuid));
    await app.configService.flush(agent.uuid);

    await expect(queued).resolves.toMatchObject({
      message: expect.stringContaining(`Agent "${agent.uuid}" not found`),
    });
  });

  it("rejects a lost optimistic-lock race during the immediate commit path", async () => {
    const configRow = {
      agentId: "agent-lost-race",
      version: 1,
      payload: defaultRuntimeConfigPayload("claude-code"),
      updatedBy: "test",
      updatedAt: new Date(),
    };
    const db = {
      select: vi.fn(() => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: async () => {
              if (table === agentConfigs) return [configRow];
              if (table === agents) return [{ runtimeProvider: "claude-code" }];
              return [];
            },
          }),
        }),
      })),
      update: vi.fn(() => ({
        set: () => ({
          where: () => ({
            returning: async () => [],
          }),
        }),
      })),
    };
    const service = createConfigService({
      db: db as never,
      notifier: { notifyConfigChange: vi.fn().mockResolvedValue(undefined) } as never,
      encryptionKey: ENCRYPTION_KEY,
      debounceMs: 1,
    });

    await expect(
      service.update("agent-lost-race", { expectedVersion: 1, payload: { model: "claude-opus-4-6" } }, "test"),
    ).rejects.toThrow(/lost race during commit/);
  });
});
