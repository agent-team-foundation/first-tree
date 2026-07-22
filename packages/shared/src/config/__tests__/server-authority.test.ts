import { describe, expect, it } from "vitest";
import {
  canonicalizeServerAuthority,
  deriveAvatarAuthorityTag,
  isAvatarAuthorityTag,
  resolveServerAuthority,
  serverAuthorityFromPublicUrl,
} from "../server-authority.js";

describe("server authority", () => {
  it("canonicalizes host casing, default ports, and a trailing slash", () => {
    expect(canonicalizeServerAuthority("HTTPS://FIRST-TREE.EXAMPLE:443/api/v1/")).toBe(
      "https://first-tree.example/api/v1",
    );
  });

  it("derives the fixed API path from the configured public origin", () => {
    expect(serverAuthorityFromPublicUrl("https://first-tree.example/")).toBe("https://first-tree.example/api/v1");
  });

  it.each([
    "https://first-tree.example/app",
    "https://first-tree.example/app/",
  ])("rejects a public URL path instead of silently collapsing it to an origin: %s", (value) => {
    expect(() => serverAuthorityFromPublicUrl(value)).toThrow("without a path");
  });

  it.each([
    "ftp://first-tree.example/api/v1",
    "https://user:first-tree@first-tree.example/api/v1",
    "https://first-tree.example/api/v1?server=two",
    "https://first-tree.example/api/v1#two",
    "https://first-tree.example/other",
    "http://0.0.0.0/api/v1",
    "http://[::]/api/v1",
    "http://*/api/v1",
  ])("rejects non-canonical authority input %s", (value) => {
    expect(() => canonicalizeServerAuthority(value)).toThrow();
  });

  it("uses an explicit local authority for wildcard binds", () => {
    expect(
      resolveServerAuthority({
        authority: "http://localhost:8000/api/v1",
        host: "0.0.0.0",
        port: 8000,
      }),
    ).toBe("http://localhost:8000/api/v1");
    expect(() => resolveServerAuthority({ host: "0.0.0.0", port: 8000 })).toThrow("FIRST_TREE_SERVER_AUTHORITY");
    expect(() => resolveServerAuthority({ host: "0", port: 8000 })).toThrow("FIRST_TREE_SERVER_AUTHORITY");
    expect(() => resolveServerAuthority({ host: "::0", port: 8000 })).toThrow("FIRST_TREE_SERVER_AUTHORITY");
  });

  it("keeps an explicit authority distinct from a public callback origin", () => {
    expect(
      resolveServerAuthority({
        authority: "http://127.0.0.1:8000/api/v1",
        publicUrl: "https://rotating-oauth-tunnel.example",
        host: "127.0.0.1",
        port: 8000,
      }),
    ).toBe("http://127.0.0.1:8000/api/v1");
  });

  it("derives a stable, server-partitioned avatar tag", () => {
    const first = deriveAvatarAuthorityTag("https://s1.example/api/v1");
    expect(first).toHaveLength(43);
    expect(isAvatarAuthorityTag(first)).toBe(true);
    expect(deriveAvatarAuthorityTag("https://s1.example/api/v1/")).toBe(first);
    expect(deriveAvatarAuthorityTag("https://s2.example/api/v1")).not.toBe(first);
    expect(isAvatarAuthorityTag(`${first}=`)).toBe(false);
  });
});
