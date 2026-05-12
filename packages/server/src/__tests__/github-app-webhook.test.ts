import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { githubAppInstallations } from "../db/schema/github-app-installations.js";
import { organizations } from "../db/schema/organizations.js";
import { findInstallationByGithubId, upsertInstallationFromMetadata } from "../services/github-app-installations.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

const WEBHOOK_SECRET = "test-app-webhook-secret";
const PATH = "/api/v1/webhooks/github";

function signBody(body: string): string {
  return `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`;
}

function buildInstallationPayload(
  action: string,
  overrides: Partial<{
    id: number;
    accountId: number;
    accountLogin: string;
    accountType: "User" | "Organization";
    permissions: Record<string, "read" | "write" | "admin">;
    events: string[];
    suspended_at: string | null;
  }> = {},
): Record<string, unknown> {
  return {
    action,
    installation: {
      id: overrides.id ?? 9_900_001,
      account: {
        id: overrides.accountId ?? 8_800_001,
        login: overrides.accountLogin ?? "acme",
        type: overrides.accountType ?? "Organization",
      },
      permissions: overrides.permissions ?? { contents: "write", issues: "read" },
      events: overrides.events ?? ["issues", "pull_request"],
      suspended_at: overrides.suspended_at ?? null,
    },
  };
}

