import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { notifications } from "../db/schema/notifications.js";
import { createAgent } from "../services/agent.js";
import { bindAgentToClient, removeClientConnection, setClientConnection } from "../services/connection-manager.js";
import { createMeChat } from "../services/me-chat.js";
import { putOrgSetting } from "../services/org-settings.js";
import { bindAgent, setContextTreeBinding } from "../services/presence.js";
import { finalizeTreeWriteTaskResult, maybeStartTreeWriteOnArchive } from "../services/tree-write.js";
import { createAdminContext, useTestApp } from "./helpers.js";

describe("tree-write archive automation", () => {
  const getApp = useTestApp();

  it("creates a skipped notification when the eligible agent is offline", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: "tree-write-offline-skip" });
    const managed = await createAgent(app.db, {
      name: `managed-${crypto.randomUUID().slice(0, 8)}`,
      type: "autonomous_agent",
      displayName: "Managed Agent",
      managerId: admin.memberId,
      clientId: admin.clientId,
      treeWriteOnArchive: true,
    });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [managed.uuid],
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${encodeURIComponent(chatId)}/engagement`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { status: "archived" },
    });
    expect(res.statusCode).toBe(200);

    const rows = await app.db.select().from(notifications).where(eq(notifications.chatId, chatId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe("tree_write_completed");
    expect(rows[0]?.message).toContain("agent_offline");
  });

  it("sends task:tree_write:start for an online agent with a verified context-tree binding", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: "tree-write-online-start" });
    const managed = await createAgent(app.db, {
      name: `managed-${crypto.randomUUID().slice(0, 8)}`,
      type: "autonomous_agent",
      displayName: "Managed Agent",
      managerId: admin.memberId,
      clientId: admin.clientId,
      treeWriteOnArchive: true,
    });

    const ws = {
      readyState: 1,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;
    setClientConnection(admin.clientId, ws);
    bindAgentToClient(admin.clientId, managed.uuid);

    await bindAgent(app.db, managed.uuid, {
      clientId: admin.clientId,
      instanceId: "test-instance",
      runtimeType: "claude-code",
    });
    await putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree",
      {
        repo: "https://github.com/agent-team-foundation/first-tree-context.git",
        branch: "main",
      },
      { updatedBy: admin.memberId },
    );
    await setContextTreeBinding(app.db, managed.uuid, {
      contextTreeRepoUrl: "https://github.com/agent-team-foundation/first-tree-context.git",
      contextTreeBranch: "main",
      verificationStatus: "verified",
    });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [managed.uuid],
    });

    await maybeStartTreeWriteOnArchive(app.db, {
      sourceChatId: chatId,
      ownerUserId: admin.userId,
      ownerMemberId: admin.memberId,
    });

    expect(ws.send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String((ws.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])) as {
      type: string;
      taskId: string;
      sourceChatId: string;
      agentId: string;
    };
    expect(payload.type).toBe("task:tree_write:start");
    expect(payload.sourceChatId).toBe(chatId);
    expect(payload.agentId).toBe(managed.uuid);

    removeClientConnection(admin.clientId, ws);
  });

  it("ignores tree-write results from the wrong agent and accepts the right one", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: "tree-write-result-owner" });
    const managed = await createAgent(app.db, {
      name: `managed-${crypto.randomUUID().slice(0, 8)}`,
      type: "autonomous_agent",
      displayName: "Managed Agent",
      managerId: admin.memberId,
      clientId: admin.clientId,
      treeWriteOnArchive: true,
    });
    const other = await createAgent(app.db, {
      name: `other-${crypto.randomUUID().slice(0, 8)}`,
      type: "autonomous_agent",
      displayName: "Other Agent",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });

    const ws = {
      readyState: 1,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;
    setClientConnection(admin.clientId, ws);
    bindAgentToClient(admin.clientId, managed.uuid);

    await bindAgent(app.db, managed.uuid, {
      clientId: admin.clientId,
      instanceId: "test-instance",
      runtimeType: "claude-code",
    });
    await putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree",
      {
        repo: "https://github.com/agent-team-foundation/first-tree-context.git",
        branch: "main",
      },
      { updatedBy: admin.memberId },
    );
    await setContextTreeBinding(app.db, managed.uuid, {
      contextTreeRepoUrl: "https://github.com/agent-team-foundation/first-tree-context.git",
      contextTreeBranch: "main",
      verificationStatus: "verified",
    });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [managed.uuid],
    });

    await maybeStartTreeWriteOnArchive(app.db, {
      sourceChatId: chatId,
      ownerUserId: admin.userId,
      ownerMemberId: admin.memberId,
    });

    const payload = JSON.parse(String((ws.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])) as { taskId: string };
    expect(payload.taskId).toBeTruthy();

    await finalizeTreeWriteTaskResult(app.db, other.uuid, {
      type: "task:tree_write:result",
      taskId: payload.taskId,
      kind: "done",
      prUrl: "https://github.com/agent-team-foundation/first-tree-context/pull/123",
    });

    let rows = await app.db.select().from(notifications).where(eq(notifications.chatId, chatId));
    expect(rows).toHaveLength(0);

    await finalizeTreeWriteTaskResult(app.db, managed.uuid, {
      type: "task:tree_write:result",
      taskId: payload.taskId,
      kind: "done",
      prUrl: "https://github.com/agent-team-foundation/first-tree-context/pull/123",
    });

    rows = await app.db.select().from(notifications).where(eq(notifications.chatId, chatId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message).toContain("/pull/123");

    removeClientConnection(admin.clientId, ws);
  });
});
