import { describe, expect, it } from "vitest";
import type { Database } from "../db/connection.js";
import { getStats } from "../services/stats.js";

function fakeDb(resultSets: unknown[][]): Database {
  let index = 0;
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            groupBy: () => resultSets[index++] ?? [],
          }),
        }),
        where: () => ({
          groupBy: () => resultSets[index++] ?? [],
        }),
      }),
    }),
  };
  // Test double for the small Drizzle chain used by getStats.
  return db as unknown as Database;
}

describe("getStats", () => {
  it("merges sparse per-organization counts and derives totals", async () => {
    const db = fakeDb([
      [
        { organizationId: "org-a", agentCount: 2 },
        { organizationId: "org-b", agentCount: 1 },
      ],
      [
        { organizationId: "org-a", chatCount: 3 },
        { organizationId: "org-c", chatCount: 4 },
      ],
      [
        { organizationId: "org-a", messageCount: 5 },
        { organizationId: "org-c", messageCount: 6 },
      ],
    ]);

    await expect(getStats(db)).resolves.toEqual({
      totalAgents: 3,
      totalChats: 7,
      totalMessages: 11,
      byOrganization: [
        { organizationId: "org-a", agentCount: 2, chatCount: 3, messageCount: 5 },
        { organizationId: "org-b", agentCount: 1, chatCount: 0, messageCount: 0 },
        { organizationId: "org-c", agentCount: 0, chatCount: 4, messageCount: 6 },
      ],
    });
  });

  it("supports org-scoped empty results without extra total queries", async () => {
    await expect(getStats(fakeDb([[], [], []]), "org-empty")).resolves.toEqual({
      totalAgents: 0,
      totalChats: 0,
      totalMessages: 0,
      byOrganization: [],
    });
  });
});
