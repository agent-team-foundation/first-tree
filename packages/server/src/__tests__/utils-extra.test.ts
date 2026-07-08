import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashToken, serializeDate } from "../utils.js";

describe("server utils", () => {
  it("hashes tokens with SHA-256 hex output", () => {
    expect(hashToken("raw-token")).toBe(createHash("sha256").update("raw-token").digest("hex"));
    expect(hashToken("raw-token")).toHaveLength(64);
  });

  it("serializes dates and preserves nulls", () => {
    expect(serializeDate(new Date("2026-07-08T12:34:56.789Z"))).toBe("2026-07-08T12:34:56.789Z");
    expect(serializeDate(null)).toBeNull();
  });
});
