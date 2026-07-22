import { createHmac, randomUUID } from "node:crypto";
import { CONTEXT_REVIEW_MANAGED_MARKER } from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { agents } from "../db/schema/agents.js";
import { authIdentities } from "../db/schema/auth-identities.js";
import { chatUserState } from "../db/schema/chat-user-state.js";
import { chats } from "../db/schema/chats.js";
import { githubAppInstallations } from "../db/schema/github-app-installations.js";
import { githubEntityChatMappings } from "../db/schema/github-entity-chat-mappings.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { processedEvents } from "../db/schema/processed-events.js";
import { users } from "../db/schema/users.js";
import * as eventDedupService from "../services/event-dedup.js";
import * as githubAudienceService from "../services/github-audience.js";
import * as githubEntityStateService from "../services/github-entity-state.js";
import { putOrgSetting } from "../services/org-settings.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

const APP_WEBHOOK_SECRET = "test-app-webhook-secret";

function signBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

type App = ReturnType<ReturnType<typeof useTestApp>>;

async function postWebhook(
  app: App,
  eventType: string,
  payload: object,
  opts: { secret?: string; deliveryId?: string; skipDelivery?: boolean; skipSignature?: boolean } = {},
) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": eventType,
  };
  if (!opts.skipDelivery) headers["x-github-delivery"] = opts.deliveryId ?? randomUUID();
  if (!opts.skipSignature) {
    headers["x-hub-signature-256"] = signBody(opts.secret ?? APP_WEBHOOK_SECRET, body);
  }
  return app.inject({
    method: "POST",
    url: "/api/v1/webhooks/github-app",
    headers,
    payload: body,
  });
}

async function postRawWebhook(
  app: App,
  eventType: string | null,
  body: string,
  opts: { secret?: string; deliveryId?: string; skipDelivery?: boolean; skipSignature?: boolean } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (!opts.skipDelivery) headers["x-github-delivery"] = opts.deliveryId ?? randomUUID();
  if (eventType !== null) headers["x-github-event"] = eventType;
  if (!opts.skipSignature) {
    headers["x-hub-signature-256"] = signBody(opts.secret ?? APP_WEBHOOK_SECRET, body);
  }
  return app.inject({
    method: "POST",
    url: "/api/v1/webhooks/github-app",
    headers,
    payload: body,
  });
}

async function seedAgent(
  app: App,
  opts: { orgId: string; memberId: string; name: string; type?: "agent" | "human"; delegateMention?: string | null },
): Promise<string> {
  const uuid = randomUUID();
  const managerId = opts.type === "human" ? randomUUID() : opts.memberId;
  if (opts.type === "human") {
    const userId = randomUUID();
    await app.db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        username: `user-${uuid}`,
        passwordHash: "test",
        displayName: opts.name,
      });
      await tx.insert(agents).values({
        uuid,
        name: opts.name,
        organizationId: opts.orgId,
        type: "human",
        displayName: opts.name,
        inboxId: `inbox_${uuid}`,
        managerId,
        delegateMention: opts.delegateMention ?? null,
        visibility: "organization",
      });
      await tx.insert(members).values({
        id: managerId,
        userId,
        organizationId: opts.orgId,
        agentId: uuid,
        role: "member",
      });
    });
    return uuid;
  }
  await app.db.insert(agents).values({
    uuid,
    name: opts.name,
    organizationId: opts.orgId,
    type: "agent",
    displayName: opts.name,
    inboxId: `inbox_${uuid}`,
    managerId,
    delegateMention: opts.delegateMention ?? null,
    visibility: "organization",
  });
  return uuid;
}

async function seedInstallation(
  app: App,
  opts: { installationId: number; orgId: string | null; suspended?: boolean },
): Promise<void> {
  await app.db.insert(githubAppInstallations).values({
    id: uuidv7(),
    installationId: opts.installationId,
    accountType: "Organization",
    accountLogin: "owner",
    accountGithubId: 1000 + opts.installationId,
    hubOrganizationId: opts.orgId,
    permissions: { contents: "read", pull_requests: "write" },
    events: ["pull_request", "issues"],
    suspendedAt: opts.suspended ? new Date() : null,
  });
}

async function configureContextReviewer(app: App, admin: Awaited<ReturnType<typeof createTestAdmin>>) {
  const reviewer = await seedAgent(app, {
    orgId: admin.organizationId,
    memberId: admin.memberId,
    name: `context-reviewer-${randomUUID().slice(0, 6)}`,
  });
  await putOrgSetting(
    app.db,
    admin.organizationId,
    "context_tree",
    { repo: "https://github.com/owner/context-tree.git", branch: "main" },
    { updatedBy: admin.userId },
  );
  await putOrgSetting(
    app.db,
    admin.organizationId,
    "context_tree_features",
    { contextReviewer: { enabled: true, agentUuid: reviewer } },
    { updatedBy: admin.userId, memberId: admin.memberId },
  );
  return reviewer;
}

function contextPullRequestPayload(installationId: number, repoFullName = "owner/context-tree") {
  return {
    action: "opened",
    pull_request: {
      number: 42,
      title: "Improve context review guidance",
      html_url: `https://github.com/${repoFullName}/pull/42`,
      body: "",
      base: { ref: "main" },
      head: { ref: "context-reviewer" },
      draft: false,
      user: { login: "context-writer", type: "User" },
    },
    repository: { full_name: repoFullName },
    sender: { login: "context-writer", type: "User" },
    installation: { id: installationId },
  };
}

function contextIssueCommentPayload(installationId: number, repoFullName = "owner/context-tree") {
  return {
    action: "created",
    issue: {
      number: 42,
      title: "Improve context review guidance",
      html_url: `https://github.com/${repoFullName}/issues/42`,
      user: { login: "context-writer", type: "User" },
      pull_request: { html_url: `https://github.com/${repoFullName}/pull/42` },
    },
    comment: {
      body: "Please take another pass.",
      html_url: `https://github.com/${repoFullName}/pull/42#issuecomment-2`,
      user: { login: "context-commenter" },
    },
    repository: { full_name: repoFullName },
    sender: { login: "context-commenter", type: "User" },
    installation: { id: installationId },
  };
}

