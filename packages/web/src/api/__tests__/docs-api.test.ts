import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
}));

vi.mock("../client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client.js")>();
  return {
    ...actual,
    api: apiMock,
    withOrg: (path: string) => `/orgs/current${path}`,
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.get.mockResolvedValue({});
  apiMock.patch.mockResolvedValue({});
  apiMock.post.mockResolvedValue({});
});

describe("document API wrappers", () => {
  it("lists documents with an org-scoped query string and omits undefined filters", async () => {
    const { listDocs } = await import("../docs.js");

    await listDocs();
    await listDocs({ slug: "handbook", project: "web", status: "draft", limit: 25, cursor: undefined });

    expect(apiMock.get).toHaveBeenCalledWith("/orgs/current/documents");
    expect(apiMock.get).toHaveBeenCalledWith("/orgs/current/documents?slug=handbook&project=web&status=draft&limit=25");
  });

  it("resolves a slug to the first summary or null", async () => {
    const summary = { id: "doc-1", slug: "handbook" };
    apiMock.get.mockResolvedValueOnce({ items: [summary] }).mockResolvedValueOnce({ items: [] });
    const { findDocBySlug } = await import("../docs.js");

    await expect(findDocBySlug("hand/book")).resolves.toBe(summary);
    await expect(findDocBySlug("missing")).resolves.toBeNull();

    expect(apiMock.get).toHaveBeenCalledWith("/orgs/current/documents?slug=hand%2Fbook&limit=1");
    expect(apiMock.get).toHaveBeenCalledWith("/orgs/current/documents?slug=missing&limit=1");
  });

  it("formats document resource requests with encoded ids", async () => {
    const { createDocComment, getDoc, listDocComments, replyDocComment, setDocCommentStatus, setDocStatus } =
      await import("../docs.js");

    await getDoc("doc/id", 7);
    await getDoc("doc/id");
    await setDocStatus("doc/id", "approved");
    await listDocComments("doc/id", { status: "open", versionNumber: 3 });
    await listDocComments("doc/id");
    await createDocComment("doc/id", { body: "Looks good", anchor: { exact: "good" } });
    await replyDocComment("comment/id", "Done");
    await setDocCommentStatus("comment/id", "resolved");

    expect(apiMock.get).toHaveBeenCalledWith("/documents/doc%2Fid?version=7");
    expect(apiMock.get).toHaveBeenCalledWith("/documents/doc%2Fid");
    expect(apiMock.patch).toHaveBeenCalledWith("/documents/doc%2Fid", { status: "approved" });
    expect(apiMock.get).toHaveBeenCalledWith("/documents/doc%2Fid/comments?status=open&versionNumber=3");
    expect(apiMock.get).toHaveBeenCalledWith("/documents/doc%2Fid/comments");
    expect(apiMock.post).toHaveBeenCalledWith("/documents/doc%2Fid/comments", {
      body: "Looks good",
      anchor: { exact: "good" },
    });
    expect(apiMock.post).toHaveBeenCalledWith("/document-comments/comment%2Fid/replies", { body: "Done" });
    expect(apiMock.patch).toHaveBeenCalledWith("/document-comments/comment%2Fid", { status: "resolved" });
  });
});
