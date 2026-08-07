import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const clientSrc = join(here, "..");

/**
 * Every literal module specifier a source file references through a real
 * ESM import/export/dynamic-import syntax node, plus the named bindings
 * imported from each specifier (`import { name } from "spec"`).
 *
 * Built by walking a real TypeScript AST (`ts.createSourceFile` +
 * `ts.forEachChild`) rather than by pattern-matching source text. This is
 * what a regex-based matcher cannot give you: comments are trivia the parser
 * discards before producing nodes, and a string/template-literal expression
 * is never classified as an `ImportDeclaration`, `ExportDeclaration`, or a
 * dynamic `import()` call — so text that merely *looks like* import syntax
 * inside a comment, doc-string, or string/template literal can never be
 * misread as a real dependency edge, regardless of how closely it resembles
 * real syntax. A previous regex-based version of this guard (any version up
 * to and including commit `5b1cd66c`) was fooled by exactly this: a
 * global, unanchored `import\(...\)` pattern matched `import("...")` text
 * inside line comments, doc-comments, plain strings, and template literals
 * alike. The "module-specifier detection stays precise" block below
 * reproduces that exact class of near-miss against this AST-based
 * implementation to prove it no longer happens.
 */
interface ModuleReferences {
  specifiers: Set<string>;
  namedImportsBySpecifier: Map<string, Set<string>>;
}

/**
 * `ts.isImportCall` (the TS compiler's own dynamic-`import()`-call
 * predicate) is `@internal` and not part of the public `.d.ts`, so it's
 * unusable under `tsc --noEmit`. A dynamic import call is, in the public
 * AST shape, simply a `CallExpression` whose callee is the bare `import`
 * keyword token — that's the one fact this local check relies on.
 */
function isDynamicImportCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

