import { randomUUID } from "node:crypto";
import { MAX_MESSAGE_ATTACHMENT_REFS } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { BadRequestError } from "../errors.js";
import type { AttachmentReader } from "../services/attachment.js";
import { validateDocumentContext, validateMessageAttachmentRefs } from "../services/doc-snapshots.js";

describe("validateDocumentContext", () => {
  it("accepts metadata without documentContext", () => {
    expect(() => validateDocumentContext({})).not.toThrow();
    expect(() => validateDocumentContext(undefined)).not.toThrow();
    expect(() => validateDocumentContext({ mentions: ["x"] })).not.toThrow();
  });

  it("accepts a snapshot variant carrying a failedMentions roster", () => {
    expect(() =>
      validateDocumentContext({
        documentContext: {
          kind: "snapshot",
          failedMentions: [{ raw: "docs/missing.md", reason: "missing" }],
        },
      }),
    ).not.toThrow();
  });

  it("rejects a snapshot variant with an empty failedMentions roster", () => {
    expect(() =>
      validateDocumentContext({
        documentContext: { kind: "snapshot", failedMentions: [] },
      }),
    ).toThrow(BadRequestError);
  });

  it("rejects a snapshot variant with no failedMentions field", () => {
    // The inline `docs[]` shape is gone, so a bare `{ kind: "snapshot" }` is
    // no longer valid — the roster is now required.
    expect(() =>
      validateDocumentContext({
        documentContext: { kind: "snapshot" },
      }),
    ).toThrow(BadRequestError);
  });

  it("rejects an unknown failure reason", () => {
    expect(() =>
      validateDocumentContext({
        documentContext: {
          kind: "snapshot",
          failedMentions: [{ raw: "docs/x.md", reason: "nonsense" }],
        },
      }),
    ).toThrow(BadRequestError);
  });

  it("normalises legacy `{ basePath }` to kind=path via the shared preprocessor", () => {
    expect(() => validateDocumentContext({ documentContext: { basePath: "first-tree" } })).not.toThrow();
  });

  it("rejects the legacy inline snapshot shape (cutover — graceful degrade is reader-side)", () => {
    // A pre-cutover message's inline `docs[].content` shape no longer matches
    // the schema. On the SEND path that's a client bug worth surfacing; readers
    // (web) tolerate the old shape by falling back to no-preview.
    expect(() =>
      validateDocumentContext({
        documentContext: {
          kind: "snapshot",
          docs: [{ path: "docs/design.md", content: "# design", sha256: "a".repeat(64), size: 8 }],
        },
      }),
    ).toThrow(BadRequestError);
  });
});

