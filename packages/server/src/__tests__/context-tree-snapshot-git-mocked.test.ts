import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const RECORD_SEPARATOR = "\x1e";

type GitHandler = (args: string[], options: unknown) => string | Error | unknown;

async function loadSnapshotServiceWithGit(handler: GitHandler) {
  vi.resetModules();
  const execFile = vi.fn((command: string, args: string[], options: unknown, callback?: unknown) => {
    const cb = typeof options === "function" ? options : callback;
    if (typeof cb !== "function") return;
    if (command !== "git") {
      cb(new Error(`unexpected command ${command}`));
      return;
    }
    const result = handler(args, options);
    if (result instanceof Error || typeof result !== "string") {
      cb(result);
      return;
    }
    cb(null, { stdout: result, stderr: "" });
  });
  vi.doMock("node:child_process", () => ({ execFile }));
  const service = await import("../services/context-tree-snapshot.js");
  return { execFile, service };
}

describe("Context Tree snapshot service with mocked git", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("materializes public GitLab content anonymously without credential injection", async () => {
    const repo = `https://gitlab.example/public/context-${crypto.randomUUID()}`;
    const head = "a".repeat(40);
    const { execFile, service } = await loadSnapshotServiceWithGit((args) => {
      if (args.includes("clone")) {
        const root = args.at(-1);
        if (!root) return new Error("missing clone root");
        mkdirSync(join(root, ".git"), { recursive: true });
        writeFileSync(join(root, "NODE.md"), "---\ntitle: Public GitLab\nowners: [team]\n---\nPublic context\n");
        return "";
      }
      if (args[0] === "rev-parse" && args[1] === "HEAD") return head;
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main";
      if (args[0] === "rev-list") return "";
      return "";
    });
    const anonymousUrl = `${repo}.git`;
    const root = service.contextTreeSnapshotTestInternals.managedContextTreePath(anonymousUrl, "main");

    try {
      const resolved = await service.contextTreeSnapshotTestInternals.resolveContextTreeRoot(
        repo,
        null,
        "main",
        "gitlab",
        true,
        undefined,
        undefined,
        {
          gitlabInstanceOrigin: "https://gitlab.example",
          gitlabEgressAllowlist: [{ origin: "https://gitlab.example", addressPolicy: { kind: "public" } }],
          gitlabDnsLookup: async () => [{ address: "8.8.8.8", family: 4 }],
        },
      );

      expect(resolved).toEqual({
        root,
        reason: "ok",
        staleReason: null,
        contentAvailability: { status: "available", accessMode: "anonymous" },
      });
      const cloneCall = execFile.mock.calls.find(([, args]) => Array.isArray(args) && args.includes("clone"));
      expect(cloneCall?.[1]).toEqual(expect.arrayContaining(["-c", "credential.helper=", "clone", anonymousUrl]));
      expect(cloneCall?.[2]).toEqual(
        expect.objectContaining({
          env: expect.objectContaining({
            GIT_TERMINAL_PROMPT: "0",
            GIT_ASKPASS: "/bin/false",
            GIT_CONFIG_NOSYSTEM: "1",
          }),
        }),
      );
      const env = (cloneCall?.[2] as { env?: Record<string, string> } | undefined)?.env ?? {};
      expect(Object.keys(env).some((key) => /gitlab.*token|git_password/iu.test(key))).toBe(false);
      expect(Object.keys(env).some((key) => /^(?:http|https|all|no)_proxy$/iu.test(key))).toBe(false);
      expect(cloneCall?.[1]).toEqual(
        expect.arrayContaining([
          "-c",
          "http.followRedirects=false",
          "-c",
          "http.https://gitlab.example/.curloptResolve=gitlab.example:443:8.8.8.8",
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("isolates cached GitLab checkout from hostile ambient filter configuration", async () => {
    const repo = `https://gitlab.example/public/filter-${crypto.randomUUID()}.git`;
    const cacheRoot = join(tmpdir(), `first-tree-snapshot-filter-${crypto.randomUUID()}`);
    const hostileGlobal = join(cacheRoot, "hostile.gitconfig");
    const { execFile, service } = await loadSnapshotServiceWithGit(() => "");
    const root = service.contextTreeSnapshotTestInternals.managedContextTreePath(repo, "main", cacheRoot);
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
    await writeFile(
      hostileGlobal,
      "[filter \"hostile\"]\n\tsmudge = sh -c 'touch /tmp/first-tree-hostile-filter'\n\trequired = true\n",
    );
    const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = hostileGlobal;

    try {
      await service.contextTreeSnapshotTestInternals.materializeRemoteContextTree(
        repo,
        "main",
        cacheRoot,
        undefined,
        undefined,
        "gitlab",
        {
          origin: "https://gitlab.example",
          hostname: "gitlab.example",
          port: 443,
          addresses: ["8.8.8.8"],
          pinnedAddress: "8.8.8.8",
          curlResolve: "gitlab.example:443:8.8.8.8",
        },
        [{ origin: "https://gitlab.example", addressPolicy: { kind: "public" } }],
        async () => [{ address: "8.8.8.8", family: 4 }],
      );

      const checkoutCall = execFile.mock.calls.find(([, args]) => Array.isArray(args) && args.includes("checkout"));
      expect(checkoutCall?.[1]).toEqual(
        expect.arrayContaining(["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "checkout"]),
      );
      expect(checkoutCall?.[2]).toEqual(
        expect.objectContaining({
          env: expect.objectContaining({
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_SYSTEM: "/dev/null",
          }),
        }),
      );
      expect((checkoutCall?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env?.GIT_CONFIG_GLOBAL).not.toBe(
        hostileGlobal,
      );
    } finally {
      if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
      await rm(cacheRoot, { recursive: true, force: true });
      service.contextTreeSnapshotTestInternals.clearRemoteSyncState();
    }
  });

  it("classifies private GitLab as content-unavailable and never retries with credentials", async () => {
    const repo = `git@gitlab.example:private/context-${crypto.randomUUID()}.git`;
    const authError = Object.assign(new Error("Command failed: git clone"), {
      stderr: "fatal: could not read Username for 'https://gitlab.example': terminal prompts disabled",
    });
    const { execFile, service } = await loadSnapshotServiceWithGit((args) => (args.includes("clone") ? authError : ""));
    const anonymousUrl = repo.replace(/^git@gitlab\.example:/u, "https://gitlab.example/");
    const root = service.contextTreeSnapshotTestInternals.managedContextTreePath(anonymousUrl, "main");

    try {
      const resolved = await service.contextTreeSnapshotTestInternals.resolveContextTreeRoot(
        repo,
        null,
        "main",
        "gitlab",
        true,
        undefined,
        undefined,
        {
          gitlabInstanceOrigin: "https://gitlab.example",
          gitlabEgressAllowlist: [{ origin: "https://gitlab.example", addressPolicy: { kind: "public" } }],
          gitlabDnsLookup: async () => [{ address: "8.8.8.8", family: 4 }],
        },
      );

      expect(resolved.root).toBeNull();
      expect(resolved.contentAvailability).toEqual({
        status: "unavailable",
        accessMode: "anonymous",
        reason: "gitlab_authentication_required",
      });
      expect(resolved.reason).toContain("Cloud only performs anonymous GitLab reads");
      const cloneCalls = execFile.mock.calls.filter(([, args]) => Array.isArray(args) && args.includes("clone"));
      expect(cloneCalls).toHaveLength(1);
      expect(String(cloneCalls[0]?.[1])).toContain("https://gitlab.example/private/");
      expect(String(cloneCalls[0]?.[1])).not.toContain("git@gitlab.example");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("performs no git egress for an origin absent from the deployment allowlist", async () => {
    const { execFile, service } = await loadSnapshotServiceWithGit(() => {
      throw new Error("git must not run");
    });
    const resolved = await service.contextTreeSnapshotTestInternals.resolveContextTreeRoot(
      "https://gitlab.denied/acme/context.git",
      null,
      "main",
      "gitlab",
      true,
      undefined,
      undefined,
      {
        gitlabInstanceOrigin: "https://gitlab.denied",
        gitlabEgressAllowlist: [],
        gitlabDnsLookup: async () => [{ address: "8.8.8.8", family: 4 }],
      },
    );
    expect(resolved.contentAvailability).toEqual({
      status: "unavailable",
      accessMode: "anonymous",
      reason: "gitlab_origin_not_authorized",
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("fails closed when DNS changes across the pinned clone guard", async () => {
    const head = "b".repeat(40);
    const repo = `https://gitlab.example/acme/rebinding-${crypto.randomUUID()}.git`;
    const { service } = await loadSnapshotServiceWithGit((args) => {
      if (args.includes("clone")) {
        const root = args.at(-1);
        if (!root) return new Error("missing clone root");
        mkdirSync(join(root, ".git"), { recursive: true });
        writeFileSync(join(root, "NODE.md"), "---\ntitle: Context\nowners: [team]\n---\nContext\n");
        return "";
      }
      if (args[0] === "rev-parse" && args[1] === "HEAD") return head;
      return "";
    });
    let lookupCount = 0;
    const root = service.contextTreeSnapshotTestInternals.managedContextTreePath(repo, "main");
    try {
      const resolved = await service.contextTreeSnapshotTestInternals.resolveContextTreeRoot(
        repo,
        null,
        "main",
        "gitlab",
        true,
        undefined,
        undefined,
        {
          gitlabInstanceOrigin: "https://gitlab.example",
          gitlabEgressAllowlist: [{ origin: "https://gitlab.example", addressPolicy: { kind: "public" } }],
          gitlabDnsLookup: async () => [{ address: lookupCount++ === 0 ? "8.8.8.8" : "1.1.1.1", family: 4 }],
        },
      );
      expect(resolved.contentAvailability).toMatchObject({
        status: "unavailable",
        reason: "gitlab_egress_denied",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the live binding changes during a pinned clone", async () => {
    const repo = `https://gitlab.example/acme/binding-race-${crypto.randomUUID()}.git`;
    const { service } = await loadSnapshotServiceWithGit((args) => {
      if (args.includes("clone")) {
        const root = args.at(-1);
        if (!root) return new Error("missing clone root");
        mkdirSync(join(root, ".git"), { recursive: true });
        writeFileSync(join(root, "NODE.md"), "---\ntitle: Context\nowners: [team]\n---\nContext\n");
      }
      return "";
    });
    let guardCount = 0;
    const root = service.contextTreeSnapshotTestInternals.managedContextTreePath(repo, "main");
    try {
      const resolved = await service.contextTreeSnapshotTestInternals.resolveContextTreeRoot(
        repo,
        null,
        "main",
        "gitlab",
        true,
        undefined,
        undefined,
        {
          gitlabInstanceOrigin: "https://gitlab.example",
          gitlabEgressAllowlist: [{ origin: "https://gitlab.example", addressPolicy: { kind: "public" } }],
          gitlabDnsLookup: async () => [{ address: "8.8.8.8", family: 4 }],
          gitlabExecutionGuard: async () => guardCount++ === 0,
        },
      );
      expect(resolved.contentAvailability).toMatchObject({
        status: "unavailable",
        reason: "gitlab_origin_not_authorized",
      });
      expect(guardCount).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not follow GitLab redirects", async () => {
    const redirect = Object.assign(new Error("Command failed: git clone"), {
      stderr: "fatal: unable to update url base from redirection",
    });
    const { service } = await loadSnapshotServiceWithGit((args) => (args.includes("clone") ? redirect : ""));
    const resolved = await service.contextTreeSnapshotTestInternals.resolveContextTreeRoot(
      "https://gitlab.example/acme/redirect.git",
      null,
      "main",
      "gitlab",
      true,
      undefined,
      undefined,
      {
        gitlabInstanceOrigin: "https://gitlab.example",
        gitlabEgressAllowlist: [{ origin: "https://gitlab.example", addressPolicy: { kind: "public" } }],
        gitlabDnsLookup: async () => [{ address: "8.8.8.8", family: 4 }],
      },
    );
    expect(resolved.contentAvailability).toMatchObject({
      status: "unavailable",
      reason: "gitlab_redirect_forbidden",
    });
  });

  it("parses unusual git diff and log records through defensive fallbacks", async () => {
    const safeBase = "a".repeat(40);
    const safeHead = "b".repeat(40);
    const metadataCommit = "c".repeat(40);
    const { service } = await loadSnapshotServiceWithGit((args) => {
      if (args[0] === "diff") {
        return [
          "\t",
          "R100\told.md\tnew.md",
          "R100\told-only.md",
          "R100\t\tnew-only.md",
          "A\t",
          "M\tmodified.md",
          "D\tdeleted.md",
          "X\tignored.md",
        ].join("\n");
      }
      if (args[0] === "log") {
        return [
          `${RECORD_SEPARATOR}${metadataCommit}\x00\x00\x00Merge pull request #12 from acme/context\nmodified.md`,
          `${RECORD_SEPARATOR}not-a-safe-commit\x002026-01-01T00:00:00.000Z\x00bot\x00docs: invalid\nignored.md`,
          `${RECORD_SEPARATOR}${"d".repeat(40)}\x002026-01-02T00:00:00.000Z\x00bot\x00docs: header only`,
        ].join("");
      }
      return "";
    });

    const diff = await service.contextTreeSnapshotTestInternals.readDiffEntries("/fake", safeBase, safeHead);

    expect(diff.truncated).toBe(true);
    expect(diff.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "removed", path: "old.md", commit: safeHead }),
        expect.objectContaining({ type: "added", path: "new.md", commit: safeHead }),
        expect.objectContaining({ type: "removed", path: "old-only.md", commit: safeHead }),
        expect.objectContaining({ type: "removed", path: "new-only.md", commit: safeHead }),
        expect.objectContaining({
          type: "edited",
          path: "modified.md",
          commit: metadataCommit,
          changedAt: null,
          changedBy: null,
          summary: "Merge pull request #12 from acme/context",
          prNumber: 12,
        }),
        expect.objectContaining({ type: "removed", path: "deleted.md", commit: safeHead }),
      ]),
    );
    expect(diff.entries.some((entry) => entry.path === "ignored.md")).toBe(false);
  });

  it("uses fallback diff metadata when git log has empty records", async () => {
    const safeBase = "a".repeat(40);
    const safeHead = "b".repeat(40);
    const { service } = await loadSnapshotServiceWithGit((args) => {
      if (args[0] === "diff") return "A\tnew.md";
      if (args[0] === "log") return "";
      return "";
    });

    const diff = await service.contextTreeSnapshotTestInternals.readDiffEntries("/fake", safeBase, safeHead);

    expect(diff.entries).toEqual([
      expect.objectContaining({
        type: "added",
        path: "new.md",
        commit: safeHead,
        changedAt: null,
        changedBy: null,
        summary: null,
        prNumber: null,
      }),
    ]);
  });

  it("handles empty diff path sets and missing git log subject fields", async () => {
    const safeBase = "a".repeat(40);
    const safeHead = "b".repeat(40);
    const metadataCommit = "c".repeat(40);
    const { service } = await loadSnapshotServiceWithGit((args) => {
      if (args[0] === "diff") return "A\t";
      if (args[0] === "log") return `${RECORD_SEPARATOR}${metadataCommit}\x002026-01-01T00:00:00.000Z\x00bot\nnew.md`;
      return "";
    });

    await expect(
      service.contextTreeSnapshotTestInternals.readDiffEntries("/fake", safeBase, safeHead),
    ).resolves.toEqual({
      entries: [],
      truncated: true,
    });

    const { service: serviceWithPath } = await loadSnapshotServiceWithGit((args) => {
      if (args[0] === "diff") return "A\tnew.md";
      if (args[0] === "log") return `${RECORD_SEPARATOR}${metadataCommit}\x002026-01-01T00:00:00.000Z\x00bot\nnew.md`;
      return "";
    });
    const diff = await serviceWithPath.contextTreeSnapshotTestInternals.readDiffEntries("/fake", safeBase, safeHead);
    expect(diff.entries[0]).toMatchObject({
      path: "new.md",
      commit: metadataCommit,
      summary: null,
      prNumber: null,
    });
  });

  it("caches non-Error remote sync failures without leaking an error message", async () => {
    const cacheRoot = join(tmpdir(), `context-tree-mocked-failure-${crypto.randomUUID()}`);
    const { service } = await loadSnapshotServiceWithGit((args) => {
      if (args.includes("clone")) return { reason: "clone failed as object" };
      return "";
    });

    try {
      await expect(
        service.contextTreeSnapshotTestInternals.materializeRemoteContextTree(
          "https://github.com/acme/context-tree",
          "main",
          cacheRoot,
        ),
      ).rejects.toEqual({ reason: "clone failed as object" });
      await expect(
        service.contextTreeSnapshotTestInternals.materializeRemoteContextTree(
          "https://github.com/acme/context-tree",
          "main",
          cacheRoot,
        ),
      ).rejects.toThrow("Previous Context Tree sync failed recently.");
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("uses fallback snapshot status when mocked git has no branch and no recent diff", async () => {
    const root = join(tmpdir(), `context-tree-mocked-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "NODE.md"), "---\ntitle: Mocked\n---\nBody\n");
    const head = "e".repeat(40);
    const timings: Array<{ name: string; hit?: boolean }> = [];
    try {
      const { service } = await loadSnapshotServiceWithGit((args) => {
        if (args[0] === "rev-parse" && args[1] === "HEAD") return head;
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return new Error("branch unavailable");
        if (args[0] === "rev-list") return "";
        if (args[0] === "diff") return "";
        return "";
      });

      const snapshot = await service.getContextTreeSnapshot({ localPath: root }, "7d", {
        timing: (name, _ms, fields) =>
          timings.push({ name, hit: typeof fields?.hit === "boolean" ? fields.hit : undefined }),
      });

      expect(snapshot.snapshotStatus).toBe("active");
      expect(snapshot.branch).toBeNull();
      expect(snapshot.headCommit).toBe(head);
      expect(snapshot.contextStatus.label).toBe("Context Tree is up to date");
      expect(timings).toEqual(expect.arrayContaining([{ name: "snapshot_cache_lookup", hit: false }]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("surfaces the generic unavailable snapshot message for non-Error git failures", async () => {
    const root = join(tmpdir(), `context-tree-mocked-error-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    try {
      const { service } = await loadSnapshotServiceWithGit((args) => {
        if (args[0] === "rev-parse" && args[1] === "HEAD") return { reason: "git exploded" };
        return "";
      });

      const snapshot = await service.getContextTreeSnapshot({ localPath: root }, "7d");

      expect(snapshot.snapshotStatus).toBe("unavailable");
      expect(snapshot.contextStatus.detail).toBe("Unable to read Context Tree snapshot");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