describe("GitHub App webhook (/api/v1/webhooks/github)", () => {
  const getApp = useTestApp();

  async function makeOrgWithInstallation(installationId: number): Promise<{ orgId: string }> {
    const app = getApp();
    const orgId = uuidv7();
    await app.db
      .insert(organizations)
      .values({ id: orgId, name: `gh-app-wh-${orgId}`, displayName: `gh-app-wh-${orgId}` });
    await upsertInstallationFromMetadata(app.db, {
      installation: {
        id: installationId,
        accountType: "Organization",
        accountLogin: "acme",
        accountGithubId: 7_700_001,
        permissions: {},
        events: [],
        suspendedAt: null,
      },
      hubOrganizationId: orgId,
    });
    return { orgId };
  }

  describe("HMAC + headers", () => {
    it("returns 401 when the signature header is missing", async () => {
      const app = getApp();
      const body = JSON.stringify(buildInstallationPayload("created"));
      const res = await app.inject({
        method: "POST",
        url: PATH,
        headers: {
          "content-type": "application/json",
          "x-github-event": "installation",
          "x-github-delivery": uuidv7(),
        },
        payload: body,
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 401 when the signature doesn't verify", async () => {
      const app = getApp();
      const body = JSON.stringify(buildInstallationPayload("created"));
      const res = await app.inject({
        method: "POST",
        url: PATH,
        headers: {
          "content-type": "application/json",
          "x-github-event": "installation",
          "x-github-delivery": uuidv7(),
          "x-hub-signature-256": "sha256=deadbeef",
        },
        payload: body,
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 400 when x-github-event is missing", async () => {
      const app = getApp();
      const body = JSON.stringify(buildInstallationPayload("created"));
      const res = await app.inject({
        method: "POST",
        url: PATH,
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": signBody(body),
          "x-github-delivery": uuidv7(),
        },
        payload: body,
      });
      expect(res.statusCode).toBe(400);
    });

    it("ping returns 200 ok without dedup or state change", async () => {
      const app = getApp();
      const body = JSON.stringify({ zen: "Hello!" });
      const res = await app.inject({
        method: "POST",
        url: PATH,
        headers: {
          "content-type": "application/json",
          "x-github-event": "ping",
          "x-github-delivery": uuidv7(),
          "x-hub-signature-256": signBody(body),
        },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, event: "ping" });
    });
  });

  describe("installation lifecycle", () => {
    it("installation:created UPSERTs a fresh row", async () => {
      const app = getApp();
      const installationId = 9_910_001;
      const body = JSON.stringify(buildInstallationPayload("created", { id: installationId }));
      const res = await app.inject({
        method: "POST",
        url: PATH,
        headers: {
          "content-type": "application/json",
          "x-github-event": "installation",
          "x-github-delivery": uuidv7(),
          "x-hub-signature-256": signBody(body),
        },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      const row = await findInstallationByGithubId(app.db, installationId);
      expect(row?.accountLogin).toBe("acme");
      expect(row?.permissions).toMatchObject({ contents: "write" });
    });

    it("installation:deleted removes the row (when it's past the create-grace window)", async () => {
      const app = getApp();
      const { orgId } = await makeOrgWithInstallation(9_910_002);
      expect(orgId).toBeTruthy();
      // `installation: deleted` only deletes rows older than the 1-minute
      // grace window (codex P1-7 — guards a delayed `deleted` from wiping a
      // just-created re-install row). Backdate so this exercises the
      // delete path.
      await app.db
        .update(githubAppInstallations)
        .set({ createdAt: new Date(Date.now() - 5 * 60_000) })
        .where(eq(githubAppInstallations.installationId, 9_910_002));
      const body = JSON.stringify(buildInstallationPayload("deleted", { id: 9_910_002 }));
      const res = await app.inject({
        method: "POST",
        url: PATH,
        headers: {
          "content-type": "application/json",
          "x-github-event": "installation",
          "x-github-delivery": uuidv7(),
          "x-hub-signature-256": signBody(body),
        },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      const row = await findInstallationByGithubId(app.db, 9_910_002);
      expect(row).toBeNull();
    });

    it("installation:deleted does NOT remove a row created within the grace window (codex P1-7)", async () => {
      const app = getApp();
      const installationId = 9_910_009;
      await makeOrgWithInstallation(installationId); // createdAt ≈ now
      const body = JSON.stringify(buildInstallationPayload("deleted", { id: installationId }));
      const res = await app.inject({
        method: "POST",
        url: PATH,
        headers: {
          "content-type": "application/json",
          "x-github-event": "installation",
          "x-github-delivery": uuidv7(),
          "x-hub-signature-256": signBody(body),
        },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      // Row survives — a stale `deleted` mustn't wipe a fresh re-install.
      expect(await findInstallationByGithubId(app.db, installationId)).not.toBeNull();
    });

    it("installation:suspend sets suspended_at; installation:unsuspend clears it", async () => {
      const app = getApp();
      const installationId = 9_910_003;
      await makeOrgWithInstallation(installationId);

      const suspendBody = JSON.stringify(buildInstallationPayload("suspend", { id: installationId }));
      const sRes = await app.inject({
        method: "POST",
        url: PATH,
        headers: {
          "content-type": "application/json",
          "x-github-event": "installation",
          "x-github-delivery": uuidv7(),
          "x-hub-signature-256": signBody(suspendBody),
        },
        payload: suspendBody,
      });
      expect(sRes.statusCode).toBe(200);
      expect((await findInstallationByGithubId(app.db, installationId))?.suspendedAt).not.toBeNull();

      const unsuspendBody = JSON.stringify(buildInstallationPayload("unsuspend", { id: installationId }));
      const uRes = await app.inject({
        method: "POST",
        url: PATH,
        headers: {
          "content-type": "application/json",
          "x-github-event": "installation",
          "x-github-delivery": uuidv7(),
          "x-hub-signature-256": signBody(unsuspendBody),
        },
        payload: unsuspendBody,
      });
      expect(uRes.statusCode).toBe(200);
      expect((await findInstallationByGithubId(app.db, installationId))?.suspendedAt).toBeNull();
    });

    it("installation:new_permissions_accepted re-snapshots permissions", async () => {
      const app = getApp();
      const installationId = 9_910_004;
      await makeOrgWithInstallation(installationId);

      const body = JSON.stringify(
        buildInstallationPayload("new_permissions_accepted", {
          id: installationId,
          permissions: { contents: "write", members: "read" },
          events: ["issues", "pull_request", "member"],
        }),
      );
      const res = await app.inject({
        method: "POST",
        url: PATH,
        headers: {
          "content-type": "application/json",
          "x-github-event": "installation",
          "x-github-delivery": uuidv7(),
          "x-hub-signature-256": signBody(body),
        },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      const row = await findInstallationByGithubId(app.db, installationId);
      expect(row?.permissions).toMatchObject({ members: "read" });
      expect(row?.events).toContain("member");
    });

    it("preserves the org binding on installation re-snapshot", async () => {
      const app = getApp();
      const installationId = 9_910_005;
      const { orgId } = await makeOrgWithInstallation(installationId);

      const body = JSON.stringify(
        buildInstallationPayload("new_permissions_accepted", {
          id: installationId,
          permissions: { contents: "write" },
        }),
      );
      await app.inject({
        method: "POST",
        url: PATH,
        headers: {
          "content-type": "application/json",
          "x-github-event": "installation",
          "x-github-delivery": uuidv7(),
          "x-hub-signature-256": signBody(body),
        },
        payload: body,
      });

      const row = await findInstallationByGithubId(app.db, installationId);
      expect(row?.hubOrganizationId).toBe(orgId);
    });
  });

  describe("other events", () => {
    it("unknown installation returns 503 with reason='no_binding' so GitHub redelivers (codex P1-6)", async () => {
      const app = getApp();
      const body = JSON.stringify({
        action: "opened",
        installation: { id: 9_999_999 },
        issue: { number: 1, title: "x", body: "", html_url: "" },
        repository: { full_name: "u/r" },
        sender: { login: "u" },
      });
      const res = await app.inject({
        method: "POST",
        url: PATH,
        headers: {
          "content-type": "application/json",
          "x-github-event": "issues",
          "x-github-delivery": uuidv7(),
          "x-hub-signature-256": signBody(body),
        },
        payload: body,
      });
      // 503 (not 200) — a 2xx would tell GitHub the delivery succeeded and
      // it'd never retry, dropping the event for good.
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ ok: false, routed: false, reason: "no_binding" });
    });

    it("does NOT claim the delivery on no_binding — a redelivery after the bind lands is routed (codex P1-6)", async () => {
      const app = getApp();
      // The bound org needs an admin member for the github-adapter agent
      // to be createable when the redelivered event actually routes.
      const admin = await createTestAdmin(app, { username: `wh-redeliver-${uuidv7().slice(0, 8)}` });
      const installationId = 9_960_001;
      const deliveryId = uuidv7();
      const body = JSON.stringify({
        action: "opened",
        installation: { id: installationId },
        issue: { number: 7, title: "race", body: "", html_url: "" },
        repository: { full_name: "u/r" },
        sender: { login: "u" },
      });
      const headers = {
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-github-delivery": deliveryId,
        "x-hub-signature-256": signBody(body),
      };

      // 1st delivery: arrives before the OAuth callback binds the install.
      const first = await app.inject({ method: "POST", url: PATH, headers, payload: body });
      expect(first.statusCode).toBe(503);

      // The bind lands (OAuth callback completes).
      await upsertInstallationFromMetadata(app.db, {
        installation: {
          id: installationId,
          accountType: "Organization",
          accountLogin: "acme",
          accountGithubId: 7_700_010,
          permissions: {},
          events: [],
          suspendedAt: null,
        },
        hubOrganizationId: admin.organizationId,
      });

      // GitHub redelivers the SAME delivery id — because the first attempt
      // wasn't claimed, it's processed fresh and now routes (no target
      // agent for `u/r`, so `routed:false`, but a real 200 — not deduped).
      const second = await app.inject({ method: "POST", url: PATH, headers, payload: body });
      expect(second.statusCode).toBe(200);
      expect(second.json()).not.toMatchObject({ deduped: true });
    });

    it("missing installation block returns 200 with reason='no_installation'", async () => {
      const app = getApp();
      const body = JSON.stringify({
        action: "opened",
        // installation block deliberately omitted
        issue: { number: 1, title: "x" },
        repository: { full_name: "u/r" },
        sender: { login: "u" },
      });
      const res = await app.inject({
        method: "POST",
        url: PATH,
        headers: {
          "content-type": "application/json",
          "x-github-event": "issues",
          "x-github-delivery": uuidv7(),
          "x-hub-signature-256": signBody(body),
        },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, routed: false, reason: "no_installation" });
    });
  });

  describe("idempotency", () => {
    it("duplicate x-github-delivery is deduped (no second UPSERT)", async () => {
      const app = getApp();
      const installationId = 9_911_001;
      const body = JSON.stringify(buildInstallationPayload("created", { id: installationId }));
      const deliveryId = uuidv7();
      const headers = {
        "content-type": "application/json",
        "x-github-event": "installation",
        "x-github-delivery": deliveryId,
        "x-hub-signature-256": signBody(body),
      };
      const first = await app.inject({ method: "POST", url: PATH, headers, payload: body });
      const second = await app.inject({ method: "POST", url: PATH, headers, payload: body });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({ deduped: true });

      // Sanity: only one row exists (UPSERT is idempotent anyway, but the
      // dedup check should mean the handler was skipped entirely).
      const rows = await app.db
        .select()
        .from(githubAppInstallations)
        .where(eq(githubAppInstallations.installationId, installationId));
      expect(rows).toHaveLength(1);
    });
  });
});