describe("validateMessageAttachmentRefs", () => {
  const id = randomUUID();
  const baseRef = (overrides: Record<string, unknown> = {}) => ({
    attachmentId: id,
    kind: "document",
    mimeType: "text/markdown",
    filename: "design.md",
    size: 12,
    sha256: "a".repeat(64),
    source: { path: "docs/design.md" },
    ...overrides,
  });

  // The fake reader can't decode drizzle's `eq()` predicate, so we give it a
  // single-row store keyed by the only id we reference and read by ignoring the
  // predicate — every `select` returns that row. Tests that need "missing" use
  // an empty store.
  // Minimal stand-in for the `select().from().where().limit()` chain
  // `loadAttachmentMeta` uses. Drizzle's real builder types are far richer than
  // this test needs, so the whole stub is cast through `unknown` to
  // `AttachmentReader` — the only contract we exercise is that `limit()`
  // resolves to the seeded row (or none).
  function readerWith(row: { mimeType: string; sizeBytes: number } | null): AttachmentReader {
    const chain = {
      from() {
        return chain;
      },
      where() {
        return chain;
      },
      async limit() {
        return row ? [{ id, ...row }] : [];
      },
    };
    return { select: () => chain } as unknown as AttachmentReader;
  }

  it("no-ops when there is no attachments field", async () => {
    await expect(validateMessageAttachmentRefs(readerWith(null), {})).resolves.toBeUndefined();
    await expect(validateMessageAttachmentRefs(readerWith(null), undefined)).resolves.toBeUndefined();
  });

  it("accepts a ref whose mime + size match the stored row", async () => {
    await expect(
      validateMessageAttachmentRefs(readerWith({ mimeType: "text/markdown", sizeBytes: 12 }), {
        attachments: [baseRef()],
      }),
    ).resolves.toBeUndefined();
  });

  it("accepts a supported generic image ref whose mime + size match the stored row", async () => {
    await expect(
      validateMessageAttachmentRefs(readerWith({ mimeType: "image/png", sizeBytes: 12 }), {
        attachments: [
          baseRef({
            kind: "image",
            mimeType: "image/png",
            filename: "decision.png",
            sha256: undefined,
            source: undefined,
          }),
        ],
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a generic image ref whose MIME is unsupported by image consumers", async () => {
    await expect(
      validateMessageAttachmentRefs(readerWith({ mimeType: "image/svg+xml", sizeBytes: 12 }), {
        attachments: [
          baseRef({
            kind: "image",
            mimeType: "image/svg+xml",
            filename: "decision.svg",
            sha256: undefined,
            source: undefined,
          }),
        ],
      }),
    ).rejects.toThrow(BadRequestError);
  });

  it("rejects a ref pointing at a non-existent attachment", async () => {
    await expect(validateMessageAttachmentRefs(readerWith(null), { attachments: [baseRef()] })).rejects.toThrow(
      BadRequestError,
    );
  });

  it("rejects more attachment refs than the message cap", async () => {
    await expect(
      validateMessageAttachmentRefs(readerWith(null), {
        attachments: Array.from({ length: MAX_MESSAGE_ATTACHMENT_REFS + 1 }, () => baseRef()),
      }),
    ).rejects.toMatchObject({
      attrs: {
        "attachment_ref.count": MAX_MESSAGE_ATTACHMENT_REFS + 1,
        "attachment_ref.limit": MAX_MESSAGE_ATTACHMENT_REFS,
      },
    });
  });

  it("rejects a mime mismatch", async () => {
    await expect(
      validateMessageAttachmentRefs(readerWith({ mimeType: "image/png", sizeBytes: 12 }), {
        attachments: [baseRef()],
      }),
    ).rejects.toThrow(BadRequestError);
  });

  it("rejects a size mismatch", async () => {
    await expect(
      validateMessageAttachmentRefs(readerWith({ mimeType: "text/markdown", sizeBytes: 99 }), {
        attachments: [baseRef()],
      }),
    ).rejects.toThrow(BadRequestError);
  });

  it("rejects a present-but-malformed attachments entry (strict on send)", async () => {
    await expect(
      validateMessageAttachmentRefs(readerWith({ mimeType: "text/markdown", sizeBytes: 12 }), {
        attachments: [{ attachmentId: "not-a-uuid" }],
      }),
    ).rejects.toThrow(BadRequestError);
  });

  // R5: the strict reader now full-schema-parses each ref, so a ref with a
  // schema-invalid sha256 (wrong length) is rejected before any DB lookup —
  // not just the uuid-shape check the hand-rolled guard performed.
  it("rejects a ref whose sha256 is the wrong length (full schema parse)", async () => {
    await expect(
      validateMessageAttachmentRefs(readerWith({ mimeType: "text/markdown", sizeBytes: 12 }), {
        attachments: [baseRef({ sha256: "abc" })],
      }),
    ).rejects.toThrow(BadRequestError);
  });

  // R5: schema parse attributes the failing index for diagnostics.
  it("reports the failing ref index in the BadRequestError attributes", async () => {
    await expect(
      validateMessageAttachmentRefs(readerWith({ mimeType: "text/markdown", sizeBytes: 12 }), {
        attachments: [baseRef(), baseRef({ size: -1 })],
      }),
    ).rejects.toMatchObject({ attrs: { "attachment_ref.index": 1 } });
  });

  it("rejects a non-array attachments field", async () => {
    await expect(validateMessageAttachmentRefs(readerWith(null), { attachments: "nope" })).rejects.toThrow(
      BadRequestError,
    );
  });

  it("does not check uploader == sender (uploaded_by is the managing human)", async () => {
    // The stored row carries no uploadedBy in the fake, and the validator never
    // reads it — a normal send (agent sender ≠ human uploader) must pass.
    await expect(
      validateMessageAttachmentRefs(readerWith({ mimeType: "text/markdown", sizeBytes: 12 }), {
        attachments: [baseRef()],
      }),
    ).resolves.toBeUndefined();
  });
});
