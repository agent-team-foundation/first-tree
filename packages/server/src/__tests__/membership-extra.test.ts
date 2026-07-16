import { describe, expect, it } from "vitest";
import { createPersonalTeam, deactivateMembership, MEMBER_STATUSES } from "../services/membership.js";
import { createAdminContext, useTestApp } from "./helpers.js";

describe("membership service edge coverage", () => {
  const getApp = useTestApp();

  it("rejects deactivation when the membership is already in a different inactive state", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `membership-state-${crypto.randomUUID().slice(0, 8)}` });

    await deactivateMembership(app.db, admin.memberId, MEMBER_STATUSES.REMOVED);

    await expect(deactivateMembership(app.db, admin.memberId, MEMBER_STATUSES.LEFT)).rejects.toThrow(/not active/);
  });

  it("falls back to a uuid-based organization slug after repeated insert collisions", async () => {
    let organizationInsertAttempts = 0;
    const insertedOrganizationNames: string[] = [];
    const insertedMembers: Record<string, unknown>[] = [];
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
      insert: () => ({
        values: (value: Record<string, unknown>) => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              organizationInsertAttempts += 1;
              if (organizationInsertAttempts <= 4) return [];
              if (typeof value.name === "string") insertedOrganizationNames.push(value.name);
              return [{ name: value.name }];
            },
          }),
        }),
      }),
      transaction: async (callback: (tx: unknown) => Promise<Record<string, unknown>>) => {
        return callback({
          insert: () => ({
            values: (value: Record<string, unknown>) => ({
              returning: async () => {
                insertedMembers.push(value);
                return [
                  {
                    id: "member-1",
                    userId: value.userId,
                    organizationId: value.organizationId,
                    agentId: value.agentId,
                    role: value.role,
                    status: value.status,
                  },
                ];
              },
            }),
          }),
        });
      },
    };

    await expect(
      createPersonalTeam(fakeDb as never, {
        userId: "user-1",
        username: "Retry User",
        teamDisplayName: "Retry User's team",
        userDisplayName: "Retry User",
      }),
    ).resolves.toMatchObject({
      slug: expect.stringMatching(/^retry-user-[0-9a-f-]{12}$/),
      memberId: "member-1",
    });

    expect(organizationInsertAttempts).toBe(5);
    expect(insertedOrganizationNames).toHaveLength(1);
    expect(insertedMembers).toHaveLength(1);
  });
});
