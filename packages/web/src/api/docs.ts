import type {
  CreateDocCommentRequest,
  DocComment,
  DocCommentStatus,
  DocStatus,
  DocSummary,
  DocWithVersion,
  ListDocCommentsResponse,
  ListDocsResponse,
} from "@first-tree/shared";
import { api, withOrg } from "./client.js";

/**
 * Document review (docloop) API layer.
 *
 * List/publish are org-scoped (Class B, `withOrg`); everything addressing a
 * specific document or comment goes through the resource surface (Class C,
 * UUID locates the org server-side). Route contracts live in
 * packages/server/src/api/{orgs/,}documents.ts.
 */

export type ListDocsQueryInput = {
  slug?: string;
  project?: string;
  status?: DocStatus;
  limit?: number;
  cursor?: string;
};

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export function listDocs(input: ListDocsQueryInput = {}): Promise<ListDocsResponse> {
  return api.get<ListDocsResponse>(`${withOrg("/documents")}${query(input)}`);
}

/** Slug → summary resolution (slugs are org-unique; the URL uses them). */
export async function findDocBySlug(slug: string): Promise<DocSummary | null> {
  const { items } = await listDocs({ slug, limit: 1 });
  return items[0] ?? null;
}

export function getDoc(docId: string, version?: number): Promise<DocWithVersion> {
  return api.get<DocWithVersion>(`/documents/${encodeURIComponent(docId)}${query({ version })}`);
}

export function setDocStatus(docId: string, status: DocStatus): Promise<DocSummary> {
  return api.patch<DocSummary>(`/documents/${encodeURIComponent(docId)}`, { status });
}

export function listDocComments(
  docId: string,
  input: { status?: DocCommentStatus; versionNumber?: number } = {},
): Promise<ListDocCommentsResponse> {
  return api.get<ListDocCommentsResponse>(`/documents/${encodeURIComponent(docId)}/comments${query(input)}`);
}

export function createDocComment(docId: string, body: CreateDocCommentRequest): Promise<DocComment> {
  return api.post<DocComment>(`/documents/${encodeURIComponent(docId)}/comments`, body);
}

export function replyDocComment(commentId: string, body: string): Promise<DocComment> {
  return api.post<DocComment>(`/document-comments/${encodeURIComponent(commentId)}/replies`, { body });
}

export function setDocCommentStatus(commentId: string, status: DocCommentStatus): Promise<DocComment> {
  return api.patch<DocComment>(`/document-comments/${encodeURIComponent(commentId)}`, { status });
}
