import { describe, expect, it } from "vitest";
import { createAgent, deleteAgent, getAgent, getAgentByName, listAgents, suspendAgent } from "../services/agent.js";
import { createOrganization } from "../services/organization.js";
import { createTestAdmin, useTestApp } from "./helpers.js";
import { DEFAULT_ORG_ID } from "./setup.js";

describe("Agent Identity (UUID + Name)", () => {
  const getApp = useTestApp();

  // ── Name recycling ──────────────────────────────────────────────

  describe("name recycling", () => {
    it("reusing a deleted name creates a new agent with a different uuid", async () => {
      const app = getApp();

      // Create → suspend → delete
      const original = await createAgent(app.db, { name: "recycle-me", type: "human" });
      await suspendAgent(app.db, original.uuid);
      await deleteAgent(app.db, original.uuid);

      // Recreate with same name
      const recycled = await createAgent(app.db, { name: "recycle-me", type: "autonomous_agent" });

      expect(recycled.uuid).not.toBe(original.uuid);
      expect(recycled.name).toBe("recycle-me");
      expect(recycled.type).toBe("autonomous_agent");
      expect(recycled.status).toBe("active");
    });

    it("deleted agent retains uuid but loses name", async () => {
      const app = getApp();

      const agent = await createAgent(app.db, { name: "will-delete", type: "human" });
      const savedUuid = agent.uuid;

      await suspendAgent(app.db, agent.uuid);
      await deleteAgent(app.db, agent.uuid);

      // uuid still exists in DB (for historical message attribution)
      // but getAgent (which excludes deleted) returns 404
      await expect(getAgent(app.db, savedUuid)).rejects.toThrow(/not found/i);
    });

    it("multiple deleted agents can have name=NULL in the same org", async () => {
      const app = getApp();

      const a1 = await createAgent(app.db, { name: "multi-del-1", type: "human" });
      const a2 = await createAgent(app.db, { name: "multi-del-2", type: "human" });

      await suspendAgent(app.db, a1.uuid);
      await deleteAgent(app.db, a1.uuid);
      await suspendAgent(app.db, a2.uuid);
      await deleteAgent(app.db, a2.uuid);

      // Both deleted — no unique constraint violation (NULL != NULL in PG)
      // Verify by creating new agents with those names
      const r1 = await createAgent(app.db, { name: "multi-del-1", type: "autonomous_agent" });
      const r2 = await createAgent(app.db, { name: "multi-del-2", type: "autonomous_agent" });
      expect(r1.uuid).not.toBe(a1.uuid);
      expect(r2.uuid).not.toBe(a2.uuid);
    });
  });

  // ── getAgentByName ──────────────────────────────────────────────

  describe("getAgentByName", () => {
    it("resolves an active agent by org + name", async () => {
      const app = getApp();

      const created = await createAgent(app.db, { name: "find-by-name", type: "autonomous_agent" });
      const found = await getAgentByName(app.db, DEFAULT_ORG_ID, "find-by-name");

      expect(found.uuid).toBe(created.uuid);
      expect(found.name).toBe("find-by-name");
    });

    it("returns 404 for non-existent name", async () => {
      const app = getApp();

      await expect(getAgentByName(app.db, DEFAULT_ORG_ID, "no-such-agent")).rejects.toThrow(/not found/i);
    });

    it("returns 404 for deleted agent name", async () => {
      const app = getApp();

      const agent = await createAgent(app.db, { name: "deleted-lookup", type: "human" });
      await suspendAgent(app.db, agent.uuid);
      await deleteAgent(app.db, agent.uuid);

      await expect(getAgentByName(app.db, DEFAULT_ORG_ID, "deleted-lookup")).rejects.toThrow(/not found/i);
    });

    it("returns 404 when name exists in a different org", async () => {
      const app = getApp();

      const orgAlpha = await createOrganization(app.db, { name: "org-alpha", displayName: "Alpha" });
      const orgBeta = await createOrganization(app.db, { name: "org-beta", displayName: "Beta" });
      await createAgent(app.db, {
        name: "org-scoped",
        type: "autonomous_agent",
        organizationId: orgAlpha.id,
      });

      // Same name, different org → not found
      await expect(getAgentByName(app.db, orgBeta.id, "org-scoped")).rejects.toThrow(/not found/i);

      // Correct org → found
      const found = await getAgentByName(app.db, orgAlpha.id, "org-scoped");
      expect(found.name).toBe("org-scoped");
    });
  });

  // ── listAgents org filtering ────────────────────────────────────

  describe("listAgents org filtering", () => {
    it("only returns agents in the requested org", async () => {
      const app = getApp();

      const orgList = await createOrganization(app.db, { name: "org-list-test", displayName: "List Test" });
      const orgOther = await createOrganization(app.db, { name: "org-other", displayName: "Other" });
      const a1 = await createAgent(app.db, {
        name: "list-org-a",
        type: "human",
        organizationId: orgList.id,
      });
      await createAgent(app.db, {
        name: "list-org-b",
        type: "human",
        organizationId: orgOther.id,
      });

      const result = await listAgents(app.db, orgList.id, 50);
      const uuids = result.items.map((a) => a.uuid);

      expect(uuids).toContain(a1.uuid);
      // Should not contain agents from "org-other" or "default"
      for (const item of result.items) {
        expect(item.organizationId).toBe(orgList.id);
      }
    });
  });

  // ── UUID generation ─────────────────────────────────────────────

  describe("uuid generation", () => {
    it("auto-generates uuid when creating an agent", async () => {
      const app = getApp();

      const agent = await createAgent(app.db, { name: "auto-uuid", type: "autonomous_agent" });

      // UUID v7 format: 8-4-4-4-12 hex chars, version nibble = 7
      expect(agent.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it("generates inbox_id from uuid", async () => {
      const app = getApp();

      const agent = await createAgent(app.db, { name: "inbox-uuid", type: "autonomous_agent" });

      expect(agent.inboxId).toBe(`inbox_${agent.uuid}`);
    });
  });

  // ── Name uniqueness ─────────────────────────────────────────────

  describe("name uniqueness", () => {
    it("rejects duplicate name within the same org", async () => {
      const app = getApp();

      await createAgent(app.db, { name: "unique-name", type: "human" });

      await expect(createAgent(app.db, { name: "unique-name", type: "autonomous_agent" })).rejects.toThrow(
        /already exists/i,
      );
    });

    it("allows same name in different orgs", async () => {
      const app = getApp();

      const orgX = await createOrganization(app.db, { name: "org-x", displayName: "Org X" });
      const orgY = await createOrganization(app.db, { name: "org-y", displayName: "Org Y" });
      const a1 = await createAgent(app.db, {
        name: "cross-org-name",
        type: "human",
        organizationId: orgX.id,
      });
      const a2 = await createAgent(app.db, {
        name: "cross-org-name",
        type: "human",
        organizationId: orgY.id,
      });

      expect(a1.uuid).not.toBe(a2.uuid);
      expect(a1.name).toBe(a2.name);
      expect(a1.organizationId).toBe(orgX.id);
      expect(a2.organizationId).toBe(orgY.id);
    });

    it("allows creating an agent without a name", async () => {
      const app = getApp();

      const agent = await createAgent(app.db, { type: "autonomous_agent" });

      expect(agent.uuid).toBeDefined();
      expect(agent.name).toBeNull();
    });
  });

  // ── Admin API integration ───────────────────────────────────────

  describe("admin API uuid routing", () => {
    it("GET /admin/agents returns uuid + name fields", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app, { username: `id-admin-${Date.now()}` });

      await createAgent(app.db, { name: "api-check", type: "human" });

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/admin/agents",
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ items: Array<{ uuid: string; name: string | null }> }>();
      const found = body.items.find((a) => a.name === "api-check");
      expect(found).toBeDefined();
      expect(found?.uuid).toMatch(/^[0-9a-f]{8}-/);
    });

    it("GET /admin/agents/:uuid fetches by uuid", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app, { username: `id-admin2-${Date.now()}` });

      const agent = await createAgent(app.db, { name: "get-by-uuid", type: "autonomous_agent" });

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/admin/agents/${agent.uuid}`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ uuid: string; name: string }>();
      expect(body.uuid).toBe(agent.uuid);
      expect(body.name).toBe("get-by-uuid");
    });
  });
});
