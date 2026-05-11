import { describe, expect, it } from "vitest";
import { extractStructuralMentions } from "../api/webhooks/github.js";

describe("extractStructuralMentions", () => {
  it("extracts requested reviewer from pull_request.review_requested", () => {
    const payload = {
      action: "review_requested",
      requested_reviewer: { login: "baixiaohang" },
    };
    expect(extractStructuralMentions("pull_request", payload)).toEqual(["baixiaohang"]);
  });

  it("lowercases the reviewer login", () => {
    const payload = {
      action: "review_requested",
      requested_reviewer: { login: "BaiXiaoHang" },
    };
    expect(extractStructuralMentions("pull_request", payload)).toEqual(["baixiaohang"]);
  });

  it("returns empty array for team review requests (no requested_reviewer field)", () => {
    const payload = {
      action: "review_requested",
      requested_team: { slug: "core-team" },
    };
    expect(extractStructuralMentions("pull_request", payload)).toEqual([]);
  });

  it("returns empty array for unrelated pull_request actions", () => {
    const payload = {
      action: "opened",
      requested_reviewer: { login: "baixiaohang" },
    };
    expect(extractStructuralMentions("pull_request", payload)).toEqual([]);
  });

  it("returns empty array for non-pull_request event types", () => {
    const payload = {
      action: "review_requested",
      requested_reviewer: { login: "baixiaohang" },
    };
    expect(extractStructuralMentions("issues", payload)).toEqual([]);
  });

  it("returns empty array when payload is not an object", () => {
    expect(extractStructuralMentions("pull_request", null)).toEqual([]);
    expect(extractStructuralMentions("pull_request", "string")).toEqual([]);
  });

  it("returns empty array when requested_reviewer is missing or malformed", () => {
    expect(extractStructuralMentions("pull_request", { action: "review_requested" })).toEqual([]);
    expect(
      extractStructuralMentions("pull_request", {
        action: "review_requested",
        requested_reviewer: {},
      }),
    ).toEqual([]);
    expect(
      extractStructuralMentions("pull_request", {
        action: "review_requested",
        requested_reviewer: { login: 42 },
      }),
    ).toEqual([]);
  });
});
