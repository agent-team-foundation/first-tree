import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME_PROVIDER_IDS, runtimeAuthProviderSchema } from "@first-tree/shared";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const clientSrc = join(here, "..");
const repoRoot = join(clientSrc, "..", "..", "..");

/** Quote tokens derived from the Zod ID set — auto-expands when a provider is added. */
const PROVIDER_LITERAL_TOKENS: readonly string[] = RUNTIME_PROVIDER_IDS.flatMap((id) => [`"${id}"`, `'${id}'`]);

/**
 * The narrower in-product auth set, derived from its own schema so that
 * extending `runtimeAuthProviderSchema` widens this guard in the same commit
 * that widens the driver registry. The full-provider tokens above still apply
 * to the daemon dispatcher; this set pins the enum the dispatcher keys on.
 */
const AUTH_PROVIDER_LITERAL_TOKENS: readonly string[] = runtimeAuthProviderSchema.options.flatMap((id) => [
  `"${id}"`,
  `'${id}'`,
  `\`${id}\``,
]);

const THIRD_PARTY_SDK_IMPORTS = [
  "@anthropic-ai/claude-agent-sdk",
  "@openai/codex-sdk",
  "@botiverse/kimi-code-sdk",
  "@agentclientprotocol/sdk",
] as const;

/** Unique composition roots allowed to name concrete providers / import adapters. */
const COMPOSITION_ALLOWLIST = new Set([
  "providers/auth-drivers.ts",
  "providers/builtin-registry.ts",
  "providers/builtin-probes.ts",
  "providers/skill-roots.ts",
]);

/** Generic modules that must stay provider-neutral after this foundation PR. */
const GUARDED_CLIENT_FILES = [
  "runtime/capabilities/index.ts",
  "runtime/managed-skills.ts",
  "runtime/runtime.ts",
  "runtime/handler.ts",
  "runtime/runtime-notice.ts",
  "runtime/session-manager.ts",
  "runtime/error-taxonomy.ts",
  "handlers/auth-error-hint.ts",
] as const;

/** Concrete provider binary / handler implementation modules (not support seams). */
const CONCRETE_PROVIDER_BINARY_IMPORT = /from ["']\.\/(?:codex|cursor|grok|pi|kimi|opencode)-binary\.js["']/;
const CONCRETE_PROVIDER_HANDLER_IMPORT = /from ["'].*handlers\/(claude-code|codex|cursor|grok|kimi-code|opencode|pi)/;

/** Live presentation consumers that must derive catalog-owned copy. */
const CATALOG_CONSUMER_FILES = [
  "packages/web/src/components/new-agent-dialog.tsx",
  "packages/web/src/features/agent-setup/use-computer-connection.ts",
  "packages/web/src/pages/onboarding/steps/step-create-agent.tsx",
  "packages/web/src/pages/onboarding/steps/step-connect-computer.tsx",
  "packages/web/src/pages/agent-detail/runtime-section.tsx",
  "packages/web/src/pages/clients/cards/shared/providers.ts",
  "packages/web/src/pages/clients/cards/shared/runtime-auth-view.ts",
  "packages/web/src/pages/clients/cards/shared/bound-agents-list.tsx",
  "packages/client/src/handlers/auth-error-hint.ts",
  "packages/client/src/runtime/runtime-notice.ts",
  "packages/client/src/runtime/capabilities/claude-code.ts",
  "packages/client/src/runtime/codex-binary.ts",
  "packages/client/src/runtime/cursor-binary.ts",
  "packages/client/src/runtime/grok-binary.ts",
  "packages/client/src/runtime/kimi-binary.ts",
  "packages/client/src/runtime/opencode-binary.ts",
  "packages/client/src/runtime/pi-binary.ts",
] as const;

function listFilesRecursive(root: string, predicate: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const st = statSync(path);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === "__tests__") continue;
      out.push(...listFilesRecursive(path, predicate));
    } else if (predicate(path)) {
      out.push(path);
    }
  }
  return out;
}

function containsAnyProviderLiteral(source: string): string | null {
  for (const token of PROVIDER_LITERAL_TOKENS) {
    if (source.includes(token)) return token;
  }
  return null;
}

