import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createAnthropicClassifier,
  parseVerdictJson,
  validateAndGroundNodes,
} from "#products/gardener/engine/classifiers/anthropic.js";
import {
  collectTreeDigest,
  formatDigest,
} from "#products/gardener/engine/classifiers/tree-digest.js";
import type { ClassifyInput } from "#products/gardener/engine/comment.js";
import { useTmpDir } from "../helpers.js";

function seedTree(root: string): void {
  mkdirSync(join(root, "engineering"), { recursive: true });
  mkdirSync(join(root, "product"), { recursive: true });
  writeFileSync(
    join(root, "NODE.md"),
    "---\ntitle: Root\ndescription: Example tree root\n---\n",
  );
  writeFileSync(
    join(root, "engineering", "NODE.md"),
    "---\ntitle: Engineering\ndescription: Backend services and runtime.\n---\n",
  );
  writeFileSync(
    join(root, "product", "NODE.md"),
    "---\ntitle: Product\n---\n\nThin core scope for V1.\n",
  );
}

const prInput = (treeRoot: string): ClassifyInput => ({
  type: "pr",
  prView: {
    number: 42,
    title: "Add payment module",
    body: "Ships the new payments table and handler.",
    headRefOid: "abc123",
    state: "OPEN",
  },
  diff: "diff --git a/src/payments.ts b/src/payments.ts\n+new code\n",
  treeRoot,
  treeSha: "treesha",
});

