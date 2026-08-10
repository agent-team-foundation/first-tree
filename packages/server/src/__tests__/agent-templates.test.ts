import { type AgentTemplatePayload, ATTACHMENT_FILENAME_HEADER, ATTACHMENT_MIME_HEADER } from "@first-tree/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { agentConfigs } from "../db/schema/agent-configs.js";
import { agentResourceBindings } from "../db/schema/agent-resource-bindings.js";
import { agentTemplates } from "../db/schema/agent-templates.js";
import { attachments } from "../db/schema/attachments.js";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { resources } from "../db/schema/resources.js";
import { createAgent } from "../services/agent.js";
import { releaseTemplateBundles } from "../services/agent-templates.js";
import type { AttachmentBlobStore } from "../services/attachment-blob-store.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, seedAgentFactory, useTestApp } from "./helpers.js";

const PUBLISHER_ORG_ID = "agent-template-publisher-org-test";
const INTERNAL_URL = "/api/v1/internal/agent-templates";
const PUBLIC_URL = "/api/v1/agent-templates";

type Admin = Awaited<ReturnType<typeof createTestAdmin>>;
type TestApp = ReturnType<ReturnType<typeof useTestApp>>;

function skillMarkdown(name: string): Uint8Array {
  return strToU8(
    `---\nname: ${name}\ndescription: ${name} description\nmetadata:\n  owner: platform\n---\n\n# ${name}\n\nRun carefully.`,
  );
}

function skillZip(name: string, entries: Record<string, Uint8Array> = {}): Buffer {
  return Buffer.from(zipSync({ "SKILL.md": skillMarkdown(name), ...entries }));
}

/** Give `userId` a membership row (any role/status) in the publisher org. */
async function seedPublisherMembership(
  app: TestApp,
  userId: string,
  role: "admin" | "member",
  status: "active" | "left" = "active",
): Promise<{ memberId: string }> {
  await app.db
    .insert(organizations)
    .values({ id: PUBLISHER_ORG_ID, name: "official-publisher", displayName: "Official Publisher" })
    .onConflictDoNothing();
  const memberId = uuidv7();
  await app.db.transaction(async (tx) => {
    const human = await createAgent(tx as unknown as typeof app.db, {
      name: `publisher-human-${crypto.randomUUID().slice(0, 6)}`,
      type: "human",
      displayName: "Publisher Human",
      managerId: memberId,
      organizationId: PUBLISHER_ORG_ID,
    });
    await tx.insert(members).values({
      id: memberId,
      userId,
      organizationId: PUBLISHER_ORG_ID,
      agentId: human.uuid,
      role,
      status,
    });
  });
  return { memberId };
}

/** Create a user who is an active admin of the publisher org. */
async function createPublisherAdmin(app: TestApp): Promise<Admin> {
  const admin = await createTestAdmin(app, { username: `pub-${crypto.randomUUID().slice(0, 8)}` });
  await seedPublisherMembership(app, admin.userId, "admin");
  return admin;
}

