import type {
  CreateDocCommentRequest,
  DocAuthor,
  DocComment,
  DocSummary,
  DocVersion,
  DocWithVersion,
  ListDocCommentsQuery,
  ListDocsQuery,
  PublishDocRequest,
  PublishDocResponse,
} from "@first-tree/shared";
import { docCommentStatusSchema, docStatusSchema, locateDocAnchor } from "@first-tree/shared";
import { and, asc, desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { docComments, docDocuments, docVersions } from "../db/schema/index.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import { uuidv7 } from "../uuid.js";

/**
 * Document review (docloop) domain service.
 *
 * Identity comes in as a `DocAuthor` principal ({ kind, id, name }) that the
 * route layer resolves from either the org scope (humans — their identity-
 * mirror agent) or the agent selector (agents). The service never touches
 * auth tables; org authorization has already happened at the route layer.
 * This is the extractability seam: the domain depends on the principal
 * shape, not on how the host authenticates it.
 *
 * Services throw AppError subclasses; routes map them to HTTP statuses.
 */

export type DocDocumentRow = typeof docDocuments.$inferSelect;
export type DocCommentRow = typeof docComments.$inferSelect;
type DocVersionRow = typeof docVersions.$inferSelect;

function toAuthor(kind: string, id: string, name: string): DocAuthor {
  return { kind: kind === "human" ? "human" : "agent", id, name };
}

function toSummary(row: DocDocumentRow, openCommentCount: number): DocSummary {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    project: row.project,
    status: docStatusSchema.parse(row.status),
    latestVersion: row.latestVersion,
    openCommentCount,
    createdBy: toAuthor(row.createdByKind, row.createdById, row.createdByName),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toVersion(row: DocVersionRow): DocVersion {
  return {
    number: row.number,
    content: row.content,
    note: row.note,
    author: toAuthor(row.authorKind, row.authorId, row.authorName),
    createdAt: row.createdAt.toISOString(),
  };
}

export function toDocComment(row: DocCommentRow): DocComment {
  return {
    id: row.id,
    documentId: row.documentId,
    versionNumber: row.versionNumber,
    parentId: row.parentId,
    author: toAuthor(row.authorKind, row.authorId, row.authorName),
    body: row.body,
    anchor: row.anchor ?? null,
    status: docCommentStatusSchema.parse(row.status),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// Replies carry no independent status (they follow their thread), so open
// counts consider top-level comments only.
async function openCommentCount(db: Database, documentId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(docComments)
    .where(and(eq(docComments.documentId, documentId), eq(docComments.status, "open"), isNull(docComments.parentId)));
  return row?.count ?? 0;
}

/** Postgres `unique_violation` SQLSTATE — emitted on UNIQUE constraint trips. */
const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
  return code === PG_UNIQUE_VIOLATION;
}

/**
 * Idempotent publish: creates the document on first publish of a slug,
 * appends the next version otherwise. Runs in a transaction with the
 * document row locked so concurrent publishes of the same slug serialize
 * (the unique (document_id, number) index is the backstop).
 *
 * Concurrent FIRST publishes of one slug have no row for `FOR UPDATE` to
 * lock, so both take the create branch and the loser trips
 * `doc_documents_org_slug_unique` (Postgres reports it only after the
 * winner's transaction commits). One retry then sees the committed row and
 * takes the locked append path, so the loser publishes version 2 instead of
 * surfacing a 500.
 */
export async function publishDocument(
  db: Database,
  input: PublishDocRequest & { organizationId: string; author: DocAuthor },
): Promise<PublishDocResponse> {
  try {
    return await publishDocumentOnce(db, input);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return await publishDocumentOnce(db, input);
  }
}

async function publishDocumentOnce(
  db: Database,
  input: PublishDocRequest & { organizationId: string; author: DocAuthor },
): Promise<PublishDocResponse> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(docDocuments)
      .where(and(eq(docDocuments.organizationId, input.organizationId), eq(docDocuments.slug, input.slug)))
      .for("update")
      .limit(1);

    if (!existing) {
      if (!input.title) {
        throw new BadRequestError("title is required on the first publish of a slug");
      }
      const documentId = uuidv7();
      const status = input.status ?? "draft";
      const [doc] = await tx
        .insert(docDocuments)
        .values({
          id: documentId,
          organizationId: input.organizationId,
          slug: input.slug,
          title: input.title,
          project: input.project ?? null,
          status,
          latestVersion: 1,
          createdByKind: input.author.kind,
          createdById: input.author.id,
          createdByName: input.author.name,
        })
        .returning();
      if (!doc) throw new Error("doc_documents insert returned no row");
      await tx.insert(docVersions).values({
        id: uuidv7(),
        documentId,
        number: 1,
        content: input.content,
        note: input.note ?? null,
        authorKind: input.author.kind,
        authorId: input.author.id,
        authorName: input.author.name,
      });
      return {
        id: doc.id,
        slug: doc.slug,
        title: doc.title,
        project: doc.project,
        status: docStatusSchema.parse(doc.status),
        version: 1,
        createdDocument: true,
        createdVersion: true,
      };
    }

    if (input.ifChanged) {
      const [latest] = await tx
        .select({ content: docVersions.content })
        .from(docVersions)
        .where(and(eq(docVersions.documentId, existing.id), eq(docVersions.number, existing.latestVersion)))
        .limit(1);
      if (latest && latest.content === input.content) {
        // `ifChanged` only skips the VERSION — metadata carried on the same
        // call (title/project/status) still applies, so e.g.
        // `doc publish --if-changed --status in_review` moves the status
        // even when the content is untouched.
        let row = existing;
        if (input.title !== undefined || input.project !== undefined || input.status !== undefined) {
          const [updated] = await tx
            .update(docDocuments)
            .set({
              ...(input.title !== undefined ? { title: input.title } : {}),
              ...(input.project !== undefined ? { project: input.project } : {}),
              ...(input.status !== undefined ? { status: input.status } : {}),
              updatedAt: new Date(),
            })
            .where(eq(docDocuments.id, existing.id))
            .returning();
          if (!updated) throw new Error("doc_documents update returned no row");
          row = updated;
        }
        return {
          id: row.id,
          slug: row.slug,
          title: row.title,
          project: row.project,
          status: docStatusSchema.parse(row.status),
          version: existing.latestVersion,
          createdDocument: false,
          createdVersion: false,
        };
      }
    }

    const nextNumber = existing.latestVersion + 1;
    await tx.insert(docVersions).values({
      id: uuidv7(),
      documentId: existing.id,
      number: nextNumber,
      content: input.content,
      note: input.note ?? null,
      authorKind: input.author.kind,
      authorId: input.author.id,
      authorName: input.author.name,
    });
    const [updated] = await tx
      .update(docDocuments)
      .set({
        latestVersion: nextNumber,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.project !== undefined ? { project: input.project } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        updatedAt: new Date(),
      })
      .where(eq(docDocuments.id, existing.id))
      .returning();
    if (!updated) throw new Error("doc_documents update returned no row");
    return {
      id: updated.id,
      slug: updated.slug,
      title: updated.title,
      project: updated.project,
      status: docStatusSchema.parse(updated.status),
      version: nextNumber,
      createdDocument: false,
      createdVersion: true,
    };
  });
}

