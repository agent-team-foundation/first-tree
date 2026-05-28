import { describe, expect, it } from "vitest";
import {
  extractCaption,
  imageBatchInlineContentSchema,
  imageBatchRefContentSchema,
  imageInlineContentSchema,
  imageRefContentSchema,
  isImageBatchRefContent,
  isImageRefContent,
  MAX_BATCH_ATTACHMENTS,
} from "../schemas/image-payload.js";

const SAMPLE_INLINE = {
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
  mimeType: "image/png" as const,
  filename: "photo.png",
  size: 128,
};

const SAMPLE_REF = {
  imageId: "9c2ce4e7-3f0d-4f53-9c0c-1c93e7d51a92",
  mimeType: "image/png" as const,
  filename: "photo.png",
  size: 128,
};

describe("image-payload — batch schemas", () => {
  describe("imageBatchInlineContentSchema (wire)", () => {
    it("accepts caption + multiple inline attachments", () => {
      const parsed = imageBatchInlineContentSchema.parse({
        caption: "look at these",
        attachments: [SAMPLE_INLINE, { ...SAMPLE_INLINE, filename: "photo2.png" }],
      });
      expect(parsed.attachments).toHaveLength(2);
      expect(parsed.caption).toBe("look at these");
    });

    it("accepts a batch with no caption (attachment-only send)", () => {
      const parsed = imageBatchInlineContentSchema.parse({ attachments: [SAMPLE_INLINE] });
      expect(parsed.caption).toBeUndefined();
      expect(parsed.attachments).toHaveLength(1);
    });

    it("rejects an empty attachments array", () => {
      const result = imageBatchInlineContentSchema.safeParse({ caption: "hi", attachments: [] });
      expect(result.success).toBe(false);
    });

    it("rejects when an attachment is malformed", () => {
      const result = imageBatchInlineContentSchema.safeParse({
        attachments: [{ data: "", mimeType: "image/png", filename: "x.png" }],
      });
      expect(result.success).toBe(false);
    });

    it("does NOT match a single inline image (kept distinct for backward compat)", () => {
      // Old single-image messages stay on imageInlineContentSchema and would
      // fail the batch schema (no `attachments` array). Renderers parse each
      // schema in order and fall through when the shape doesn't match.
      const result = imageBatchInlineContentSchema.safeParse(SAMPLE_INLINE);
      expect(result.success).toBe(false);
      expect(imageInlineContentSchema.safeParse(SAMPLE_INLINE).success).toBe(true);
    });
  });

  describe("imageBatchRefContentSchema (persisted)", () => {
    it("accepts caption + multiple refs", () => {
      const parsed = imageBatchRefContentSchema.parse({
        caption: "see attached",
        attachments: [SAMPLE_REF, { ...SAMPLE_REF, imageId: "11111111-1111-4111-8111-111111111111" }],
      });
      expect(parsed.attachments).toHaveLength(2);
    });

    it("accepts a ref batch with no caption", () => {
      const parsed = imageBatchRefContentSchema.parse({ attachments: [SAMPLE_REF] });
      expect(parsed.caption).toBeUndefined();
    });

    it("rejects an empty attachments array", () => {
      const result = imageBatchRefContentSchema.safeParse({ attachments: [] });
      expect(result.success).toBe(false);
    });

    it("does NOT match a single ref (legacy single-image message)", () => {
      // Backward compat: existing single-ref messages stay on imageRefContentSchema.
      expect(imageBatchRefContentSchema.safeParse(SAMPLE_REF).success).toBe(false);
      expect(imageRefContentSchema.safeParse(SAMPLE_REF).success).toBe(true);
    });
  });

  describe("attachments count cap (MAX_BATCH_ATTACHMENTS)", () => {
    // Fastify's bodyLimit is a byte limit, not a count — without this `.max()`
    // a single authenticated POST could carry hundreds of small images and
    // fan out to every recipient via the broadcast path.
    it("rejects more than MAX_BATCH_ATTACHMENTS inline attachments", () => {
      const tooMany = Array.from({ length: MAX_BATCH_ATTACHMENTS + 1 }, (_, i) => ({
        ...SAMPLE_INLINE,
        filename: `photo${i}.png`,
      }));
      const result = imageBatchInlineContentSchema.safeParse({ attachments: tooMany });
      expect(result.success).toBe(false);
    });

    it("rejects more than MAX_BATCH_ATTACHMENTS ref attachments", () => {
      const tooMany = Array.from({ length: MAX_BATCH_ATTACHMENTS + 1 }, (_, i) => ({
        ...SAMPLE_REF,
        // generate distinct v4 UUIDs by varying the last digit (still a valid uuid pattern)
        imageId: `11111111-1111-4111-8111-1111111111${(i + 10).toString().padStart(2, "0")}`,
      }));
      const result = imageBatchRefContentSchema.safeParse({ attachments: tooMany });
      expect(result.success).toBe(false);
    });

    it("accepts exactly MAX_BATCH_ATTACHMENTS attachments (boundary)", () => {
      const atLimit = Array.from({ length: MAX_BATCH_ATTACHMENTS }, (_, i) => ({
        ...SAMPLE_INLINE,
        filename: `photo${i}.png`,
      }));
      const result = imageBatchInlineContentSchema.safeParse({ attachments: atLimit });
      expect(result.success).toBe(true);
    });
  });

  describe("type guards (shared)", () => {
    it("isImageRefContent accepts a single ref, rejects batch / arbitrary", () => {
      expect(isImageRefContent(SAMPLE_REF)).toBe(true);
      expect(isImageRefContent({ attachments: [SAMPLE_REF] })).toBe(false);
      // Missing required fields fail.
      expect(isImageRefContent({ imageId: "x", mimeType: "image/png" })).toBe(false);
      expect(isImageRefContent({ mimeType: "image/png", filename: "f" })).toBe(false);
      expect(isImageRefContent(null)).toBe(false);
      expect(isImageRefContent("hello")).toBe(false);
    });

    it("isImageRefContent rejects unsupported MIME types", () => {
      expect(isImageRefContent({ ...SAMPLE_REF, mimeType: "image/heic" })).toBe(false);
    });

    it("isImageBatchRefContent accepts batch, rejects single ref / empty / mixed", () => {
      expect(isImageBatchRefContent({ caption: "hi", attachments: [SAMPLE_REF] })).toBe(true);
      expect(isImageBatchRefContent({ attachments: [SAMPLE_REF, SAMPLE_REF] })).toBe(true);
      expect(isImageBatchRefContent(SAMPLE_REF)).toBe(false);
      expect(isImageBatchRefContent({ attachments: [] })).toBe(false);
      expect(isImageBatchRefContent({ attachments: [SAMPLE_REF, { imageId: "x" }] })).toBe(false);
    });

    it("extractCaption returns the caption from batched content, '' otherwise", () => {
      expect(extractCaption({ caption: "look", attachments: [SAMPLE_REF] })).toBe("look");
      expect(extractCaption({ attachments: [SAMPLE_REF] })).toBe("");
      expect(extractCaption(SAMPLE_REF)).toBe("");
      expect(extractCaption("plain text")).toBe("");
      expect(extractCaption(null)).toBe("");
    });
  });
});
