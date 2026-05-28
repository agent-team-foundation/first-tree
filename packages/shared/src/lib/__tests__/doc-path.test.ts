import { describe, expect, it, vi } from "vitest";
import {
  buildWorkspaceDocKey,
  isCanonicalDocLinkPath,
  looksLikeChatId,
  normalizeDocLinkPath,
  parseWorkspaceDocKey,
} from "../doc-path.js";

describe("normalizeDocLinkPath", () => {
  it("returns the canonical workspace-relative form", () => {
    expect(normalizeDocLinkPath("docs/design.md")).toBe("docs/design.md");
    expect(normalizeDocLinkPath("./docs/design.md")).toBe("docs/design.md");
    expect(normalizeDocLinkPath("/docs/design.md")).toBe("docs/design.md");
    expect(normalizeDocLinkPath("docs/api/../design.md")).toBe("docs/design.md");
  });

  it("rejects empty / whitespace / non-string input", () => {
    expect(normalizeDocLinkPath("")).toBeNull();
    expect(normalizeDocLinkPath("   ")).toBeNull();
    expect(normalizeDocLinkPath("/")).toBeNull();
    expect(normalizeDocLinkPath("./")).toBeNull();
    expect(normalizeDocLinkPath(undefined as unknown as string)).toBeNull();
  });

  it("rejects paths that escape above the workspace root", () => {
    expect(normalizeDocLinkPath("../secret.md")).toBeNull();
    expect(normalizeDocLinkPath("docs/../../secret.md")).toBeNull();
  });

  it("rejects any segment that starts with a dot (hidden / dotfile / .agent / .git)", () => {
    expect(normalizeDocLinkPath(".agent/secret.md")).toBeNull();
    expect(normalizeDocLinkPath("docs/.hidden.md")).toBeNull();
    expect(normalizeDocLinkPath(".git/HEAD.md")).toBeNull();
    expect(normalizeDocLinkPath("docs/.git/HEAD.md")).toBeNull();
  });

  it("rejects external-link forms so runtime never resolves them as workspace paths", () => {
    // Without this guard `normalizeDocLinkPath("https://x.com/a.md")` would
    // canonicalise to `https:/x.com/a.md` and the runtime would try to read
    // it on disk — proposal §非目标 explicitly forbids that.
    expect(normalizeDocLinkPath("https://example.com/readme.md")).toBeNull();
    expect(normalizeDocLinkPath("http://example.com/a.md")).toBeNull();
    expect(normalizeDocLinkPath("mailto:hello@example.com")).toBeNull();
    expect(normalizeDocLinkPath("ftp://host/a.md")).toBeNull();
    // Scheme-relative
    expect(normalizeDocLinkPath("//example.com/readme.md")).toBeNull();
    // Pure fragment
    expect(normalizeDocLinkPath("#heading")).toBeNull();
  });

  it("strips empty / `.` segments without rejecting", () => {
    expect(normalizeDocLinkPath("docs//design.md")).toBe("docs/design.md");
    expect(normalizeDocLinkPath("docs/./design.md")).toBe("docs/design.md");
  });

  it("rejects embedded query / fragment so the path layer never holds href artefacts", () => {
    expect(normalizeDocLinkPath("docs/a.md?x=1")).toBeNull();
    expect(normalizeDocLinkPath("docs/a.md#section")).toBeNull();
    expect(normalizeDocLinkPath("docs?/a.md")).toBeNull();
  });
});

describe("isCanonicalDocLinkPath", () => {
  it("returns true only for already-canonical paths", () => {
    expect(isCanonicalDocLinkPath("docs/design.md")).toBe(true);
    expect(isCanonicalDocLinkPath("a.md")).toBe(true);
  });

  it("returns false for anything that would change under normalisation", () => {
    expect(isCanonicalDocLinkPath("./docs/a.md")).toBe(false);
    expect(isCanonicalDocLinkPath("/docs/a.md")).toBe(false);
    expect(isCanonicalDocLinkPath("docs/../a.md")).toBe(false);
    expect(isCanonicalDocLinkPath("docs/")).toBe(false);
  });

  it("returns false for paths the normaliser rejects (external / hidden / escape)", () => {
    expect(isCanonicalDocLinkPath("https://x/a.md")).toBe(false);
    expect(isCanonicalDocLinkPath(".agent/x.md")).toBe(false);
    expect(isCanonicalDocLinkPath("../x.md")).toBe(false);
  });
});

