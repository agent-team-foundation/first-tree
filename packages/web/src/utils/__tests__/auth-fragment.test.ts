import { describe, expect, it } from "vitest";
import { parseAuthFragment } from "../auth-fragment.js";

describe("parseAuthFragment", () => {
  it("extracts access + refresh + next from a well-formed fragment", () => {
    expect(parseAuthFragment("#access=ACCESS&refresh=REFRESH&next=%2Fsetup")).toEqual({
      accessToken: "ACCESS",
      refreshToken: "REFRESH",
      next: "/setup",
    });
  });

  it("tolerates a fragment without the leading '#'", () => {
    expect(parseAuthFragment("access=A&refresh=B&next=%2F")).toEqual({
      accessToken: "A",
      refreshToken: "B",
      next: "/",
    });
  });

  it("defaults `next` to '/' when the field is absent", () => {
    expect(parseAuthFragment("#access=A&refresh=B")).toEqual({
      accessToken: "A",
      refreshToken: "B",
      next: "/",
    });
  });

  it("returns null for an empty fragment so callers can render a single error branch", () => {
    expect(parseAuthFragment("")).toBeNull();
    expect(parseAuthFragment("#")).toBeNull();
  });

  it("returns null when either token field is missing", () => {
    expect(parseAuthFragment("#access=A&next=%2F")).toBeNull();
    expect(parseAuthFragment("#refresh=B&next=%2F")).toBeNull();
  });

  it("preserves the URL-decoded `next` so deep-links survive the round-trip", () => {
    expect(parseAuthFragment("#access=A&refresh=B&next=%2Finvite%2Fabc-123")?.next).toBe("/invite/abc-123");
  });

  it("downgrades a malicious `next` to '/' to block fragment-based open redirects", () => {
    // A crafted link like /auth/github/complete#access=…&refresh=…&next=//evil
    // would otherwise land the user off-origin AFTER persisting the
    // server-controlled tokens. Server-side `/start` validates `next`
    // before it ever reaches the JWT — the same guard runs here so a
    // bypass through a fabricated fragment is also blocked.
    expect(parseAuthFragment("#access=A&refresh=B&next=%2F%2Fevil.com")?.next).toBe("/");
    expect(parseAuthFragment("#access=A&refresh=B&next=%2F%5Cevil.com")?.next).toBe("/");
    expect(parseAuthFragment("#access=A&refresh=B&next=https%3A%2F%2Fevil.com")?.next).toBe("/");
    expect(parseAuthFragment("#access=A&refresh=B&next=javascript%3Aalert(1)")?.next).toBe("/");
  });
});