export async function getDocumentRow(db: Database, documentId: string): Promise<DocDocumentRow | null> {
  const [row] = await db.select().from(docDocuments).where(eq(docDocuments.id, documentId)).limit(1);
  return row ?? null;
}

/** Resolve a document with one version's content (latest when unspecified). */
export async function getDocumentWithVersion(
  db: Database,
  doc: DocDocumentRow,
  versionNumber?: number,
): Promise<DocWithVersion> {
  const target = versionNumber ?? doc.latestVersion;
  const [version] = await db
    .select()
    .from(docVersions)
    .where(and(eq(docVersions.documentId, doc.id), eq(docVersions.number, target)))
    .limit(1);
  if (!version) {
    throw new NotFoundError(`Version ${target} not found for document "${doc.slug}"`);
  }
  return {
    ...toSummary(doc, await openCommentCount(db, doc.id)),
    version: toVersion(version),
  };
}

export async function listDocuments(
  db: Database,
  organizationId: string,
  query: ListDocsQuery,
): Promise<{ items: DocSummary[]; nextCursor: string | null }> {
  const conditions = [eq(docDocuments.organizationId, organizationId)];
  if (query.slug) conditions.push(eq(docDocuments.slug, query.slug));
  if (query.project) conditions.push(eq(docDocuments.project, query.project));
  if (query.status) conditions.push(eq(docDocuments.status, query.status));
  if (query.cursor) {
    const cursorDate = new Date(query.cursor);
    if (Number.isNaN(cursorDate.getTime())) {
      throw new BadRequestError("cursor must be an ISO timestamp from a previous page");
    }
    conditions.push(lt(docDocuments.updatedAt, cursorDate));
  }

  const rows = await db
    .select({
      doc: docDocuments,
      openComments: sql<number>`(
        SELECT count(*)::int FROM ${docComments}
        WHERE ${docComments.documentId} = ${docDocuments.id}
          AND ${docComments.status} = 'open'
          AND ${docComments.parentId} IS NULL
      )`,
    })
    .from(docDocuments)
    .where(and(...conditions))
    .orderBy(desc(docDocuments.updatedAt))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(({ doc, openComments }) => toSummary(doc, openComments)),
    nextCursor: hasMore && last ? last.doc.updatedAt.toISOString() : null,
  };
}