describe("POST /webhooks/github-app", () => {
  const getApp = useTestApp();

  it("returns 401 on a bad HMAC signature", async () => {
    const app = getApp();
    const res = await postWebhook(app, "ping", { zen: "x" }, { secret: "wrong-secret" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when the signature header is missing", async () => {
    const app = getApp();
    const res = await postWebhook(app, "ping", { zen: "x" }, { skipSignature: true });
    expect(res.statusCode).toBe(401);
  });

  it("returns 200 fast-path on a ping event", async () => {
    const app = getApp();
    const res = await postWebhook(app, "ping", { zen: "Anything added dilutes everything else." });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, event: "ping" });
  });

  it("rejects malformed raw JSON and requests missing the GitHub event header", async () => {
    const app = getApp();

    const malformed = await postRawWebhook(app, "ping", "{");
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json<{ error: string }>().error).toBe("Invalid JSON payload");

    const missingEvent = await postRawWebhook(app, null, JSON.stringify({ zen: "x" }));
    expect(missingEvent.statusCode).toBe(400);
    expect(missingEvent.json<{ error: string }>().error).toBe("Missing x-github-event header");
  });

  it("rejects non-buffer webhook bodies before signature parsing", async () => {
    const app = getApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/github-app",
      headers: {
        "content-type": "text/plain",
        "x-github-event": "ping",
        "x-hub-signature-256": "sha256=ignored",
      },
      payload: "plain text",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("Expected raw body buffer");
  });

  it("installation.created → records the row unbound with the installer (direct install: no requester)", async () => {
    const app = getApp();
    const installationId = 100001;
    const payload = {
      action: "created",
      installation: {
        id: installationId,
        account: { id: 555, login: "octolabs", type: "Organization" },
        permissions: { contents: "read" },
        events: ["pull_request"],
        suspended_at: null,
      },
      // `sender` is the GitHub-authenticated installer — persisted as the
      // trusted `installer_github_id`.
      sender: { id: 777, login: "octo-admin", type: "User" },
    };
    const res = await postWebhook(app, "installation", payload);
    expect(res.statusCode).toBe(200);
    // Record-only: the row is created with its identity anchors, never bound.
    expect(res.json().lifecycle).toBe("created:recorded");

    const [row] = await app.db
      .select()
      .from(githubAppInstallations)
      .where(eq(githubAppInstallations.installationId, installationId))
      .limit(1);
    expect(row).toBeTruthy();
    expect(row?.accountLogin).toBe("octolabs");
    expect(row?.installerGithubId).toBe(777);
    expect(row?.requesterGithubId).toBeNull();
    expect(row?.hubOrganizationId).toBeNull();
  });

  it("installation.created accepts missing events arrays and installation unknown actions are no-ops", async () => {
    const app = getApp();
    const installationId = 100013;
    const created = await postWebhook(app, "installation", {
      action: "created",
      installation: {
        id: installationId,
        account: { id: 4245, login: "acme4", type: "Organization" },
        permissions: { contents: "read" },
        events: "pull_request",
        suspended_at: null,
      },
      sender: { id: 90213, login: "owner", type: "User" },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().lifecycle).toBe("created:recorded");

    const [row] = await app.db
      .select({ events: githubAppInstallations.events })
      .from(githubAppInstallations)
      .where(eq(githubAppInstallations.installationId, installationId))
      .limit(1);
    expect(row?.events).toEqual([]);

    const unknown = await postWebhook(app, "installation", {
      action: "unknown_action",
      installation: { id: installationId, account: { id: 4245, login: "acme4", type: "Organization" } },
    });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json().lifecycle).toBe("ignored:unknown-action");
  });

  it("installation lifecycle rejects malformed metadata defensively", async () => {
    const app = getApp();

    const notObject = await postRawWebhook(app, "installation", "null");
    expect(notObject.statusCode).toBe(200);
    expect(notObject.json().lifecycle).toBe("ignored:malformed");

    const repos = await postWebhook(app, "installation_repositories", {
      action: "added",
      installation: { id: 100099 },
    });
    expect(repos.statusCode).toBe(200);
    expect(repos.json().lifecycle).toBe("noop");

    const missingInstallation = await postWebhook(app, "installation", { action: "created" });
    expect(missingInstallation.statusCode).toBe(200);
    expect(missingInstallation.json().lifecycle).toBe("ignored:malformed");

    const invalidMetadataCases = [
      { id: Number.NaN, account: { id: 1, login: "x", type: "Organization" } },
      { id: 100101 },
      { id: 100102, account: { id: "1", login: "x", type: "Organization" } },
      { id: 100103, account: { id: 1, login: "x", type: "Bot" } },
    ];
    for (const installation of invalidMetadataCases) {
      const res = await postWebhook(app, "installation", { action: "created", installation });
      expect(res.statusCode).toBe(200);
      expect(res.json().lifecycle).toBe("ignored:malformed");
    }

    const invalidPermissions = await postWebhook(app, "installation", {
      action: "created",
      installation: {
        id: 100104,
        account: { id: 1, login: "fallback-permissions", type: "Organization" },
        permissions: { contents: 123 },
        events: ["pull_request", 42, "issues"],
        suspended_at: "2026-05-13T00:00:00Z",
      },
      sender: { id: "not-a-number" },
      requester: null,
    });
    expect(invalidPermissions.statusCode).toBe(200);
    expect(invalidPermissions.json().lifecycle).toBe("created:recorded");
    const [row] = await app.db
      .select()
      .from(githubAppInstallations)
      .where(eq(githubAppInstallations.installationId, 100104))
      .limit(1);
    expect(row).toMatchObject({
      permissions: {},
      events: ["pull_request", "issues"],
      installerGithubId: null,
      requesterGithubId: null,
    });
    expect(row?.suspendedAt).toBeTruthy();
  });

  it("installation.created via the approval flow records BOTH the requester and the approving installer", async () => {
    const app = getApp();
    const installationId = 100010;
    const res = await postWebhook(app, "installation", {
      action: "created",
      installation: {
        id: installationId,
        account: { id: 4242, login: "acme-inc", type: "Organization" },
        permissions: { contents: "read" },
        events: ["pull_request"],
        suspended_at: null,
      },
      // Approval flow: `sender` is the approving org OWNER, while the
      // top-level `requester` is the member who asked for the install —
      // the identity the connect panel must be able to match.
      sender: { id: 90210, login: "acme-owner", type: "User" },
      requester: { id: 111, login: "acme-member", type: "User" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().lifecycle).toBe("created:recorded");

    const [row] = await app.db
      .select()
      .from(githubAppInstallations)
      .where(eq(githubAppInstallations.installationId, installationId))
      .limit(1);
    expect(row?.installerGithubId).toBe(90210);
    expect(row?.requesterGithubId).toBe(111);
    expect(row?.hubOrganizationId).toBeNull();
  });

  it("installation.created NEVER binds — even when the installer is a known team admin", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100011;
    // The installer's GitHub id belonging to a First Tree admin changes
    // nothing at webhook time: the webhook cannot know which team the
    // installation should connect to, so it records and stops. Binding is
    // the admin's explicit connect-panel action.
    const res = await postWebhook(app, "installation", {
      action: "created",
      installation: {
        id: installationId,
        account: { id: 4243, login: "acme2", type: "Organization" },
        permissions: { contents: "read" },
        events: ["pull_request"],
        suspended_at: null,
      },
      sender: { id: 90211, login: admin.username, type: "User" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().lifecycle).toBe("created:recorded");

    const [row] = await app.db
      .select()
      .from(githubAppInstallations)
      .where(eq(githubAppInstallations.installationId, installationId))
      .limit(1);
    expect(row?.hubOrganizationId).toBeNull();
  });

  it("new_permissions_accepted preserves the recorded requester + installer (COALESCE, different sender)", async () => {
    const app = getApp();
    const installationId = 100012;
    const base = {
      id: installationId,
      account: { id: 4244, login: "acme3", type: "Organization" },
      permissions: { contents: "read" },
      events: ["pull_request"],
      suspended_at: null,
    };
    await postWebhook(app, "installation", {
      action: "created",
      installation: base,
      sender: { id: 90212, login: "owner", type: "User" },
      requester: { id: 112, login: "member", type: "User" },
    });
    // A different admin accepts new permissions later — the original
    // identity anchors must survive the metadata refresh.
    const res = await postWebhook(app, "installation", {
      action: "new_permissions_accepted",
      installation: { ...base, permissions: { contents: "write" } },
      sender: { id: 99999, login: "another-admin", type: "User" },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await app.db
      .select()
      .from(githubAppInstallations)
      .where(eq(githubAppInstallations.installationId, installationId))
      .limit(1);
    expect(row?.permissions).toEqual({ contents: "write" });
    expect(row?.installerGithubId).toBe(90212);
    expect(row?.requesterGithubId).toBe(112);
  });

  it("installation.deleted → removes the row", async () => {
    const app = getApp();
    const installationId = 100002;
    await seedInstallation(app, { installationId, orgId: null });

    const res = await postWebhook(app, "installation", {
      action: "deleted",
      installation: { id: installationId, account: { id: 999, login: "x", type: "User" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().lifecycle).toBe("deleted");
    const rows = await app.db
      .select()
      .from(githubAppInstallations)
      .where(eq(githubAppInstallations.installationId, installationId));
    expect(rows).toHaveLength(0);
  });

  it("installation.suspend → sets suspended_at", async () => {
    const app = getApp();
    const installationId = 100003;
    await seedInstallation(app, { installationId, orgId: null });

    const res = await postWebhook(app, "installation", {
      action: "suspend",
      installation: {
        id: installationId,
        account: { id: 1, login: "x", type: "User" },
        suspended_at: "2026-05-13T00:00:00Z",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().lifecycle).toBe("suspended");

    const [row] = await app.db
      .select({ suspendedAt: githubAppInstallations.suspendedAt })
      .from(githubAppInstallations)
      .where(eq(githubAppInstallations.installationId, installationId))
      .limit(1);
    expect(row?.suspendedAt).toBeTruthy();
  });

  it("installation.unsuspend clears suspended_at", async () => {
    const app = getApp();
    const installationId = 100014;
    await seedInstallation(app, { installationId, orgId: null, suspended: true });

    const res = await postWebhook(app, "installation", {
      action: "unsuspend",
      installation: {
        id: installationId,
        account: { id: 1, login: "x", type: "User" },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().lifecycle).toBe("unsuspended");

    const [row] = await app.db
      .select({ suspendedAt: githubAppInstallations.suspendedAt })
      .from(githubAppInstallations)
      .where(eq(githubAppInstallations.installationId, installationId))
      .limit(1);
    expect(row?.suspendedAt).toBeNull();
  });

  it("returns ignored:no installation context when payload lacks an installation block", async () => {
    const app = getApp();
    const res = await postWebhook(app, "issues", {
      action: "opened",
      issue: { number: 1, title: "x" },
      repository: { full_name: "owner/repo" },
      sender: { login: "anyone", type: "User" },
      // no installation field
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ignored).toBe("no installation context");
  });

  it("returns ignored:installation not seen when installation_id is unknown", async () => {
    const app = getApp();
    const res = await postWebhook(app, "issues", {
      action: "opened",
      issue: { number: 1, title: "x", html_url: "https://github.com/owner/repo/issues/1", body: "" },
      repository: { full_name: "owner/repo" },
      sender: { login: "anyone", type: "User" },
      installation: { id: 9_999_999 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ignored).toBe("installation not seen");
  });

  it("returns ignored:installation not bound for an unbound installation", async () => {
    const app = getApp();
    const installationId = 100010;
    await seedInstallation(app, { installationId, orgId: null });
    const res = await postWebhook(app, "issues", {
      action: "opened",
      issue: { number: 1, title: "x", html_url: "https://github.com/owner/repo/issues/1", body: "" },
      repository: { full_name: "owner/repo" },
      sender: { login: "anyone", type: "User" },
      installation: { id: installationId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ignored).toBe("installation not bound");
  });

  it("returns ignored:suspended for a suspended installation", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100011;
    await seedInstallation(app, { installationId, orgId: admin.organizationId, suspended: true });
    const res = await postWebhook(app, "issues", {
      action: "opened",
      issue: { number: 1, title: "x", html_url: "https://github.com/owner/repo/issues/1", body: "" },
      repository: { full_name: "owner/repo" },
      sender: { login: "anyone", type: "User" },
      installation: { id: installationId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ignored).toBe("suspended");
  });

  it("returns handled=false for unsupported repository events after state seed resolution no-ops", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100015;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const res = await postWebhook(app, "star", {
      action: "created",
      repository: { full_name: "owner/repo" },
      sender: { login: "stargazer", type: "User" },
      installation: { id: installationId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, event: "star", handled: false });
  });

  it("handles repository events without a delivery header", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100018;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const res = await postWebhook(
      app,
      "star",
      {
        action: "created",
        repository: { full_name: "owner/repo" },
        sender: { login: "stargazer", type: "User" },
        installation: { id: installationId },
      },
      { skipDelivery: true },
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, event: "star", handled: false });
  });

  it("does not claim a supported event when x-github-delivery is absent", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100023;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });
    const claimSpy = vi.spyOn(eventDedupService, "claimEvent");
    const payload = {
      action: "opened",
      issue: {
        number: 923,
        title: "No delivery id",
        html_url: "https://github.com/owner/repo/issues/923",
        body: "",
        assignees: [],
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "external", type: "User" },
      installation: { id: installationId },
    };

    try {
      const first = await postWebhook(app, "issues", payload, { skipDelivery: true });
      const second = await postWebhook(app, "issues", payload, { skipDelivery: true });

      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ event: "issues", audience: 0 });
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({ event: "issues", audience: 0 });
      expect(claimSpy).not.toHaveBeenCalled();
    } finally {
      claimSpy.mockRestore();
    }
  });

  it("derives PR state seeds from issue comment payload fallbacks", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100019;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const closedMerged = await postWebhook(app, "issue_comment", {
      action: "edited",
      issue: {
        number: 77,
        title: "PR issue comment",
        html_url: "https://github.com/owner/repo/issues/77",
        state: "closed",
        pull_request: { html_url: "https://github.com/owner/repo/pull/77", merged_at: "2026-01-01T00:00:00Z" },
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "commenter", type: "User" },
      installation: { id: installationId },
    });
    expect(closedMerged.statusCode).toBe(200);
    expect(closedMerged.json()).toMatchObject({ handled: false });

    const draftOpen = await postWebhook(app, "issue_comment", {
      action: "edited",
      issue: {
        number: 78,
        title: "Draft PR issue comment",
        html_url: "https://github.com/owner/repo/issues/78",
        draft: true,
        pull_request: { html_url: "https://github.com/owner/repo/pull/78" },
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "commenter", type: "User" },
      installation: { id: installationId },
    });
    expect(draftOpen.statusCode).toBe(200);
    expect(draftOpen.json()).toMatchObject({ handled: false });
  });

  it("tolerates malformed entity state seed payloads", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100022;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const malformedReviewComment = await postWebhook(app, "pull_request_review_comment", {
      action: "dismissed",
      pull_request: null,
      repository: { full_name: "owner/repo" },
      sender: { login: "reviewer", type: "User" },
      installation: { id: installationId },
    });
    expect(malformedReviewComment.statusCode).toBe(200);
    expect(malformedReviewComment.json()).toMatchObject({ handled: false });

    const malformedClosedPr = await postWebhook(app, "pull_request", {
      action: "closed",
      pull_request: null,
      repository: { full_name: "owner/repo" },
      sender: { login: "closer", type: "User" },
      installation: { id: installationId },
    });
    expect(malformedClosedPr.statusCode).toBe(200);
    expect(malformedClosedPr.json()).toMatchObject({ handled: false });

    const malformedIssue = await postWebhook(app, "issues", {
      action: "closed",
      issue: null,
      repository: { full_name: "owner/repo" },
      sender: { login: "closer", type: "User" },
      installation: { id: installationId },
    });
    expect(malformedIssue.statusCode).toBe(200);
    expect(malformedIssue.json()).toMatchObject({ handled: false });
  });

  it("continues delivery when entity state sync fails", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100016;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });
    const stateSpy = vi
      .spyOn(githubEntityStateService, "setEntityState")
      .mockRejectedValueOnce(new Error("state sync down"));

    try {
      const res = await postWebhook(app, "issues", {
        action: "closed",
        issue: {
          number: 912,
          title: "Closed issue",
          html_url: "https://github.com/owner/repo/issues/912",
          body: "",
          state: "closed",
        },
        repository: { full_name: "owner/repo" },
        sender: { login: "closer", type: "User" },
        installation: { id: installationId },
      });

      expect(res.statusCode).toBe(200);
      expect(stateSpy).toHaveBeenCalled();
    } finally {
      stateSpy.mockRestore();
    }
  });

  it("recovers a delivery whose handling and release both failed once the claim TTL elapses", async () => {
    // End-to-end regression for the issue #317 headline scenario: audience
    // resolution fails AND the release fails (leak path 2), so the pending
    // claim survives with its original TTL. Before the claim lease this row
    // was permanent and every redelivery was deduped — the event was lost.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100017;
    const deliveryId = randomUUID();
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    // A followed chat so the recovered redelivery has a visible card to land.
    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `human-${randomUUID().slice(0, 6)}`,
      delegateMention: delegate,
      type: "human",
    });
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "direct" });
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "issue",
      entityKey: "owner/repo#913",
      chatId,
      boundVia: "direct",
    });

    const payload = {
      action: "opened",
      issue: {
        number: 913,
        title: "Issue",
        html_url: "https://github.com/owner/repo/issues/913",
        body: "",
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "author", type: "User" },
      installation: { id: installationId },
    };

    const audienceSpy = vi
      .spyOn(githubAudienceService, "resolveGithubAudience")
      .mockRejectedValueOnce(new Error("audience down"));
    const releaseSpy = vi
      .spyOn(eventDedupService, "releaseClaimedEvent")
      .mockRejectedValueOnce(new Error("release down"));

    try {
      const res = await postWebhook(app, "issues", payload, { deliveryId });

      expect(res.statusCode).toBe(500);
      expect(audienceSpy).toHaveBeenCalled();
      expect(releaseSpy).toHaveBeenCalledWith(app.db, deliveryId, "github", expect.any(String));
    } finally {
      audienceSpy.mockRestore();
      releaseSpy.mockRestore();
    }

    const stuck = await app.db
      .select()
      .from(processedEvents)
      .where(and(eq(processedEvents.eventId, deliveryId), eq(processedEvents.platform, "github")));
    expect(stuck[0]).toMatchObject({ status: "pending" });

    // Inside the TTL the claim still shields the delivery: deduped, with
    // claimState telling the operator to redeliver after the TTL.
    const shielded = await postWebhook(app, "issues", payload, { deliveryId });
    expect(shielded.statusCode).toBe(200);
    expect(shielded.json()).toMatchObject({ ok: true, deduped: true, claimState: "pending" });

    // TTL elapses (rewound in the DB), the operator redelivers: the claim is
    // taken over inline and the event is fully processed this time.
    await app.db
      .update(processedEvents)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(and(eq(processedEvents.eventId, deliveryId), eq(processedEvents.platform, "github")));

    const recovered = await postWebhook(app, "issues", payload, { deliveryId });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({ ok: true, delivered: 1 });
    const cards = await app.db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(cards).toHaveLength(1);
    const finished = await app.db
      .select()
      .from(processedEvents)
      .where(and(eq(processedEvents.eventId, deliveryId), eq(processedEvents.platform, "github")));
    expect(finished[0]).toMatchObject({ status: "done", expiresAt: null, claimToken: null });
  });

  it("Bug 1 — pull_request.synchronize delivers to subscribed chat (was silenced before)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100020;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `human-${randomUUID().slice(0, 6)}`,
      delegateMention: delegate,
      type: "human",
    });
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "direct" });
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#700",
      chatId,
      boundVia: "direct",
    });

    const res = await postWebhook(app, "pull_request", {
      action: "synchronize",
      pull_request: {
        number: 700,
        title: "Refactor inbox",
        html_url: "https://github.com/owner/repo/pull/700",
        body: "",
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "external-author", type: "User" },
      installation: { id: installationId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().delivered).toBe(1);
    const sent = await app.db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(sent).toHaveLength(1);
  });

  it("Bug 3 — issue_comment on a PR routes to the existing PR chat, not a new Issue chat", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100021;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `human-${randomUUID().slice(0, 6)}`,
      delegateMention: delegate,
      type: "human",
    });
    const prChatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: prChatId, organizationId: admin.organizationId, type: "direct" });
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#316",
      chatId: prChatId,
      boundVia: "direct",
    });

    const res = await postWebhook(app, "issue_comment", {
      action: "created",
      issue: {
        number: 316,
        title: "Improve onboarding",
        html_url: "https://github.com/owner/repo/issues/316",
        pull_request: { html_url: "https://github.com/owner/repo/pull/316" },
      },
      comment: { body: "ack", html_url: "https://github.com/owner/repo/pull/316#issuecomment-1" },
      repository: { full_name: "owner/repo" },
      sender: { login: "external-commenter", type: "User" },
      installation: { id: installationId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().delivered).toBe(1);

    // No new chat with metadata.entityType="issue" should have been created.
    const sentToPRChat = await app.db.select().from(messages).where(eq(messages.chatId, prChatId));
    expect(sentToPRChat).toHaveLength(1);
    const issueMappings = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.entityType, "issue"));
    expect(issueMappings).toEqual([]);
  });

  it("pull_request.closed (merged=true) → syncs entity_state to 'merged' without delivering a message", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100030;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `human-${randomUUID().slice(0, 6)}`,
      delegateMention: delegate,
      type: "human",
    });
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "direct" });
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#820",
      chatId,
      boundVia: "direct",
    });

    const res = await postWebhook(app, "pull_request", {
      action: "closed",
      pull_request: {
        number: 820,
        title: "Implement archive on merge",
        html_url: "https://github.com/owner/repo/pull/820",
        body: "",
        merged: true,
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "merger", type: "User" },
      installation: { id: installationId },
    });

    expect(res.statusCode).toBe(200);
    // normalize still drops pull_request.closed → no audience/deliver run.
    expect(res.json().handled).toBe(false);

    // Merge no longer flips engagement on the spot — the chat-archive
    // sweeper does that after the idle window. The webhook's job is just
    // to persist the upstream PR state.
    const stateRows = await app.db
      .select()
      .from(chatUserState)
      .where(and(eq(chatUserState.chatId, chatId), eq(chatUserState.agentId, human)));
    expect(stateRows).toHaveLength(0);

    const [mappingRow] = await app.db
      .select({
        entityState: githubEntityChatMappings.entityState,
        entityStateUpdatedAt: githubEntityChatMappings.entityStateUpdatedAt,
      })
      .from(githubEntityChatMappings)
      .where(and(eq(githubEntityChatMappings.chatId, chatId), eq(githubEntityChatMappings.entityKey, "owner/repo#820")))
      .limit(1);
    expect(mappingRow?.entityState).toBe("merged");
    expect(mappingRow?.entityStateUpdatedAt).not.toBeNull();

    const sent = await app.db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(sent).toHaveLength(0);
  });

  it("pull_request.reopened → flips entity_state back to 'open'", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100032;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `human-${randomUUID().slice(0, 6)}`,
      delegateMention: delegate,
      type: "human",
    });
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "direct" });
    // Mapping was previously settled (merged) — reopened must un-settle it.
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#822",
      chatId,
      boundVia: "direct",
      entityState: "merged",
    });

    const res = await postWebhook(app, "pull_request", {
      action: "reopened",
      pull_request: {
        number: 822,
        title: "Reopened PR",
        html_url: "https://github.com/owner/repo/pull/822",
        body: "",
        merged: false,
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "reopener", type: "User" },
      installation: { id: installationId },
    });

    expect(res.statusCode).toBe(200);

    const [mappingRow] = await app.db
      .select({ entityState: githubEntityChatMappings.entityState })
      .from(githubEntityChatMappings)
      .where(and(eq(githubEntityChatMappings.chatId, chatId), eq(githubEntityChatMappings.entityKey, "owner/repo#822")))
      .limit(1);
    expect(mappingRow?.entityState).toBe("open");
  });

  it("late opened webhooks do not overwrite newer persisted entity_state", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100036;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `human-${randomUUID().slice(0, 6)}`,
      delegateMention: delegate,
      type: "human",
    });
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "direct" });
    await app.db.insert(githubEntityChatMappings).values([
      {
        organizationId: admin.organizationId,
        humanAgentId: human,
        delegateAgentId: delegate,
        entityType: "pull_request",
        entityKey: "owner/repo#825",
        chatId,
        boundVia: "direct",
        entityState: "draft",
      },
      {
        organizationId: admin.organizationId,
        humanAgentId: human,
        delegateAgentId: delegate,
        entityType: "pull_request",
        entityKey: "owner/repo#826",
        chatId,
        boundVia: "direct",
        entityState: "merged",
      },
      {
        organizationId: admin.organizationId,
        humanAgentId: human,
        delegateAgentId: delegate,
        entityType: "issue",
        entityKey: "owner/repo#827",
        chatId,
        boundVia: "direct",
        entityState: "closed",
      },
    ]);

    for (const number of [825, 826]) {
      const res = await postWebhook(app, "pull_request", {
        action: "opened",
        pull_request: {
          number,
          title: "Late opened",
          html_url: `https://github.com/owner/repo/pull/${number}`,
          body: "",
          state: "open",
          draft: false,
          merged: false,
        },
        repository: { full_name: "owner/repo" },
        sender: { login: "author", type: "User" },
        installation: { id: installationId },
      });
      expect(res.statusCode).toBe(200);
    }

    const issueRes = await postWebhook(app, "issues", {
      action: "opened",
      issue: {
        number: 827,
        title: "Late issue opened",
        html_url: "https://github.com/owner/repo/issues/827",
        body: "",
        state: "open",
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "author", type: "User" },
      installation: { id: installationId },
    });
    expect(issueRes.statusCode).toBe(200);

    const rows = await app.db
      .select({ entityKey: githubEntityChatMappings.entityKey, entityState: githubEntityChatMappings.entityState })
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.chatId, chatId));
    const stateByKey = new Map(rows.map((row) => [row.entityKey, row.entityState]));
    expect(stateByKey.get("owner/repo#825")).toBe("draft");
    expect(stateByKey.get("owner/repo#826")).toBe("merged");
    expect(stateByKey.get("owner/repo#827")).toBe("closed");
  });

  it("pull_request.converted_to_draft → syncs entity_state to 'draft'", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100034;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `human-${randomUUID().slice(0, 6)}`,
      delegateMention: delegate,
      type: "human",
    });
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "direct" });
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#823",
      chatId,
      boundVia: "direct",
      entityState: "open",
    });

    const res = await postWebhook(app, "pull_request", {
      action: "converted_to_draft",
      pull_request: {
        number: 823,
        title: "Draft again",
        html_url: "https://github.com/owner/repo/pull/823",
        body: "",
        draft: true,
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "author", type: "User" },
      installation: { id: installationId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().handled).toBe(false);

    const [mappingRow] = await app.db
      .select({ entityState: githubEntityChatMappings.entityState })
      .from(githubEntityChatMappings)
      .where(and(eq(githubEntityChatMappings.chatId, chatId), eq(githubEntityChatMappings.entityKey, "owner/repo#823")))
      .limit(1);
    expect(mappingRow?.entityState).toBe("draft");
  });

  it("pull_request.ready_for_review → syncs entity_state to 'open' even when normalize drops the event", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100035;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `human-${randomUUID().slice(0, 6)}`,
      delegateMention: delegate,
      type: "human",
    });
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "direct" });
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#824",
      chatId,
      boundVia: "direct",
      entityState: "draft",
    });

    const res = await postWebhook(app, "pull_request", {
      action: "ready_for_review",
      pull_request: {
        number: 824,
        title: "Ready",
        html_url: "https://github.com/owner/repo/pull/824",
        body: "",
        draft: false,
        requested_reviewers: [],
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "author", type: "User" },
      installation: { id: installationId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().handled).toBe(false);

    const [mappingRow] = await app.db
      .select({ entityState: githubEntityChatMappings.entityState })
      .from(githubEntityChatMappings)
      .where(and(eq(githubEntityChatMappings.chatId, chatId), eq(githubEntityChatMappings.entityKey, "owner/repo#824")))
      .limit(1);
    expect(mappingRow?.entityState).toBe("open");
  });

  it("pull_request.review_requested seeds a new draft PR mapping from the payload state", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100037;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const humanName = `reviewer-${randomUUID().slice(0, 6)}`;
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: humanName,
      delegateMention: delegate,
      type: "human",
    });

    const res = await postWebhook(app, "pull_request", {
      action: "review_requested",
      pull_request: {
        number: 828,
        title: "Draft review",
        html_url: "https://github.com/owner/repo/pull/828",
        body: "",
        state: "open",
        draft: true,
        merged: false,
      },
      requested_reviewer: { login: humanName, type: "User" },
      repository: { full_name: "owner/repo" },
      sender: { login: "author", type: "User" },
      installation: { id: installationId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ delivered: 1, newChats: 1, failed: 0 });

    const [mappingRow] = await app.db
      .select({
        humanAgentId: githubEntityChatMappings.humanAgentId,
        entityState: githubEntityChatMappings.entityState,
      })
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.entityKey, "owner/repo#828"))
      .limit(1);
    expect(mappingRow).toMatchObject({ humanAgentId: human, entityState: "draft" });
  });

  it("issue_comment.created seeds a new closed issue mapping from the issue payload state", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100038;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const humanName = `issue-${randomUUID().slice(0, 6)}`;
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: humanName,
      delegateMention: delegate,
      type: "human",
    });

    const res = await postWebhook(app, "issue_comment", {
      action: "created",
      issue: {
        number: 829,
        title: "Closed issue",
        html_url: "https://github.com/owner/repo/issues/829",
        body: "",
        state: "closed",
      },
      comment: {
        body: `@${humanName} please verify`,
        html_url: "https://github.com/owner/repo/issues/829#issuecomment-1",
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "author", type: "User" },
      installation: { id: installationId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ delivered: 1, newChats: 1, failed: 0 });

    const [mappingRow] = await app.db
      .select({
        humanAgentId: githubEntityChatMappings.humanAgentId,
        entityType: githubEntityChatMappings.entityType,
        entityState: githubEntityChatMappings.entityState,
      })
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.entityKey, "owner/repo#829"))
      .limit(1);
    expect(mappingRow).toMatchObject({ humanAgentId: human, entityType: "issue", entityState: "closed" });
  });

  it("issue_comment.created on a PR seeds a new closed PR mapping from the issue payload state", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100040;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const humanName = `pr-issue-${randomUUID().slice(0, 6)}`;
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: humanName,
      delegateMention: delegate,
      type: "human",
    });

    const res = await postWebhook(app, "issue_comment", {
      action: "created",
      issue: {
        number: 831,
        title: "Closed PR thread",
        html_url: "https://github.com/owner/repo/pull/831",
        body: "",
        state: "closed",
        pull_request: { html_url: "https://github.com/owner/repo/pull/831", merged_at: null },
      },
      comment: {
        body: `@${humanName} please verify`,
        html_url: "https://github.com/owner/repo/pull/831#issuecomment-1",
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "author", type: "User" },
      installation: { id: installationId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ delivered: 1, newChats: 1, failed: 0 });

    const [mappingRow] = await app.db
      .select({
        humanAgentId: githubEntityChatMappings.humanAgentId,
        entityType: githubEntityChatMappings.entityType,
        entityState: githubEntityChatMappings.entityState,
      })
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.entityKey, "owner/repo#831"))
      .limit(1);
    expect(mappingRow).toMatchObject({ humanAgentId: human, entityType: "pull_request", entityState: "closed" });
  });

  it("pull_request_review_comment.created seeds a new draft PR mapping from the PR payload state", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100039;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const humanName = `pr-${randomUUID().slice(0, 6)}`;
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: humanName,
      delegateMention: delegate,
      type: "human",
    });

    const res = await postWebhook(app, "pull_request_review_comment", {
      action: "created",
      pull_request: {
        number: 830,
        title: "Draft PR review comment",
        html_url: "https://github.com/owner/repo/pull/830",
        body: "",
        state: "open",
        draft: true,
        merged: false,
      },
      comment: {
        body: `@${humanName} please review`,
        html_url: "https://github.com/owner/repo/pull/830#discussion_r1",
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "author", type: "User" },
      installation: { id: installationId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ delivered: 1, newChats: 1, failed: 0 });

    const [mappingRow] = await app.db
      .select({
        humanAgentId: githubEntityChatMappings.humanAgentId,
        entityType: githubEntityChatMappings.entityType,
        entityState: githubEntityChatMappings.entityState,
      })
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.entityKey, "owner/repo#830"))
      .limit(1);
    expect(mappingRow).toMatchObject({ humanAgentId: human, entityType: "pull_request", entityState: "draft" });
  });

  it("issues.closed → syncs entity_state to 'closed' on the issue mapping", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100033;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `human-${randomUUID().slice(0, 6)}`,
      delegateMention: delegate,
      type: "human",
    });
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "direct" });
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "issue",
      entityKey: "owner/repo#900",
      chatId,
      boundVia: "direct",
    });

    const res = await postWebhook(app, "issues", {
      action: "closed",
      issue: {
        number: 900,
        title: "Stale issue",
        html_url: "https://github.com/owner/repo/issues/900",
        body: "",
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "closer", type: "User" },
      installation: { id: installationId },
    });

    expect(res.statusCode).toBe(200);

    const [mappingRow] = await app.db
      .select({ entityState: githubEntityChatMappings.entityState })
      .from(githubEntityChatMappings)
      .where(and(eq(githubEntityChatMappings.chatId, chatId), eq(githubEntityChatMappings.entityKey, "owner/repo#900")))
      .limit(1);
    expect(mappingRow?.entityState).toBe("closed");
  });

  it("pull_request.closed without merge → entity_state 'closed' and no engagement flip", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100031;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `human-${randomUUID().slice(0, 6)}`,
      delegateMention: delegate,
      type: "human",
    });
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "direct" });
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#821",
      chatId,
      boundVia: "direct",
    });

    const res = await postWebhook(app, "pull_request", {
      action: "closed",
      pull_request: {
        number: 821,
        title: "Abandoned PR",
        html_url: "https://github.com/owner/repo/pull/821",
        body: "",
        merged: false,
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "closer", type: "User" },
      installation: { id: installationId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().handled).toBe(false);

    const stateRows = await app.db
      .select()
      .from(chatUserState)
      .where(and(eq(chatUserState.chatId, chatId), eq(chatUserState.agentId, human)));
    expect(stateRows).toHaveLength(0);

    const [mappingRow] = await app.db
      .select({ entityState: githubEntityChatMappings.entityState })
      .from(githubEntityChatMappings)
      .where(and(eq(githubEntityChatMappings.chatId, chatId), eq(githubEntityChatMappings.entityKey, "owner/repo#821")))
      .limit(1);
    expect(mappingRow?.entityState).toBe("closed");
  });

  // M1 (#507): audience-empty must distinguish "no involves at all" from
  // "had involves but resolved to zero agents" — the latter usually means
  // a mentioned GitHub login has no `delegateMention`-configured agent in
  // this org, which is a potential mis-configuration worth surfacing.
  it("audience empty with no involves returns reason=audience_empty_no_involves", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100030;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const res = await postWebhook(app, "issues", {
      action: "opened",
      issue: {
        number: 10,
        title: "no involves",
        html_url: "https://github.com/owner/repo/issues/10",
        body: "",
        assignees: [],
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "external", type: "User" },
      installation: { id: installationId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, audience: 0, reason: "audience_empty_no_involves" });
  });

  it("audience empty with involves returns reason=audience_empty_with_involves", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100031;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    // Assignee whose GitHub login has no matching agent in this org →
    // involves resolves to an empty audience (mis-config signal).
    const res = await postWebhook(app, "issues", {
      action: "opened",
      issue: {
        number: 11,
        title: "with involves but unknown login",
        html_url: "https://github.com/owner/repo/issues/11",
        body: "",
        assignees: [{ login: "nobody-here", type: "User" }],
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "external", type: "User" },
      installation: { id: installationId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, audience: 0, reason: "audience_empty_with_involves" });
  });

  it("routes installed-App follow-ups to an existing member-authored managed task with delivery dedupe", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100040;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });
    const reviewer = await configureContextReviewer(app, admin);
    await app.db.insert(authIdentities).values({
      id: randomUUID(),
      userId: admin.userId,
      provider: "github",
      identifier: `github-${randomUUID()}`,
      email: null,
      verifiedAt: new Date(),
      metadata: { login: "context-writer" },
    });

    const taskResponse = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/chats`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        mode: "keyed_task",
        initialMessage: {
          format: "markdown",
          content: "Please review this managed Context Tree PR.",
          metadata: {
            taskType: "context_tree_pr_review",
            reviewPacketV1: {
              schemaVersion: 1,
              repository: "owner/context-tree",
              pullRequest: 42,
              expectedHead: "a".repeat(40),
              baseRef: "main",
              sourceRef: "context-reviewer",
              requesterGithubLogin: "context-writer",
              goal: "Verify the managed Context Tree change.",
              source: { label: "Task source", reference: "first-tree-chat:test" },
              decisionSummary: "Keep one stable task Chat.",
              rationale: "The App is an event bridge, not a second task producer.",
              targetPaths: ["system/context-tree-pr-reviewer.md"],
              repairScope: ["system/context-tree-pr-reviewer.md"],
              relevantContextRefs: [],
              unresolvedQuestions: [],
              verify: { status: "passed", summary: "tree verification passed" },
              evidence: [],
            },
          },
        },
      },
    });
    expect(taskResponse.statusCode).toBe(201);
    const task = taskResponse.json<{ chatId: string; messageId: string }>();

    const followedDelegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `followed-delegate-${randomUUID().slice(0, 6)}`,
    });
    const followedHuman = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `followed-human-${randomUUID().slice(0, 6)}`,
      delegateMention: followedDelegate,
      type: "human",
    });
    const followedChatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({
      id: followedChatId,
      organizationId: admin.organizationId,
      type: "direct",
    });
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: followedHuman,
      delegateAgentId: followedDelegate,
      entityType: "pull_request",
      entityKey: "owner/context-tree#42",
      chatId: followedChatId,
      boundVia: "agent_declared",
    });

    const synchronizePayload = contextPullRequestPayload(installationId);
    synchronizePayload.action = "synchronize";
    synchronizePayload.pull_request.body = `${CONTEXT_REVIEW_MANAGED_MARKER}\n\nRepair scope: system/`;
    (synchronizePayload.pull_request.head as { ref: string; sha?: string }).sha = "b".repeat(40);
    const deliveryId = randomUUID();

    const audienceSpy = vi
      .spyOn(githubAudienceService, "resolveGithubAudience")
      .mockRejectedValueOnce(new Error("audience down after managed dispatch"));
    try {
      const failedSynchronize = await postWebhook(app, "pull_request", synchronizePayload, { deliveryId });
      expect(failedSynchronize.statusCode).toBe(500);
    } finally {
      audienceSpy.mockRestore();
    }
    const taskMessagesAfterFailure = await app.db.select().from(messages).where(eq(messages.chatId, task.chatId));
    expect(taskMessagesAfterFailure).toHaveLength(2);
    const committedEvent = taskMessagesAfterFailure.find((message) => message.id !== task.messageId);
    expect(committedEvent?.metadata).toMatchObject({
      contextReviewManagedEventV1: {
        triggerEvent: "pull_request.synchronize",
        deliveryId,
      },
    });
    expect(
      await app.db
        .select()
        .from(inboxEntries)
        .where(eq(inboxEntries.messageId, committedEvent?.id ?? "missing")),
    ).toHaveLength(1);

    const synchronize = await postWebhook(app, "pull_request", synchronizePayload, { deliveryId });
    expect(synchronize.statusCode).toBe(200);
    expect(synchronize.json()).toMatchObject({
      delivered: 1,
      contextReviewer: {
        handled: true,
        chatId: task.chatId,
        messageId: committedEvent?.id,
        reused: true,
        suppressed: true,
      },
    });
    const followedMessagesAfterSynchronize = await app.db
      .select()
      .from(messages)
      .where(eq(messages.chatId, followedChatId));
    expect(followedMessagesAfterSynchronize).toEqual([expect.objectContaining({ format: "card", source: "github" })]);

    const duplicate = await postWebhook(app, "pull_request", synchronizePayload, { deliveryId });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ ok: true, deduped: true });

    const delayedOpenedPayload = contextPullRequestPayload(installationId);
    delayedOpenedPayload.pull_request.body = `${CONTEXT_REVIEW_MANAGED_MARKER}\n\nRepair scope: system/`;
    (delayedOpenedPayload.pull_request.head as { ref: string; sha?: string }).sha = "b".repeat(40);
    const delayedOpened = await postWebhook(app, "pull_request", delayedOpenedPayload);
    expect(delayedOpened.statusCode).toBe(200);
    expect(delayedOpened.json()).toMatchObject({
      contextReviewer: {
        handled: true,
        chatId: task.chatId,
        messageId: task.messageId,
        reused: true,
        suppressed: true,
      },
    });

    const orgChats = await app.db.select().from(chats).where(eq(chats.organizationId, admin.organizationId));
    expect(orgChats).toHaveLength(2);
    const taskMessages = await app.db.select().from(messages).where(eq(messages.chatId, task.chatId));
    expect(taskMessages).toHaveLength(2);
    const eventMessage = taskMessages.find((message) => message.id !== task.messageId);
    expect(eventMessage?.metadata).toMatchObject({
      addressedAgentIds: [reviewer],
      contextReviewManagedEventV1: { triggerEvent: "pull_request.synchronize", deliveryId },
    });
    expect(
      await app.db
        .select()
        .from(inboxEntries)
        .where(eq(inboxEntries.messageId, eventMessage?.id ?? "missing")),
    ).toHaveLength(1);
    const followedMessages = await app.db.select().from(messages).where(eq(messages.chatId, followedChatId));
    expect(followedMessages).toHaveLength(2);

    const [activeReviewerManager] = await app.db
      .select({ id: members.id })
      .from(members)
      .where(eq(members.agentId, followedHuman))
      .limit(1);
    if (!activeReviewerManager) throw new Error("followed human member missing");
    await app.db.update(agents).set({ managerId: activeReviewerManager.id }).where(eq(agents.uuid, reviewer));
    await app.db.update(members).set({ status: "removed" }).where(eq(members.id, admin.memberId));
    await app.db.update(agents).set({ status: "suspended" }).where(eq(agents.uuid, admin.humanAgentUuid));
    const revokedRequesterPayload = contextPullRequestPayload(installationId);
    revokedRequesterPayload.action = "synchronize";
    revokedRequesterPayload.pull_request.body = `${CONTEXT_REVIEW_MANAGED_MARKER}\n\nRepair scope: system/`;
    (revokedRequesterPayload.pull_request.head as { ref: string; sha?: string }).sha = "c".repeat(40);
    const revokedDeliveryId = randomUUID();

    const revokedRequester = await postWebhook(app, "pull_request", revokedRequesterPayload, {
      deliveryId: revokedDeliveryId,
    });
    expect(revokedRequester.statusCode).toBe(200);
    expect(revokedRequester.json()).toMatchObject({
      delivered: 1,
      contextReviewer: { handled: false, reason: "managed_task_unavailable" },
    });
    expect(await app.db.select().from(messages).where(eq(messages.chatId, task.chatId))).toHaveLength(2);
    expect(await app.db.select().from(messages).where(eq(messages.chatId, followedChatId))).toHaveLength(3);

    const revokedReplay = await postWebhook(app, "pull_request", revokedRequesterPayload, {
      deliveryId: revokedDeliveryId,
    });
    expect(revokedReplay.statusCode).toBe(200);
    expect(revokedReplay.json()).toMatchObject({ ok: true, deduped: true });
    expect(await app.db.select().from(messages).where(eq(messages.chatId, task.chatId))).toHaveLength(2);
    expect(await app.db.select().from(messages).where(eq(messages.chatId, followedChatId))).toHaveLength(3);
  });

  it("pull_request.opened on the bound context repo creates a Context Reviewer task message", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100041;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });
    const reviewer = await configureContextReviewer(app, admin);

    const res = await postWebhook(app, "pull_request", contextPullRequestPayload(installationId));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      event: "pull_request",
      audience: 0,
      contextReviewer: { handled: true, reused: false },
    });

    const [chat] = await app.db.select().from(chats).limit(1);
    expect(chat?.metadata).toMatchObject({
      source: "github",
      entityType: "pull_request",
      entityKey: "owner/context-tree#42",
      contextTreeReviewer: true,
      reviewerAgentUuid: reviewer,
    });

    const [message] = await app.db
      .select()
      .from(messages)
      .where(eq(messages.chatId, chat?.id ?? ""))
      .limit(1);
    expect(message?.content).toContain("Load the installed `context-tree-review` skill");
    expect(message?.content).not.toContain("gh pr review");
    expect(message?.content).not.toContain("Context changes requested");
    expect(message?.content).toContain("Draft status from webhook: ready for review");
    expect(message?.metadata).toMatchObject({
      source: "github",
      event: "pull_request",
      action: "opened",
      triggerEvent: "pull_request.opened",
      contextTreeReviewer: true,
      pullRequestDraft: false,
      mentions: [reviewer],
    });
  });

  it("follow-up activity on a bound context PR wakes the existing Context Reviewer chat", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100043;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });
    const reviewer = await configureContextReviewer(app, admin);

    const opened = await postWebhook(app, "pull_request", contextPullRequestPayload(installationId));
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toMatchObject({ contextReviewer: { handled: true, reused: false } });

    const followUp = await postWebhook(app, "issue_comment", contextIssueCommentPayload(installationId));

    expect(followUp.statusCode).toBe(200);
    expect(followUp.json()).toMatchObject({
      ok: true,
      event: "issue_comment",
      audience: 0,
      contextReviewer: { handled: true, reused: true },
    });

    const chatRows = await app.db.select().from(chats);
    expect(chatRows).toHaveLength(1);

    const messageRows = await app.db
      .select()
      .from(messages)
      .where(eq(messages.chatId, chatRows[0]?.id ?? ""));
    expect(messageRows).toHaveLength(2);
    const followUpMessage = messageRows.find((message) => message.metadata.triggerEvent === "issue_comment.created");
    expect(followUpMessage?.content).toContain("Trigger event: issue_comment.created");
    expect(followUpMessage?.content).toContain("Comment author: context-commenter");
    expect(followUpMessage?.content).toContain(
      "Comment URL: https://github.com/owner/context-tree/pull/42#issuecomment-2",
    );
    expect(followUpMessage?.content).toContain("Load the installed `context-tree-review` skill");
    expect(followUpMessage?.metadata).toMatchObject({
      source: "github",
      event: "issue_comment",
      action: "created",
      triggerEvent: "issue_comment.created",
      entityType: "pull_request",
      entityKey: "owner/context-tree#42",
      contextTreeReviewer: true,
      commentAuthorLogin: "context-commenter",
      commentUrl: "https://github.com/owner/context-tree/pull/42#issuecomment-2",
      mentions: [reviewer],
    });

    const [entry] = await app.db
      .select({ notify: inboxEntries.notify })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.messageId, followUpMessage?.id ?? ""), eq(inboxEntries.inboxId, `inbox_${reviewer}`)))
      .limit(1);
    expect(entry?.notify).toBe(true);
  });

  it("pull_request.ready_for_review on a bound context PR wakes the existing Context Reviewer chat", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100044;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });
    const reviewer = await configureContextReviewer(app, admin);

    const draftOpenedPayload = contextPullRequestPayload(installationId);
    draftOpenedPayload.pull_request.draft = true;
    const opened = await postWebhook(app, "pull_request", draftOpenedPayload);
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toMatchObject({ contextReviewer: { handled: true, reused: false } });

    const readyPayload = contextPullRequestPayload(installationId);
    readyPayload.action = "ready_for_review";
    readyPayload.pull_request.draft = false;
    const ready = await postWebhook(app, "pull_request", readyPayload);

    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      ok: true,
      event: "pull_request",
      handled: false,
      contextReviewer: { handled: true, reused: true },
    });

    const [chat] = await app.db.select().from(chats).limit(1);
    const messageRows = await app.db
      .select()
      .from(messages)
      .where(eq(messages.chatId, chat?.id ?? ""));
    expect(messageRows).toHaveLength(2);
    const followUpMessage = messageRows.find(
      (message) => message.metadata.triggerEvent === "pull_request.ready_for_review",
    );
    expect(followUpMessage?.content).toContain("Trigger event: pull_request.ready_for_review");
    expect(followUpMessage?.content).toContain("Draft status from webhook: ready for review");
    expect(followUpMessage?.content).toContain("Load the installed `context-tree-review` skill");
    expect(followUpMessage?.content).not.toContain("gh pr review");
    expect(followUpMessage?.metadata).toMatchObject({
      source: "github",
      event: "pull_request",
      action: "ready_for_review",
      triggerEvent: "pull_request.ready_for_review",
      entityType: "pull_request",
      entityKey: "owner/context-tree#42",
      contextTreeReviewer: true,
      pullRequestDraft: false,
      mentions: [reviewer],
    });
  });

  it("pull_request.opened on an ordinary code repo does not trigger Context Reviewer", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100042;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });
    await configureContextReviewer(app, admin);

    const res = await postWebhook(app, "pull_request", contextPullRequestPayload(installationId, "owner/code"));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      event: "pull_request",
      audience: 0,
      contextReviewer: { handled: false, reason: "repo_mismatch" },
    });
    const chatRows = await app.db.select({ id: chats.id }).from(chats);
    expect(chatRows).toHaveLength(0);
  });

  it("duplicate delivery (same x-github-delivery) is deduped on the second call", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100022;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });
    const deliveryId = randomUUID();

    const payload = {
      action: "opened",
      issue: {
        number: 5,
        title: "x",
        html_url: "https://github.com/owner/repo/issues/5",
        body: "",
        assignees: [],
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "external", type: "User" },
      installation: { id: installationId },
    };

    const first = await postWebhook(app, "issues", payload, { deliveryId });
    expect(first.statusCode).toBe(200);
    const second = await postWebhook(app, "issues", payload, { deliveryId });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ deduped: true, claimState: "done" });
    const rows = await app.db
      .select()
      .from(processedEvents)
      .where(and(eq(processedEvents.eventId, deliveryId), eq(processedEvents.platform, "github")));
    expect(rows[0]).toMatchObject({ status: "done" });
  });

  it("duplicate context reviewer delivery is deduped and does not send another task", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100043;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });
    await configureContextReviewer(app, admin);
    const deliveryId = randomUUID();
    const payload = contextPullRequestPayload(installationId);

    const first = await postWebhook(app, "pull_request", payload, { deliveryId });
    const second = await postWebhook(app, "pull_request", payload, { deliveryId });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ deduped: true, claimState: "done" });
    const messageRows = await app.db.select({ id: messages.id }).from(messages);
    expect(messageRows).toHaveLength(1);
  });
});
