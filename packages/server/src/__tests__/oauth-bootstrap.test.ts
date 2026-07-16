import { googleExternalProfile } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
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
});
