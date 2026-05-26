import { createHash } from "node:crypto";
import { MAX_DOC_SNAPSHOT_BYTES, MAX_TOTAL_DOC_SNAPSHOT_BYTES } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { BadRequestError } from "../errors.js";
import { validateDocumentContext } from "../services/doc-snapshots.js";

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function snapshotDoc(path: string, content: string) {
  return {
    path,
    content,
    sha256: sha256(content),
    size: Buffer.byteLength(content, "utf8"),
  };
}

describe("validateDocumentContext", () => {
  it("accepts metadata without documentContext", () => {
    expect(() => validateDocumentContext({})).not.toThrow();
    expect(() => validateDocumentContext(undefined)).not.toThrow();
    expect(() => validateDocumentContext({ mentions: ["x"] })).not.toThrow();
  });

  it("accepts a well-formed snapshot variant", () => {
    expect(() =>
      validateDocumentContext({
        documentContext: {
          kind: "snapshot",
          docs: [snapshotDoc("docs/design.md", "# design\n\nbody.\n")],
        },
      }),
    ).not.toThrow();
  });

  it("normalises legacy `{ basePath }` to kind=path via the shared preprocessor", () => {
    expect(() => validateDocumentContext({ documentContext: { basePath: "first-tree" } })).not.toThrow();
  });

  it("rejects a sha256 that disagrees with the content", () => {
    expect(() =>
      validateDocumentContext({
        documentContext: {
          kind: "snapshot",
          docs: [{ ...snapshotDoc("a.md", "hello"), sha256: "0".repeat(64) }],
        },
      }),
    ).toThrow(BadRequestError);
  });

  it("rejects a size that disagrees with the content", () => {
    expect(() =>
      validateDocumentContext({
        documentContext: {
          kind: "snapshot",
          docs: [{ ...snapshotDoc("a.md", "hello"), size: 9999 }],
        },
      }),
    ).toThrow(BadRequestError);
  });

  it("rejects a snapshot that exceeds the per-file byte budget", () => {
    const oversize = "a".repeat(MAX_DOC_SNAPSHOT_BYTES + 1);
    expect(() =>
      validateDocumentContext({
        documentContext: {
          kind: "snapshot",
          docs: [snapshotDoc("big.md", oversize)],
        },
      }),
    ).toThrow(BadRequestError);
  });

  it("rejects when the aggregate byte total exceeds the per-message budget", () => {
    // Three docs each just under the per-file budget — individually OK,
    // collectively over the per-message cap.
    const chunk = "a".repeat(Math.floor(MAX_TOTAL_DOC_SNAPSHOT_BYTES / 2 + 1));
    expect(() =>
      validateDocumentContext({
        documentContext: {
          kind: "snapshot",
          docs: [snapshotDoc("a.md", chunk), snapshotDoc("b.md", chunk)],
        },
      }),
    ).toThrow(BadRequestError);
  });

  it("rejects entirely-invalid documentContext shape with a parse error", () => {
    expect(() =>
      validateDocumentContext({
        documentContext: { kind: "snapshot", docs: [] },
      }),
    ).toThrow(BadRequestError);
  });

  it("rejects non-canonical paths so the wire format matches web cache lookup", () => {
    // Any path the web `docPreviewPathFromHref` would NOT produce must be
    // rejected — leading `/`, `./`, `..`, and hidden segments all fall here.
    for (const badPath of ["/docs/a.md", "./docs/a.md", "docs/../a.md", ".agent/secret.md", "docs/.hidden.md"]) {
      expect(
        () =>
          validateDocumentContext({
            documentContext: {
              kind: "snapshot",
              docs: [snapshotDoc(badPath, "x")],
            },
          }),
        `expected to reject path: ${badPath}`,
      ).toThrow(BadRequestError);
    }
  });

  it("rejects non-`.md` paths even when canonical (trust boundary tightening)", () => {
    expect(() =>
      validateDocumentContext({
        documentContext: {
          kind: "snapshot",
          docs: [snapshotDoc("docs/secret.env", "leak")],
        },
      }),
    ).toThrow(BadRequestError);
  });

  it("rejects query / fragment embedded in path", () => {
    for (const badPath of ["docs/a.md?leak=1", "docs/a.md#section"]) {
      expect(
        () =>
          validateDocumentContext({
            documentContext: {
              kind: "snapshot",
              docs: [snapshotDoc(badPath, "x")],
            },
          }),
        `expected to reject path: ${badPath}`,
      ).toThrow(BadRequestError);
    }
  });

  describe("cross-agent provenance (chatScope)", () => {
    // Real chat ids are UUIDs (services/chat.ts uses `randomUUID()`). Tests use
    // canonical UUID-shaped strings so the cross-chat fence (which gates on
    // `looksLikeChatId`) discriminates correctly — a non-UUID second segment
    // is treated as a deep self path, NOT a cross-chat attempt.
    const CHAT_ID = "11111111-1111-4111-8111-111111111111";
    const OTHER_CHAT_ID = "22222222-2222-4222-8222-222222222222";
    const scope = (slugs: string[]) => ({ chatId: CHAT_ID, participantSlugs: new Set(slugs) });

    it("accepts a cross-agent global key when the owner is a chat participant", () => {
      expect(() =>
        validateDocumentContext(
          {
            documentContext: {
              kind: "snapshot",
              docs: [snapshotDoc(`assistant/${CHAT_ID}/design.md`, "# theirs\n")],
            },
          },
          scope(["coder", "assistant"]),
        ),
      ).not.toThrow();
    });

    it("rejects a cross-agent global key when the owner is NOT a chat participant", () => {
      expect(() =>
        validateDocumentContext(
          {
            documentContext: {
              kind: "snapshot",
              docs: [snapshotDoc(`intruder/${CHAT_ID}/secret.md`, "# leak\n")],
            },
          },
          scope(["coder", "assistant"]),
        ),
      ).toThrow(BadRequestError);
    });

    it("leaves bare self keys unaffected by the participant check", () => {
      expect(() =>
        validateDocumentContext(
          {
            documentContext: {
              kind: "snapshot",
              docs: [snapshotDoc("docs/design.md", "# mine\n")],
            },
          },
          scope(["coder"]),
        ),
      ).not.toThrow();
    });

    it("rejects a participant-owned global key that names a DIFFERENT chat (chatId fence — P1)", () => {
      // `assistant` is a participant, the second segment is a uuid-shaped
      // chatId different from `scope.chatId` — this is a cross key shape
      // pointing at another chat's workspace and must not slip past the
      // `workspaces/*/<currentChatId>/` fence.
      expect(() =>
        validateDocumentContext(
          {
            documentContext: {
              kind: "snapshot",
              docs: [snapshotDoc(`assistant/${OTHER_CHAT_ID}/design.md`, "# x\n")],
            },
          },
          scope(["coder", "assistant"]),
        ),
      ).toThrow(BadRequestError);
    });

    it("allows a deep SELF path whose first segment is not a participant slug", () => {
      // `docs/api/design.md` is a legitimate nested self path; `docs` is not a
      // participant, so the chatId-fence rule must not over-reject it.
      expect(() =>
        validateDocumentContext(
          {
            documentContext: {
              kind: "snapshot",
              docs: [snapshotDoc("docs/api/design.md", "# nested\n")],
            },
          },
          scope(["coder", "assistant"]),
        ),
      ).not.toThrow();
    });

    it("treats a participant-named first segment as SELF when the second segment is not uuid-shaped", () => {
      // Worktree-fence regression guard: a single-repo agent whose source-repo
      // `localPath` happens to coincide with another participant's slug emits
      // promoted self keys like `assistant/docs/intro.md` for relative
      // mentions. Without the `looksLikeChatId` discriminator, the
      // participant-owned-different-chat branch would reject these as a
      // cross-chat leak — but `docs` is not a uuid, so no real chat can be
      // named `docs` and the leak path is structurally impossible. Treat the
      // key as a deep self path and let it through.
      expect(() =>
        validateDocumentContext(
          {
            documentContext: {
              kind: "snapshot",
              docs: [snapshotDoc("assistant/docs/intro.md", "# self with colliding prefix\n")],
            },
          },
          scope(["coder", "assistant"]),
        ),
      ).not.toThrow();
    });

    it("allows a worktree self key whose first segment is not a participant slug", () => {
      // The wide self-fence emits agent-home-relative keys for files outside
      // the source repo (e.g. on-demand `git worktree add`). When the first
      // segment is `worktrees` and no participant is named `worktrees`, the
      // path is straightforward self — never trips the cross check.
      expect(() =>
        validateDocumentContext(
          {
            documentContext: {
              kind: "snapshot",
              docs: [snapshotDoc("worktrees/553-fix/docs/design.md", "# worktree doc\n")],
            },
          },
          scope(["coder", "assistant"]),
        ),
      ).not.toThrow();
    });

    it("skips the provenance check entirely when no chatScope is supplied (back-compat)", () => {
      expect(() =>
        validateDocumentContext({
          documentContext: {
            kind: "snapshot",
            docs: [snapshotDoc(`intruder/${CHAT_ID}/secret.md`, "# leak\n")],
          },
        }),
      ).not.toThrow();
    });
  });
});
