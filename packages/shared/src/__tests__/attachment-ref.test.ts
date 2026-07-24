import { describe, expect, it } from "vitest";
import {
  attachmentRefSchema,
  attachmentRefsFromMetadata,
  imageAttachmentRefsFromMetadata,
  isAttachmentRef,
} from "../schemas/attachment-ref.js";

const baseAttachment = {
  attachmentId: "123e4567-e89b-12d3-a456-426614174000",
  kind: "document",
  mimeType: "text/markdown",
  filename: "NODE.md",
  size: 42,
  sha256: "a".repeat(64),
  source: {
    path: "NODE.md",
    sourcePath: "tree/NODE.md",
  },
} as const;

describe("attachment refs", () => {
  it("accepts a valid attachment ref with optional integrity and source metadata", () => {
    expect(isAttachmentRef(baseAttachment)).toBe(true);
    expect(
      isAttachmentRef({
        ...baseAttachment,
        kind: "image",
        mimeType: "image/png",
        filename: "decision.png",
        sha256: undefined,
        source: undefined,
      }),
    ).toBe(true);
  });

  it("rejects malformed attachment ref shapes", () => {
    for (const value of [
      null,
      "not-an-object",
      { ...baseAttachment, attachmentId: "not-a-uuid" },
      { ...baseAttachment, kind: "video" },
      { ...baseAttachment, mimeType: "" },
      { ...baseAttachment, kind: "image", mimeType: "image/svg+xml" },
      { ...baseAttachment, kind: "image", mimeType: "application/pdf" },
      { ...baseAttachment, filename: "" },
      { ...baseAttachment, size: 1.5 },
      { ...baseAttachment, size: -1 },
      { ...baseAttachment, sha256: "A".repeat(64) },
      { ...baseAttachment, source: null },
      { ...baseAttachment, source: { path: 42 } },
      { ...baseAttachment, source: { path: "NODE.md", sourcePath: 42 } },
    ]) {
      expect(isAttachmentRef(value)).toBe(false);
    }
    expect(attachmentRefSchema.safeParse({ ...baseAttachment, kind: "image", mimeType: "image/svg+xml" }).success).toBe(
      false,
    );
  });

  it("extracts only valid attachment refs from metadata", () => {
    expect(attachmentRefsFromMetadata(undefined)).toEqual([]);
    expect(attachmentRefsFromMetadata({ attachments: "not-an-array" })).toEqual([]);
    expect(
      attachmentRefsFromMetadata({
        attachments: [
          { ...baseAttachment, filename: "valid.md" },
          { ...baseAttachment, attachmentId: "bad" },
          { ...baseAttachment, kind: "file", filename: "archive.zip", size: 0 },
        ],
      }),
    ).toEqual([
      { ...baseAttachment, filename: "valid.md" },
      { ...baseAttachment, kind: "file", filename: "archive.zip", size: 0 },
    ]);
  });

  it("extracts only renderable generic image refs", () => {
    const image = {
      ...baseAttachment,
      attachmentId: "223e4567-e89b-42d3-a456-426614174001",
      kind: "image",
      mimeType: "image/png",
      filename: "decision.png",
    } as const;
    expect(
      imageAttachmentRefsFromMetadata({
        attachments: [
          image,
          { ...image, attachmentId: "323e4567-e89b-42d3-a456-426614174002", mimeType: "application/pdf" },
          { ...baseAttachment, filename: "notes.md" },
        ],
      }),
    ).toEqual([image]);
  });
});
