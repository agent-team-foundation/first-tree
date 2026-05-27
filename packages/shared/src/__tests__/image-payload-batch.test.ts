import { describe, expect, it } from "vitest";
import {
  imageBatchInlineContentSchema,
  imageBatchRefContentSchema,
  imageInlineContentSchema,
  imageRefContentSchema,
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
});
