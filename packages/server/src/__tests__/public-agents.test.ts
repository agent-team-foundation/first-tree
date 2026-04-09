import { afterAll, describe, expect, it } from "vitest";
import { createAgent } from "../services/agent.js";
import { createTestApp } from "./helpers.js";

describe("Public Agents API", () => {
  const appPromise = createTestApp();
  afterAll(async () => (await appPromise).close());

  it("returns only public agents (no auth required)", async () => {
    const app = await appPromise;

    // Create one public and one private agent
    await createAgent(app.db, { name: "public-bot", type: "autonomous_agent", public: true });
    await createAgent(app.db, { name: "private-bot", type: "autonomous_agent" });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/public/agents",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: Array<{ name: string }> }>();

    const names = body.items.map((a) => a.name);
    expect(names).toContain("public-bot");
    expect(names).not.toContain("private-bot");
  });

  it("does not expose sensitive fields", async () => {
    const app = await appPromise;

    await createAgent(app.db, { name: "pub-fields", type: "autonomous_agent", public: true });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/public/agents",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: Array<Record<string, unknown>> }>();
    const agent = body.items.find((a) => a.name === "pub-fields");
    expect(agent).toBeDefined();

    // Should have public-safe fields
    expect(agent?.uuid).toBeDefined();
    expect(agent?.name).toBeDefined();
    expect(agent?.type).toBeDefined();
    expect(agent?.displayName).toBeDefined();

    // Should NOT have sensitive fields
    expect(agent?.inboxId).toBeUndefined();
    expect(agent?.metadata).toBeUndefined();
    expect(agent?.status).toBeUndefined();
    expect(agent?.cloudUserId).toBeUndefined();
  });

  it("returns public agents across all orgs when no org param", async () => {
    const app = await appPromise;
    const { createOrganization } = await import("../services/organization.js");

    await createOrganization(app.db, { id: "cross-org", displayName: "Cross Org" });
    await createAgent(app.db, { name: "default-pub", type: "autonomous_agent", public: true });
    await createAgent(app.db, {
      name: "cross-org-pub",
      type: "autonomous_agent",
      public: true,
      organizationId: "cross-org",
    });

    const res = await app.inject({ method: "GET", url: "/api/v1/public/agents" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: Array<{ name: string; organizationId: string }> }>();
    const orgs = new Set(body.items.map((a) => a.organizationId));
    expect(orgs.size).toBeGreaterThanOrEqual(2);
  });

  it("filters by org query param", async () => {
    const app = await appPromise;
    const { createOrganization } = await import("../services/organization.js");

    await createOrganization(app.db, { id: "pub-org", displayName: "Public Org" });
    await createAgent(app.db, {
      name: "pub-org-bot",
      type: "autonomous_agent",
      public: true,
      organizationId: "pub-org",
    });
    await createAgent(app.db, { name: "default-pub-bot", type: "autonomous_agent", public: true });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/public/agents?org=pub-org",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: Array<{ name: string; organizationId: string }> }>();

    for (const item of body.items) {
      expect(item.organizationId).toBe("pub-org");
    }
  });

  it("supports pagination", async () => {
    const app = await appPromise;

    for (let i = 0; i < 3; i++) {
      await createAgent(app.db, { name: `page-bot-${i}`, type: "autonomous_agent", public: true });
    }

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/public/agents?limit=2",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: unknown[]; nextCursor: string | null }>();
    expect(body.items).toHaveLength(2);
    expect(body.nextCursor).toBeDefined();
  });
});
