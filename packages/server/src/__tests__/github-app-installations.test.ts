import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { githubAppInstallations } from "../db/schema/github-app-installations.js";
import { organizations } from "../db/schema/organizations.js";
import type { AppInstallation } from "../services/github-app.js";
import {
  bindInstallationToOrg,
  countInstallationsForOrg,
  deleteInstallationByGithubId,
  findInstallationByGithubId,
  findInstallationByOrg,
  markInstallationSuspended,
  markInstallationUnsuspended,
  upsertInstallationFromMetadata,
} from "../services/github-app-installations.js";
import { uuidv7 } from "../uuid.js";
import { useTestApp } from "./helpers.js";

const baseInstallation: AppInstallation = {
  id: 1_000_001,
  accountType: "Organization",
  accountLogin: "acme-inc",
  accountGithubId: 9_000_001,
  permissions: { contents: "write", pull_requests: "write", issues: "read" },
  events: ["issues", "pull_request", "push"],
  suspendedAt: null,
};

describe("services/github-app-installations", () => {
  const getApp = useTestApp();

  // UUIDv7's first 8 hex chars are ms-timestamp bits; consecutive calls
  // inside the same millisecond collide. Use the full uuid as the slug
  // disambiguator so rapid `makeOrg()` calls in one test stay unique.
  async function makeOrg(slug?: string): Promise<string> {
    const app = getApp();
    const id = uuidv7();
    const safeSlug = slug ?? `gh-app-test-${id}`;
    await app.db.insert(organizations).values({ id, name: safeSlug, displayName: safeSlug });
    return id;
  }

  describe("upsertInstallationFromMetadata", () => {
    it("INSERTs a fresh row when the installation_id is unseen", async () => {
      const app = getApp();
      const installation = { ...baseInstallation, id: 1_000_100 };
      const row = await upsertInstallationFromMetadata(app.db, { installation });
      expect(row.installationId).toBe(1_000_100);
      expect(row.accountType).toBe("Organization");
      expect(row.accountLogin).toBe("acme-inc");
      expect(row.permissions).toEqual({ contents: "write", pull_requests: "write", issues: "read" });
      expect(row.events).toEqual(["issues", "pull_request", "push"]);
      expect(row.hubOrganizationId).toBeNull();
      expect(row.suspendedAt).toBeNull();
    });

    it("UPDATEs metadata on re-install but preserves hub_organization_id", async () => {
      const app = getApp();
      const orgId = await makeOrg();
      const installation = { ...baseInstallation, id: 1_000_200 };
      await upsertInstallationFromMetadata(app.db, { installation });
      await bindInstallationToOrg(app.db, installation.id, orgId);

      // Re-install with a permission upgrade — no hubOrganizationId on the input.
      const upgraded: AppInstallation = {
        ...installation,
        permissions: { ...installation.permissions, members: "read" },
        events: [...installation.events, "member"],
      };
      const row = await upsertInstallationFromMetadata(app.db, { installation: upgraded });
      expect(row.permissions).toMatchObject({ members: "read" });
      expect(row.events).toContain("member");
      // Critical: the binding survives the re-install.
      expect(row.hubOrganizationId).toBe(orgId);
    });

    it("persists suspendedAt when GitHub reports it", async () => {
      const app = getApp();
      const installation: AppInstallation = {
        ...baseInstallation,
        id: 1_000_300,
        suspendedAt: "2026-05-11T10:00:00Z",
      };
      const row = await upsertInstallationFromMetadata(app.db, { installation });
      expect(row.suspendedAt?.toISOString()).toBe("2026-05-11T10:00:00.000Z");
    });
  });

  describe("bindInstallationToOrg", () => {
    it("returns true on first bind, false on idempotent re-bind to the same org", async () => {
      const app = getApp();
      const orgId = await makeOrg();
      const installation = { ...baseInstallation, id: 1_001_001 };
      await upsertInstallationFromMetadata(app.db, { installation });

      expect(await bindInstallationToOrg(app.db, installation.id, orgId)).toBe(true);
      expect(await bindInstallationToOrg(app.db, installation.id, orgId)).toBe(false);
    });

    it("refuses to rebind to a different org (D2 1:1)", async () => {
      const app = getApp();
      const orgA = await makeOrg();
      const orgB = await makeOrg();
      const installation = { ...baseInstallation, id: 1_001_002 };
      await upsertInstallationFromMetadata(app.db, { installation });
      await bindInstallationToOrg(app.db, installation.id, orgA);
      await expect(bindInstallationToOrg(app.db, installation.id, orgB)).rejects.toThrow(
        /already bound to a different Hub team/,
      );
    });

    it("throws when the installation row does not exist", async () => {
      const app = getApp();
      const orgId = await makeOrg();
      await expect(bindInstallationToOrg(app.db, 9_999_999, orgId)).rejects.toThrow(/no installation row/);
    });
  });

  describe("suspend / unsuspend", () => {
    it("markInstallationSuspended sets the timestamp; markInstallationUnsuspended clears it", async () => {
      const app = getApp();
      const installation = { ...baseInstallation, id: 1_002_001 };
      await upsertInstallationFromMetadata(app.db, { installation });

      await markInstallationSuspended(app.db, installation.id, new Date("2026-05-11T12:00:00Z"));
      const suspended = await findInstallationByGithubId(app.db, installation.id);
      expect(suspended?.suspendedAt?.toISOString()).toBe("2026-05-11T12:00:00.000Z");

      await markInstallationUnsuspended(app.db, installation.id);
      const unsuspended = await findInstallationByGithubId(app.db, installation.id);
      expect(unsuspended?.suspendedAt).toBeNull();
    });
  });

  describe("deleteInstallationByGithubId", () => {
    it("removes the row and is idempotent on a missing installation", async () => {
      const app = getApp();
      const installation = { ...baseInstallation, id: 1_003_001 };
      await upsertInstallationFromMetadata(app.db, { installation });
      await deleteInstallationByGithubId(app.db, installation.id);
      const after = await findInstallationByGithubId(app.db, installation.id);
      expect(after).toBeNull();
      // Repeated delete is a no-op (no row matches), not an error.
      await deleteInstallationByGithubId(app.db, installation.id);
    });
  });

  describe("ON DELETE SET NULL behavior survives org deletion", () => {
    it("nulls hub_organization_id when the bound org is deleted", async () => {
      const app = getApp();
      const orgId = await makeOrg();
      const installation = { ...baseInstallation, id: 1_004_001 };
      await upsertInstallationFromMetadata(app.db, { installation });
      await bindInstallationToOrg(app.db, installation.id, orgId);

      await app.db.delete(organizations).where(eq(organizations.id, orgId));

      const row = await findInstallationByGithubId(app.db, installation.id);
      expect(row).not.toBeNull();
      expect(row?.hubOrganizationId).toBeNull();
    });
  });

  describe("findInstallationByOrg / countInstallationsForOrg", () => {
    it("returns the bound row by org, or null when nothing is bound", async () => {
      const app = getApp();
      const orgId = await makeOrg();
      expect(await findInstallationByOrg(app.db, orgId)).toBeNull();
      expect(await countInstallationsForOrg(app.db, orgId)).toBe(0);

      const installation = { ...baseInstallation, id: 1_005_001 };
      await upsertInstallationFromMetadata(app.db, { installation });
      await bindInstallationToOrg(app.db, installation.id, orgId);

      const found = await findInstallationByOrg(app.db, orgId);
      expect(found?.installationId).toBe(1_005_001);
      expect(await countInstallationsForOrg(app.db, orgId)).toBe(1);
    });
  });

  describe("schema sanity", () => {
    it("the github_app_installations table is wired up via the schema barrel", async () => {
      const app = getApp();
      // Cheap smoke: query the table by a known column. Fails if the schema
      // forgot to export the table or the migration didn't run.
      const rows = await app.db
        .select()
        .from(githubAppInstallations)
        .where(eq(githubAppInstallations.installationId, -1))
        .limit(1);
      expect(rows).toEqual([]);
    });
  });
});