async function uploadZip(app: TestApp, admin: Admin, bytes: Buffer, organizationId: string): Promise<string> {
  const reply = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${organizationId}/attachments`,
    headers: {
      authorization: `Bearer ${admin.accessToken}`,
      "content-type": "application/octet-stream",
      [ATTACHMENT_MIME_HEADER]: "application/zip",
      [ATTACHMENT_FILENAME_HEADER]: "skill.zip",
    },
    payload: bytes,
  });
  expect(reply.statusCode).toBe(201);
  return reply.json<{ id: string }>().id;
}

function validPublicProfile() {
  return {
    tagline: "Ship review-ready PRs",
    purpose: "A starting point for a pull-request engineering agent.",
    targetUsers: "Engineers running multiple agents.",
    userValue: "Start from a curated workflow.",
    instructionsSummary: "Guides review-ready delivery.",
    toolsAndSkillsSummary: "One review skill and one MCP server.",
  };
}

function promptComponent() {
  return {
    key: "instructions",
    type: "prompt",
    name: "PR Engineer Instructions",
    payload: { body: "You are a PR engineer.", description: "Core instructions" },
  };
}

function mcpComponent() {
  return {
    key: "github-mcp",
    type: "mcp",
    name: "GitHub MCP",
    payload: { name: "github", transport: "http", url: "https://mcp.github.example/mcp" },
  };
}

function createBody(components: unknown[] = [promptComponent(), mcpComponent()]) {
  return {
    slug: `tpl-${crypto.randomUUID().slice(0, 8)}`,
    name: "PR Engineer",
    public: validPublicProfile(),
    components,
  };
}

describe("Agent Template catalog", () => {
  const getApp = useTestApp({ agentTemplatePublisherOrgId: PUBLISHER_ORG_ID });

  function call(
    app: TestApp,
    admin: Admin | null,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    payload?: Record<string, unknown>,
  ) {
    return app.inject({
      method,
      url,
      ...(admin ? { headers: { authorization: `Bearer ${admin.accessToken}` } } : {}),
      ...(payload !== undefined ? { payload } : {}),
    });
  }

  async function createDraft(app: TestApp, admin: Admin, components?: unknown[]) {
    const reply = await call(app, admin, "POST", INTERNAL_URL, createBody(components));
    expect(reply.statusCode).toBe(201);
    return reply.json<{ id: string; slug: string; status: string; updatedAt: string }>();
  }

  async function publish(app: TestApp, admin: Admin, template: { id: string; updatedAt: string }) {
    const reply = await call(app, admin, "POST", `${INTERNAL_URL}/${template.id}/publish`, {
      expectedUpdatedAt: template.updatedAt,
    });
    expect(reply.statusCode).toBe(200);
    return reply.json<{ id: string; slug: string; status: string; updatedAt: string }>();
  }

  describe("publisher authorization", () => {
    it("rejects unauthenticated maintenance requests with 401", async () => {
      const app = getApp();
      const reply = await call(app, null, "POST", INTERNAL_URL, createBody());
      expect(reply.statusCode).toBe(401);
    });

    it("rejects users without publisher-org membership", async () => {
      const app = getApp();
      const outsider = await createTestAdmin(app, { username: `out-${crypto.randomUUID().slice(0, 8)}` });
      const reply = await call(app, outsider, "POST", INTERNAL_URL, createBody());
      expect(reply.statusCode).toBe(403);
    });

    it("rejects non-admin publisher-org members", async () => {
      const app = getApp();
      const member = await createTestAdmin(app, { username: `mem-${crypto.randomUUID().slice(0, 8)}` });
      await seedPublisherMembership(app, member.userId, "member");
      const reply = await call(app, member, "POST", INTERNAL_URL, createBody());
      expect(reply.statusCode).toBe(403);
    });

    it("rejects inactive publisher-org memberships", async () => {
      const app = getApp();
      const former = await createTestAdmin(app, { username: `old-${crypto.randomUUID().slice(0, 8)}` });
      await seedPublisherMembership(app, former.userId, "admin", "left");
      const reply = await call(app, former, "POST", INTERNAL_URL, createBody());
      expect(reply.statusCode).toBe(403);
    });
  });

  describe("skill compilation", () => {
    it("derives skill fields and the measured bundle descriptor from the real ZIP", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const zipBytes = skillZip("review-skill", { "scripts/run.sh": strToU8("echo ok") });
      const bundleId = await uploadZip(app, publisher, zipBytes, PUBLISHER_ORG_ID);

      const reply = await call(
        app,
        publisher,
        "POST",
        INTERNAL_URL,
        createBody([promptComponent(), { key: "review", type: "skill", bundleAttachmentId: bundleId }]),
      );
      expect(reply.statusCode).toBe(201);
      const detail = reply.json<{
        createdBy: string;
        payload: { components: Array<Record<string, unknown>> };
      }>();
      const skill = detail.payload.components.find((component) => component.type === "skill");
      expect(skill).toMatchObject({
        key: "review",
        name: "review-skill",
        payload: { name: "review-skill", description: "review-skill description" },
        bundle: { attachmentId: bundleId, format: "zip", sizeBytes: zipBytes.length },
      });
      const [publisherMember] = await app.db
        .select({ id: members.id })
        .from(members)
        .where(and(eq(members.userId, publisher.userId), eq(members.organizationId, PUBLISHER_ORG_ID)));
      expect(detail.createdBy).toBe(publisherMember?.id);
    });

    it("rejects bundles owned by another organization", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const foreignBundle = await uploadZip(app, publisher, skillZip("foreign"), publisher.organizationId);
      const reply = await call(
        app,
        publisher,
        "POST",
        INTERNAL_URL,
        createBody([{ key: "foreign", type: "skill", bundleAttachmentId: foreignBundle }]),
      );
      expect(reply.statusCode).toBe(400);
    });

    it("rejects non-ready or byteless attachments", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const missing = await call(
        app,
        publisher,
        "POST",
        INTERNAL_URL,
        createBody([{ key: "missing", type: "skill", bundleAttachmentId: crypto.randomUUID() }]),
      );
      expect(missing.statusCode).toBe(400);

      const bytelessId = crypto.randomUUID();
      await app.db.insert(attachments).values({
        id: bytelessId,
        organizationId: PUBLISHER_ORG_ID,
        lifecycleState: "ready",
        mimeType: "application/zip",
        filename: "byteless.zip",
        sizeBytes: 10,
        uploadedBy: "qa",
      });
      const byteless = await call(
        app,
        publisher,
        "POST",
        INTERNAL_URL,
        createBody([{ key: "byteless", type: "skill", bundleAttachmentId: bytelessId }]),
      );
      expect(byteless.statusCode).toBe(400);
    });

    it("rejects corrupted ZIP bytes", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const bundleId = await uploadZip(app, publisher, Buffer.from("not a zip"), PUBLISHER_ORG_ID);
      const reply = await call(
        app,
        publisher,
        "POST",
        INTERNAL_URL,
        createBody([{ key: "broken", type: "skill", bundleAttachmentId: bundleId }]),
      );
      expect(reply.statusCode).toBe(400);
    });
  });

  describe("lifecycle and concurrency", () => {
    it("runs create -> publish -> update -> retire with audit fields", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const draft = await createDraft(app, publisher);
      expect(draft.status).toBe("draft");

      const active = await publish(app, publisher, draft);
      expect(active.status).toBe("active");
      // The mutation token strictly advances and round-trips verbatim.
      expect(active.updatedAt > draft.updatedAt).toBe(true);

      const updated = await call(app, publisher, "PATCH", `${INTERNAL_URL}/${active.id}`, {
        expectedUpdatedAt: active.updatedAt,
        name: "PR Engineer v2",
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json<{ name: string }>().name).toBe("PR Engineer v2");

      const retired = await call(app, publisher, "POST", `${INTERNAL_URL}/${active.id}/retire`, {
        expectedUpdatedAt: updated.json<{ updatedAt: string }>().updatedAt,
      });
      expect(retired.statusCode).toBe(200);
      expect(retired.json<{ status: string }>().status).toBe("retired");
    });

    it("rejects illegal transitions", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const draft = await createDraft(app, publisher);

      const retireDraft = await call(app, publisher, "POST", `${INTERNAL_URL}/${draft.id}/retire`, {
        expectedUpdatedAt: draft.updatedAt,
      });
      expect(retireDraft.statusCode).toBe(409);

      const active = await publish(app, publisher, draft);
      const republish = await call(app, publisher, "POST", `${INTERNAL_URL}/${active.id}/publish`, {
        expectedUpdatedAt: active.updatedAt,
      });
      expect(republish.statusCode).toBe(409);

      const retired = await call(app, publisher, "POST", `${INTERNAL_URL}/${active.id}/retire`, {
        expectedUpdatedAt: active.updatedAt,
      });
      expect(retired.statusCode).toBe(200);
      const retiredAt = retired.json<{ updatedAt: string }>().updatedAt;

      const updateRetired = await call(app, publisher, "PATCH", `${INTERNAL_URL}/${active.id}`, {
        expectedUpdatedAt: retiredAt,
        name: "Nope",
      });
      expect(updateRetired.statusCode).toBe(409);
      const reactivate = await call(app, publisher, "POST", `${INTERNAL_URL}/${active.id}/publish`, {
        expectedUpdatedAt: retiredAt,
      });
      expect(reactivate.statusCode).toBe(409);
    });

    // A component-less Template can never be adopted, so publish must reject
    // it at the source instead of letting it reach the public catalog and
    // fail only once a real user clicks Use.
    it("rejects publishing a Template with no components and leaves it draft", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const draft = await createDraft(app, publisher, []);

      const rejected = await call(app, publisher, "POST", `${INTERNAL_URL}/${draft.id}/publish`, {
        expectedUpdatedAt: draft.updatedAt,
      });
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json<{ error: string }>().error).toContain("has no components");

      const detail = await call(app, publisher, "GET", `${INTERNAL_URL}/${draft.id}`);
      expect(detail.statusCode).toBe(200);
      const unchanged = detail.json<{ status: string; updatedAt: string }>();
      expect(unchanged.status).toBe("draft");
      expect(unchanged.updatedAt).toBe(draft.updatedAt);

      // The draft is still publishable once it actually carries a component.
      const filled = await call(app, publisher, "PATCH", `${INTERNAL_URL}/${draft.id}`, {
        expectedUpdatedAt: draft.updatedAt,
        components: [promptComponent()],
      });
      expect(filled.statusCode).toBe(200);
      const active = await publish(app, publisher, filled.json<{ id: string; updatedAt: string }>());
      expect(active.status).toBe("active");
    });

    it("allows slug edits only while draft", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const draft = await createDraft(app, publisher);
      const renamed = await call(app, publisher, "PATCH", `${INTERNAL_URL}/${draft.id}`, {
        expectedUpdatedAt: draft.updatedAt,
        slug: `renamed-${crypto.randomUUID().slice(0, 8)}`,
      });
      expect(renamed.statusCode).toBe(200);

      const active = await publish(app, publisher, renamed.json<{ id: string; updatedAt: string }>());
      const blocked = await call(app, publisher, "PATCH", `${INTERNAL_URL}/${active.id}`, {
        expectedUpdatedAt: active.updatedAt,
        slug: `blocked-${crypto.randomUUID().slice(0, 8)}`,
      });
      expect(blocked.statusCode).toBe(409);
    });

    it("rejects stale expectedUpdatedAt with 409", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const draft = await createDraft(app, publisher);
      const stale = await call(app, publisher, "PATCH", `${INTERNAL_URL}/${draft.id}`, {
        expectedUpdatedAt: "2000-01-01T00:00:00.000000Z",
        name: "Stale write",
      });
      expect(stale.statusCode).toBe(409);
    });

    it("enforces replacement constraints on retire", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const first = await publish(app, publisher, await createDraft(app, publisher));
      const secondDraft = await createDraft(app, publisher);

      const selfReplacement = await call(app, publisher, "POST", `${INTERNAL_URL}/${first.id}/retire`, {
        expectedUpdatedAt: first.updatedAt,
        replacementTemplateId: first.id,
      });
      expect(selfReplacement.statusCode).toBe(400);

      const draftReplacement = await call(app, publisher, "POST", `${INTERNAL_URL}/${first.id}/retire`, {
        expectedUpdatedAt: first.updatedAt,
        replacementTemplateId: secondDraft.id,
      });
      expect(draftReplacement.statusCode).toBe(400);

      const second = await publish(app, publisher, secondDraft);
      const retired = await call(app, publisher, "POST", `${INTERNAL_URL}/${first.id}/retire`, {
        expectedUpdatedAt: first.updatedAt,
        replacementTemplateId: second.id,
      });
      expect(retired.statusCode).toBe(200);
      expect(retired.json<{ replacementTemplateId: string }>().replacementTemplateId).toBe(second.id);
    });

    it("rejects duplicate slugs with 409", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const body = createBody();
      const first = await call(app, publisher, "POST", INTERNAL_URL, body);
      expect(first.statusCode).toBe(201);
      const duplicate = await call(app, publisher, "POST", INTERNAL_URL, body);
      expect(duplicate.statusCode).toBe(409);
    });
  });

  describe("public read model", () => {
    it("serves the active catalog without authentication and redacts internals", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const zipBytes = skillZip("public-skill");
      const bundleId = await uploadZip(app, publisher, zipBytes, PUBLISHER_ORG_ID);
      const draft = await createDraft(app, publisher, [
        promptComponent(),
        mcpComponent(),
        { key: "public-skill", type: "skill", bundleAttachmentId: bundleId },
      ]);
      await publish(app, publisher, draft);

      const list = await app.inject({ method: "GET", url: PUBLIC_URL });
      expect(list.statusCode).toBe(200);
      const body = list.json<{
        templates: Array<Record<string, unknown> & { slug: string; status: string }>;
      }>();
      const found = body.templates.find((template) => template.slug === draft.slug);
      expect(found).toBeDefined();
      expect(found?.status).toBe("active");
      const serialized = JSON.stringify(found);
      expect(found).not.toHaveProperty("components");
      expect(found).not.toHaveProperty("payload");
      expect(serialized).not.toContain(bundleId);
      expect(serialized).not.toContain("You are a PR engineer.");
      expect(serialized).not.toContain("mcp.github.example");
      expect(serialized).not.toContain("Run carefully.");

      const detail = await app.inject({ method: "GET", url: `${PUBLIC_URL}/${draft.slug}` });
      expect(detail.statusCode).toBe(200);
      expect(JSON.stringify(detail.json())).not.toContain(bundleId);
    });

    it("hides drafts from both public endpoints", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const draft = await createDraft(app, publisher);
      const detail = await app.inject({ method: "GET", url: `${PUBLIC_URL}/${draft.slug}` });
      expect(detail.statusCode).toBe(404);
      const list = await app.inject({ method: "GET", url: PUBLIC_URL });
      expect(
        list.json<{ templates: Array<{ slug: string }> }>().templates.find((t) => t.slug === draft.slug),
      ).toBeUndefined();
    });

    it("keeps retired details readable with a safe replacement summary", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const first = await publish(app, publisher, await createDraft(app, publisher));
      const second = await publish(app, publisher, await createDraft(app, publisher));
      const secondDetail = await call(app, publisher, "GET", `${INTERNAL_URL}/${second.id}`);
      const secondName = secondDetail.json<{ name: string; slug: string }>();

      const retired = await call(app, publisher, "POST", `${INTERNAL_URL}/${first.id}/retire`, {
        expectedUpdatedAt: first.updatedAt,
        replacementTemplateId: second.id,
      });
      expect(retired.statusCode).toBe(200);

      const detail = await app.inject({ method: "GET", url: `${PUBLIC_URL}/${first.slug}` });
      expect(detail.statusCode).toBe(200);
      const body = detail.json<{ status: string; replacement: { slug: string; name: string } }>();
      expect(body.status).toBe("retired");
      expect(body.replacement).toEqual({ slug: secondName.slug, name: secondName.name });

      const list = await app.inject({ method: "GET", url: PUBLIC_URL });
      expect(
        list.json<{ templates: Array<{ slug: string }> }>().templates.find((t) => t.slug === first.slug),
      ).toBeUndefined();
    });

    it("fails closed on active rows whose outer fields violate the public contract", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const good = await publish(app, publisher, await createDraft(app, publisher));

      const rawPayload: AgentTemplatePayload = {
        schemaVersion: 1,
        public: validPublicProfile(),
        components: [
          {
            key: "instructions",
            type: "prompt",
            name: "PR Engineer Instructions",
            payload: { body: "You are a PR engineer.", description: "Core instructions" },
          },
        ],
      };
      const badSlugId = uuidv7();
      await app.db.insert(agentTemplates).values({
        id: badSlugId,
        slug: "Bad Slug!",
        name: "Bad Slug Row",
        status: "active",
        payload: rawPayload,
        createdBy: "qa",
        updatedBy: "qa",
      });
      const emptyNameId = uuidv7();
      await app.db.insert(agentTemplates).values({
        id: emptyNameId,
        slug: "empty-name-row",
        name: "",
        status: "active",
        payload: rawPayload,
        createdBy: "qa",
        updatedBy: "qa",
      });

      // One contract-violating row must not break the whole catalog.
      const list = await app.inject({ method: "GET", url: PUBLIC_URL });
      expect(list.statusCode).toBe(200);
      const slugs = list.json<{ templates: Array<{ slug: string }> }>().templates.map((t) => t.slug);
      expect(slugs).toContain(good.slug);
      expect(slugs).not.toContain("Bad Slug!");
      expect(slugs).not.toContain("empty-name-row");

      const badSlugDetail = await app.inject({ method: "GET", url: `${PUBLIC_URL}/Bad%20Slug!` });
      expect(badSlugDetail.statusCode).toBe(404);
      const emptyNameDetail = await app.inject({ method: "GET", url: `${PUBLIC_URL}/empty-name-row` });
      expect(emptyNameDetail.statusCode).toBe(404);

      await app.db.delete(agentTemplates).where(inArray(agentTemplates.id, [badSlugId, emptyNameId]));
    });

    it("fails closed on malformed or unavailable active rows", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const zipBytes = skillZip("doomed-skill");
      const bundleId = await uploadZip(app, publisher, zipBytes, PUBLISHER_ORG_ID);
      const active = await publish(
        app,
        publisher,
        await createDraft(app, publisher, [
          promptComponent(),
          { key: "doomed", type: "skill", bundleAttachmentId: bundleId },
        ]),
      );

      // Release the bundle behind the Template's back: the active row must
      // fail closed out of discovery and the direct safe read.
      await app.db.delete(attachments).where(eq(attachments.id, bundleId));
      const missingDetail = await app.inject({ method: "GET", url: `${PUBLIC_URL}/${active.slug}` });
      expect(missingDetail.statusCode).toBe(404);

      // A malformed stored payload must fail closed the same way, without
      // leaking raw payload content.
      await app.db
        .update(agentTemplates)
        .set({ payload: sql`${JSON.stringify({ schemaVersion: 1, components: "broken" })}::jsonb` })
        .where(eq(agentTemplates.id, active.id));
      const malformedDetail = await app.inject({ method: "GET", url: `${PUBLIC_URL}/${active.slug}` });
      expect(malformedDetail.statusCode).toBe(404);
      const list = await app.inject({ method: "GET", url: PUBLIC_URL });
      const listBody = list.json<{ templates: Array<{ slug: string }> }>();
      expect(listBody.templates.find((t) => t.slug === active.slug)).toBeUndefined();
      expect(JSON.stringify(listBody)).not.toContain("broken");

      // Do not leak the deliberately-corrupted row into later suites.
      await app.db.delete(agentTemplates).where(eq(agentTemplates.id, active.id));
    });
  });

  describe("bundle lifecycle", () => {
    it("collects released bundles after a successful update and keeps shared ones", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const bundleA = await uploadZip(app, publisher, skillZip("bundle-a"), PUBLISHER_ORG_ID);
      const bundleB = await uploadZip(app, publisher, skillZip("bundle-b"), PUBLISHER_ORG_ID);

      const first = await publish(
        app,
        publisher,
        await createDraft(app, publisher, [{ key: "a", type: "skill", bundleAttachmentId: bundleA }]),
      );
      const second = await publish(
        app,
        publisher,
        await createDraft(app, publisher, [{ key: "a", type: "skill", bundleAttachmentId: bundleA }]),
      );

      // Replace bundle A with bundle B on the first Template. Bundle A is
      // still referenced by the second Template and must survive.
      const updated = await call(app, publisher, "PATCH", `${INTERNAL_URL}/${first.id}`, {
        expectedUpdatedAt: first.updatedAt,
        components: [{ key: "b", type: "skill", bundleAttachmentId: bundleB }],
      });
      expect(updated.statusCode).toBe(200);
      expect(await app.db.select().from(attachments).where(eq(attachments.id, bundleA))).toHaveLength(1);
      expect(await app.db.select().from(attachments).where(eq(attachments.id, bundleB))).toHaveLength(1);

      // Releasing the last reference collects the bundle.
      const updatedSecond = await call(app, publisher, "PATCH", `${INTERNAL_URL}/${second.id}`, {
        expectedUpdatedAt: second.updatedAt,
        components: [{ key: "b", type: "skill", bundleAttachmentId: bundleB }],
      });
      expect(updatedSecond.statusCode).toBe(200);
      expect(await app.db.select().from(attachments).where(eq(attachments.id, bundleA))).toHaveLength(0);
      expect(await app.db.select().from(attachments).where(eq(attachments.id, bundleB))).toHaveLength(1);
    });

    it("does not collect bundles when the update fails", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const bundleA = await uploadZip(app, publisher, skillZip("kept-a"), PUBLISHER_ORG_ID);
      const bundleB = await uploadZip(app, publisher, skillZip("kept-b"), PUBLISHER_ORG_ID);
      const active = await publish(
        app,
        publisher,
        await createDraft(app, publisher, [{ key: "a", type: "skill", bundleAttachmentId: bundleA }]),
      );

      const stale = await call(app, publisher, "PATCH", `${INTERNAL_URL}/${active.id}`, {
        expectedUpdatedAt: "2000-01-01T00:00:00.000000Z",
        components: [{ key: "b", type: "skill", bundleAttachmentId: bundleB }],
      });
      expect(stale.statusCode).toBe(409);
      expect(await app.db.select().from(attachments).where(eq(attachments.id, bundleA))).toHaveLength(1);
    });
  });

  describe("customer-state isolation", () => {
    it("never touches agent configs, resources, or bindings", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const createAgentRow = await seedAgentFactory(app);
      const agent = await createAgentRow({ name: `isolated-${crypto.randomUUID().slice(0, 6)}` });

      const [configBefore] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agent.uuid));
      const resourcesBefore = await app.db.select().from(resources);
      const bindingsBefore = await app.db.select().from(agentResourceBindings);

      const active = await publish(app, publisher, await createDraft(app, publisher));
      await call(app, publisher, "PATCH", `${INTERNAL_URL}/${active.id}`, {
        expectedUpdatedAt: active.updatedAt,
        name: "Isolation check",
      });
      const updated = await call(app, publisher, "GET", `${INTERNAL_URL}/${active.id}`);
      await call(app, publisher, "POST", `${INTERNAL_URL}/${active.id}/retire`, {
        expectedUpdatedAt: updated.json<{ updatedAt: string }>().updatedAt,
      });

      const [configAfter] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agent.uuid));
      expect(configAfter).toEqual(configBefore);
      expect(await app.db.select().from(resources)).toEqual(resourcesBefore);
      expect(await app.db.select().from(agentResourceBindings)).toEqual(bindingsBefore);
    });
  });

  describe("internal reads", () => {
    it("lists and fetches full rows for the publisher only", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const outsider = await createTestAdmin(app, { username: `lur-${crypto.randomUUID().slice(0, 8)}` });
      const draft = await createDraft(app, publisher);

      const denied = await call(app, outsider, "GET", INTERNAL_URL);
      expect(denied.statusCode).toBe(403);

      const list = await call(app, publisher, "GET", INTERNAL_URL);
      expect(list.statusCode).toBe(200);
      const found = list
        .json<{ templates: Array<{ id: string; payload: { components: unknown[] } }> }>()
        .templates.find((template) => template.id === draft.id);
      expect(found?.payload.components.length).toBeGreaterThan(0);

      const detail = await call(app, publisher, "GET", `${INTERNAL_URL}/${draft.id}`);
      expect(detail.statusCode).toBe(200);
      expect(detail.json<{ status: string }>().status).toBe("draft");

      const missing = await call(app, publisher, "GET", `${INTERNAL_URL}/${crypto.randomUUID()}`);
      expect(missing.statusCode).toBe(404);
    });
  });

  describe("optimistic concurrency", () => {
    it("lets exactly one of two same-token writers win", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const draft = await createDraft(app, publisher);
      const token = draft.updatedAt;

      const [first, second] = await Promise.all([
        call(app, publisher, "PATCH", `${INTERNAL_URL}/${draft.id}`, {
          expectedUpdatedAt: token,
          name: "Writer A",
        }),
        call(app, publisher, "PATCH", `${INTERNAL_URL}/${draft.id}`, {
          expectedUpdatedAt: token,
          name: "Writer B",
        }),
      ]);
      const outcomes = [first.statusCode, second.statusCode].sort();
      expect(outcomes).toEqual([200, 409]);

      const winner = (first.statusCode === 200 ? first : second).json<{ name: string; updatedAt: string }>();
      const loser = first.statusCode === 200 ? second : first;
      expect(loser.json<{ error: string }>().error).toContain("modified concurrently");
      expect(winner.updatedAt > token).toBe(true);

      // The winner's token round-trips into the next mutation, which again
      // strictly advances it.
      const followup = await call(app, publisher, "PATCH", `${INTERNAL_URL}/${draft.id}`, {
        expectedUpdatedAt: winner.updatedAt,
        name: "Follow up",
      });
      expect(followup.statusCode).toBe(200);
      expect(followup.json<{ updatedAt: string }>().updatedAt > winner.updatedAt).toBe(true);

      const [stored] = await app.db
        .select({ name: agentTemplates.name })
        .from(agentTemplates)
        .where(eq(agentTemplates.id, draft.id));
      expect(stored?.name).toBe("Follow up");
    });
  });

  describe("publish re-verification", () => {
    it("rejects a draft whose stored Skill projection drifted from its bundle", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const bundleId = await uploadZip(app, publisher, skillZip("drift-check"), PUBLISHER_ORG_ID);
      const draft = await createDraft(app, publisher, [{ key: "drift", type: "skill", bundleAttachmentId: bundleId }]);

      // Tamper with the stored projection behind the service's back.
      await app.db.execute(sql`
        UPDATE agent_templates
        SET payload = jsonb_set(payload, '{components,0,name}', '"forged-name"'::jsonb)
        WHERE id = ${draft.id}
      `);
      const forgedName = await call(app, publisher, "POST", `${INTERNAL_URL}/${draft.id}/publish`, {
        expectedUpdatedAt: draft.updatedAt,
      });
      expect(forgedName.statusCode).toBe(409);

      await app.db.execute(sql`
        UPDATE agent_templates
        SET payload = jsonb_set(payload, '{components,0,name}', '"drift-check"'::jsonb)
        WHERE id = ${draft.id}
      `);
      await app.db.execute(sql`
        UPDATE agent_templates
        SET payload = jsonb_set(payload, '{components,0,bundle,sizeBytes}', '1'::jsonb)
        WHERE id = ${draft.id}
      `);
      const forgedSize = await call(app, publisher, "POST", `${INTERNAL_URL}/${draft.id}/publish`, {
        expectedUpdatedAt: draft.updatedAt,
      });
      expect(forgedSize.statusCode).toBe(409);

      const [stored] = await app.db
        .select({ status: agentTemplates.status })
        .from(agentTemplates)
        .where(eq(agentTemplates.id, draft.id));
      expect(stored?.status).toBe("draft");

      // Restore the real projection; publish then succeeds.
      await app.db.execute(sql`
        UPDATE agent_templates
        SET payload = jsonb_set(payload, '{components,0,bundle,sizeBytes}', to_jsonb(${skillZip("drift-check").length}::int))
        WHERE id = ${draft.id}
      `);
      const published = await call(app, publisher, "POST", `${INTERNAL_URL}/${draft.id}/publish`, {
        expectedUpdatedAt: draft.updatedAt,
      });
      expect(published.statusCode).toBe(200);
    });
  });

  describe("replacement projection", () => {
    async function retiredWithReplacement(app: TestApp, publisher: Admin) {
      const bundleId = await uploadZip(app, publisher, skillZip("replacement-skill"), PUBLISHER_ORG_ID);
      const first = await publish(app, publisher, await createDraft(app, publisher));
      const second = await publish(
        app,
        publisher,
        await createDraft(app, publisher, [{ key: "r", type: "skill", bundleAttachmentId: bundleId }]),
      );
      const retired = await call(app, publisher, "POST", `${INTERNAL_URL}/${first.id}/retire`, {
        expectedUpdatedAt: first.updatedAt,
        replacementTemplateId: second.id,
      });
      expect(retired.statusCode).toBe(200);
      return { first, second, bundleId };
    }

    it("points at a currently-active adoptable replacement", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const { first } = await retiredWithReplacement(app, publisher);
      const detail = await app.inject({ method: "GET", url: `${PUBLIC_URL}/${first.slug}` });
      expect(detail.statusCode).toBe(200);
      expect(detail.json<{ replacement: { slug: string } | null }>().replacement).not.toBeNull();
    });

    it("degrades to null when the replacement later retires", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const { first, second } = await retiredWithReplacement(app, publisher);
      await call(app, publisher, "POST", `${INTERNAL_URL}/${second.id}/retire`, {
        expectedUpdatedAt: second.updatedAt,
      });
      const detail = await app.inject({ method: "GET", url: `${PUBLIC_URL}/${first.slug}` });
      expect(detail.statusCode).toBe(200);
      const body = detail.json<{ status: string; replacement: unknown }>();
      expect(body.status).toBe("retired");
      expect(body.replacement).toBeNull();
    });

    it("degrades to null when the replacement loses its bundle or turns malformed", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const { first, second, bundleId } = await retiredWithReplacement(app, publisher);

      await app.db.delete(attachments).where(eq(attachments.id, bundleId));
      const withoutBundle = await app.inject({ method: "GET", url: `${PUBLIC_URL}/${first.slug}` });
      expect(withoutBundle.statusCode).toBe(200);
      expect(withoutBundle.json<{ replacement: unknown }>().replacement).toBeNull();

      await app.db
        .update(agentTemplates)
        .set({ payload: sql`${JSON.stringify({ schemaVersion: 1, components: "broken" })}::jsonb` })
        .where(eq(agentTemplates.id, second.id));
      const malformed = await app.inject({ method: "GET", url: `${PUBLIC_URL}/${first.slug}` });
      expect(malformed.statusCode).toBe(200);
      expect(malformed.json<{ replacement: unknown }>().replacement).toBeNull();

      // Do not leak the deliberately-corrupted row into later suites.
      await app.db.delete(agentTemplates).where(eq(agentTemplates.id, second.id));
    });

    it("degrades to null when the replacement's outer fields violate the contract", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const { first, second } = await retiredWithReplacement(app, publisher);

      await app.db.update(agentTemplates).set({ name: "" }).where(eq(agentTemplates.id, second.id));
      const emptyName = await app.inject({ method: "GET", url: `${PUBLIC_URL}/${first.slug}` });
      expect(emptyName.statusCode).toBe(200);
      expect(emptyName.json<{ status: string; replacement: unknown }>().replacement).toBeNull();

      await app.db
        .update(agentTemplates)
        .set({ name: "Restored", slug: "Bad Slug!" })
        .where(eq(agentTemplates.id, second.id));
      const badSlug = await app.inject({ method: "GET", url: `${PUBLIC_URL}/${first.slug}` });
      expect(badSlug.statusCode).toBe(200);
      expect(badSlug.json<{ status: string; replacement: unknown }>().replacement).toBeNull();

      // Restore a clean projection so later suites keep working.
      await app.db
        .update(agentTemplates)
        .set({ slug: `restored-${crypto.randomUUID().slice(0, 8)}`, name: "Restored" })
        .where(eq(agentTemplates.id, second.id));
    });
  });

  describe("bundle GC resilience", () => {
    it("keeps collecting other released bundles when one cleanup fails", async () => {
      const app = getApp();
      // An S3-style row whose blob delete fails, plus a normal PG-backed row.
      const failingId = crypto.randomUUID();
      await app.db.insert(attachments).values({
        id: failingId,
        organizationId: PUBLISHER_ORG_ID,
        objectKey: `s3-${failingId}`,
        lifecycleState: "ready",
        mimeType: "application/zip",
        filename: "failing.zip",
        sizeBytes: 3,
        uploadedBy: "qa",
      });
      const collectableId = crypto.randomUUID();
      await app.db.insert(attachments).values({
        id: collectableId,
        organizationId: PUBLISHER_ORG_ID,
        lifecycleState: "ready",
        mimeType: "application/zip",
        filename: "collectable.zip",
        sizeBytes: 3,
        data: Buffer.from("zip"),
        uploadedBy: "qa",
      });
      const failingBlobStore: AttachmentBlobStore = {
        get: () => Promise.reject(new Error("unreachable")),
        delete: () => Promise.reject(new Error("simulated storage outage")),
      };

      await expect(
        releaseTemplateBundles(app.db, failingBlobStore, [failingId, collectableId]),
      ).resolves.toBeUndefined();
      expect(await app.db.select().from(attachments).where(eq(attachments.id, collectableId))).toHaveLength(0);
      // The failed id is left for the orphan sweep, not lost or erroring.
      const [stranded] = await app.db
        .select({ lifecycleState: attachments.lifecycleState })
        .from(attachments)
        .where(eq(attachments.id, failingId));
      expect(stranded?.lifecycleState).toBe("deleting");
    });
  });

  describe("surface contracts", () => {
    it("sorts the public catalog by name, then slug", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const entries = [
        { slug: "zulu-last", name: "Beta" },
        { slug: "alpha-first", name: "Beta" },
        { slug: "mid", name: "Alpha" },
      ];
      for (const entry of entries) {
        const created = await call(app, publisher, "POST", INTERNAL_URL, {
          ...createBody(),
          slug: entry.slug,
          name: entry.name,
        });
        expect(created.statusCode).toBe(201);
        await publish(app, publisher, created.json<{ id: string; updatedAt: string }>());
      }

      const list = await app.inject({ method: "GET", url: PUBLIC_URL });
      const ordered = list
        .json<{ templates: Array<{ slug: string; name: string }> }>()
        .templates.filter((template) => entries.some((entry) => entry.slug === template.slug))
        .map((template) => template.slug);
      expect(ordered).toEqual(["mid", "alpha-first", "zulu-last"]);
    });

    it("keeps a retired detail readable after its own bundle is gone", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const bundleId = await uploadZip(app, publisher, skillZip("retired-skill"), PUBLISHER_ORG_ID);
      const active = await publish(
        app,
        publisher,
        await createDraft(app, publisher, [{ key: "r", type: "skill", bundleAttachmentId: bundleId }]),
      );
      await call(app, publisher, "POST", `${INTERNAL_URL}/${active.id}/retire`, {
        expectedUpdatedAt: active.updatedAt,
      });
      await app.db.delete(attachments).where(eq(attachments.id, bundleId));

      const detail = await app.inject({ method: "GET", url: `${PUBLIC_URL}/${active.slug}` });
      expect(detail.statusCode).toBe(200);
      expect(detail.json<{ status: string }>().status).toBe("retired");
    });

    it("has no DELETE surface", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const draft = await createDraft(app, publisher);
      const reply = await call(app, publisher, "DELETE", `${INTERNAL_URL}/${draft.id}`);
      expect(reply.statusCode).toBe(404);
    });

    it("revokes publisher access in real time on demotion", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const allowed = await call(app, publisher, "GET", INTERNAL_URL);
      expect(allowed.statusCode).toBe(200);

      await app.db
        .update(members)
        .set({ role: "member" })
        .where(and(eq(members.userId, publisher.userId), eq(members.organizationId, PUBLISHER_ORG_ID)));
      const demoted = await call(app, publisher, "GET", INTERNAL_URL);
      expect(demoted.statusCode).toBe(403);

      await app.db
        .update(members)
        .set({ role: "admin", status: "left" })
        .where(and(eq(members.userId, publisher.userId), eq(members.organizationId, PUBLISHER_ORG_ID)));
      const deactivated = await call(app, publisher, "GET", INTERNAL_URL);
      expect(deactivated.statusCode).toBe(403);
    });
  });

  describe("write-size envelope", () => {
    function oversizedPromptComponents() {
      const body = "x".repeat(32 * 1024);
      return Array.from({ length: 33 }, (_, index) => ({
        key: `prompt-${index}`,
        type: "prompt",
        name: `Prompt ${index}`,
        payload: { body, description: "Full-size prompt" },
      }));
    }

    it("accepts a schema-valid create request larger than the default 1 MiB body limit", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const body = createBody(oversizedPromptComponents());
      // Guard the premise: this request really exceeds Fastify's default cap.
      expect(Buffer.byteLength(JSON.stringify(body), "utf8")).toBeGreaterThan(1024 * 1024);

      const reply = await call(app, publisher, "POST", INTERNAL_URL, body);
      expect(reply.statusCode).toBe(201);
      expect(reply.json<{ payload: { components: unknown[] } }>().payload.components).toHaveLength(33);
    });

    it("accepts a schema-valid update request larger than the default 1 MiB body limit", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const draft = await createDraft(app, publisher);
      const body = {
        expectedUpdatedAt: draft.updatedAt,
        components: oversizedPromptComponents(),
      };
      expect(Buffer.byteLength(JSON.stringify(body), "utf8")).toBeGreaterThan(1024 * 1024);

      const reply = await call(app, publisher, "PATCH", `${INTERNAL_URL}/${draft.id}`, body);
      expect(reply.statusCode).toBe(200);
      expect(reply.json<{ payload: { components: unknown[] } }>().payload.components).toHaveLength(33);
    });
  });

  describe("MCP name contract over HTTP", () => {
    it("rejects duplicate MCP names case-insensitively and non-canonical names", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);

      const duplicates = createBody([
        {
          key: "a",
          type: "mcp",
          name: "A",
          payload: { name: "github", transport: "http", url: "https://mcp.example/a" },
        },
        { key: "b", type: "mcp", name: "B", payload: { name: "GitHub", transport: "stdio", command: "github-mcp" } },
      ]);
      const dupReply = await call(app, publisher, "POST", INTERNAL_URL, duplicates);
      expect(dupReply.statusCode).toBe(400);

      const nonCanonical = createBody([
        {
          key: "a",
          type: "mcp",
          name: "A",
          payload: { name: "GitHub MCP", transport: "http", url: "https://mcp.example/a" },
        },
      ]);
      const nameReply = await call(app, publisher, "POST", INTERNAL_URL, nonCanonical);
      expect(nameReply.statusCode).toBe(400);
    });
  });

  describe("PostgreSQL text compatibility over HTTP", () => {
    const NUL = String.fromCharCode(0);

    async function templateCount(app: TestApp): Promise<number> {
      const rows = await app.db.select({ id: agentTemplates.id }).from(agentTemplates);
      return rows.length;
    }

    it("rejects a create carrying actual U+0000 with 400 and no persisted row", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const before = await templateCount(app);
      const body = createBody([
        { key: "p", type: "prompt", name: "Prompt", payload: { body: `run${NUL}this`, description: "ok" } },
      ]);
      const reply = await call(app, publisher, "POST", INTERNAL_URL, body);
      expect(reply.statusCode).toBe(400);
      expect(await templateCount(app)).toBe(before);
    });

    it("rejects an update carrying actual U+0000 with 400 and leaves the row untouched", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const draft = await createDraft(app, publisher);
      const reply = await call(app, publisher, "PATCH", `${INTERNAL_URL}/${draft.id}`, {
        expectedUpdatedAt: draft.updatedAt,
        components: [
          { key: "p", type: "prompt", name: "Prompt", payload: { body: `bad${NUL}body`, description: "ok" } },
        ],
      });
      expect(reply.statusCode).toBe(400);
      const detail = await call(app, publisher, "GET", `${INTERNAL_URL}/${draft.id}`);
      const stored = detail.json<{ name: string; updatedAt: string }>();
      expect(stored.name).toBe("PR Engineer");
      expect(stored.updatedAt).toBe(draft.updatedAt);
    });

    it("rejects a Skill whose ZIP-derived body carries actual U+0000", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const before = await templateCount(app);
      const markdown = `---\nname: nul-skill\ndescription: nul-skill description\n---\n\n# nul-skill\n\nRun ${NUL}carefully.`;
      const bundleId = await uploadZip(
        app,
        publisher,
        Buffer.from(zipSync({ "SKILL.md": strToU8(markdown) })),
        PUBLISHER_ORG_ID,
      );
      const reply = await call(
        app,
        publisher,
        "POST",
        INTERNAL_URL,
        createBody([{ key: "nul-skill", type: "skill", bundleAttachmentId: bundleId }]),
      );
      expect(reply.statusCode).toBe(400);
      expect(await templateCount(app)).toBe(before);
    });

    it("persists the fully-filled maximum contract with PostgreSQL-safe escaped controls", async () => {
      const app = getApp();
      const publisher = await createPublisherAdmin(app);
      const escaped = (length: number) => String.fromCharCode(1).repeat(length);
      const components = Array.from({ length: 100 }, (_, index) => ({
        key: `${"p".repeat(97)}${String(index).padStart(3, "0")}`,
        type: "prompt",
        name: escaped(200),
        payload: { body: escaped(32 * 1024), description: escaped(1000) },
      }));
      const create = {
        slug: `max-${crypto.randomUUID().slice(0, 8)}`,
        name: escaped(200),
        public: {
          tagline: escaped(200),
          purpose: escaped(2000),
          targetUsers: escaped(1000),
          userValue: escaped(2000),
          instructionsSummary: escaped(2000),
          toolsAndSkillsSummary: escaped(2000),
        },
        components,
      };
      expect(Buffer.byteLength(JSON.stringify(create), "utf8")).toBeLessThan(21_757_952);

      const created = await call(app, publisher, "POST", INTERNAL_URL, create);
      expect(created.statusCode).toBe(201);
      const detail = created.json<{ id: string; updatedAt: string; payload: { components: unknown[] } }>();
      expect(detail.payload.components).toHaveLength(100);

      const updated = await call(app, publisher, "PATCH", `${INTERNAL_URL}/${detail.id}`, {
        expectedUpdatedAt: detail.updatedAt,
        components,
      });
      expect(updated.statusCode).toBe(200);
    });
  });
});

