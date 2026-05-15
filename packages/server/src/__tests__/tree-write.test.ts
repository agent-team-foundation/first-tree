import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { treeWriteTasks } from "../db/schema/tree-write-tasks.js";
import { createAgent } from "../services/agent.js";
import { createMeChat, setChatEngagement } from "../services/me-chat.js";
import { dispatchTreeWriteTask } from "../services/tree-write.js";
import { uuidv7 } from "../uuid.js";
import { createAdminContext, useTestApp } from "./helpers.js";

describe("tree-write tasks", () => {
  const getApp = useTestApp();

  it("archive_seq increments only on real active -> archived transitions", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: "tree-write-archive-seq" });
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

    const first = await setChatEngagement(app.db, chatId, admin.humanAgentUuid, "archived");
    expect(first.archiveSeq).toBe(1);

    const revive = await setChatEngagement(app.db, chatId, admin.humanAgentUuid, "active");
    expect(revive.archiveSeq).toBe(1);

    const second = await setChatEngagement(app.db, chatId, admin.humanAgentUuid, "archived");
    expect(second.archiveSeq).toBe(2);
  });

  it("POST /chats/:id/engagement enqueues a tree-write task for the single eligible managed agent", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: "tree-write-enqueue" });
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

    const rows = await app.db.select().from(treeWriteTasks).where(eq(treeWriteTasks.sourceChatId, chatId));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.agentId).toBe(managed.uuid);
    expect(rows[0]?.archiveSeq).toBe(1);
    expect(rows[0]?.state).toBe("pending");
  });

  it("dispatchTreeWriteTask retries when the target agent is offline instead of finalizing no_write", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: "tree-write-offline-retry" });
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

    const taskId = uuidv7();
    await app.db.insert(treeWriteTasks).values({
      id: taskId,
      sourceChatId: chatId,
      ownerUserId: admin.userId,
      archiveSeq: 1,
      agentId: managed.uuid,
      state: "running",
      attemptCount: 1,
      nextAttemptAt: new Date(),
      updatedAt: new Date(),
    });

    await dispatchTreeWriteTask(app.db, {
      id: taskId,
      source_chat_id: chatId,
      owner_user_id: admin.userId,
      archive_seq: 1,
      agent_id: managed.uuid,
      exec_chat_id: null,
      attempt_count: 1,
    });

    const [row] = await app.db.execute<{
      state: string;
      result_kind: string | null;
      last_error: string | null;
    }>(sql`
      SELECT state, result_kind, last_error
      FROM tree_write_tasks
      WHERE id = ${taskId}
    `);

    expect(row?.state).toBe("pending");
    expect(row?.result_kind).toBeNull();
    expect(row?.last_error).toContain("offline");
  });
});
