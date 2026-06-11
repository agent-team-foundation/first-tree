import { describe, expect, it } from "vitest";
import { extractMentions } from "../services/github-normalize.js";

describe("extractMentions", () => {
  it("extracts single mention", () => {
    expect(extractMentions("Hey @baixiaohang please review")).toEqual(["baixiaohang"]);
  });

  it("extracts multiple mentions", () => {
    const result = extractMentions("cc @baixiaohang @bestony for visibility");
    expect(result).toContain("baixiaohang");
    expect(result).toContain("bestony");
    expect(result).toHaveLength(2);
  });

  it("deduplicates mentions", () => {
    expect(extractMentions("@alice @alice @alice")).toEqual(["alice"]);
  });

  it("lowercases mentions", () => {
    expect(extractMentions("@BaiXiaoHang")).toEqual(["baixiaohang"]);
  });

  it("handles hyphens in usernames", () => {
    expect(extractMentions("@ops-agent")).toEqual(["ops-agent"]);
  });

  it("handles underscores in usernames", () => {
    expect(extractMentions("@my_agent")).toEqual(["my_agent"]);
  });

  it("returns empty array for null/undefined", () => {
    expect(extractMentions(null)).toEqual([]);
    expect(extractMentions(undefined)).toEqual([]);
  });

  it("returns empty array when no mentions", () => {
    expect(extractMentions("just some text")).toEqual([]);
  });

  it("ignores email addresses", () => {
    const result = extractMentions("email user@example.com but @real mention");
    expect(result).toEqual(["real"]);
    expect(result).not.toContain("example");
  });

  it("ignores team mentions (@org/team)", () => {
    const result = extractMentions("cc @org/team-name and @baixiaohang");
    expect(result).toEqual(["baixiaohang"]);
    expect(result).not.toContain("org");
  });

  it("handles mention at start of text", () => {
    expect(extractMentions("@admin check this")).toEqual(["admin"]);
  });

  it("handles mention at end of text", () => {
    expect(extractMentions("check this @admin")).toEqual(["admin"]);
  });
});