describe("Agent Template catalog without publisher config", () => {
  const getApp = useTestApp();

  it("fails closed for every maintenance request", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `npc-${crypto.randomUUID().slice(0, 8)}` });
    const reply = await app.inject({
      method: "POST",
      url: INTERNAL_URL,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        slug: "unconfigured",
        name: "Unconfigured",
        public: {
          tagline: "t",
          purpose: "p",
          targetUsers: "u",
          userValue: "v",
          instructionsSummary: "i",
          toolsAndSkillsSummary: "s",
        },
        components: [],
      },
    });
    expect(reply.statusCode).toBe(403);
  });

  it("keeps the public read model available", async () => {
    const app = getApp();
    const profile = {
      tagline: "t",
      purpose: "p",
      targetUsers: "u",
      userValue: "v",
      instructionsSummary: "i",
      toolsAndSkillsSummary: "s",
    };
    await app.db.insert(agentTemplates).values({
      id: uuidv7(),
      slug: "seeded-public",
      name: "Seeded Public",
      status: "active",
      payload: {
        schemaVersion: 1,
        public: profile,
        components: [
          {
            key: "instructions",
            type: "prompt",
            name: "Instructions",
            payload: { body: "You are helpful.", description: "d" },
          },
        ],
      },
      createdBy: "qa",
      updatedBy: "qa",
    });

    const list = await app.inject({ method: "GET", url: PUBLIC_URL });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ templates: Array<{ slug: string }> }>().templates.some((t) => t.slug === "seeded-public")).toBe(
      true,
    );
    const detail = await app.inject({ method: "GET", url: `${PUBLIC_URL}/seeded-public` });
    expect(detail.statusCode).toBe(200);
  });
});
