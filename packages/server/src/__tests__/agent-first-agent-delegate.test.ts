import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { createAgent, updateAgent } from "../services/agent.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

/**
 * First-agent → delegate adoption (createAgent + POST /orgs/:orgId/agents).
 *
 * A member's FIRST non-human agent is auto-adopted as their delegate
 * (`delegateMention` on their human agent), so the new-chat default recipient
 * and the GitHub @mention forward target work out of the box. Adoption fires
 * only on a SELF-create (the route passes `adoptAsDelegateIfFirst` only when
 * `managerId === scope.memberId`), is first-agent-only, and is only-if-unset
 * (atomic via a `delegateMention IS NULL` UPDATE guard). Companion to the
 * source-type and cross-org delegate guards.
 */
async function readDelegate(
  app: ReturnType<ReturnType<typeof useTestApp>>,
  humanAgentUuid: string,
): Promise<string | null> {
  const [row] = await app.db
    .select({ delegateMention: agents.delegateMention })
    .from(agents)
    .where(eq(agents.uuid, humanAgentUuid))
    .limit(1);
  return row?.delegateMention ?? null;
}

describe("agent service — first-agent delegate adoption", () => {
  const getApp = useTestApp();

  it("adopts a member's first agent as their delegate when self-created", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    expect(await readDelegate(app, admin.humanAgentUuid)).toBeNull();

    const first = await createAgent(
      app.db,
      { name: `a1-${randomUUID().slice(0, 6)}`, type: "agent", displayName: "First", managerId: admin.memberId },
      { adoptAsDelegateIfFirst: true },
    );

    expect(await readDelegate(app, admin.humanAgentUuid)).toBe(first.uuid);
  });

  it("adopts a private first agent (visibility is not required)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const first = await createAgent(
      app.db,
      {
        name: `pa-${randomUUID().slice(0, 6)}`,
        type: "agent",
        displayName: "Private assistant",
        visibility: "private",
        managerId: admin.memberId,
      },
      { adoptAsDelegateIfFirst: true },
    );

    expect(first.visibility).toBe("private");
    expect(await readDelegate(app, admin.humanAgentUuid)).toBe(first.uuid);
  });

  it("does not adopt unless the self-create intent is passed", async () => {
    // The bootstrap, system/webhook, and admin-for-other paths never pass
    // `adoptAsDelegateIfFirst`, so a first agent created without it leaves the
    // manager's delegate untouched.
    const app = getApp();
    const admin = await createTestAdmin(app);

    await createAgent(app.db, {
      name: `sys-${randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "System",
      managerId: admin.memberId,
    });

    expect(await readDelegate(app, admin.humanAgentUuid)).toBeNull();
  });

  it("does not change the delegate when a second agent is created", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const first = await createAgent(
      app.db,
      { name: `a1-${randomUUID().slice(0, 6)}`, type: "agent", displayName: "First", managerId: admin.memberId },
      { adoptAsDelegateIfFirst: true },
    );
    const second = await createAgent(
      app.db,
      { name: `a2-${randomUUID().slice(0, 6)}`, type: "agent", displayName: "Second", managerId: admin.memberId },
      { adoptAsDelegateIfFirst: true },
    );

    expect(second.uuid).not.toBe(first.uuid);
    expect(await readDelegate(app, admin.humanAgentUuid)).toBe(first.uuid);
  });

  it("does not overwrite a delegate already set before the member's first own agent", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    // A second member in the same org owns the pre-set target, so it does not
    // count toward `admin`'s own-agent tally (keeping the first-agent count at 1
    // below — isolating the only-if-unset guard from the count guard).
    const other = await createTestAdmin(app);
    const target = await createAgent(
      app.db,
      {
        name: `tgt-${randomUUID().slice(0, 6)}`,
        type: "agent",
        displayName: "Pre-set target",
        visibility: "organization",
        managerId: other.memberId,
      },
      { adoptAsDelegateIfFirst: true },
    );
    await updateAgent(app.db, admin.humanAgentUuid, { delegateMention: target.uuid });

    // admin's OWN first agent — tally is 1, but the delegate is already set.
    await createAgent(
      app.db,
      { name: `a1-${randomUUID().slice(0, 6)}`, type: "agent", displayName: "First own", managerId: admin.memberId },
      { adoptAsDelegateIfFirst: true },
    );

    expect(await readDelegate(app, admin.humanAgentUuid)).toBe(target.uuid);
  });
});

describe("POST /orgs/:orgId/agents — delegate adoption is self-only", () => {
  const getApp = useTestApp();

  async function postAgent(
    app: ReturnType<ReturnType<typeof useTestApp>>,
    accessToken: string,
    orgId: string,
    body: Record<string, unknown>,
  ) {
    return app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: body,
    });
  }

  it("adopts the caller's first agent as their delegate on a self-create", async () => {
    const app = getApp();
    const member = await createTestAdmin(app);

    const res = await postAgent(app, member.accessToken, member.organizationId, {
      name: `mine-${randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Mine",
    });
    expect(res.statusCode).toBe(201);
    const created = res.json() as { uuid: string };

    expect(await readDelegate(app, member.humanAgentUuid)).toBe(created.uuid);
  });

  it("does NOT set another member's delegate when an admin creates an agent for them", async () => {
    // Regression: delegate is a personal choice — the PATCH path rejects an
    // admin setting another member's delegate, so create-for-other must not set
    // it as a side effect either.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const bob = await createTestAdmin(app); // same default org, a different member

    const res = await postAgent(app, admin.accessToken, admin.organizationId, {
      name: `for-bob-${randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "For Bob",
      managerId: bob.memberId,
    });
    expect(res.statusCode).toBe(201);

    // Bob's first agent now exists, but his delegate was NOT touched by the
    // admin's create.
    expect(await readDelegate(app, bob.humanAgentUuid)).toBeNull();
  });
});
