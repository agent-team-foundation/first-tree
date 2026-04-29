import { describe, expect, it } from "vitest";
import { readFromPath } from "../redirect-from-state.js";

/**
 * `readFromPath` is the post-login redirect-target extractor for the
 * password flow (the OAuth flow uses the server-validated `?next=` query
 * instead). The fixtures below pin both the type-narrowing branches and
 * the security rules — anything that would let a tampered `state` send
 * the browser somewhere unexpected after auth must be rejected here.
 *
 * Mirrors the safety contract in
 * `packages/shared/src/__tests__/safe-redirect.test.ts`. If a new
 * rejection arrives there, add the matching case here.
 */

const wrap = (from: unknown): unknown => ({ from });

describe("readFromPath", () => {
  describe("type narrowing", () => {
    it("accepts a router-shaped Location with just pathname", () => {
      expect(readFromPath(wrap({ pathname: "/agents" }))).toBe("/agents");
    });

    it("assembles pathname + search + hash when present", () => {
      expect(readFromPath(wrap({ pathname: "/agents", search: "?q=1", hash: "#top" }))).toBe("/agents?q=1#top");
    });

    it("ignores non-string search and hash silently", () => {
      expect(readFromPath(wrap({ pathname: "/agents", search: 42, hash: null }))).toBe("/agents");
    });

    it("returns null for null / undefined / primitives", () => {
      expect(readFromPath(null)).toBeNull();
      expect(readFromPath(undefined)).toBeNull();
      expect(readFromPath("/agents")).toBeNull();
      expect(readFromPath(42)).toBeNull();
      expect(readFromPath(true)).toBeNull();
    });

    it("returns null when `from` is missing", () => {
      expect(readFromPath({})).toBeNull();
      expect(readFromPath({ other: "/agents" })).toBeNull();
    });

    it("returns null when `from` is not a Location-shaped object", () => {
      expect(readFromPath(wrap(null))).toBeNull();
      expect(readFromPath(wrap("/agents"))).toBeNull();
      expect(readFromPath(wrap(42))).toBeNull();
    });

    it("returns null when `from.pathname` is missing or non-string", () => {
      expect(readFromPath(wrap({}))).toBeNull();
      expect(readFromPath(wrap({ pathname: 42 }))).toBeNull();
      expect(readFromPath(wrap({ pathname: null }))).toBeNull();
    });
  });

  describe("loop break", () => {
    it("refuses to bounce back to /login itself", () => {
      expect(readFromPath(wrap({ pathname: "/login" }))).toBeNull();
    });

    it("still rejects /login with a search/hash decoration", () => {
      // safeRedirectPath would accept `/login?next=foo` shape-wise, but
      // returning that here would create a tight redirect loop the moment
      // login completes.
      expect(readFromPath(wrap({ pathname: "/login", search: "?x=1" }))).toBeNull();
    });
  });

  describe("safeRedirectPath defense-in-depth", () => {
    it("rejects scheme-relative URL bypass at the assembled level", () => {
      // A malicious `from.pathname` of `//evil.com` would be a syntactic
      // `pathname`-string but is interpreted by browsers as an authority.
      expect(readFromPath(wrap({ pathname: "//evil.com/anything" }))).toBeNull();
    });

    it("rejects backslash-prefixed authority bypass", () => {
      expect(readFromPath(wrap({ pathname: "/\\evil.com" }))).toBeNull();
    });

    it("rejects absurdly long paths (256-char cap)", () => {
      const long = `/${"a".repeat(300)}`;
      expect(readFromPath(wrap({ pathname: long }))).toBeNull();
    });

    it("rejects paths containing characters outside the safe set", () => {
      // safeRedirectPath only allows [A-Za-z0-9_-./?=&%#]. A space is not
      // in the set and would otherwise be a soft injection point.
      expect(readFromPath(wrap({ pathname: "/agents foo" }))).toBeNull();
    });

    it('honors "/" as a valid (default) destination, not a rejection sentinel', () => {
      // The implementation converts safeRedirectPath's substituted "/"
      // back to null EXCEPT when the original assembled string was
      // actually "/". This case verifies that exception fires.
      expect(readFromPath(wrap({ pathname: "/" }))).toBe("/");
    });
  });
});
