import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FirstTreeHubSDK } from "@first-tree/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureOutboundDocs } from "../core/doc-capture.js";

/**
 * `chat send` doc capture (L3): the CLI captures referenced `.md` the same way
 * result-sink does, driven by the runtime-injected env. After the
 * attachment-ref convergence it uploads bytes to the org store (org resolved
 * from the chat) and attaches generic refs. The snapshot/rewrite mechanics
 * themselves are covered by client `doc-snapshots.test.ts`; these tests pin the
 * env contract + the metadata shape this layer produces.
 */

const CHAT_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

function stubSdk(): { sdk: FirstTreeHubSDK } {
  let seq = 0;
  const sdk = {
    serverUrl: "http://test",
    async getChatDetail() {
      return { id: CHAT_ID, organizationId: ORG_ID, participants: [] };
    },
    async uploadAttachment(o: { bytes: Uint8Array | Buffer; mimeType: string; filename: string; orgId: string }) {
      seq += 1;
      const bytes = Buffer.from(o.bytes);
      return {
        id: `00000000-0000-4000-8000-${seq.toString(16).padStart(12, "0")}`,
        mimeType: o.mimeType,
        filename: o.filename,
        sizeBytes: bytes.byteLength,
      };
    },
  } as unknown as FirstTreeHubSDK;
  return { sdk };
}

describe("captureOutboundDocs (chat send L3 capture)", () => {
  let base: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "cli-doc-capture-"));
    await writeFile(join(base, "design.md"), "# design\n", "utf8");
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("pass-through when no doc base in env (not in an agent session)", async () => {
    const { sdk } = stubSdk();
    const out = await captureOutboundDocs("see design.md please", { sdk, chatId: CHAT_ID }, {});
    expect(out.content).toBe("see design.md please");
    expect(out.attachments).toBeUndefined();
  });

  // KNOWN GAP (tracked in #1069), not an endorsed final behavior: `chat create`'s
  // initial message can't resolve an upload org without a chatId, so doc capture is
  // a pass-through there and mentions degrade to plain text. `chat send` captures
  // normally. Closing this gap (org resolution without a chatId) is follow-up #1069.
  it("pass-through when no chatId is supplied (org unresolvable, e.g. chat create — see #1069)", async () => {
    const { sdk } = stubSdk();
    const out = await captureOutboundDocs("see design.md please", { sdk }, { FIRST_TREE_DOC_BASE: base });
    expect(out.content).toBe("see design.md please");
    expect(out.attachments).toBeUndefined();
  });

  it("captures a referenced workspace .md as an attachment ref + rewrites the link", async () => {
    const { sdk } = stubSdk();
    const out = await captureOutboundDocs(
      "see design.md please",
      { sdk, chatId: CHAT_ID },
      { FIRST_TREE_DOC_BASE: base },
    );
    expect(out.content).toBe("see [design.md](attachment:00000000-0000-4000-8000-000000000001) please");
    expect(out.attachments?.map((a) => a.source?.path)).toEqual(["design.md"]);
    expect(out.attachments?.[0]?.kind).toBe("document");
  });

  it("no attachments when the referenced path is not in the workspace", async () => {
    const { sdk } = stubSdk();
    const out = await captureOutboundDocs(
      "see /etc/nope/missing.md",
      { sdk, chatId: CHAT_ID },
      { FIRST_TREE_DOC_BASE: base },
    );
    expect(out.content).toBe("see /etc/nope/missing.md");
    expect(out.attachments).toBeUndefined();
  });

  it("no attachments when the message references no .md", async () => {
    const { sdk } = stubSdk();
    const out = await captureOutboundDocs(
      "just a plain message",
      { sdk, chatId: CHAT_ID },
      { FIRST_TREE_DOC_BASE: base },
    );
    expect(out.content).toBe("just a plain message");
    expect(out.attachments).toBeUndefined();
  });

  describe("wide-fence env (FIRST_TREE_DOC_AGENT_HOME + optional FIRST_TREE_DOC_REPO_LOCAL_PATH)", () => {
    let agentHome: string;

    beforeAll(async () => {
      agentHome = await mkdtemp(join(tmpdir(), "cli-doc-capture-agent-home-"));
      await mkdir(join(agentHome, "first-tree", "docs"), { recursive: true });
      await writeFile(join(agentHome, "first-tree", "docs", "intro.md"), "# intro\n", "utf8");
      await mkdir(join(agentHome, "worktrees", "task-x", "docs"), { recursive: true });
      await writeFile(join(agentHome, "worktrees", "task-x", "docs", "design.md"), "# design\n", "utf8");
    });

    afterAll(async () => {
      await rm(agentHome, { recursive: true, force: true });
    });

    it("captures a worktree-scoped absolute path when AGENT_HOME widens the fence", async () => {
      const { sdk } = stubSdk();
      const abs = join(agentHome, "worktrees", "task-x", "docs", "design.md");
      const out = await captureOutboundDocs(
        `wrote ${abs} now`,
        { sdk, chatId: CHAT_ID },
        { FIRST_TREE_DOC_AGENT_HOME: agentHome, FIRST_TREE_DOC_REPO_LOCAL_PATH: "first-tree" },
      );
      expect(out.attachments?.map((a) => a.source?.path)).toEqual(["worktrees/task-x/docs/design.md"]);
      expect(out.content).toBe(
        "wrote [worktrees/task-x/docs/design.md](attachment:00000000-0000-4000-8000-000000000001) now",
      );
    });

    it("promotes a relative source-repo mention to a shared agent-home-relative source path", async () => {
      const { sdk } = stubSdk();
      const out = await captureOutboundDocs(
        "see docs/intro.md please",
        { sdk, chatId: CHAT_ID },
        { FIRST_TREE_DOC_AGENT_HOME: agentHome, FIRST_TREE_DOC_REPO_LOCAL_PATH: "first-tree" },
      );
      expect(out.attachments?.map((a) => a.source?.path)).toEqual(["first-tree/docs/intro.md"]);
    });

    it("ignores the legacy FIRST_TREE_DOC_BASE when FIRST_TREE_DOC_AGENT_HOME is present", async () => {
      const { sdk } = stubSdk();
      const abs = join(agentHome, "worktrees", "task-x", "docs", "design.md");
      const out = await captureOutboundDocs(
        `wrote ${abs} now`,
        { sdk, chatId: CHAT_ID },
        { FIRST_TREE_DOC_AGENT_HOME: agentHome, FIRST_TREE_DOC_BASE: join(agentHome, "first-tree") },
      );
      expect(out.attachments?.map((a) => a.source?.path)).toEqual(["worktrees/task-x/docs/design.md"]);
    });
  });
});
