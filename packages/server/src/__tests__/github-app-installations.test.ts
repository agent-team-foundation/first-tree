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
    it("first bind sets hub_organization_id; idempotent re-bind is a no-op at the row level", async () => {
      const app = getApp();
      const orgId = await makeOrg();
      const installation = { ...baseInstallation, id: 1_001_001 };
      await upsertInstallationFromMetadata(app.db, { installation });

      expect(await bindInstallationToOrg(app.db, installation.id, orgId)).toBe(true);
      const first = await findInstallationByGithubId(app.db, installation.id);
      expect(first?.hubOrganizationId).toBe(orgId);

      // Second call to the same org is allowed (idempotent retry-safe);
      // the row's hub_organization_id is unchanged.
      expect(await bindInstallationToOrg(app.db, installation.id, orgId)).toBe(true);
      const second = await findInstallationByGithubId(app.db, installation.id);
      expect(second?.hubOrganizationId).toBe(orgId);
    });

    it("refuses to rebind installation X to a different org (D2 1:1) — ConflictError", async () => {
      const app = getApp();
      const orgA = await makeOrg();
      const orgB = await makeOrg();
      const installation = { ...baseInstallation, id: 1_001_002 };
      await upsertInstallationFromMetadata(app.db, { installation });
      await bindInstallationToOrg(app.db, installation.id, orgA);
      const err = await bindInstallationToOrg(app.db, installation.id, orgB).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe("ConflictError");
      expect((err as Error).message).toMatch(/already bound to a different Hub team/);
    });

    it("refuses to bind installation Y when org A already has install X bound (H2 / codex P0-3 follow-up)", async () => {
      const app = getApp();
      const orgA = await makeOrg();
      const installX = { ...baseInstallation, id: 1_001_010 };
      const installY = { ...baseInstallation, id: 1_001_011, accountGithubId: 9_000_010 };
      await upsertInstallationFromMetadata(app.db, { installation: installX });
      await upsertInstallationFromMetadata(app.db, { installation: installY });
      await bindInstallationToOrg(app.db, installX.id, orgA);

      // Now try to bind installY to orgA — UNIQUE(hub_organization_id)
      // would surface as 23505; the service translates to ConflictError
      // with a clean user-facing message.
      const err = await bindInstallationToOrg(app.db, installY.id, orgA).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe("ConflictError");
      expect((err as Error).message).toMatch(/already bound to a different GitHub installation/);

      // installY remains unbound.
      const y = await findInstallationByGithubId(app.db, installY.id);
      expect(y?.hubOrganizationId).toBeNull();
    });

    it("NotFoundError when the installation row does not exist", async () => {
      const app = getApp();
      const orgId = await makeOrg();
      const err = await bindInstallationToOrg(app.db, 9_999_999, orgId).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe("NotFoundError");
      expect((err as Error).message).toMatch(/no installation row/i);
    });

    it("race-safe: two concurrent binds to different orgs — exactly one wins, other gets ConflictError", async () => {
      const app = getApp();
      const orgA = await makeOrg();
      const orgB = await makeOrg();
      const installation = { ...baseInstallation, id: 1_001_020 };
      await upsertInstallationFromMetadata(app.db, { installation });

      // Fire both calls concurrently. With the old SELECT-then-UPDATE
      // both could see NULL and the second UPDATE would silently win;
      // with the conditional UPDATE the second loses cleanly.
      const results = await Promise.allSettled([
        bindInstallationToOrg(app.db, installation.id, orgA),
        bindInstallationToOrg(app.db, installation.id, orgB),
      ]);
      const fulfilled = results.filter((r): r is PromiseFulfilledResult<boolean> => r.status === "fulfilled");
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason?.name).toBe("ConflictError");

      // The row's binding is one of the two orgs (whichever won the
      // race), not silently both / neither.
      const row = await findInstallationByGithubId(app.db, installation.id);
      expect([orgA, orgB]).toContain(row?.hubOrganizationId);
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

      // Unsuspend timestamp after the suspension → clears.
      await markInstallationUnsuspended(app.db, installation.id, new Date("2026-05-11T13:00:00Z"));
      const unsuspended = await findInstallationByGithubId(app.db, installation.id);
      expect(unsuspended?.suspendedAt).toBeNull();
    });

    it("a stale suspend (older timestamp) does not overwrite a newer suspend (codex P1-7)", async () => {
      const app = getApp();
      const installation = { ...baseInstallation, id: 1_002_002 };
      await upsertInstallationFromMetadata(app.db, { installation });

      const newer = new Date("2026-05-11T12:05:00Z");
      const stale = new Date("2026-05-11T12:00:00Z");
      await markInstallationSuspended(app.db, installation.id, newer);
      await markInstallationSuspended(app.db, installation.id, stale); // out-of-order redelivery
      const row = await findInstallationByGithubId(app.db, installation.id);
      expect(row?.suspendedAt?.toISOString()).toBe(newer.toISOString());
    });

    it("a stale unsuspend (timestamp before the current suspension) does not clear it (codex P1-7)", async () => {
      const app = getApp();
      const installation = { ...baseInstallation, id: 1_002_003 };
      await upsertInstallationFromMetadata(app.db, { installation });

      const suspendedAt = new Date("2026-05-11T12:10:00Z");
      await markInstallationSuspended(app.db, installation.id, suspendedAt);
      // Stale unsuspend whose receive-time predates the suspension → no-op.
      await markInstallationUnsuspended(app.db, installation.id, new Date("2026-05-11T12:00:00Z"));
      expect((await findInstallationByGithubId(app.db, installation.id))?.suspendedAt?.toISOString()).toBe(
        suspendedAt.toISOString(),
      );
      // A later unsuspend does clear it.
      await markInstallationUnsuspended(app.db, installation.id, new Date("2026-05-11T12:20:00Z"));
      expect((await findInstallationByGithubId(app.db, installation.id))?.suspendedAt).toBeNull();
    });
  });

  describe("deleteInstallationByGithubId", () => {
    it("deletes a row older than the grace window and is idempotent on a missing installation", async () => {
      const app = getApp();
      const installation = { ...baseInstallation, id: 1_003_001 };
      await upsertInstallationFromMetadata(app.db, { installation });
      // Backdate past the 1-minute grace window so `deleted` is honored.
      await app.db
        .update(githubAppInstallations)
        .set({ createdAt: new Date(Date.now() - 5 * 60_000) })
        .where(eq(githubAppInstallations.installationId, installation.id));

      await deleteInstallationByGithubId(app.db, installation.id);
      expect(await findInstallationByGithubId(app.db, installation.id)).toBeNull();
      // Repeated delete is a no-op (no row matches), not an error.
      await deleteInstallationByGithubId(app.db, installation.id);
    });

    it("does NOT delete a freshly-created row — guards against an out-of-order `deleted` after re-install (codex P1-7)", async () => {
      const app = getApp();
      const installation = { ...baseInstallation, id: 1_003_002 };
      await upsertInstallationFromMetadata(app.db, { installation }); // createdAt ≈ now
      await deleteInstallationByGithubId(app.db, installation.id);
      // Still there — the row is younger than the grace window.
      expect(await findInstallationByGithubId(app.db, installation.id)).not.toBeNull();
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