function stubFetch(text: string): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({ content: [{ type: "text", text }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
}

describe("tree-digest collectTreeDigest", () => {
  it("finds NODE.md files with frontmatter description or first paragraph", () => {
    const tmp = useTmpDir();
    seedTree(tmp.path);
    const entries = collectTreeDigest(tmp.path);
    expect(entries.length).toBe(3);
    const root = entries.find((e) => e.path === "NODE.md");
    expect(root?.summary).toBe("Example tree root");
    const eng = entries.find((e) => e.path === "engineering/NODE.md");
    expect(eng?.summary).toContain("Backend");
    const product = entries.find((e) => e.path === "product/NODE.md");
    expect(product?.summary).toBe("Thin core scope for V1.");
  });

  it("skips noise directories like node_modules and .git", () => {
    const tmp = useTmpDir();
    seedTree(tmp.path);
    mkdirSync(join(tmp.path, "node_modules", "x"), { recursive: true });
    writeFileSync(
      join(tmp.path, "node_modules", "x", "NODE.md"),
      "---\ntitle: Leaked\n---\n",
    );
    const entries = collectTreeDigest(tmp.path);
    expect(entries.every((e) => !e.path.startsWith("node_modules/"))).toBe(true);
  });
});

describe("tree-digest formatDigest", () => {
  it("renders a bulleted list with backticked paths", () => {
    const out = formatDigest([
      { path: "a/NODE.md", summary: "hello" },
      { path: "b/NODE.md", summary: "world" },
    ]);
    expect(out).toContain("- `a/NODE.md` — hello");
    expect(out).toContain("- `b/NODE.md` — world");
  });

  it("handles empty input", () => {
    expect(formatDigest([])).toBe("(no NODE.md files found)");
  });
});

describe("parseVerdictJson", () => {
  it("parses a bare JSON object", () => {
    const out = parseVerdictJson(
      JSON.stringify({
        verdict: "ALIGNED",
        severity: "low",
        summary: "fits V1",
        treeNodes: [{ path: "product/NODE.md", summary: "scope" }],
      }),
    );
    expect(out?.verdict).toBe("ALIGNED");
    expect(out?.treeNodes).toHaveLength(1);
  });

  it("strips ```json code fences", () => {
    const out = parseVerdictJson(
      '```json\n{"verdict":"CONFLICT","severity":"high","summary":"contradicts","treeNodes":[]}\n```',
    );
    expect(out?.verdict).toBe("CONFLICT");
    expect(out?.severity).toBe("high");
  });

  it("rejects invalid verdict", () => {
    const out = parseVerdictJson(
      '{"verdict":"MAYBE","severity":"low","summary":"x","treeNodes":[]}',
    );
    expect(out).toBeNull();
  });

  it("rejects missing summary", () => {
    const out = parseVerdictJson(
      '{"verdict":"ALIGNED","severity":"low","treeNodes":[]}',
    );
    expect(out).toBeNull();
  });

  it("returns null on non-JSON prose", () => {
    expect(parseVerdictJson("The model chose to refuse.")).toBeNull();
  });

  it("drops malformed treeNodes entries but keeps well-formed ones", () => {
    const out = parseVerdictJson(
      '{"verdict":"ALIGNED","severity":"low","summary":"s","treeNodes":[{"path":"a","summary":"b"},{"nope":true},"string"]}',
    );
    expect(out?.treeNodes).toEqual([{ path: "a", summary: "b" }]);
  });

  it("truncates overlong summaries to the prompt cap", () => {
    const out = parseVerdictJson(
      JSON.stringify({
        verdict: "ALIGNED",
        severity: "low",
        summary: "x".repeat(250),
        treeNodes: [],
      }),
    );
    expect(out?.summary).toHaveLength(200);
    expect(out?.summary.endsWith("…")).toBe(true);
  });
});

describe("validateAndGroundNodes", () => {
  it("drops cited paths that do not exist on disk", () => {
    const tmp = useTmpDir();
    seedTree(tmp.path);
    const grounded = validateAndGroundNodes(
      {
        verdict: "ALIGNED",
        severity: "low",
        summary: "x",
        treeNodes: [
          { path: "product/NODE.md", summary: "real" },
          { path: "imaginary/NODE.md", summary: "hallucinated" },
        ],
      },
      tmp.path,
    );
    expect(grounded.treeNodes).toEqual([
      { path: "product/NODE.md", summary: "real" },
    ]);
  });

  it("drops absolute and tree-escaping cited paths", () => {
    const tmp = useTmpDir();
    const treeRoot = join(tmp.path, "tree");
    const outsideRoot = join(tmp.path, "outside");
    seedTree(treeRoot);
    mkdirSync(outsideRoot, { recursive: true });
    writeFileSync(join(outsideRoot, "NODE.md"), "outside");
    const grounded = validateAndGroundNodes(
      {
        verdict: "ALIGNED",
        severity: "low",
        summary: "x",
        treeNodes: [
          { path: "product/NODE.md", summary: "real" },
          { path: "../outside/NODE.md", summary: "escape" },
          { path: join(outsideRoot, "NODE.md"), summary: "absolute" },
        ],
      },
      treeRoot,
    );
    expect(grounded.treeNodes).toEqual([
      { path: "product/NODE.md", summary: "real" },
    ]);
  });
});

describe("createAnthropicClassifier", () => {
  it("returns the parsed verdict on a well-formed response", async () => {
    const tmp = useTmpDir();
    seedTree(tmp.path);
    const classifier = createAnthropicClassifier({
      apiKey: "sk-test",
      fetchImpl: stubFetch(
        JSON.stringify({
          verdict: "ALIGNED",
          severity: "low",
          summary: "matches V1 scope",
          treeNodes: [{ path: "product/NODE.md", summary: "V1 scope" }],
        }),
      ),
    });
    const out = await classifier(prInput(tmp.path));
    expect(out.verdict).toBe("ALIGNED");
    expect(out.treeNodes).toEqual([
      { path: "product/NODE.md", summary: "V1 scope" },
    ]);
  });

  it("falls back to INSUFFICIENT_CONTEXT on non-JSON response", async () => {
    const tmp = useTmpDir();
    seedTree(tmp.path);
    const classifier = createAnthropicClassifier({
      apiKey: "sk-test",
      fetchImpl: stubFetch("I cannot decide this one."),
    });
    const out = await classifier(prInput(tmp.path));
    expect(out.verdict).toBe("INSUFFICIENT_CONTEXT");
    expect(out.summary).toContain("could not parse");
  });

  it("falls back on non-2xx HTTP status", async () => {
    const tmp = useTmpDir();
    seedTree(tmp.path);
    const failingFetch: typeof fetch = (async () =>
      new Response("rate limited", { status: 429 })) as typeof fetch;
    const classifier = createAnthropicClassifier({
      apiKey: "sk-test",
      fetchImpl: failingFetch,
    });
    const out = await classifier(prInput(tmp.path));
    expect(out.verdict).toBe("INSUFFICIENT_CONTEXT");
    expect(out.summary).toContain("anthropic API 429");
  });

  it("falls back on network error", async () => {
    const tmp = useTmpDir();
    seedTree(tmp.path);
    const throwingFetch: typeof fetch = (async () => {
      throw new Error("ENETDOWN");
    }) as typeof fetch;
    const classifier = createAnthropicClassifier({
      apiKey: "sk-test",
      fetchImpl: throwingFetch,
    });
    const out = await classifier(prInput(tmp.path));
    expect(out.verdict).toBe("INSUFFICIENT_CONTEXT");
    expect(out.summary).toContain("ENETDOWN");
  });

  it("drops hallucinated treeNodes before returning", async () => {
    const tmp = useTmpDir();
    seedTree(tmp.path);
    const classifier = createAnthropicClassifier({
      apiKey: "sk-test",
      fetchImpl: stubFetch(
        JSON.stringify({
          verdict: "CONFLICT",
          severity: "high",
          summary: "contradicts scope",
          treeNodes: [
            { path: "product/NODE.md", summary: "real" },
            { path: "fabricated/NODE.md", summary: "not real" },
          ],
        }),
      ),
    });
    const out = await classifier(prInput(tmp.path));
    expect(out.treeNodes).toEqual([
      { path: "product/NODE.md", summary: "real" },
    ]);
  });

  it("sends the expected API headers and model", async () => {
    const tmp = useTmpDir();
    seedTree(tmp.path);
    const seen: {
      url?: string;
      headers?: Record<string, string>;
      body?: string;
      signal?: AbortSignal | null;
    } = {};
    const captureFetch: typeof fetch = (async (url: string, init: RequestInit) => {
      seen.url = url;
      seen.headers = init.headers as Record<string, string>;
      seen.body = init.body as string;
      seen.signal = init.signal;
      return new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                verdict: "ALIGNED",
                severity: "low",
                summary: "ok",
                treeNodes: [],
              }),
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const classifier = createAnthropicClassifier({
      apiKey: "sk-live",
      model: "claude-sonnet-4-6",
      fetchImpl: captureFetch,
    });
    await classifier(prInput(tmp.path));
    expect(seen.url).toBe("https://api.anthropic.com/v1/messages");
    expect(seen.headers?.["x-api-key"]).toBe("sk-live");
    expect(seen.headers?.["anthropic-version"]).toBe("2023-06-01");
    expect(seen.signal).toBeTruthy();
    const parsed = JSON.parse(seen.body ?? "{}");
    expect(parsed.model).toBe("claude-sonnet-4-6");
    expect(parsed.messages[0].content).toContain("Add payment module");
  });
});
