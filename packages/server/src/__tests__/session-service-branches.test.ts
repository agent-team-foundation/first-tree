import { describe, expect, it } from "vitest";
import type { Database } from "../db/connection.js";

type DbResult = unknown[];
type QueryChain = {
  execute: () => DbResult;
  for: () => DbResult;
  from: () => QueryChain;
  groupBy: () => DbResult;
  innerJoin: () => QueryChain;
  limit: () => DbResult;
  orderBy: () => QueryChain;
  select: () => QueryChain;
  selectDistinctOn: () => QueryChain;
  where: () => QueryChain;
};

function createDb(results: DbResult[]): Database {
  const next = (): DbResult => results.shift() ?? [];
  const chain: QueryChain = {
    execute: () => next(),
    for: () => next(),
    from: () => chain,
    groupBy: () => next(),
    innerJoin: () => chain,
    limit: () => next(),
    orderBy: () => chain,
    select: () => chain,
    selectDistinctOn: () => chain,
    where: () => chain,
  };
  // biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaitable; this test double mirrors that contract.
  Object.defineProperty(chain, "then", {
    value: (resolve: (value: DbResult) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(next()).then(resolve, reject),
  });
  const db = {
    execute: () => next(),
    select: () => chain,
    selectDistinctOn: () => chain,
  };
  return db as unknown as Database;
}

const updatedAt = new Date("2026-05-28T10:00:00.000Z");
const olderUpdatedAt = new Date("2026-05-28T09:00:00.000Z");
const chatCreatedAt = new Date("2026-05-28T08:00:00.000Z");

describe("session service branch coverage", () => {
  it("extracts summaries from object content, strips mentions/code, and preserves code points", async () => {
    const { extractSummary } = await import("../services/session.js");

    expect(extractSummary({ text: "@atlas please review `@param` handling" })).toBe("please review handling");
    expect(extractSummary("@atlas")).toBeNull();
    expect(extractSummary({ text: "🚀 release looks good" }, 2)).toBe("🚀 ");
    expect(extractSummary({ text: null })).toBeNull();
  });

  it("lists agent sessions with runtime filtering, message counts, and first-message summaries", async () => {
    const { listAgentSessions } = await import("../services/session.js");

    await expect(
      listAgentSessions(
        createDb([
          [
            {
              agentId: "agent-1",
              chatId: "chat-1",
              state: "active",
              updatedAt,
              chatCreatedAt,
              chatTopic: "Launch",
            },
          ],
          [{ runtimeState: "idle" }],
        ]),
        "agent-1",
        { runtimeState: "working" },
      ),
    ).resolves.toEqual([]);

    await expect(
      listAgentSessions(
        createDb([
          [
            {
              agentId: "agent-1",
              chatId: "chat-1",
              state: "active",
              updatedAt,
              chatCreatedAt,
              chatTopic: "Launch",
            },
            {
              agentId: "agent-1",
              chatId: "chat-2",
              state: "suspended",
              updatedAt: olderUpdatedAt,
              chatCreatedAt,
              chatTopic: null,
            },
          ],
          [{ runtimeState: "working" }],
          [{ chatId: "chat-1", count: 3 }],
          [
            { chatId: "chat-1", content: { text: "@atlas ship the branch" } },
            { chatId: "chat-2", content: "@atlas" },
          ],
        ]),
        "agent-1",
        { state: "active", runtimeState: "working" },
      ),
    ).resolves.toEqual([
      {
        agentId: "agent-1",
        chatId: "chat-1",
        lastActivityAt: updatedAt.toISOString(),
        messageCount: 3,
        runtimeState: "working",
        startedAt: chatCreatedAt.toISOString(),
        state: "active",
        summary: "ship the branch",
        topic: "Launch",
      },
      {
        agentId: "agent-1",
        chatId: "chat-2",
        lastActivityAt: olderUpdatedAt.toISOString(),
        messageCount: 0,
        runtimeState: "working",
        startedAt: chatCreatedAt.toISOString(),
        state: "suspended",
        summary: null,
        topic: null,
      },
    ]);
  });

  it("lists all sessions with filters, cursor pagination, presence, and summary maps", async () => {
    const { listAllSessions } = await import("../services/session.js");
    const rows = [
      {
        agentId: "agent-1",
        chatId: "chat-1",
        state: "active",
        updatedAt,
        chatCreatedAt,
        chatTopic: "Launch",
      },
      {
        agentId: "agent-2",
        chatId: "chat-2",
        state: "suspended",
        updatedAt: olderUpdatedAt,
        chatCreatedAt,
        chatTopic: null,
      },
      {
        agentId: "agent-3",
        chatId: "chat-3",
        state: "active",
        updatedAt: new Date("2026-05-28T08:30:00.000Z"),
        chatCreatedAt,
        chatTopic: "Overflow",
      },
    ];

    await expect(
      listAllSessions(
        createDb([
          rows,
          [
            { agentId: "agent-1", runtimeState: "working" },
            { agentId: "agent-2", runtimeState: "idle" },
          ],
          [
            { chatId: "chat-1", content: "First launch note" },
            { chatId: "chat-2", content: { text: "@atlas waiting" } },
          ],
        ]),
        2,
        "2026-05-29T00:00:00.000Z",
        { agentId: "agent-1", organizationId: "org-1", state: "active" },
      ),
    ).resolves.toEqual({
      items: [
        {
          agentId: "agent-1",
          chatId: "chat-1",
          lastActivityAt: updatedAt.toISOString(),
          messageCount: 0,
          runtimeState: "working",
          startedAt: chatCreatedAt.toISOString(),
          state: "active",
          summary: "First launch note",
          topic: "Launch",
        },
        {
          agentId: "agent-2",
          chatId: "chat-2",
          lastActivityAt: olderUpdatedAt.toISOString(),
          messageCount: 0,
          runtimeState: "idle",
          startedAt: chatCreatedAt.toISOString(),
          state: "suspended",
          summary: "waiting",
          topic: null,
        },
      ],
      nextCursor: olderUpdatedAt.toISOString(),
    });

    await expect(listAllSessions(createDb([[]]), 10)).resolves.toEqual({ items: [], nextCursor: null });
  });

  it("filters sessions by participant speaker access", async () => {
    const { filterSessionsByParticipant } = await import("../services/session.js");
    const sessions = [
      {
        agentId: "agent-1",
        chatId: "chat-1",
        lastActivityAt: updatedAt.toISOString(),
        messageCount: 0,
        runtimeState: null,
        startedAt: chatCreatedAt.toISOString(),
        state: "active",
        summary: null,
        topic: null,
      },
      {
        agentId: "agent-1",
        chatId: "chat-2",
        lastActivityAt: olderUpdatedAt.toISOString(),
        messageCount: 0,
        runtimeState: null,
        startedAt: chatCreatedAt.toISOString(),
        state: "active",
        summary: null,
        topic: null,
      },
    ];

    await expect(filterSessionsByParticipant(createDb([]), [], "agent-human")).resolves.toEqual([]);
    await expect(
      filterSessionsByParticipant(createDb([[{ chatId: "chat-2" }]]), sessions, "agent-human"),
    ).resolves.toEqual([sessions[1]]);
  });
});