function parseModuleReferences(source: string): ModuleReferences {
  const sourceFile = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers = new Set<string>();
  const namedImportsBySpecifier = new Map<string, Set<string>>();

  function recordNamedImport(spec: string, name: string): void {
    let names = namedImportsBySpecifier.get(spec);
    if (!names) {
      names = new Set();
      namedImportsBySpecifier.set(spec, names);
    }
    names.add(name);
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      // Covers named, default, namespace, type-only, and bare side-effect
      // imports alike — all of them are `ImportDeclaration` nodes; only the
      // (optional) `importClause` shape differs, and a side-effect import
      // simply has no `importClause` at all.
      const spec = node.moduleSpecifier.text;
      specifiers.add(spec);
      const namedBindings = node.importClause?.namedBindings;
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          recordNamedImport(spec, element.name.text);
        }
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      // `export { name } from "spec"` / `export * from "spec"`.
      specifiers.add(node.moduleSpecifier.text);
    } else if (isDynamicImportCall(node)) {
      // Dynamic `import("spec")`, however it's used (awaited, `.then()`-
      // chained, bare statement, single- or double-quoted).
      const [arg] = node.arguments;
      if (arg && ts.isStringLiteralLike(arg)) {
        specifiers.add(arg.text);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { specifiers, namedImportsBySpecifier };
}

/**
 * True if `source` references module `spec` through ANY real ESM form: a
 * binding import, a re-export-from, a bare side-effect import, or a dynamic
 * `import()` call. This is the single predicate the "must not depend on X"
 * checks below use, so a forbidden edge cannot sneak back in through a form
 * the guard forgot to check.
 */
function referencesModuleSpecifier(source: string, spec: string): boolean {
  return parseModuleReferences(source).specifiers.has(spec);
}

/** True if `source` has a real named-import binding of `name` from the exact module specifier `spec`. */
function hasNamedImport(source: string, name: string, spec: string): boolean {
  return parseModuleReferences(source).namedImportsBySpecifier.get(spec)?.has(name) ?? false;
}

/**
 * Every name a source file re-exports via `export { name }` or
 * `export { name } from "spec"` (both are `ExportDeclaration` nodes with a
 * `NamedExports` `exportClause`; only the presence of `moduleSpecifier`
 * differs) — i.e. every name reachable by importing this file, regardless of
 * whether it re-exports a name imported from elsewhere or one declared here.
 */
function collectNamedExports(source: string): Set<string> {
  const sourceFile = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = new Set<string>();

  function visit(node: ts.Node): void {
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) {
        names.add(element.name.text);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return names;
}

/** Every top-level function name declared with `export function name(...)` in `source`. */
function collectExportedFunctionDeclarationNames(source: string): Set<string> {
  const sourceFile = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = new Set<string>();

  function visit(node: ts.Node): void {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return names;
}

/**
 * Architectural guard for the Claude provider-family split
 * (`handlers/claude/tool-call-processor.ts`, `handlers/claude/mcp-config.ts`,
 * `handlers/claude/sdk-query-options.ts`).
 *
 * The SDK stream handler (`handlers/claude-code.ts`) and the Claude TUI
 * transcript handler (`handlers/claude-code-tui/index.ts`) both consume these
 * modules directly. Before this split, the TUI handler imported them FROM the
 * SDK handler entry point — a reverse dependency that made the TUI handler's
 * load graph include the entire SDK lifecycle module. This guard fails if
 * that reverse dependency ever comes back — as a binding import, a
 * re-export-from, a side-effect import, or a dynamic `import()` — and if the
 * SDK handler entry stops re-exporting the same names (which would silently
 * break any existing internal/package import of them from `claude-code.js`).
 *
 * Every check below is driven by a real TypeScript AST parse of the file
 * under test, not text pattern-matching, so a comment, doc-string, or
 * string/template literal that merely *contains* the forbidden/required
 * import syntax cannot flip the assertion either way. The "module-specifier
 * detection stays precise" block below proves this directly against
 * synthetic snippets, so the guard's own detection logic does not rest
 * solely on the fact that it happens to pass against current source.
 */
describe("Claude provider-family boundary", () => {
  it("TUI handler depends on the provider-family modules directly, never on the SDK handler entry", () => {
    const tui = readFileSync(join(clientSrc, "handlers/claude-code-tui/index.ts"), "utf8");

    // The reverse dependency this split removes: the TUI handler must never
    // reference its sibling SDK handler entry point again, in any ESM form.
    expect(referencesModuleSpecifier(tui, "../claude-code.js")).toBe(false);

    // It must import the provider-family modules it actually uses via real
    // named-import declarations (not merely mention them in a comment).
    expect(hasNamedImport(tui, "createToolCallProcessor", "../claude/tool-call-processor.js")).toBe(true);
    expect(hasNamedImport(tui, "mapMcpServers", "../claude/mcp-config.js")).toBe(true);
  });

  it("provider-family modules stay self-contained (no import back into either handler, in any ESM form)", () => {
    for (const file of ["tool-call-processor.ts", "mcp-config.ts", "sdk-query-options.ts"]) {
      const source = readFileSync(join(clientSrc, "handlers/claude", file), "utf8");
      for (const spec of ["../claude-code.js", "./claude-code.js", "../../handlers/claude-code.js"]) {
        expect(
          referencesModuleSpecifier(source, spec),
          `${file} must not reference the SDK handler entry (${spec})`,
        ).toBe(false);
      }
      for (const spec of ["../claude-code-tui/index.js", "./claude-code-tui/index.js"]) {
        expect(referencesModuleSpecifier(source, spec), `${file} must not reference the TUI handler (${spec})`).toBe(
          false,
        );
      }
    }
  });

  it("sdk-query-options.ts composes mcp-config.ts rather than re-deriving MCP mapping", () => {
    const source = readFileSync(join(clientSrc, "handlers/claude/sdk-query-options.ts"), "utf8");
    expect(hasNamedImport(source, "mapMcpServers", "./mcp-config.js")).toBe(true);
    expect(source).not.toMatch(/for \(const s of payload\.mcpServers\)/);
  });

  it("the SDK handler entry re-exports every migrated helper/type for backward-compatible imports", () => {
    const source = readFileSync(join(clientSrc, "handlers/claude-code.ts"), "utf8");

    // The three modules stay the actual owners; claude-code.ts is now a thin
    // SDK-lifecycle-only facade that imports and re-exports them.
    expect(referencesModuleSpecifier(source, "./claude/tool-call-processor.js")).toBe(true);
    expect(referencesModuleSpecifier(source, "./claude/mcp-config.js")).toBe(true);
    expect(referencesModuleSpecifier(source, "./claude/sdk-query-options.js")).toBe(true);

    // Every name any existing import site (internal call sites, tests, and —
    // pre-decoupling — the TUI handler) could previously reach via
    // `handlers/claude-code.js` must still resolve from there, via a real
    // `export { ... }` declaration (not a mention in prose).
    const exportedNames = collectNamedExports(source);
    for (const name of [
      "createToolCallProcessor",
      "treeNodePathOf",
      "ContextTreeBinding",
      "ToolCallProcessor",
      "mapMcpServers",
      "buildClaudeQueryOptions",
      "isSameModelFamily",
      "ClaudeQueryConfigOptions",
    ]) {
      expect(exportedNames.has(name), `claude-code.ts must still export ${name}`).toBe(true);
    }

    // The extracted logic itself must not still be defined inline here —
    // only imported/re-exported — so there is exactly one source of truth.
    const exportedFunctionDeclarations = collectExportedFunctionDeclarationNames(source);
    for (const name of ["createToolCallProcessor", "mapMcpServers", "buildClaudeQueryOptions"]) {
      expect(exportedFunctionDeclarations.has(name), `claude-code.ts must not still declare ${name} inline`).toBe(
        false,
      );
    }
  });

  it("re-exported runtime helpers are the exact same function references the leaf modules export, not a second implementation", async () => {
    const facade = await import("../handlers/claude-code.js");
    const toolCallProcessor = await import("../handlers/claude/tool-call-processor.js");
    const mcpConfig = await import("../handlers/claude/mcp-config.js");
    const sdkQueryOptions = await import("../handlers/claude/sdk-query-options.js");

    // `export { name } from "./leaf.js"` after `import { name } from "./leaf.js"`
    // re-exports the same binding under ESM semantics; asserting reference
    // identity (not just equal behavior) is what rules out a wrapper or a
    // copy-pasted second implementation living behind the facade — importing
    // the same names from both the facade and each leaf and comparing `toBe`
    // proves it directly, rather than inferring it from source text.
    expect(facade.createToolCallProcessor).toBe(toolCallProcessor.createToolCallProcessor);
    expect(facade.treeNodePathOf).toBe(toolCallProcessor.treeNodePathOf);
    expect(facade.mapMcpServers).toBe(mcpConfig.mapMcpServers);
    expect(facade.buildClaudeQueryOptions).toBe(sdkQueryOptions.buildClaudeQueryOptions);
    expect(facade.isSameModelFamily).toBe(sdkQueryOptions.isSameModelFamily);

    // `ContextTreeBinding`, `ToolCallProcessor`, `ClaudeQueryConfigOptions` are
    // type-only exports erased at runtime — there is no value to assert
    // identity on. `tsc` is the proof for those: every `import type` of them
    // from either the facade or the leaf module must resolve to the same
    // declaration, which the repo-wide typecheck run already exercises.
  });

  describe("module-specifier detection stays precise", () => {
    const spec = "../claude-code.js";

    /**
     * Table-driven characterization of `referencesModuleSpecifier()` against
     * every real ESM form that could re-introduce the forbidden dependency,
     * plus the near-miss shapes that must never trip a false positive:
     * comments, doc-strings, plain strings, and template literals — each
     * tested both as a bare specifier mention AND as a full import/dynamic-
     * import statement written out inside them (the latter is exactly the
     * class of false positive a text-pattern matcher is prone to, and an
     * AST-based check is not). This is what proves the detection logic
     * itself — the guard tests above only prove today's real source happens
     * to satisfy it.
     */
    const SPECIFIER_CASES: ReadonlyArray<{ label: string; snippet: string; expected: boolean }> = [
      {
        label: "static named import",
        snippet: 'import { createToolCallProcessor } from "../claude-code.js";',
        expected: true,
      },
      { label: "static default import", snippet: 'import ClaudeCode from "../claude-code.js";', expected: true },
      { label: "static namespace import", snippet: 'import * as claudeCode from "../claude-code.js";', expected: true },
      { label: "static type-only import", snippet: 'import type { Foo } from "../claude-code.js";', expected: true },
      {
        label: "multi-line static named import",
        snippet: 'import {\n  createToolCallProcessor,\n  mapMcpServers,\n} from "../claude-code.js";',
        expected: true,
      },
      {
        label: "bare side-effect import (no bindings, no `from`)",
        snippet: 'import "../claude-code.js";',
        expected: true,
      },
      {
        label: "re-export-from",
        snippet: 'export { createToolCallProcessor } from "../claude-code.js";',
        expected: true,
      },
      { label: "namespace re-export-from", snippet: 'export * from "../claude-code.js";', expected: true },
      {
        label: "dynamic import(), awaited",
        snippet: 'const m = await import("../claude-code.js");',
        expected: true,
      },
      {
        label: "dynamic import(), chained .then()",
        snippet: 'import("../claude-code.js").then((m) => m);',
        expected: true,
      },
      { label: "dynamic import(), single-quoted", snippet: "import('../claude-code.js');", expected: true },
      {
        label: "comment-only mention (bare specifier text)",
        snippet:
          '// see ../claude-code.js for the pre-split behaviour\nimport { mapMcpServers } from "./mcp-config.js";',
        expected: false,
      },
      {
        label: "doc-string mention (bare specifier text)",
        snippet: '/**\n * Used to import from "../claude-code.js" before this split.\n */\nexport const x = 1;',
        expected: false,
      },
      {
        label: "string-literal mention (bare specifier text)",
        snippet: 'const message = "this string contains ../claude-code.js but is not an import";',
        expected: false,
      },
      {
        label: "line comment containing a full dynamic-import statement",
        snippet: 'const x = 1;\n// do not use import("../claude-code.js")\nconst y = 2;',
        expected: false,
      },
      {
        label: "block comment containing a full static-import statement",
        snippet: '/* import { createToolCallProcessor } from "../claude-code.js"; */\nconst y = 2;',
        expected: false,
      },
      {
        label: "doc comment containing a full dynamic-import statement",
        snippet: '/**\n * Used to do: import("../claude-code.js")\n */\nexport const x = 1;',
        expected: false,
      },
      {
        label: "plain string literal containing a full dynamic-import statement",
        snippet: "const s = 'import(\"../claude-code.js\")';",
        expected: false,
      },
      {
        label: "multi-line template literal containing a full static-import statement",
        snippet: 'const s = `\n  import { x } from "../claude-code.js";\n`;',
        expected: false,
      },
      {
        label: "similar-but-unequal specifier (shares a suffix)",
        snippet: 'import { x } from "../not-claude-code.js";',
        expected: false,
      },
    ];

    it.each(SPECIFIER_CASES)("$label -> referencesModuleSpecifier === $expected", ({ snippet, expected }) => {
      expect(referencesModuleSpecifier(snippet, spec)).toBe(expected);
    });
  });
});
