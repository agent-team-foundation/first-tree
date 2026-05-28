import type { Attention } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const attention: Attention = {
  id: "attention-1",
  originAgentId: "agent-origin",
  originChatId: "chat-1",
  targetHumanId: "human-1",
  subject: "Need approval",
  body: "Please approve.",
  requiresResponse: true,
  state: "open",
  response: null,
  respondedBy: null,
  respondedAt: null,
  cancelled: false,
  cancelledReason: null,
  createdAt: "2026-05-28T00:00:00.000Z",
  closedAt: null,
  metadata: {},
};

function appWithChatOrg(organizationId: string | null): FastifyInstance {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => (organizationId === null ? [] : [{ organizationId }]),
  };
  // FastifyInstance carries many runtime fields; these helpers only need db.select().
  return { db: { select: () => chain } } as unknown as FastifyInstance;
}

describe("attention API notification helpers", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("broadcasts opened and cancelled frames with the chat organization id", async () => {
    const broadcastToAdminsMock = vi.fn();
    const { registerAdminBroadcaster } = await import("../services/admin-broadcast.js");
    const { emitAttentionCancelled, emitAttentionOpened } = await import("../api/attention.js");
    registerAdminBroadcaster(broadcastToAdminsMock);
    const app = appWithChatOrg("org-1");

    await emitAttentionOpened(app, attention);
    await emitAttentionCancelled(app, { ...attention, cancelledReason: "obsolete" });

    expect(broadcastToAdminsMock).toHaveBeenCalledWith({
      type: "attention:opened",
      attentionId: "attention-1",
      chatId: "chat-1",
      targetHumanId: "human-1",
      requiresResponse: true,
      organizationId: "org-1",
    });
    expect(broadcastToAdminsMock).toHaveBeenCalledWith({
      type: "attention:cancelled",
      attentionId: "attention-1",
      chatId: "chat-1",
      targetHumanId: "human-1",
      reason: "obsolete",
      organizationId: "org-1",
    });
  });

  it("does not broadcast when the originating chat no longer exists", async () => {
    const broadcastToAdminsMock = vi.fn();
    const { registerAdminBroadcaster } = await import("../services/admin-broadcast.js");
    const { emitAttentionCancelled, emitAttentionOpened } = await import("../api/attention.js");
    registerAdminBroadcaster(broadcastToAdminsMock);
    const app = appWithChatOrg(null);

    await emitAttentionOpened(app, attention);
    await emitAttentionCancelled(app, attention);

    expect(broadcastToAdminsMock).not.toHaveBeenCalled();
  });
});
