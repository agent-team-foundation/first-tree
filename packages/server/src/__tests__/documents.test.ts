import crypto from "node:crypto";
import type { PublishDocResponse } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { docDocuments } from "../db/schema/index.js";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { users } from "../db/schema/users.js";
import { createAgent } from "../services/agent.js";
import { docAuthorForAgentUuid } from "../services/doc-author.js";
import { createComment } from "../services/document.js";
import { uuidv7 } from "../uuid.js";
import { createAdminContext, createTestAgent, INVALID_BCRYPT_PLACEHOLDER, useTestApp } from "./helpers.js";

/**
 * Document review (docloop) — integration coverage for all three route
 * classes: org surface (Class B), resource surface (Class C), and the agent
 * self surface (Class D). One publish→comment→reply→resolve loop per
 * surface, plus the org-isolation and feature-flag boundaries.
 */

type Ctx = Awaited<ReturnType<typeof createAdminContext>>;

function humanRequest(app: FastifyInstance, accessToken: string) {
  return (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${accessToken}` },
      ...(payload ? { payload } : {}),
    });
}

function slug(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

async function publishDoc(app: FastifyInstance, ctx: Ctx, body: Record<string, unknown>): Promise<PublishDocResponse> {
  const res = await humanRequest(app, ctx.accessToken)("POST", `/api/v1/orgs/${ctx.organizationId}/documents`, body);
  expect(res.statusCode).toBe(200);
  const published: PublishDocResponse = res.json();
  return published;
}

/** Provision a user + org + admin membership entirely outside the shared default org. */
async function createOutsideOrgContext(app: FastifyInstance) {
  const orgId = `org-docs-${crypto.randomUUID().slice(0, 8)}`;
  const memberId = uuidv7();
  const userId = uuidv7();
  const humanAgentUuid = await app.db.transaction(async (tx) => {
    await tx.insert(users).values({
      id: userId,
      username: `docs-out-${crypto.randomUUID().slice(0, 6)}`,
      passwordHash: INVALID_BCRYPT_PLACEHOLDER,
      displayName: "Outside Admin",
    });
    await tx.insert(organizations).values({ id: orgId, name: orgId.slice(0, 30), displayName: "Outside Org" });
    const human = await createAgent(tx as unknown as typeof app.db, {
      name: `docs-out-h-${crypto.randomUUID().slice(0, 6)}`,
      type: "human",
      displayName: "Outside Human",
      managerId: memberId,
      organizationId: orgId,
    });
    await tx.insert(members).values({
      id: memberId,
      userId,
      organizationId: orgId,
      agentId: human.uuid,
      role: "admin",
    });
    return human.uuid;
  });
  return { orgId, memberId, userId, humanAgentUuid };
}

describe("documents API", () => {
  const getApp = useTestApp();

  describe("org surface (Class B)", () => {
    it("publishes a new document with version 1 and a human author", async () => {
      const app = getApp();
      const ctx = await createAdminContext(app);
      const s = slug("first");

      const doc = await publishDoc(app, ctx, { slug: s, title: "Design Doc", content: "# Hello" });
      expect(doc).toMatchObject({
        slug: s,
        title: "Design Doc",
        project: null,
        status: "draft",
        version: 1,
        createdDocument: true,
        createdVersion: true,
      });

      const read = await humanRequest(app, ctx.accessToken)("GET", `/api/v1/documents/${doc.id}`);
      expect(read.statusCode).toBe(200);
      expect(read.json().version.content).toBe("# Hello");
      expect(read.json().createdBy.kind).toBe("human");
      expect(read.json().createdBy.id).toBe(ctx.humanAgentUuid);
    });

    it("rejects the first publish of a slug without a title", async () => {
      const app = getApp();
      const ctx = await createAdminContext(app);
      const res = await humanRequest(app, ctx.accessToken)("POST", `/api/v1/orgs/${ctx.organizationId}/documents`, {
        slug: slug("untitled"),
        content: "body",
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects an invalid slug", async () => {
      const app = getApp();
      const ctx = await createAdminContext(app);
      const res = await humanRequest(app, ctx.accessToken)("POST", `/api/v1/orgs/${ctx.organizationId}/documents`, {
        slug: "Not A Slug!",
        title: "x",
        content: "y",
      });
      expect(res.statusCode).toBe(400);
    });

    it("appends versions idempotently by slug and honors ifChanged", async () => {
      const app = getApp();
      const ctx = await createAdminContext(app);
      const s = slug("versioned");

      const v1 = await publishDoc(app, ctx, { slug: s, title: "V", content: "one" });
      const v2 = await publishDoc(app, ctx, { slug: s, content: "two", note: "second pass" });
      expect(v2).toMatchObject({ id: v1.id, version: 2, createdDocument: false, createdVersion: true, title: "V" });

      const unchanged = await publishDoc(app, ctx, { slug: s, content: "two", ifChanged: true });
      expect(unchanged).toMatchObject({ version: 2, createdVersion: false });

      // ifChanged only skips the version — metadata on the same call still applies.
      const metaOnly = await publishDoc(app, ctx, {
        slug: s,
        content: "two",
        ifChanged: true,
        title: "V renamed",
        status: "in_review",
      });
      expect(metaOnly).toMatchObject({
        version: 2,
        createdVersion: false,
        title: "V renamed",
        status: "in_review",
      });

      const read = await humanRequest(app, ctx.accessToken)("GET", `/api/v1/documents/${v1.id}?version=2`);
      expect(read.json().version.note).toBe("second pass");
      const readV1 = await humanRequest(app, ctx.accessToken)("GET", `/api/v1/documents/${v1.id}?version=1`);
      expect(readV1.json().version.content).toBe("one");
      const missing = await humanRequest(app, ctx.accessToken)("GET", `/api/v1/documents/${v1.id}?version=99`);
      expect(missing.statusCode).toBe(404);
    });

    it("paginates stably across identical updatedAt timestamps", async () => {
      const app = getApp();
      const ctx = await createAdminContext(app);
      const { docDocuments } = await import("../db/schema/index.js");

      // Bulk-import shape: several documents sharing one exact timestamp. A
      // timestamp-only cursor drops the tied rows at a page boundary.
      const sameInstant = new Date("2026-07-05T12:00:00.123Z");
      const tiedSlugs = Array.from({ length: 3 }, (_, i) => slug(`tied-${i}`));
      for (const s of tiedSlugs) {
        await app.db.insert(docDocuments).values({
          id: uuidv7(),
          organizationId: ctx.organizationId,
          slug: s,
          title: s,
          status: "draft",
          latestVersion: 1,
          createdByKind: "human",
          createdById: ctx.humanAgentUuid,
          createdByName: "Test Admin",
          createdAt: sameInstant,
          updatedAt: sameInstant,
        });
      }

      const req = humanRequest(app, ctx.accessToken);
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 100; i++) {
        const url: string = `/api/v1/orgs/${ctx.organizationId}/documents?limit=1${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
        }`;
        const page = await req("GET", url);
        expect(page.statusCode).toBe(200);
        for (const item of page.json().items) {
          if (tiedSlugs.includes(item.slug)) seen.push(item.slug);
        }
        cursor = page.json().nextCursor;
        if (cursor === null) break;
      }

      // Every tied document surfaces exactly once across the full walk.
      expect([...seen].sort()).toEqual([...tiedSlugs].sort());
      expect(new Set(seen).size).toBe(tiedSlugs.length);
    });

    it("paginates stably across microsecond differences within one millisecond", async () => {
      const app = getApp();
      const ctx = await createAdminContext(app);
      const { docDocuments } = await import("../db/schema/index.js");
      const { sql, eq: eqOp } = await import("drizzle-orm");

      // Postgres keeps microseconds; the cursor only carries milliseconds.
      // Give the LARGER (later) uuidv7 id to the row with the SMALLER
      // microsecond part, so id order contradicts raw-timestamp order —
      // the exact shape that exposed the predicate/ordering mismatch.
      const idA = uuidv7();
      const idB = uuidv7();
      const seeds = [
        { id: idA, slug: slug("us-high"), ts: "2026-07-05T15:00:00.123900Z" },
        { id: idB, slug: slug("us-low"), ts: "2026-07-05T15:00:00.123800Z" },
      ];
      for (const seed of seeds) {
        await app.db.insert(docDocuments).values({
          id: seed.id,
          organizationId: ctx.organizationId,
          slug: seed.slug,
          title: seed.slug,
          status: "draft",
          latestVersion: 1,
          createdByKind: "human",
          createdById: ctx.humanAgentUuid,
          createdByName: "Test Admin",
        });
        await app.db
          .update(docDocuments)
          .set({ updatedAt: sql`${seed.ts}::timestamptz` })
          .where(eqOp(docDocuments.id, seed.id));
      }

      const req = humanRequest(app, ctx.accessToken);
      const wanted = seeds.map((s) => s.slug);
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 100; i++) {
        const url: string = `/api/v1/orgs/${ctx.organizationId}/documents?limit=1${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
        }`;
        const page = await req("GET", url);
        expect(page.statusCode).toBe(200);
        for (const item of page.json().items) {
          if (wanted.includes(item.slug)) seen.push(item.slug);
        }
        cursor = page.json().nextCursor;
        if (cursor === null) break;
      }

      expect([...seen].sort()).toEqual([...wanted].sort());
      expect(new Set(seen).size).toBe(wanted.length);
    });

    it("serializes concurrent first publishes of one slug", async () => {
      const app = getApp();
      const ctx = await createAdminContext(app);
      const s = slug("race");
      const req = humanRequest(app, ctx.accessToken);

      // No row exists yet, so FOR UPDATE cannot serialize these — the
      // unique-violation retry in publishDocument must absorb the race.
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          req("POST", `/api/v1/orgs/${ctx.organizationId}/documents`, {
            slug: s,
            title: "Race",
            content: `variant ${i}`,
          }),
        ),
      );

      for (const res of results) expect(res.statusCode).toBe(200);
      const bodies = results.map((r) => {
        const body: PublishDocResponse = r.json();
        return body;
      });
      expect(bodies.filter((b) => b.createdDocument)).toHaveLength(1);
      expect(new Set(bodies.map((b) => b.version)).size).toBe(5);

      const read = await req("GET", `/api/v1/documents/${bodies[0]?.id}`);
      expect(read.json().latestVersion).toBe(5);
    });

    it("accepts documents beyond Fastify's default body limit up to the content cap", async () => {
      const app = getApp();
      const ctx = await createAdminContext(app);
      const req = humanRequest(app, ctx.accessToken);

      // ~1.5M chars: over the ~1 MiB default JSON body limit, under the cap.
      const large = await req("POST", `/api/v1/orgs/${ctx.organizationId}/documents`, {
        slug: slug("large"),
        title: "Large",
        content: "x".repeat(1_500_000),
      });
      expect(large.statusCode).toBe(200);

      // Over the schema cap: the body still arrives (route bodyLimit is
      // higher) and Zod rejects it as a 400, not a transport-level 413.
      const overCap = await req("POST", `/api/v1/orgs/${ctx.organizationId}/documents`, {
        slug: slug("overcap"),
        title: "Too Large",
        content: "x".repeat(2_000_001),
      });
      expect(overCap.statusCode).toBe(400);
    });

    it("lists with slug/status/project filters and paginates", async () => {
      const app = getApp();
      const ctx = await createAdminContext(app);
      const project = `proj-${crypto.randomUUID().slice(0, 8)}`;
      const a = await publishDoc(app, ctx, { slug: slug("list-a"), title: "A", content: "a", project });
      await publishDoc(app, ctx, { slug: slug("list-b"), title: "B", content: "b", project, status: "in_review" });

      const req = humanRequest(app, ctx.accessToken);
      const byProject = await req("GET", `/api/v1/orgs/${ctx.organizationId}/documents?project=${project}`);
      expect(byProject.json().items).toHaveLength(2);

      const bySlug = await req("GET", `/api/v1/orgs/${ctx.organizationId}/documents?slug=${a.slug}`);
      expect(bySlug.json().items).toHaveLength(1);
      expect(bySlug.json().items[0].id).toBe(a.id);

      const byStatus = await req(
        "GET",
        `/api/v1/orgs/${ctx.organizationId}/documents?project=${project}&status=in_review`,
      );
      expect(byStatus.json().items).toHaveLength(1);
      expect(byStatus.json().items[0].title).toBe("B");

      const page1 = await req("GET", `/api/v1/orgs/${ctx.organizationId}/documents?project=${project}&limit=1`);
      expect(page1.json().items).toHaveLength(1);
      expect(page1.json().nextCursor).not.toBeNull();
      const page2 = await req(
        "GET",
        `/api/v1/orgs/${ctx.organizationId}/documents?project=${project}&limit=1&cursor=${encodeURIComponent(
          page1.json().nextCursor,
        )}`,
      );
      expect(page2.json().items).toHaveLength(1);
      expect(page2.json().items[0].id).not.toBe(page1.json().items[0].id);

      const invalidCursor = await req("GET", `/api/v1/orgs/${ctx.organizationId}/documents?cursor=not-a-cursor`);
      expect(invalidCursor.statusCode).toBe(400);
    });
  });

  describe("resource surface (Class C)", () => {
    it("changes document status", async () => {
      const app = getApp();
      const ctx = await createAdminContext(app);
      const doc = await publishDoc(app, ctx, { slug: slug("status"), title: "S", content: "c" });

      const req = humanRequest(app, ctx.accessToken);
      const ok = await req("PATCH", `/api/v1/documents/${doc.id}`, { status: "approved" });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().status).toBe("approved");

      const bad = await req("PATCH", `/api/v1/documents/${doc.id}`, { status: "nonsense" });
      expect(bad.statusCode).toBe(400);
    });

    it("runs the comment → reply → resolve loop with anchors", async () => {
      const app = getApp();
      const ctx = await createAdminContext(app);
      const doc = await publishDoc(app, ctx, { slug: slug("comments"), title: "C", content: "alpha beta gamma" });
      const req = humanRequest(app, ctx.accessToken);

      const comment = await req("POST", `/api/v1/documents/${doc.id}/comments`, {
        body: "why beta?",
        anchor: { exact: "beta", prefix: "alpha ", suffix: " gamma" },
      });
      expect(comment.statusCode).toBe(200);
      expect(comment.json()).toMatchObject({
        documentId: doc.id,
        versionNumber: 1,
        status: "open",
        anchor: { exact: "beta" },
      });
      expect(comment.json().author.kind).toBe("human");

      const reply = await req("POST", `/api/v1/document-comments/${comment.json().id}/replies`, {
        body: "because gamma",
      });
      expect(reply.statusCode).toBe(200);
      expect(reply.json()).toMatchObject({ parentId: comment.json().id, versionNumber: 1, anchor: null });

      const missingParentReply = await req("POST", `/api/v1/document-comments/${uuidv7()}/replies`, {
        body: "missing parent",
      });
      expect(missingParentReply.statusCode).toBe(404);

      // Threads are one level deep — replying to a reply is a 400.
      const replyToReply = await req("POST", `/api/v1/document-comments/${reply.json().id}/replies`, {
        body: "nope",
      });
      expect(replyToReply.statusCode).toBe(400);
      // A reply has no independent status.
      const resolveReply = await req("PATCH", `/api/v1/document-comments/${reply.json().id}`, {
        status: "resolved",
      });
      expect(resolveReply.statusCode).toBe(400);

      const beforeResolve = await req("GET", `/api/v1/documents/${doc.id}`);
      const resolved = await req("PATCH", `/api/v1/document-comments/${comment.json().id}`, { status: "resolved" });
      expect(resolved.statusCode).toBe(200);
      expect(resolved.json().status).toBe("resolved");

      // Resolving is review activity: the document's list-order key moves.
      const afterResolve = await req("GET", `/api/v1/documents/${doc.id}`);
      expect(new Date(afterResolve.json().updatedAt).getTime()).toBeGreaterThan(
        new Date(beforeResolve.json().updatedAt).getTime(),
      );

      // Status filtering is thread-scoped: the reply follows its parent.
      const openLeft = await req("GET", `/api/v1/documents/${doc.id}/comments?status=open`);
      expect(openLeft.json().items).toHaveLength(0);
      const resolvedThread = await req("GET", `/api/v1/documents/${doc.id}/comments?status=resolved`);
      expect(resolvedThread.json().items).toHaveLength(2);

      // Document-level open-comment count reflects thread status.
      const summary = await req("GET", `/api/v1/documents/${doc.id}`);
      expect(summary.json().openCommentCount).toBe(0);
    });

    it("rejects anchored replies and missing parent comments in the document service", async () => {
      const app = getApp();
      const ctx = await createAdminContext(app);
      const doc = await publishDoc(app, ctx, { slug: slug("service-replies"), title: "S", content: "alpha beta" });
      const [document] = await app.db.select().from(docDocuments).where(eq(docDocuments.id, doc.id)).limit(1);
      if (!document) throw new Error("published document row was not found");
      const author = { kind: "human" as const, id: ctx.humanAgentUuid, name: "Test Admin" };
      const parent = await createComment(app.db, {
        document,
        author,
        body: "root comment",
        anchor: { exact: "beta" },
      });

      await expect(
        createComment(app.db, {
          document,
          author,
          body: "anchored reply",
          parentId: parent.id,
          anchor: { exact: "beta" },
        }),
      ).rejects.toThrow("Replies cannot carry an anchor");

      await expect(
        createComment(app.db, {
          document,
          author,
          body: "missing parent",
          parentId: uuidv7(),
        }),
      ).rejects.toThrow("Parent comment not found on this document");
    });

    it("rejects missing document author identities", async () => {
      const chain = {
        from: () => chain,
        limit: async () => [],
        where: () => chain,
      };
      await expect(docAuthorForAgentUuid({ select: () => chain } as never, "missing-agent")).rejects.toThrow(
        "Caller identity not found",
      );
    });

    it("marks anchored comments outdated when their quote disappears from the latest version", async () => {
      const app = getApp();
      const ctx = await createAdminContext(app);
      const doc = await publishDoc(app, ctx, { slug: slug("anchored"), title: "A", content: "alpha beta gamma" });
      const req = humanRequest(app, ctx.accessToken);

      const kept = await req("POST", `/api/v1/documents/${doc.id}/comments`, {
        body: "keep me",
        anchor: { exact: "alpha" },
      });
      const dropped = await req("POST", `/api/v1/documents/${doc.id}/comments`, {
        body: "drop me",
        anchor: { exact: "beta" },
      });
      expect(kept.statusCode).toBe(200);
      expect(dropped.statusCode).toBe(200);

      // v2 rewrites the text: "beta" is edited away, "alpha" survives a reflow.
      await publishDoc(app, ctx, { slug: doc.slug, content: "alpha\n  gamma delta" });

      const list = await req("GET", `/api/v1/documents/${doc.id}/comments`);
      const items: Array<{ id: string; outdated?: boolean }> = list.json().items;
      expect(items.find((c) => c.id === kept.json().id)?.outdated).toBe(false);
      expect(items.find((c) => c.id === dropped.json().id)?.outdated).toBe(true);

      // Comments on the current latest version carry no outdated flag at all.
      const fresh = await req("POST", `/api/v1/documents/${doc.id}/comments`, {
        body: "current",
        anchor: { exact: "delta" },
      });
      expect(fresh.statusCode).toBe(200);
      const relist = await req("GET", `/api/v1/documents/${doc.id}/comments`);
      const freshRow: { outdated?: boolean } | undefined = relist
        .json()
        .items.find((c: { id: string }) => c.id === fresh.json().id);
      expect(freshRow?.outdated).toBeUndefined();
    });

    it("rejects bad comment targets", async () => {
      const app = getApp();
      const ctx = await createAdminContext(app);
      const doc = await publishDoc(app, ctx, { slug: slug("badc"), title: "B", content: "c" });
      const req = humanRequest(app, ctx.accessToken);

      const badVersion = await req("POST", `/api/v1/documents/${doc.id}/comments`, {
        body: "x",
        versionNumber: 5,
      });
      expect(badVersion.statusCode).toBe(400);

      const ghostDoc = await req("POST", `/api/v1/documents/${uuidv7()}/comments`, { body: "x" });
      expect(ghostDoc.statusCode).toBe(404);

      const ghostComment = await req("PATCH", `/api/v1/document-comments/${uuidv7()}`, { status: "resolved" });
      expect(ghostComment.statusCode).toBe(404);
    });

    it("404s cross-org access without leaking existence", async () => {
      const app = getApp();
      const ctx = await createAdminContext(app);

      // Seed a document in a separate org; the default-org member must get
      // 404 (not 403) on every Class C path so existence never leaks.
      const outside = await createOutsideOrgContext(app);
      const outsideDocId = uuidv7();
      const outsideSlug = slug("outside");
      const { docDocuments, docVersions } = await import("../db/schema/index.js");
      await app.db.insert(docDocuments).values({
        id: outsideDocId,
        organizationId: outside.orgId,
        slug: outsideSlug,
        title: "Outside Doc",
        status: "draft",
        latestVersion: 1,
        createdByKind: "human",
        createdById: outside.humanAgentUuid,
        createdByName: "Outside Human",
      });
      await app.db.insert(docVersions).values({
        id: uuidv7(),
        documentId: outsideDocId,
        number: 1,
        content: "outside content",
        authorKind: "human",
        authorId: outside.humanAgentUuid,
        authorName: "Outside Human",
      });

      const req = humanRequest(app, ctx.accessToken);
      expect((await req("GET", `/api/v1/documents/${outsideDocId}`)).statusCode).toBe(404);
      expect((await req("POST", `/api/v1/documents/${outsideDocId}/comments`, { body: "x" })).statusCode).toBe(404);
      expect((await req("PATCH", `/api/v1/documents/${outsideDocId}`, { status: "approved" })).statusCode).toBe(404);

      // And the default org's list never shows the outside org's document.
      const list = await req("GET", `/api/v1/orgs/${ctx.organizationId}/documents?slug=${outsideSlug}`);
      expect(list.json().items).toHaveLength(0);
    });
  });

  describe("agent surface (Class D)", () => {
    it("runs the full publish → comment → reply → resolve loop as an agent", async () => {
      const app = getApp();
      const { agent, request } = await createTestAgent(app, { name: `doc-agent-${crypto.randomUUID().slice(0, 6)}` });
      const s = slug("agent");

      const published = await request("POST", "/api/v1/agent/documents", {
        slug: s,
        title: "Agent Doc",
        content: "agent draft",
        status: "in_review",
      });
      expect(published.statusCode).toBe(200);
      expect(published.json()).toMatchObject({ slug: s, version: 1, status: "in_review", createdDocument: true });

      const docId = published.json().id;
      const read = await request("GET", `/api/v1/agent/documents/${docId}`);
      expect(read.statusCode).toBe(200);
      expect(read.json().createdBy).toMatchObject({ kind: "agent", id: agent.uuid, name: agent.displayName });
      expect(read.json().version.content).toBe("agent draft");

      // Slug resolution via list filter — the CLI's slug→id path.
      const bySlug = await request("GET", `/api/v1/agent/documents?slug=${s}`);
      expect(bySlug.json().items).toHaveLength(1);
      expect(bySlug.json().items[0].id).toBe(docId);

      const comment = await request("POST", `/api/v1/agent/documents/${docId}/comments`, {
        body: "self note",
        anchor: { exact: "draft" },
      });
      expect(comment.statusCode).toBe(200);
      expect(comment.json().author).toMatchObject({ kind: "agent", name: agent.displayName });

      const reply = await request("POST", `/api/v1/agent/document-comments/${comment.json().id}/replies`, {
        body: "answered",
      });
      expect(reply.statusCode).toBe(200);

      const resolved = await request("PATCH", `/api/v1/agent/document-comments/${comment.json().id}`, {
        status: "resolved",
      });
      expect(resolved.statusCode).toBe(200);

      const open = await request("GET", `/api/v1/agent/documents/${docId}/comments?status=open`);
      expect(open.json().items).toHaveLength(0);

      const statusSet = await request("PATCH", `/api/v1/agent/documents/${docId}`, { status: "approved" });
      expect(statusSet.statusCode).toBe(200);
      expect(statusSet.json().status).toBe("approved");
    });

    it("404s documents outside the agent's org", async () => {
      const app = getApp();
      const { request } = await createTestAgent(app);
      const outside = await createOutsideOrgContext(app);

      const { docDocuments } = await import("../db/schema/index.js");
      const outsideDocId = uuidv7();
      await app.db.insert(docDocuments).values({
        id: outsideDocId,
        organizationId: outside.orgId,
        slug: slug("agent-outside"),
        title: "Elsewhere",
        status: "draft",
        latestVersion: 1,
        createdByKind: "human",
        createdById: outside.humanAgentUuid,
        createdByName: "Outside Human",
      });

      expect((await request("GET", `/api/v1/agent/documents/${outsideDocId}`)).statusCode).toBe(404);
      expect(
        (await request("PATCH", `/api/v1/agent/documents/${outsideDocId}`, { status: "approved" })).statusCode,
      ).toBe(404);
    });

    it("records a human identity-mirror agent as a human author", async () => {
      const app = getApp();
      const human = await createTestAgent(app, { type: "human" });
      const s = slug("mirror");

      const published = await human.request("POST", "/api/v1/agent/documents", {
        slug: s,
        title: "Mirror Doc",
        content: "hi",
      });
      expect(published.statusCode).toBe(200);
      const read = await human.request("GET", `/api/v1/agent/documents/${published.json().id}`);
      expect(read.json().createdBy.kind).toBe("human");
    });
  });
});

describe("documents API with the feature flag off", () => {
  const getApp = useTestApp({ docsEnabled: false });

  it("mounts no document routes", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app);
    const req = humanRequest(app, ctx.accessToken);

    expect(
      (await req("POST", `/api/v1/orgs/${ctx.organizationId}/documents`, { slug: "x", title: "x", content: "x" }))
        .statusCode,
    ).toBe(404);
    expect((await req("GET", `/api/v1/documents/${uuidv7()}`)).statusCode).toBe(404);
  });
});