describe("runtime provider architecture guard", () => {
  it("keeps migrated generic client files free of concrete provider literals and handler imports", () => {
    for (const rel of GUARDED_CLIENT_FILES) {
      const source = readFileSync(join(clientSrc, rel), "utf8");
      const relPosix = rel.replaceAll("\\", "/");

      if (COMPOSITION_ALLOWLIST.has(relPosix)) {
        continue;
      }

      if (relPosix === "runtime/managed-skills.ts") {
        expect(source).toContain("PROVIDER_SKILL_ROOTS");
        expect(source).not.toContain("getProviderSkillRoots");
        const hit = containsAnyProviderLiteral(source);
        // managed-skills may mention providers only via typed RuntimeProvider params;
        // forbid hard-coded skill-root maps and quoted provider ids.
        expect(hit, `${rel} must not hard-code provider literal ${hit}`).toBeNull();
        continue;
      }

      if (relPosix === "runtime/capabilities/index.ts") {
        expect(source).toContain("BUILTIN_PROVIDER_PROBES");
        expect(source).toContain("RUNTIME_PROVIDER_IDS");
        expect(source).not.toContain("peekInstalledBuiltinProviderRegistry");
        expect(source).not.toContain("installBuiltinProviderRegistry");
        const hit = containsAnyProviderLiteral(source);
        expect(hit, `${rel} must not contain ${hit}`).toBeNull();
        // Generic import rule: no concrete capability modules.
        expect(source).not.toMatch(/from "\.\/[^"]+\.js"/);
        continue;
      }

      if (relPosix === "handlers/auth-error-hint.ts") {
        expect(source).toContain("runtimeProviderChatAuthLoginPhrase");
        expect(source).toContain("runtimeProviderAuthOwnerLabel");
        expect(source).not.toMatch(/case ["']codex["']/);
        // Detection keywords may mention provider names in comments/strings;
        // forbid runtime-id branching for login/owner copy.
        expect(source).not.toMatch(/runtime\s*===\s*["']/);
        continue;
      }

      if (relPosix === "runtime/runtime-notice.ts") {
        expect(source).toContain("runtimeProviderLabel");
        expect(source).not.toMatch(/function providerLabel/);
        expect(source).not.toMatch(/case ["']codex["']:\s*return ["']Codex["']/);
        continue;
      }

      if (relPosix === "runtime/session-manager.ts") {
        // Session lifecycle owns provider-typed payloads but must not hard-code
        // a concrete runtime id (including the retired silent Claude-era default).
        const hit = containsAnyProviderLiteral(source);
        expect(hit, `${rel} must not hard-code provider literal ${hit}`).toBeNull();
        expect(source).not.toMatch(CONCRETE_PROVIDER_HANDLER_IMPORT);
        expect(source).toContain("runtimeProviderSchema");
        expect(source).toMatch(/runtimeProvider is required/);
        continue;
      }

      if (relPosix === "runtime/error-taxonomy.ts") {
        // Generic taxonomy consumes normalized binary-failure signals only.
        expect(source).toContain("recognizeProviderBinaryFailure");
        expect(source).toContain("provider-support/binary-failure");
        expect(source).not.toMatch(CONCRETE_PROVIDER_BINARY_IMPORT);
        expect(source).not.toMatch(CONCRETE_PROVIDER_HANDLER_IMPORT);
        expect(source).not.toMatch(/from ["']\.\/(?:codex|cursor|grok|pi)-binary/);
        continue;
      }

      expect(source).not.toMatch(CONCRETE_PROVIDER_HANDLER_IMPORT);
      if (relPosix === "runtime/handler.ts" || relPosix === "runtime/runtime.ts") {
        const hit = containsAnyProviderLiteral(source);
        expect(hit, `${rel} must not contain ${hit}`).toBeNull();
        expect(source).not.toContain("installHandlers");
      }
    }
  });

  it("keeps the provider-support binary-failure seam free of concrete provider implementations", () => {
    const rel = "runtime/provider-support/binary-failure.ts";
    const source = readFileSync(join(clientSrc, rel), "utf8");
    expect(source).toContain("recognizeProviderBinaryFailure");
    expect(source).toContain("PROVIDER_BINARY_FAILURE_REASON_CODES");
    expect(source).not.toMatch(CONCRETE_PROVIDER_BINARY_IMPORT);
    expect(source).not.toMatch(CONCRETE_PROVIDER_HANDLER_IMPORT);
    expect(source).not.toMatch(/from ["']\.\.\/(?:codex|cursor|grok|pi|kimi|opencode)-binary/);
    expect(source).not.toMatch(/from ["'].*handlers\//);
    // Match rules are owned here — binary modules must re-export, not duplicate.
    expect(source).toContain("isCodexBinaryMissingError");
    expect(source).toContain("isCursorBinaryMissingError");
    expect(source).toContain("isGrokBinaryMissingError");
    expect(source).toContain("isPiBinaryMissingError");
    expect(source).toContain("piProviderDetailBinaryMissingReasonCode");
    // Contextual Pi-detail entry must compose the strict matcher, not copy its phrases.
    expect(source).toMatch(
      /export function piProviderDetailBinaryMissingReasonCode\([\s\S]*?isPiBinaryMissingError\(detail\)/,
    );
    const contextualFn = source.slice(source.indexOf("export function piProviderDetailBinaryMissingReasonCode"));
    expect(contextualFn).not.toContain("pi cli is missing");
    expect(contextualFn).not.toContain("no pi binary");
    expect(contextualFn).toContain('includes("not found")');
    expect(contextualFn).toContain('includes("not installed")');
  });

  it("keeps binary modules as re-export delegates for missing-error matchers (single owner)", () => {
    for (const [file, symbol] of [
      ["runtime/codex-binary.ts", "isCodexBinaryMissingError"],
      ["runtime/cursor-binary.ts", "isCursorBinaryMissingError"],
      ["runtime/grok-binary.ts", "isGrokBinaryMissingError"],
      ["runtime/pi-binary.ts", "isPiBinaryMissingError"],
    ] as const) {
      const source = readFileSync(join(clientSrc, file), "utf8");
      expect(source, `${file} must re-export ${symbol} from provider-support`).toContain(
        'from "./provider-support/binary-failure.js"',
      );
      expect(source).toContain(symbol);
      // No second owner of the match tables / regexes.
      expect(source).not.toMatch(/BINARY_MISSING_PATTERNS/);
      expect(source).not.toMatch(/function is(?:Codex|Cursor|Grok|Pi)BinaryMissingError/);
    }
  });

  it("keeps production handlers from owning a second binary-missing matcher or reason-code table", () => {
    const handlersRoot = join(clientSrc, "handlers");
    const productionFiles = listFilesRecursive(handlersRoot, (p) => p.endsWith(".ts"));
    // Local regex / phrase tables that re-recognize provider binary absence.
    const secondOwnerMatchers = [
      /pi cli is missing/i,
      /no pi binary/i,
      /BINARY_MISSING_PATTERNS/,
      /codex runtime binary is missing/i,
      /unable to locate codex cli binaries/i,
      /cursor agent cli is missing/i,
      /grok build cli is missing/i,
    ] as const;
    const reasonLiterals = [
      '"codex_binary_missing"',
      '"cursor_binary_missing"',
      '"grok_binary_missing"',
      '"pi_binary_missing"',
      "'codex_binary_missing'",
      "'cursor_binary_missing'",
      "'grok_binary_missing'",
      "'pi_binary_missing'",
    ] as const;

    for (const file of productionFiles) {
      const source = readFileSync(file, "utf8");
      const rel = relative(clientSrc, file).replaceAll("\\", "/");
      for (const matcher of secondOwnerMatchers) {
        expect(source, `${rel} must not re-own binary-missing recognition (${matcher})`).not.toMatch(matcher);
      }
      for (const literal of reasonLiterals) {
        expect(
          source,
          `${rel} must not hard-code ${literal}; import PROVIDER_BINARY_FAILURE_REASON_CODES`,
        ).not.toContain(literal);
      }
    }

    // Pi sanitizer must consume the Pi-detail seam entry (not a local table).
    const piHandler = readFileSync(join(clientSrc, "handlers/pi/index.ts"), "utf8");
    expect(piHandler).toContain("piProviderDetailBinaryMissingReasonCode");
    expect(piHandler).toContain("provider-support/binary-failure");
    expect(piHandler).not.toContain("isPiBinaryMissingError");
    expect(piHandler).not.toContain("PROVIDER_BINARY_FAILURE_REASON_CODES");
  });

  it("names only the concrete composition file as the built-in handler factory root", () => {
    const registry = readFileSync(join(clientSrc, "providers/builtin-registry.ts"), "utf8");
    expect(registry).toContain("createBuiltinHandlerRegistry");
    expect(registry).toContain("Object.freeze");
    expect(registry).toContain("satisfies Record<RuntimeProvider, HandlerFactory>");
    expect(registry).not.toContain("installBuiltinProviderRegistry");
    expect(registry).not.toContain("installedRegistry");
    expect(registry).not.toContain("createBuiltinProviderRegistry");
    expect(registry).not.toContain("BuiltinProviderRegistry");
    expect(registry).not.toContain("builtinRegistryProviderIds");
    expect(registry).not.toContain("HANDLER_REGISTRY");
    expect(registry).not.toContain("registerHandler");
    expect(registry).not.toContain("registerBuiltinHandlers");
    expect(registry).not.toMatch(/probe\s*:/);
    expect(registry).not.toMatch(/skillRoot\s*:/);
    expect(registry).not.toMatch(/\{\s*factory\s*:/);

    const probes = readFileSync(join(clientSrc, "providers/builtin-probes.ts"), "utf8");
    const skills = readFileSync(join(clientSrc, "providers/skill-roots.ts"), "utf8");
    expect(probes).toContain("Object.freeze");
    expect(probes).not.toContain("builtinProbeProviderIds");
    expect(skills).toContain("Object.freeze");
    expect(skills).not.toContain("assertSkillRootsComplete");
  });

  it("forbids process-global handler registry symbols and keeps CLI on the package entry", () => {
    const forbidden = [
      "HANDLER_REGISTRY",
      "registerHandler",
      "getHandlerFactory",
      "hasHandler",
      "registerBuiltinHandlers",
    ] as const;
    const productionFiles = listFilesRecursive(clientSrc, (p) => p.endsWith(".ts") && !p.includes("__tests__"));
    for (const file of productionFiles) {
      const source = readFileSync(file, "utf8");
      const rel = relative(clientSrc, file).replaceAll("\\", "/");
      for (const symbol of forbidden) {
        expect(source, `${rel} must not retain ${symbol}`).not.toMatch(new RegExp(`\\b${symbol}\\b`));
      }
    }

    // handlers/index.ts was the old process-global registration root — gone.
    expect(() => readFileSync(join(clientSrc, "handlers/index.ts"), "utf8")).toThrow();

    const cliRuntime = readFileSync(join(repoRoot, "apps/cli/src/core/client-runtime.ts"), "utf8");
    expect(cliRuntime).toContain("createBuiltinHandlerRegistry");
    expect(cliRuntime).toContain("resolveAndLogClaudeExecutable");
    expect(cliRuntime).toContain('from "@first-tree/client"');
    expect(cliRuntime).not.toMatch(/from ["']@first-tree\/client\//);
    expect(cliRuntime).not.toMatch(/from ["']\.\.\/\.\.\/packages\/client/);
    for (const symbol of forbidden) {
      expect(cliRuntime, `CLI must not retain ${symbol}`).not.toMatch(new RegExp(`\\b${symbol}\\b`));
    }

    const agentRuntime = readFileSync(join(clientSrc, "runtime/runtime.ts"), "utf8");
    expect(agentRuntime).toContain("handlerFactories");
    expect(agentRuntime).not.toMatch(/\bgetHandlerFactory\b/);
    expect(agentRuntime).not.toMatch(/\bHANDLER_REGISTRY\b/);
  });

  it("keeps SessionManager/SessionRegistry off public barrels and out of CLI production", () => {
    const rootIndex = readFileSync(join(clientSrc, "index.ts"), "utf8");
    const runtimeIndex = readFileSync(join(clientSrc, "runtime/index.ts"), "utf8");
    for (const [label, source] of [
      ["packages/client/src/index.ts", rootIndex],
      ["packages/client/src/runtime/index.ts", runtimeIndex],
    ] as const) {
      expect(source, `${label} must not re-export SessionManager`).not.toMatch(/export\s*\{[^}]*\bSessionManager\b/);
      expect(source, `${label} must not re-export SessionRegistry`).not.toMatch(/export\s*\{[^}]*\bSessionRegistry\b/);
      expect(source, `${label} must expose cleanAgentWorkspaces`).toContain("cleanAgentWorkspaces");
      // contracts entry is provider-internal, not a new package public API / barrel export.
      expect(source, `${label} must not re-export runtime/contracts`).not.toMatch(/runtime\/contracts/);
    }

    const cliProduction = listFilesRecursive(join(repoRoot, "apps/cli/src"), (p) => {
      return p.endsWith(".ts") && !p.includes("__tests__") && !p.includes("/__mocks__/");
    });
    for (const file of cliProduction) {
      const source = readFileSync(file, "utf8");
      const rel = relative(repoRoot, file).replaceAll("\\", "/");
      expect(source, `${rel} must not import SessionRegistry`).not.toMatch(/\bSessionRegistry\b/);
      expect(source, `${rel} must not import SessionManager`).not.toMatch(/\bSessionManager\b/);
      expect(source, `${rel} must not call low-level cleanWorkspaces`).not.toMatch(/\bcleanWorkspaces\b/);
      expect(source, `${rel} must not deep-import client`).not.toMatch(/from ["']@first-tree\/client\//);
    }

    const cleanCommand = readFileSync(join(repoRoot, "apps/cli/src/commands/agent/workspace/clean.ts"), "utf8");
    expect(cleanCommand).toContain("cleanAgentWorkspaces");
    const clientImport = cleanCommand.match(/import\s*\{([^}]*)\}\s*from\s*["']@first-tree\/client["']/);
    expect(clientImport?.[1]?.replace(/\s+/g, " ").trim()).toBe("cleanAgentWorkspaces");
    expect(cleanCommand).toMatch(/const DEFAULT_WORKSPACE_TTL_MS = 7 \* 24 \* 60 \* 60 \* 1000/);
    expect(cleanCommand).not.toMatch(/\bfrom ["']node:fs["']/);
    expect(cleanCommand).not.toMatch(/\bfrom ["']node:path["']/);
    expect(cleanCommand).not.toContain("defaultDataDir");

    const maintenance = readFileSync(join(clientSrc, "runtime/workspace-maintenance.ts"), "utf8");
    const optionsMatch = maintenance.match(/export type CleanAgentWorkspacesOptions = \{([\s\S]*?)\n\};/);
    expect(optionsMatch?.[1], "CleanAgentWorkspacesOptions must be declared").toBeTruthy();
    const optionsBody = optionsMatch?.[1] ?? "";
    expect(optionsBody).toMatch(/\bagentName\?:/);
    expect(optionsBody).toMatch(/\bttlMs:/);
    expect(optionsBody).not.toMatch(/\bdataDir\b/);
    expect(optionsBody).not.toMatch(/\bcleanWorkspacesFn\b/);
    for (const [label, source] of [
      ["packages/client/src/index.ts", rootIndex],
      ["packages/client/src/runtime/index.ts", runtimeIndex],
    ] as const) {
      expect(source, `${label} must not re-export cleanAgentWorkspacesWithDeps`).not.toMatch(
        /\bcleanAgentWorkspacesWithDeps\b/,
      );
      expect(source, `${label} must not re-export CleanAgentWorkspacesTestDeps`).not.toMatch(
        /\bCleanAgentWorkspacesTestDeps\b/,
      );
    }

    const cliRuntime = readFileSync(join(repoRoot, "apps/cli/src/core/client-runtime.ts"), "utf8");
    expect(cliRuntime).toMatch(/resolveHandlerFactory[\s\S]*Object\.hasOwn/);
  });

  it("routes provider production contract imports through runtime/contracts only", () => {
    const contractSymbols = [
      "AgentHandler",
      "AgentIdentity",
      "DeliveryToken",
      "HandlerConfig",
      "HandlerFactory",
      "HandlerShutdownOptions",
      "SessionContext",
      "SessionMessage",
      "TurnConsumedErrorReason",
      "TurnOutcome",
      "noopDeliveryToken",
      "requireDeliveryToken",
      "LoginOutcome",
      "ReplayFenceEntry",
      "ReplayFenceWriter",
    ] as const;
    const forbiddenOwners = ["runtime/handler.js", "runtime/runtime-login.js", "runtime/replay-fence.js"] as const;

    const productionProviderFiles = [
      ...listFilesRecursive(join(clientSrc, "handlers"), (p) => p.endsWith(".ts") && !p.includes("__tests__")),
      ...listFilesRecursive(join(clientSrc, "providers"), (p) => p.endsWith(".ts") && !p.includes("__tests__")),
    ];

    for (const file of productionProviderFiles) {
      const source = readFileSync(file, "utf8");
      const rel = relative(clientSrc, file).replaceAll("\\", "/");
      for (const owner of forbiddenOwners) {
        expect(source, `${rel} must not deep-import ${owner}`).not.toMatch(
          new RegExp(`from\\s+["'][^"']*${owner.replace(".", "\\.")}["']`),
        );
      }
    }

    // Positive: at least the known contract consumers resolve contracts.js.
    const mustUseContracts = [
      "handlers/claude-code.ts",
      "handlers/claude-code-tui/index.ts",
      "handlers/codex/index.ts",
      "handlers/codex/sdk.ts",
      "handlers/codex/app-server/index.ts",
      "handlers/codex/turn-completion.ts",
      "handlers/cursor/index.ts",
      "handlers/grok/index.ts",
      "handlers/kimi-code.ts",
      "handlers/opencode/index.ts",
      "handlers/pi/index.ts",
      "handlers/turn-settlement.ts",
      "providers/builtin-registry.ts",
      "providers/auth-driver.ts",
    ] as const;
    for (const rel of mustUseContracts) {
      const source = readFileSync(join(clientSrc, rel), "utf8");
      expect(source, `${rel} must import runtime/contracts.js`).toMatch(/runtime\/contracts\.js/);
    }

    // contracts entry itself stays an allowlist and does not import forbidden owners as values beyond the declared re-exports.
    const contractsSource = readFileSync(join(clientSrc, "runtime/contracts.ts"), "utf8");
    expect(contractsSource).toContain('from "./handler.js"');
    expect(contractsSource).toContain('from "./runtime-login.js"');
    expect(contractsSource).toContain('from "./replay-fence.js"');
    for (const name of contractSymbols) {
      expect(contractsSource, `contracts allowlist must mention ${name}`).toMatch(new RegExp(`\\b${name}\\b`));
    }
    for (const banned of [
      "SessionManager",
      "SessionRegistry",
      "AgentSlot",
      "AgentRuntime",
      "ReplayFenceStore",
      "createBuiltinHandlerRegistry",
    ]) {
      expect(contractsSource, `contracts must not mention ${banned}`).not.toMatch(new RegExp(`\\b${banned}\\b`));
    }
  });

  it("keeps the runtime-auth driver projection in one frozen, schema-exhaustive composition root", () => {
    const drivers = readFileSync(join(clientSrc, "providers/auth-drivers.ts"), "utf8");
    expect(drivers).toContain("Object.freeze");
    // The key set is a projection of the narrow server-accepted auth enum, not
    // a second handwritten known-provider list.
    expect(drivers).toContain("satisfies Record<RuntimeAuthProvider, RuntimeAuthDriver>");
    for (const provider of runtimeAuthProviderSchema.options) {
      expect(drivers, `auth-drivers must register ${provider}`).toContain(provider);
    }
    // The contract itself stays provider-neutral.
    const contract = readFileSync(join(clientSrc, "providers/auth-driver.ts"), "utf8");
    expect(containsAnyProviderLiteral(contract)).toBeNull();
    // Method-shorthand type syntax (`resolveLogin(): ...`) is NOT readonly, so
    // the contract must declare its function members as readonly properties -
    // the compile-time half of the immutability guarantee that Object.freeze
    // on each production driver enforces at runtime.
    expect(contract).toContain("readonly resolveLogin");
    expect(contract).toContain("readonly reprobe");

    // Every provider-owned factory must freeze what it hands back, so the
    // guarantee holds regardless of how - or whether - it is composed into
    // RUNTIME_AUTH_DRIVERS.
    for (const file of ["claude-login.ts", "codex-login.ts", "cursor-login.ts", "grok-login.ts"]) {
      const source = readFileSync(join(clientSrc, "runtime", file), "utf8");
      expect(source, `${file} must freeze its returned driver`).toContain("Object.freeze");
    }
  });

  it("keeps the daemon runtime-auth dispatcher free of provider literals, imports and branches", () => {
    const rel = "apps/cli/src/core/runtime-auth-login.ts";
    const source = readFileSync(join(repoRoot, rel), "utf8");

    expect(source).toContain("RUNTIME_AUTH_DRIVERS");
    const hit = containsAnyProviderLiteral(source);
    expect(hit, `${rel} must not contain provider literal ${hit}`).toBeNull();
    // Same file, narrower lens: the auth enum the dispatcher keys on, derived
    // from its own schema so a new in-product target cannot widen the registry
    // without widening this guard.
    for (const token of AUTH_PROVIDER_LITERAL_TOKENS) {
      expect(source, `${rel} must not contain auth provider literal ${token}`).not.toContain(token);
    }
    for (const provider of runtimeAuthProviderSchema.options) {
      expect(source, `${rel} must not branch on ${provider}`).not.toMatch(
        new RegExp(`(===|case)\\s*["']${provider}["']`),
      );
    }
    // No provider-specific resolver / probe / browser-login imports remain.
    expect(source).not.toMatch(/\b(resolve|probe|run)(Codex|Claude|Cursor|Grok)\w*/);
    // Published failure text goes through the shared redaction boundary.
    expect(source).toContain("redactErrorPreview");
    expect(source).toContain("RUNTIME_AUTH_ERROR_MAX_LEN");
  });

  it("keeps provider login output bounded and incrementally scanned", () => {
    const source = readFileSync(join(clientSrc, "runtime/runtime-login.ts"), "utf8");
    expect(source).toContain("createAuthUrlScanner");
    expect(source).toContain("AUTH_URL_TOKEN_MAX");
    expect(source).toContain("LOGIN_STDERR_TAIL_MAX");
    // No full-output accumulation, and no full-buffer handoff to consumers.
    expect(source).not.toMatch(/\bbuffer\s*\+=/);
    expect(source).not.toMatch(/onOutput\?\.\([^)]*,/);
    // `pendingAuth.authUrl` is a structured field that never itself passes
    // through redactErrorPreview, so URL candidacy is the only gate that
    // keeps a credential-bearing string (proxy URL, redirect echo, a vendor
    // token under a neutral key, ...) out of the capability snapshot. It must
    // delegate to that exact sanitizer rather than re-check a subset of its
    // rules (a partial reimplementation would fall behind the moment that
    // helper gains a new detection rule), and it must reject a bad candidate
    // outright rather than rewrite it.
    expect(source).toContain("redactErrorPreview");
    expect(source).toContain("hasCredentialShape");
  });

  it("keeps third-party provider SDKs out of shared and web packages", () => {
    const sharedSrc = join(repoRoot, "packages/shared/src");
    const webSrc = join(repoRoot, "packages/web/src");
    const files = [
      ...listFilesRecursive(sharedSrc, (p) => p.endsWith(".ts") || p.endsWith(".tsx")),
      ...listFilesRecursive(webSrc, (p) => p.endsWith(".ts") || p.endsWith(".tsx")),
    ];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const sdk of THIRD_PARTY_SDK_IMPORTS) {
        expect(source, `${relative(repoRoot, file)} must not import ${sdk}`).not.toContain(`from "${sdk}"`);
        expect(source, `${relative(repoRoot, file)} must not import ${sdk}`).not.toContain(`from '${sdk}'`);
      }
    }
  });

  it("keeps live catalog consumers on shared helpers (not parallel switches)", () => {
    const providersTs = readFileSync(
      join(repoRoot, "packages/web/src/pages/clients/cards/shared/providers.ts"),
      "utf8",
    );
    expect(providersTs).toContain("RUNTIME_PROVIDER_CATALOG");
    expect(providersTs).toContain("enabledRuntimeProviders");
    expect(providersTs).toContain("runtimeProviderInstallCommand");
    expect(providersTs).toContain("runtimeProviderInteractiveLoginCue");
    expect(providersTs).toContain("runtimeProviderShowsHostLoginOnSetup");
    expect(providersTs).toContain("runtimeProviderComputerSetupCommand");
    expect(providersTs).not.toContain("runtimeProviderInstallLoginCommand");
    expect(providersTs).toContain("recordByRuntimeProvider");
    expect(providersTs).toContain('case "codex"');
    expect(providersTs).toContain("const _exhaustive: never = provider");
    expect(providersTs).not.toContain("Install the OpenAI Codex CLI");
    expect(providersTs).not.toMatch(
      /export const PROVIDER_LABEL: Record<RuntimeProvider, string> = \{\s*"claude-code":/,
    );

    for (const rel of CATALOG_CONSUMER_FILES) {
      const source = readFileSync(join(repoRoot, rel), "utf8");
      if (rel.endsWith("new-agent-dialog.tsx")) {
        expect(source).toContain("pickPreferredRuntimeProvider");
        expect(source).toContain("enabledOkRuntimeProviders");
        expect(source).toContain("runtimeProviderLabel");
        expect(source).toContain("PREFERRED_RUNTIME_PROVIDER");
        expect(source).not.toContain("Object.entries(activeCapabilities)");
        expect(source).not.toContain('provider === "claude-code"');
        expect(source).not.toContain('"claude-code"');
        expect(source).not.toMatch(/function prettyRuntimeLabel/);
        expect(source).not.toMatch(/function asRuntimeProvider/);
      }
      if (rel.endsWith("use-computer-connection.ts")) {
        expect(source).toContain("pickPreferredRuntimeProvider");
        expect(source).toContain("enabledOkRuntimeProviders");
        expect(source).not.toContain("Object.entries(activeCapabilities)");
        expect(source).not.toMatch(/Object\.entries\([^)]*capabilities/);
        expect(source).not.toMatch(/function pickPreferredRuntime/);
        expect(source).not.toContain('"claude-code"');
        expect(source).not.toContain('"codex"');
      }
      if (rel.endsWith("step-create-agent.tsx") || rel.endsWith("step-connect-computer.tsx")) {
        expect(source).toMatch(/from "@first-tree\/shared"/);
        expect(source).toContain("runtimeProviderLabel");
        expect(source).not.toContain("clients/cards/shared/providers");
        expect(source).not.toContain("PROVIDER_LABEL");
        expect(source).not.toContain("Object.entries(");
        expect(source).not.toMatch(/r === ["']claude-code["']/);
        expect(source).not.toContain('"claude-code"');
        expect(source).not.toMatch(/function pickPreferred/);
      }
      if (rel.endsWith("bound-agents-list.tsx")) {
        expect(source).toContain("asRuntimeProvider");
        expect(source).toContain("runtimeProviderLabel");
        expect(source).not.toContain("Object.values(RUNTIME_PROVIDERS)");
        expect(source).not.toContain("KNOWN_RUNTIME_PROVIDERS");
        expect(source).not.toContain("PROVIDER_LABEL");
      }
      if (rel.endsWith("runtime-section.tsx")) {
        expect(source).toContain("runtimeProviderLabel");
        expect(source).not.toMatch(/const RUNTIME_NAME/);
      }
      if (rel.endsWith("runtime-auth-view.ts")) {
        expect(source).toContain("runtimeProviderInProductAuthTarget");
        expect(source).not.toContain("runtimeProviderAuthRecovery");
        const hit = containsAnyProviderLiteral(source);
        expect(hit, `${rel} must not hard-code auth target ${hit}`).toBeNull();
      }
      if (rel.endsWith("auth-error-hint.ts")) {
        expect(source).toContain("runtimeProviderChatAuthLoginPhrase");
        expect(source).toContain("runtimeProviderAuthOwnerLabel");
      }
      if (rel.endsWith("runtime-notice.ts")) {
        expect(source).toContain("runtimeProviderLabel");
      }
      if (rel.endsWith("cursor-binary.ts") || rel.endsWith("grok-binary.ts")) {
        expect(source).toMatch(/from "@first-tree\/shared"/);
        expect(source).toContain("INSTALL_COMMAND");
      }
      if (rel.endsWith("opencode-binary.ts")) {
        expect(source).toContain("OPENCODE_MINIMUM_VERSION");
        expect(source).toContain("runtimeProviderInstallCommand");
      }
      if (rel.endsWith("pi-binary.ts")) {
        expect(source).toContain("runtimeProviderInstallCommand");
        expect(source).toContain("runtimeProviderInteractiveLoginCue");
        expect(source).not.toContain("running `pi` and entering `/login`");
        expect(source).not.toContain("`pi` and enter `/login`");
      }
      if (rel.endsWith("claude-code.ts")) {
        expect(source).toContain("runtimeProviderInstallCommand");
        expect(source).toContain("runtimeProviderLoginCommand");
        expect(source).toContain("daemon install-claude");
        expect(source).not.toContain("npm install -g @anthropic-ai/claude-code");
        expect(source).not.toContain("then run `claude auth login`");
      }
      if (rel.endsWith("codex-binary.ts")) {
        expect(source).toContain("runtimeProviderInstallCommand");
        expect(source).toContain("runtimeProviderLoginCommand");
        expect(source).toContain("daemon install-codex");
        expect(source).not.toContain("npm install -g @openai/codex");
        expect(source).not.toContain("then run `codex login`");
      }
      if (rel.endsWith("kimi-binary.ts")) {
        expect(source).toContain("KIMI_NPM_PACKAGE");
        expect(source).toContain("runtimeProviderInstallCommand");
        expect(source).toContain("runtimeProviderInteractiveLoginCue");
        expect(source).not.toContain('KIMI_CLI_PACKAGE = "@moonshot-ai/kimi-code"');
        expect(source).not.toMatch(/npm install -g \$\{KIMI_CLI_PACKAGE\}/);
        expect(source).not.toContain("then run `kimi` and enter `/login`");
      }
      if (rel.endsWith("providers.ts")) {
        expect(source).not.toContain("@moonshot-ai/kimi-code");
        expect(source).not.toContain("@earendil-works/pi-coding-agent");
        expect(source).not.toContain("Install the OpenAI Codex CLI");
        expect(source).not.toContain("run `kimi`, then `/login`");
        expect(source).not.toContain("run `pi` and enter `/login`");
      }
    }

    const activityTs = readFileSync(join(repoRoot, "packages/web/src/api/activity.ts"), "utf8");
    expect(activityTs).toContain("RuntimeAuthStartRequest");
    expect(activityTs).not.toMatch(/provider:\s*RuntimeProvider/);
  });
});
