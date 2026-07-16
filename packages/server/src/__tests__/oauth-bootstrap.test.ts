import { googleExternalProfile } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { connectDatabase } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { authIdentities } from "../db/schema/auth-identities.js";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { findOrCreateUserFromExternalAccount } from "../services/auth-identity.js";
import { completeExternalAccountBootstrap } from "../services/oauth-bootstrap.js";
import { useTestApp } from "./helpers.js";

describe("provider-neutral OAuth bootstrap", () => {
  const getApp = useTestApp({ googleOAuth: true });

  it("creates the full personal team graph for Google and preserves production-scan quickstart", async () => {
    const app = getApp();
    const account = await findOrCreateUserFromExternalAccount(
      app.db,
      googleExternalProfile({
        sub: "google-bootstrap-subject",
        email: "Workspace.Owner@example.com",
        emailVerified: true,
        name: "Workspace Owner",
      }),
    );
    const next = `/quickstart?campaign=production-scan&repo=${encodeURIComponent("https://github.com/acme/backend")}`;

    const result = await completeExternalAccountBootstrap(app.db, account, {
      next,
      allowedOrganizationId: null,
      ip: "127.0.0.1",
      userAgent: "oauth-bootstrap-test",
    });

    expect(result).toMatchObject({
      joinPath: "solo",
      next,
      orgPinned: true,
      teamCreated: true,
    });
    const [identity] = await app.db.select().from(authIdentities).where(eq(authIdentities.userId, account.userId));
    expect(identity).toMatchObject({ provider: "google", identifier: "google-bootstrap-subject" });

    const [organization] = await app.db.select().from(organizations).where(eq(organizations.id, result.organizationId));
    expect(organization).toMatchObject({
      name: "workspace-owner",
      displayName: "Workspace Owner's team",
    });

    const [membership] = await app.db.select().from(members).where(eq(members.userId, account.userId));
    expect(membership).toMatchObject({
      organizationId: result.organizationId,
      role: "admin",
      status: "active",
    });
    const [humanAgent] = await app.db
      .select()
      .from(agents)
      .where(eq(agents.uuid, membership?.agentId ?? ""));
    expect(humanAgent).toMatchObject({
      name: "workspace-owner",
      displayName: "Workspace Owner",
      type: "human",
    });
  });

  it("resets an ordinary first-sign-in destination to onboarding entry", async () => {
    const app = getApp();
    const account = await findOrCreateUserFromExternalAccount(
      app.db,
      googleExternalProfile({ sub: "google-settings-subject", name: "Settings User" }),
    );

    const result = await completeExternalAccountBootstrap(app.db, account, {
      next: "/settings/github",
      allowedOrganizationId: null,
      ip: null,
      userAgent: null,
    });

    expect(result).toMatchObject({ joinPath: "solo", next: "/", teamCreated: true });
  });

  it("serializes concurrent first sign-ins into one personal team graph", async () => {
    const app = getApp();
    const databaseUrl = process.env.DATABASE_URL ?? "";
    if (!databaseUrl) throw new Error("DATABASE_URL is required for the concurrency test");
    const firstDb = connectDatabase(databaseUrl);
    const secondDb = connectDatabase(databaseUrl);
    const bootstrapInput = {
      next: "/",
      allowedOrganizationId: null,
      ip: null,
      userAgent: "oauth-bootstrap-concurrency-test",
    };
    try {
      const results = await Promise.all(
        [firstDb, secondDb].map(async (db, index) => {
          const account = await findOrCreateUserFromExternalAccount(
            db,
            googleExternalProfile({
              sub: "google-bootstrap-concurrent-subject",
              email: `bootstrap-race-${index}@example.com`,
              emailVerified: true,
              name: `Bootstrap Race ${index}`,
            }),
          );
          return completeExternalAccountBootstrap(db, account, bootstrapInput);
        }),
      );

      expect(results[0]?.account.userId).toBe(results[1]?.account.userId);
      expect(results[0]?.organizationId).toBe(results[1]?.organizationId);
      expect(results.map((result) => result.teamCreated).sort()).toEqual([false, true]);

      const [identity] = await app.db
        .select({ userId: authIdentities.userId })
        .from(authIdentities)
        .where(eq(authIdentities.identifier, "google-bootstrap-concurrent-subject"));
      expect(identity?.userId).toBe(results[0]?.account.userId);
      const userTeams = await app.db
        .select({ organizationId: members.organizationId })
        .from(members)
        .where(eq(members.userId, results[0]?.account.userId ?? ""));
      expect(userTeams).toHaveLength(1);
      const teams = await app.db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, results[0]?.organizationId ?? ""));
      expect(teams).toHaveLength(1);
      const humanAgents = await app.db
        .select({ uuid: agents.uuid })
        .from(agents)
        .where(eq(agents.organizationId, results[0]?.organizationId ?? ""));
      expect(humanAgents).toHaveLength(1);
    } finally {
      await firstDb.end();
      await secondDb.end();
    }
  });
});