export async function setDocumentStatus(
  db: Database,
  doc: DocDocumentRow,
  status: DocSummary["status"],
): Promise<DocSummary> {
  const [updated] = await db
    .update(docDocuments)
    .set({ status, updatedAt: new Date() })
    .where(eq(docDocuments.id, doc.id))
    .returning();
  if (!updated) throw new NotFoundError("Document not found");
  return toSummary(updated, await openCommentCount(db, doc.id));
}

export async function createComment(
  db: Database,
  input: CreateDocCommentRequest & { document: DocDocumentRow; author: DocAuthor },
): Promise<DocComment> {
  const { document } = input;

  let versionNumber = input.versionNumber ?? document.latestVersion;
  if (input.parentId) {
    if (input.anchor) {
      throw new BadRequestError("Replies cannot carry an anchor");
    }
    const [parent] = await db.select().from(docComments).where(eq(docComments.id, input.parentId)).limit(1);
    if (!parent || parent.documentId !== document.id) {
      throw new NotFoundError("Parent comment not found on this document");
    }
    if (parent.parentId) {
      throw new BadRequestError("Threads are one level deep; reply to the top-level comment");
    }
    versionNumber = parent.versionNumber;
  } else if (versionNumber < 1 || versionNumber > document.latestVersion) {
    throw new BadRequestError(`versionNumber must be between 1 and ${document.latestVersion}`);
  }

  const [row] = await db
    .insert(docComments)
    .values({
      id: uuidv7(),
      documentId: document.id,
      versionNumber,
      parentId: input.parentId ?? null,
      authorKind: input.author.kind,
      authorId: input.author.id,
      authorName: input.author.name,
      body: input.body,
      anchor: input.anchor ?? null,
    })
    .returning();
  if (!row) throw new Error("doc_comments insert returned no row");

  await db.update(docDocuments).set({ updatedAt: new Date() }).where(eq(docDocuments.id, document.id));
  return toDocComment(row);
}

export async function getCommentRow(db: Database, commentId: string): Promise<DocCommentRow | null> {
  const [row] = await db.select().from(docComments).where(eq(docComments.id, commentId)).limit(1);
  return row ?? null;
}

export async function setCommentStatus(
  db: Database,
  comment: DocCommentRow,
  status: DocComment["status"],
): Promise<DocComment> {
  if (comment.parentId) {
    throw new BadRequestError("Resolve the top-level comment; replies have no independent status");
  }
  const [updated] = await db
    .update(docComments)
    .set({ status, updatedAt: new Date() })
    .where(eq(docComments.id, comment.id))
    .returning();
  if (!updated) throw new NotFoundError("Comment not found");
  return toDocComment(updated);
}

export async function listComments(
  db: Database,
  document: DocDocumentRow,
  query: ListDocCommentsQuery,
): Promise<DocComment[]> {
  const conditions = [eq(docComments.documentId, document.id)];
  if (query.versionNumber !== undefined) conditions.push(eq(docComments.versionNumber, query.versionNumber));

  const rows = await db
    .select()
    .from(docComments)
    .where(and(...conditions))
    .orderBy(asc(docComments.createdAt));

  let filtered = rows;
  if (query.status !== undefined) {
    // Status filters operate on threads: a reply has no independent status,
    // so it follows its top-level comment's.
    const topLevelStatus = new Map<string, string>();
    for (const row of rows) {
      if (!row.parentId) topLevelStatus.set(row.id, row.status);
    }
    filtered = rows.filter((row) => (row.parentId ? topLevelStatus.get(row.parentId) : row.status) === query.status);
  }

  const comments = filtered.map(toDocComment);
  await markOutdatedAnchors(db, document, comments);
  return comments;
}

/**
 * Read-time re-anchoring: an anchored top-level comment made against an
 * older version is "outdated" when its quote no longer locates in the
 * LATEST version (whitespace-insensitive; same `locateDocAnchor` the web
 * highlight path uses). Computed on read and never stored, so it always
 * reflects the current head version.
 */
async function markOutdatedAnchors(db: Database, document: DocDocumentRow, comments: DocComment[]): Promise<void> {
  const candidates = comments.filter((c) => c.anchor && !c.parentId && c.versionNumber !== document.latestVersion);
  if (candidates.length === 0) return;

  const [latest] = await db
    .select({ content: docVersions.content })
    .from(docVersions)
    .where(and(eq(docVersions.documentId, document.id), eq(docVersions.number, document.latestVersion)))
    .limit(1);
  if (!latest) return;

  for (const comment of candidates) {
    if (!comment.anchor) continue;
    comment.outdated = locateDocAnchor(latest.content, comment.anchor) === null;
  }
}
