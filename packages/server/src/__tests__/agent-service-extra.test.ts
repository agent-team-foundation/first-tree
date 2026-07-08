import { AGENT_STATUSES } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import {
  checkAgentNameAvailability,
  clearAgentAvatarImage,
  createAgent,
  getAgentAvatarImage,
  listAgentsForAdmin,
  MAX_AVATAR_IMAGE_BYTES,
  setAgentAvatarImage,
} from "../services/agent.js";
import { createAdminContext, useTestApp } from "./helpers.js";

describe("agent service extra coverage", () => {
  const getApp = useTestApp();

  it("reports name availability for invalid, reserved, taken, and available names", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `agent-name-${crypto.randomUUID().slice(0, 8)}` });
    await createAgent(app.db, {
      name: "taken-agent",
      type: "agent",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });

    await expect(checkAgentNameAvailability(app.db, admin.organizationId, "Bad Name")).resolves.toEqual({
      available: false,
      reason: "invalid",
    });
    await expect(checkAgentNameAvailability(app.db, admin.organizationId, "system")).resolves.toEqual({
      available: false,
      reason: "reserved",
    });
    await expect(checkAgentNameAvailability(app.db, admin.organizationId, "taken-agent")).resolves.toEqual({
      available: false,
      reason: "taken",
    });
    await expect(checkAgentNameAvailability(app.db, admin.organizationId, "free-agent")).resolves.toEqual({
      available: true,
    });
  });

  it("paginates admin agent listings and skips deleted rows", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `agent-admin-list-${crypto.randomUUID().slice(0, 8)}` });
    const older = await createAgent(app.db, {
      name: `admin-old-${crypto.randomUUID().slice(0, 8)}`,
      type: "agent",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const newer = await createAgent(app.db, {
      name: `admin-new-${crypto.randomUUID().slice(0, 8)}`,
      type: "agent",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const deleted = await createAgent(app.db, {
      name: `admin-deleted-${crypto.randomUUID().slice(0, 8)}`,
      type: "agent",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });

    await app.db
      .update(agents)
      .set({ createdAt: new Date("2030-01-01T00:00:00.000Z") })
      .where(eq(agents.uuid, older.uuid));
    await app.db
      .update(agents)
      .set({ createdAt: new Date("2030-01-02T00:00:00.000Z") })
      .where(eq(agents.uuid, newer.uuid));
    await app.db
      .update(agents)
      .set({ status: AGENT_STATUSES.DELETED, createdAt: new Date("2030-01-03T00:00:00.000Z") })
      .where(eq(agents.uuid, deleted.uuid));

    const scope = {
      userId: admin.userId,
      organizationId: admin.organizationId,
      memberId: admin.memberId,
      role: "admin" as const,
      humanAgentId: admin.humanAgentUuid,
    };

    const firstPage = await listAgentsForAdmin(app.db, scope, 1);
    expect(firstPage.items.map((agent) => agent.uuid)).toEqual([newer.uuid]);
    expect(firstPage.nextCursor).toBe("2030-01-02T00:00:00.000Z");

    const secondPage = await listAgentsForAdmin(app.db, scope, 5, firstPage.nextCursor ?? undefined);
    expect(secondPage.items.map((agent) => agent.uuid)).toContain(older.uuid);
    expect(secondPage.items.map((agent) => agent.uuid)).not.toContain(deleted.uuid);
    expect(secondPage.nextCursor).toBeNull();
  });

  it("validates, stores, reads, and clears avatar image blobs", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `agent-avatar-${crypto.randomUUID().slice(0, 8)}` });
    const agent = await createAgent(app.db, {
      name: `avatar-agent-${crypto.randomUUID().slice(0, 8)}`,
      type: "agent",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });

    await expect(getAgentAvatarImage(app.db, agent.uuid)).resolves.toBeNull();
    await expect(setAgentAvatarImage(app.db, agent.uuid, Buffer.from("avatar"), "image/gif")).rejects.toBeInstanceOf(
      BadRequestError,
    );
    await expect(setAgentAvatarImage(app.db, agent.uuid, Buffer.alloc(0), "image/png")).rejects.toBeInstanceOf(
      BadRequestError,
    );
    await expect(
      setAgentAvatarImage(app.db, agent.uuid, Buffer.alloc(MAX_AVATAR_IMAGE_BYTES + 1), "image/png"),
    ).rejects.toBeInstanceOf(BadRequestError);
    await expect(
      setAgentAvatarImage(app.db, crypto.randomUUID(), Buffer.from("avatar"), "image/png"),
    ).rejects.toBeInstanceOf(NotFoundError);

    const updatedAt = await setAgentAvatarImage(app.db, agent.uuid, Buffer.from("avatar"), "image/png");
    await expect(getAgentAvatarImage(app.db, agent.uuid)).resolves.toEqual({
      data: Buffer.from("avatar"),
      mime: "image/png",
      updatedAt,
    });

    await clearAgentAvatarImage(app.db, agent.uuid);
    await expect(getAgentAvatarImage(app.db, agent.uuid)).resolves.toBeNull();
    await expect(clearAgentAvatarImage(app.db, crypto.randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  });
});
