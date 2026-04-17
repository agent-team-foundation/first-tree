import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { retireClient } from "../services/client.js";
import { createTestAgent, useTestApp } from "./helpers.js";

describe("retireClient service-layer guard", () => {
  const getApp = useTestApp();

  it("rejects retire while agents are pinned", async () => {
    const app = getApp();
    const { clientId } = await createTestAgent(app);
    await expect(retireClient(app.db, clientId)).rejects.toThrow(/still pinned/i);
  });

  it("succeeds once the pinned agent is deleted", async () => {
    const app = getApp();
    const { agent, clientId } = await createTestAgent(app);
    await app.db.update(agents).set({ status: "deleted", name: null }).where(eq(agents.uuid, agent.uuid));
    await expect(retireClient(app.db, clientId)).resolves.toBeUndefined();
  });
});