describe("buildWorkspaceDocKey", () => {
  it("builds a canonical global cross-agent key", () => {
    expect(buildWorkspaceDocKey("assistant", "chat-1", "design.md")).toBe("assistant/chat-1/design.md");
    expect(buildWorkspaceDocKey("assistant", "chat-1", "docs/design.md")).toBe("assistant/chat-1/docs/design.md");
    // rel is normalised before assembly
    expect(buildWorkspaceDocKey("assistant", "chat-1", "./docs/design.md")).toBe("assistant/chat-1/docs/design.md");
  });

  it("rejects when slug / chatId are missing, hidden, or contain a slash", () => {
    expect(buildWorkspaceDocKey("", "chat-1", "a.md")).toBeNull();
    expect(buildWorkspaceDocKey("assistant", "", "a.md")).toBeNull();
    expect(buildWorkspaceDocKey(".hidden", "chat-1", "a.md")).toBeNull();
    expect(buildWorkspaceDocKey("assistant", ".x", "a.md")).toBeNull();
    expect(buildWorkspaceDocKey("a/b", "chat-1", "a.md")).toBeNull();
    expect(buildWorkspaceDocKey("assistant", "c/d", "a.md")).toBeNull();
  });

  it("rejects when rel escapes / hides / is empty", () => {
    expect(buildWorkspaceDocKey("assistant", "chat-1", "../secret.md")).toBeNull();
    expect(buildWorkspaceDocKey("assistant", "chat-1", ".agent/x.md")).toBeNull();
    expect(buildWorkspaceDocKey("assistant", "chat-1", "")).toBeNull();
  });

  it("rejects assembled keys that are not canonical workspace doc paths", () => {
    expect(buildWorkspaceDocKey("assistant?debug=true", "chat-1", "a.md")).toBeNull();
  });

  it("produces a key that is itself canonical", () => {
    const key = buildWorkspaceDocKey("assistant", "chat-1", "docs/design.md");
    expect(key).not.toBeNull();
    expect(isCanonicalDocLinkPath(key as string)).toBe(true);
  });
});

describe("parseWorkspaceDocKey", () => {
  it("splits a global key into slug / chatId / rel", () => {
    expect(parseWorkspaceDocKey("assistant/chat-1/design.md")).toEqual({
      agentSlug: "assistant",
      chatId: "chat-1",
      rel: "design.md",
    });
    expect(parseWorkspaceDocKey("assistant/chat-1/docs/design.md")).toEqual({
      agentSlug: "assistant",
      chatId: "chat-1",
      rel: "docs/design.md",
    });
  });

  it("returns null for fewer than three segments", () => {
    expect(parseWorkspaceDocKey("design.md")).toBeNull();
    expect(parseWorkspaceDocKey("chat-1/design.md")).toBeNull();
  });

  it("returns null for non-canonical / rejected input", () => {
    expect(parseWorkspaceDocKey("../a/b.md")).toBeNull();
    expect(parseWorkspaceDocKey(".agent/chat/x.md")).toBeNull();
  });

  it("returns null when parsed key fields are empty after splitting", () => {
    const originalSplit = String.prototype.split;
    let slashSplitCount = 0;
    const split = vi.spyOn(String.prototype, "split").mockImplementation(function (this: string, separator, limit) {
      const separatorValue: unknown = separator;
      if (this === "assistant/chat-1/docs.md" && separatorValue === "/") {
        slashSplitCount += 1;
        if (slashSplitCount === 2) return ["assistant", "chat-1", ""];
      }
      // Type assertion: this test drives an impossible defensive branch while
      // preserving String.prototype.split's overloaded runtime behavior.
      return Reflect.apply(originalSplit, this, [separator, limit]) as string[];
    });

    try {
      expect(parseWorkspaceDocKey("assistant/chat-1/docs.md")).toBeNull();
    } finally {
      split.mockRestore();
    }
  });

  it("round-trips with buildWorkspaceDocKey", () => {
    const key = buildWorkspaceDocKey("assistant", "chat-1", "docs/design.md") as string;
    expect(parseWorkspaceDocKey(key)).toEqual({ agentSlug: "assistant", chatId: "chat-1", rel: "docs/design.md" });
  });
});

describe("looksLikeChatId", () => {
  it("accepts canonical UUID v4 / v7 chat ids (the shape `randomUUID` mints)", () => {
    // Real chat ids — services/chat.ts uses `randomUUID()` from node:crypto.
    expect(looksLikeChatId("11111111-1111-4111-8111-111111111111")).toBe(true);
    // UUID v7 (time-ordered) — used elsewhere in the project for message ids;
    // chatIds may rotate to v7 in the future, so the check must accept it.
    expect(looksLikeChatId("018f8f3c-8c4f-7f5a-9a4b-1a2b3c4d5e6f")).toBe(true);
    // Mixed case is canonical too.
    expect(looksLikeChatId("ABCDEF12-3456-7890-ABCD-EF1234567890")).toBe(true);
  });

  it("rejects everyday subdir names — the disambiguator's whole purpose", () => {
    // Without this rejection, the server validator would over-reject promoted
    // self keys like `<localPath>/docs/intro.md` whenever `<localPath>`
    // collides with a participant slug (worktree-fence-widening codex P2).
    expect(looksLikeChatId("docs")).toBe(false);
    expect(looksLikeChatId("worktrees")).toBe(false);
    expect(looksLikeChatId("api")).toBe(false);
    expect(looksLikeChatId("chat-1")).toBe(false);
    expect(looksLikeChatId("other-chat")).toBe(false);
  });

  it("rejects strings that are uuid-like but structurally off", () => {
    expect(looksLikeChatId("")).toBe(false);
    expect(looksLikeChatId("11111111-1111-4111-8111-11111111111")).toBe(false); // 35 chars
    expect(looksLikeChatId("11111111-1111-4111-8111-1111111111111")).toBe(false); // 37 chars
    expect(looksLikeChatId("11111111-1111-9111-8111-111111111111")).toBe(false); // version=9 (invalid)
    expect(looksLikeChatId("11111111-1111-4111-c111-111111111111")).toBe(false); // variant=c (invalid)
    expect(looksLikeChatId("g1111111-1111-4111-8111-111111111111")).toBe(false); // non-hex
  });
});
