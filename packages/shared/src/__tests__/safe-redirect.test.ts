import { describe, expect, it } from "vitest";
import { DEFAULT_SAFE_REDIRECT, safeRedirectPath } from "../safe-redirect.js";

describe("safeRedirectPath", () => {
  it("accepts a typical relative path", () => {
    expect(safeRedirectPath("/")).toBe("/");
    expect(safeRedirectPath("/welcome")).toBe("/welcome");
    expect(safeRedirectPath("/invite/abc-123?ref=x#section")).toBe("/invite/abc-123?ref=x#section");
  });

  it("rejects null / undefined / empty", () => {
    expect(safeRedirectPath(null)).toBe(DEFAULT_SAFE_REDIRECT);
    expect(safeRedirectPath(undefined)).toBe(DEFAULT_SAFE_REDIRECT);
    expect(safeRedirectPath("")).toBe(DEFAULT_SAFE_REDIRECT);
  });

  it("rejects authority-component bypasses", () => {
    expect(safeRedirectPath("//evil.com")).toBe("/");
    expect(safeRedirectPath("/\\evil.com")).toBe("/");
  });

  it("rejects absolute urls", () => {
    expect(safeRedirectPath("https://evil.com/foo")).toBe("/");
    expect(safeRedirectPath("http://localhost/foo")).toBe("/");
  });

  it("rejects javascript: scheme", () => {
    expect(safeRedirectPath("javascript:alert(1)")).toBe("/");
  });

  it("rejects email-like paths that try to embed an authority", () => {
    expect(safeRedirectPath("/foo@evil.com")).toBe("/");
  });

  it("rejects paths missing the leading slash", () => {
    expect(safeRedirectPath("welcome")).toBe("/");
  });

  it("caps absurdly long paths", () => {
    const long = `/${"a".repeat(300)}`;
    expect(safeRedirectPath(long)).toBe("/");
  });

  it("preserves a quickstart campaign handoff only when the repo is percent-encoded", () => {
    // The login round-trip carries the post-login destination through `next`,
    // which must pass this guard. A campaign CTA therefore MUST percent-encode
    // the repo URL: a raw `https://…` contains `:` and `//`, which the guard
    // rejects (silently dropping the funnel to `/`); the encoded form survives.
    const encoded = `/quickstart?campaign=production-scan&repo=${encodeURIComponent("https://github.com/acme/backend")}`;
    expect(safeRedirectPath(encoded)).toBe(encoded);
    expect(safeRedirectPath("/quickstart?campaign=production-scan&repo=https://github.com/acme/backend")).toBe(
      DEFAULT_SAFE_REDIRECT,
    );
  });
});
