import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * `GET /api/v1/agents/:uuid/skills` and `PATCH /api/v1/agents/:uuid/skills`
 * back the web composer's slash-command popover. The PATCH endpoint is the
 * upload entry point for the CLI daemon's local probe; GET is read by the
 * web after the user `@mentions` the agent in the composer.
 */
describe("agents/:uuid/skills", () => {
  const getApp = useTestApp();

  const sampleSkill = {
    name: "review",
    description: "Pre-landing PR review",
    source: "user" as const,
  };

  it("defaults to an empty list on a freshly-created agent", async () => {
    const app = getApp();
    const ctx = await createTestAgent(app);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${ctx.agent.uuid}/skills`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ skills: [] });
  });

  it("PATCH replaces the full list (snapshot semantics, not merge)", async () => {
    const app = getApp();
    const ctx = await createTestAgent(app);

    const first = await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${ctx.agent.uuid}/skills`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { skills: [sampleSkill, { name: "ship", description: "Ship workflow", source: "user" }] },
    });
    expect(first.statusCode).toBe(204);

    // Second write is a smaller snapshot — must replace, not merge.
    const second = await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${ctx.agent.uuid}/skills`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { skills: [sampleSkill] },
    });
    expect(second.statusCode).toBe(204);

    const [row] = await app.db
      .select({ skills: agents.skills })
      .from(agents)
      .where(eq(agents.uuid, ctx.agent.uuid))
      .limit(1);
    expect(row?.skills).toEqual([sampleSkill]);
  });

  it("rejects malformed payloads with 400", async () => {
    const app = getApp();
    const ctx = await createTestAgent(app);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${ctx.agent.uuid}/skills`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      // `source: "bogus"` is not in the enum.
      payload: { skills: [{ name: "x", description: "y", source: "bogus" }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET round-trips the namespace field for plugin skills", async () => {
    const app = getApp();
    const ctx = await createTestAgent(app);

    await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${ctx.agent.uuid}/skills`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        skills: [{ name: "gsap", namespace: "hyperframes", description: "GSAP animation reference", source: "plugin" }],
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${ctx.agent.uuid}/skills`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      skills: [{ name: "gsap", namespace: "hyperframes", description: "GSAP animation reference", source: "plugin" }],
    });
  });
});
