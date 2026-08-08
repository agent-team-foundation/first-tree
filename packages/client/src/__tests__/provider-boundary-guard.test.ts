import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME_PROVIDER_IDS, runtimeAuthProviderSchema } from "@first-tree/shared";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  PROVIDER_SUPPORT_EXPORT_ALLOWLISTS,
  TRANSITIONAL_PROVIDER_FAMILY_FILES,
} from "./provider-support-export-allowlists.js";

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
      expect(source, `${file} must re-export ${symbol} from provider-support index`).toContain(
        'from "./provider-support/index.js"',
      );
      expect(source).toContain(symbol);
      // No second owner of the match tables / regexes.
      expect(source).not.toMatch(/BINARY_MISSING_PATTERNS/);
      expect(source).not.toMatch(/function is(?:Codex|Cursor|Grok|Pi)BinaryMissingError/);
      // Fail closed: no deep provider-support group import.
      expect(source).not.toMatch(/provider-support\/binary-failure\.js/);
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
    expect(piHandler).toMatch(/runtime\/provider-support\/(?:index|binary-failure)/);
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
        expect(source).toMatch(/\b(?:pickPreferredRuntimeProvider|resolveRuntimeSelection)\b/);
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
        expect(source).toMatch(/\b(?:pickPreferredRuntimeProvider|resolveRuntimeSelection)\b/);
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

  it("fail-closes provider-side Runtime imports to contracts or provider-support/index only", () => {
    /**
     * Fail-closed classification for provider-side production code.
     *
     * Provider-side files: handlers/**, providers/**, and the exact
     * transitional provider-family modules listed in
     * TRANSITIONAL_PROVIDER_FAMILY_FILES. For any import that resolves into
     * `runtime/`, the only legal targets are:
     *   - runtime/contracts.js
     *   - runtime/provider-support/index.js
     *   - an exact transitional provider-owned module from that list
     * Every other runtime path — including provider-support/<group>.js and
     * newly named `*-login` / `*-binary` files — fails closed because it is
     * absent from the explicit allowlist.
     */
    const transitionalTargets = new Set(TRANSITIONAL_PROVIDER_FAMILY_FILES.map((rel) => rel.replace(/\.ts$/, ".js")));

    // Explicit list must stay in sync with on-disk transitional modules.
    for (const rel of TRANSITIONAL_PROVIDER_FAMILY_FILES) {
      expect(existsSync(join(clientSrc, rel)), `missing transitional file ${rel}`).toBe(true);
    }
    // Pattern-shaped newcomers are NOT automatically trusted.
    expect(transitionalTargets.has("runtime/brand-new-login.js")).toBe(false);
    expect(transitionalTargets.has("runtime/brand-new-binary.js")).toBe(false);

    function listProviderSideFiles(): string[] {
      return [
        ...listFilesRecursive(join(clientSrc, "handlers"), (p) => p.endsWith(".ts") && !p.includes("__tests__")),
        ...listFilesRecursive(join(clientSrc, "providers"), (p) => p.endsWith(".ts") && !p.includes("__tests__")),
        ...TRANSITIONAL_PROVIDER_FAMILY_FILES.map((rel) => join(clientSrc, rel)),
      ];
    }

    /** Resolve an import specifier from `fromFile` into a runtime/*.js path, or null. */
    function resolveRuntimeImport(fromFile: string, specifier: string): string | null {
      if (!specifier.endsWith(".js")) return null;
      if (specifier.startsWith("@") || specifier.startsWith("node:")) return null;
      const fromDir = dirname(fromFile);
      let absolute: string;
      if (specifier.startsWith(".")) {
        absolute = join(fromDir, specifier);
      } else if (specifier.includes("/runtime/")) {
        // unusual but tolerate
        absolute = join(clientSrc, specifier.slice(specifier.indexOf("runtime/")));
      } else {
        return null;
      }
      const rel = relative(clientSrc, absolute).replaceAll("\\", "/");
      if (!rel.startsWith("runtime/") || rel.includes("..")) return null;
      return rel;
    }

    /**
     * `ts.isImportCall` is @internal; a dynamic import is a CallExpression whose
     * callee is the bare `import` keyword.
     */
    function isDynamicImportCall(node: ts.Node): node is ts.CallExpression {
      return ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
    }

    /** String / no-substitution template literal module specifier, or null. */
    function literalModuleSpecifierText(node: ts.Expression | ts.LiteralTypeNode["literal"]): string | null {
      return ts.isStringLiteralLike(node) ? node.text : null;
    }

    /**
     * AST-level module references: ImportDeclaration (including bare
     * side-effect), ExportDeclaration re-exports, dynamic `import()`,
     * `import("…")` type queries (`ImportTypeNode`), external
     * `import x = require("…")` (`ImportEqualsDeclaration`), and executable
     * CommonJS loader calls — `require("…")`, immediate
     * `createRequire(…)("…")`, namespace `module.createRequire(…)("…")`,
     * aliased binders, and simple binder propagation (`const load = req`).
     * Direct binder calls are classified; `req.resolve(…)` package lookups are
     * not treated as module-edge loads. Unsupported createRequire shapes /
     * non-literal / unclassifiable forms are recorded so the production scan
     * fails closed instead of silently skipping them.
     */
    function extractModuleReferences(source: string): {
      literalSpecifiers: string[];
      hasUnresolvableModuleReference: boolean;
    } {
      const sourceFile = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const literalSpecifiers: string[] = [];
      let hasUnresolvableModuleReference = false;

      // Names that bind `createRequire` (import rename / local alias).
      const createRequireNames = new Set<string>(["createRequire"]);
      // `import * as ns from "node:module"` — `ns.createRequire` is supported.
      const nodeModuleNamespaces = new Set<string>();
      // Identifiers holding the function returned by `createRequire(...)`.
      // Free `require` is a binder source so `const load = require` propagates.
      const requireBinders = new Set<string>(["require"]);

      function isNodeModuleSpecifier(spec: string): boolean {
        return spec === "node:module" || spec === "module";
      }

      function recordLoaderSpecifier(arg: ts.Expression | undefined): void {
        if (!arg) {
          hasUnresolvableModuleReference = true;
          return;
        }
        const text = literalModuleSpecifierText(arg);
        if (text !== null) literalSpecifiers.push(text);
        else hasUnresolvableModuleReference = true;
      }

      function isNamespaceCreateRequireProp(expr: ts.Expression): boolean {
        if (ts.isPropertyAccessExpression(expr) && expr.name.text === "createRequire") {
          return ts.isIdentifier(expr.expression) && nodeModuleNamespaces.has(expr.expression.text);
        }
        if (
          ts.isElementAccessExpression(expr) &&
          expr.argumentExpression &&
          ts.isStringLiteralLike(expr.argumentExpression) &&
          expr.argumentExpression.text === "createRequire"
        ) {
          return ts.isIdentifier(expr.expression) && nodeModuleNamespaces.has(expr.expression.text);
        }
        return false;
      }

      /** Any `*.createRequire` / `*["createRequire"]` access, tracked or not. */
      function isCreateRequirePropertyAccess(expr: ts.Expression): boolean {
        if (ts.isPropertyAccessExpression(expr) && expr.name.text === "createRequire") return true;
        if (
          ts.isElementAccessExpression(expr) &&
          expr.argumentExpression &&
          ts.isStringLiteralLike(expr.argumentExpression) &&
          expr.argumentExpression.text === "createRequire"
        ) {
          return true;
        }
        return false;
      }

      /**
       * Classify a `*.createRequire` property/element access:
       * - tracked `import * as ns from "node:module"` receiver → supported
       * - any other receiver → unsupported escape (fail closed)
       */
      function classifyCreateRequirePropertyAccess(expr: ts.Expression): "tracked" | "untracked" | false {
        if (!isCreateRequirePropertyAccess(expr)) return false;
        return isNamespaceCreateRequireProp(expr) ? "tracked" : "untracked";
      }

      /**
       * `true` = known createRequire callee; `"unresolvable"` = `*.createRequire`
       * form that is not a tracked node:module namespace (fail closed);
       * `false` = not a createRequire callee.
       */
      function classifyCreateRequireCallee(expr: ts.Expression): true | false | "unresolvable" {
        if (ts.isIdentifier(expr) && createRequireNames.has(expr.text)) return true;
        const prop = classifyCreateRequirePropertyAccess(expr);
        if (prop === "tracked") return true;
        if (prop === "untracked") return "unresolvable";
        return false;
      }

      function isCreateRequireCall(expr: ts.Expression): boolean {
        return ts.isCallExpression(expr) && classifyCreateRequireCallee(expr.expression) === true;
      }

      function isRequireBinderAlias(expr: ts.Expression): boolean {
        return ts.isIdentifier(expr) && requireBinders.has(expr.text);
      }

      function isKnownBinderOrFactoryName(name: string): boolean {
        return requireBinders.has(name) || createRequireNames.has(name);
      }

      /**
       * Allowed uses of a known binder/factory identifier: direct call,
       * simple `const x = id` / `x = id` aliasing, and binder `.resolve` package
       * lookup. Any other reference (argument, property storage, destructure)
       * is an unsupported escape → fail closed.
       */
      function isAllowedBinderOrFactoryUse(id: ts.Identifier): boolean {
        const parent = id.parent;
        if (!parent) return false;
        // `import { createRequire }` / `import { createRequire as cr }`
        if (ts.isImportSpecifier(parent) && (parent.name === id || parent.propertyName === id)) return true;
        // Binding site: `const req = …` / `load = …` — the name itself is not an escape.
        if (ts.isVariableDeclaration(parent) && parent.name === id) return true;
        if (
          ts.isBinaryExpression(parent) &&
          parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          parent.left === id &&
          ts.isIdentifier(parent.left)
        ) {
          return true;
        }
        if (ts.isCallExpression(parent) && parent.expression === id) return true;
        if (ts.isVariableDeclaration(parent) && parent.initializer === id && ts.isIdentifier(parent.name)) return true;
        if (
          ts.isBinaryExpression(parent) &&
          parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          parent.right === id &&
          ts.isIdentifier(parent.left)
        ) {
          return true;
        }
        if (
          ts.isPropertyAccessExpression(parent) &&
          parent.expression === id &&
          parent.name.text === "resolve" &&
          requireBinders.has(id.text)
        ) {
          return true;
        }
        // Property-name token (`obj.createRequire`) is not a value reference to
        // the `createRequire` binding; namespace forms are handled separately.
        if (ts.isPropertyAccessExpression(parent) && parent.name === id) return true;
        return false;
      }

      function isAllowedNamespaceCreateRequireUse(prop: ts.Expression): boolean {
        const parent = prop.parent;
        if (!parent) return false;
        if (ts.isCallExpression(parent) && parent.expression === prop) return true;
        if (ts.isVariableDeclaration(parent) && parent.initializer === prop && ts.isIdentifier(parent.name))
          return true;
        if (
          ts.isBinaryExpression(parent) &&
          parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          parent.right === prop &&
          ts.isIdentifier(parent.left)
        ) {
          return true;
        }
        return false;
      }

      // Pass 1: collect namespaces, createRequire aliases, binders, and binder aliases.
      // Fixed-point so `const load = req` after `const req = createRequire(...)` propagates.
      function collectOnce(node: ts.Node): void {
        if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
          const spec = node.moduleSpecifier.text;
          if (node.importClause?.namedBindings) {
            if (ts.isNamedImports(node.importClause.namedBindings)) {
              for (const el of node.importClause.namedBindings.elements) {
                if ((el.propertyName?.text ?? el.name.text) === "createRequire") {
                  createRequireNames.add(el.name.text);
                }
              }
            } else if (ts.isNamespaceImport(node.importClause.namedBindings) && isNodeModuleSpecifier(spec)) {
              nodeModuleNamespaces.add(node.importClause.namedBindings.name.text);
            }
          }
        }

        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
          const name = node.name.text;
          const init = node.initializer;
          if (isCreateRequireCall(init) || isRequireBinderAlias(init)) {
            requireBinders.add(name);
          } else if (ts.isIdentifier(init) && createRequireNames.has(init.text)) {
            createRequireNames.add(name);
          } else if (isNamespaceCreateRequireProp(init)) {
            // Tracked namespace factory property alias: `const cr = ns.createRequire`
            createRequireNames.add(name);
          } else if (isCreateRequirePropertyAccess(init)) {
            // Untracked receiver property alias (default import / dynamic import / unknown)
            hasUnresolvableModuleReference = true;
          } else if (ts.isCallExpression(init) && classifyCreateRequireCallee(init.expression) === "unresolvable") {
            hasUnresolvableModuleReference = true;
          }
        } else if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(node.left)
        ) {
          const name = node.left.text;
          const init = node.right;
          if (isCreateRequireCall(init) || isRequireBinderAlias(init)) {
            requireBinders.add(name);
          } else if (ts.isIdentifier(init) && createRequireNames.has(init.text)) {
            createRequireNames.add(name);
          } else if (isNamespaceCreateRequireProp(init)) {
            createRequireNames.add(name);
          } else if (isCreateRequirePropertyAccess(init)) {
            hasUnresolvableModuleReference = true;
          } else if (ts.isCallExpression(init) && classifyCreateRequireCallee(init.expression) === "unresolvable") {
            hasUnresolvableModuleReference = true;
          }
        }
        ts.forEachChild(node, collectOnce);
      }

      let prevBinderCount = -1;
      let prevFactoryCount = -1;
      let prevNsCount = -1;
      while (
        requireBinders.size !== prevBinderCount ||
        createRequireNames.size !== prevFactoryCount ||
        nodeModuleNamespaces.size !== prevNsCount
      ) {
        prevBinderCount = requireBinders.size;
        prevFactoryCount = createRequireNames.size;
        prevNsCount = nodeModuleNamespaces.size;
        collectOnce(sourceFile);
      }

      function visit(node: ts.Node): void {
        if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
          literalSpecifiers.push(node.moduleSpecifier.text);
        } else if (
          ts.isExportDeclaration(node) &&
          node.moduleSpecifier &&
          ts.isStringLiteralLike(node.moduleSpecifier)
        ) {
          literalSpecifiers.push(node.moduleSpecifier.text);
        } else if (isDynamicImportCall(node)) {
          const [arg] = node.arguments;
          const text = arg ? literalModuleSpecifierText(arg) : null;
          if (text !== null) literalSpecifiers.push(text);
          else hasUnresolvableModuleReference = true;
        } else if (ts.isImportTypeNode(node)) {
          if (ts.isLiteralTypeNode(node.argument)) {
            const text = literalModuleSpecifierText(node.argument.literal);
            if (text !== null) literalSpecifiers.push(text);
            else hasUnresolvableModuleReference = true;
          } else {
            hasUnresolvableModuleReference = true;
          }
        } else if (ts.isImportEqualsDeclaration(node)) {
          if (ts.isExternalModuleReference(node.moduleReference)) {
            const text = literalModuleSpecifierText(node.moduleReference.expression);
            if (text !== null) literalSpecifiers.push(text);
            else hasUnresolvableModuleReference = true;
          }
        } else if (ts.isCallExpression(node)) {
          const callee = node.expression;
          if (ts.isCallExpression(callee)) {
            const kind = classifyCreateRequireCallee(callee.expression);
            if (kind === true) {
              recordLoaderSpecifier(node.arguments[0]);
            } else if (kind === "unresolvable") {
              hasUnresolvableModuleReference = true;
            }
          } else if (ts.isIdentifier(callee) && requireBinders.has(callee.text)) {
            recordLoaderSpecifier(node.arguments[0]);
          } else if (ts.isIdentifier(callee) && createRequireNames.has(callee.text)) {
            // Bare `createRequire(url)` factory call — not a module load by itself.
          } else {
            const kind = classifyCreateRequireCallee(callee);
            if (kind === "unresolvable") hasUnresolvableModuleReference = true;
          }
          for (const arg of node.arguments) {
            if (ts.isIdentifier(arg) && isKnownBinderOrFactoryName(arg.text)) {
              hasUnresolvableModuleReference = true;
            }
          }
        } else if (ts.isIdentifier(node) && isKnownBinderOrFactoryName(node.text)) {
          if (!isAllowedBinderOrFactoryUse(node)) {
            hasUnresolvableModuleReference = true;
          }
        } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
          const prop = classifyCreateRequirePropertyAccess(node);
          if (prop === "tracked") {
            if (!isAllowedNamespaceCreateRequireUse(node)) {
              hasUnresolvableModuleReference = true;
            }
          } else if (prop === "untracked") {
            // Untracked receiver `*.createRequire` — direct call or property alias.
            hasUnresolvableModuleReference = true;
          }
        }
        ts.forEachChild(node, visit);
      }

      visit(sourceFile);
      return { literalSpecifiers, hasUnresolvableModuleReference };
    }

    function classifyRuntimeImport(runtimeRel: string): "ok" | "forbidden" {
      if (runtimeRel === "runtime/contracts.js") return "ok";
      if (runtimeRel === "runtime/provider-support/index.js") return "ok";
      if (transitionalTargets.has(runtimeRel)) return "ok";
      return "forbidden";
    }

    const violations: string[] = [];
    const residualByClass = {
      contracts: [] as string[],
      providerSupportIndex: [] as string[],
      transitionalTarget: [] as string[],
      forbiddenRuntime: [] as string[],
    };

    for (const file of listProviderSideFiles()) {
      const source = readFileSync(file, "utf8");
      const rel = relative(clientSrc, file).replaceAll("\\", "/");
      const refs = extractModuleReferences(source);
      if (refs.hasUnresolvableModuleReference) {
        violations.push(
          `${rel} has a non-literal / unclassifiable module reference; provider-side Runtime edges must be statically classifiable (fail-closed)`,
        );
      }
      for (const spec of refs.literalSpecifiers) {
        const runtimeRel = resolveRuntimeImport(file, spec);
        if (!runtimeRel) continue;
        const verdict = classifyRuntimeImport(runtimeRel);
        if (verdict === "ok") {
          if (runtimeRel === "runtime/contracts.js") residualByClass.contracts.push(`${rel} -> ${runtimeRel}`);
          else if (runtimeRel === "runtime/provider-support/index.js")
            residualByClass.providerSupportIndex.push(`${rel} -> ${runtimeRel}`);
          else residualByClass.transitionalTarget.push(`${rel} -> ${runtimeRel}`);
        } else {
          residualByClass.forbiddenRuntime.push(`${rel} -> ${runtimeRel} (via ${spec})`);
          violations.push(`${rel} imports forbidden Runtime module ${runtimeRel} (specifier ${spec})`);
        }
      }
    }

    expect(violations, violations.join("\n")).toEqual([]);
    // Mechanically supported residual report for the review freeze note.
    expect(residualByClass.forbiddenRuntime).toEqual([]);
    expect(residualByClass.providerSupportIndex.length).toBeGreaterThan(0);

    // Negative fixtures: newly introduced Runtime owners / deep support paths fail closed.
    expect(classifyRuntimeImport("runtime/brand-new-owner.js")).toBe("forbidden");
    expect(classifyRuntimeImport("runtime/provider-support/preparation.js")).toBe("forbidden");
    expect(classifyRuntimeImport("runtime/provider-support/binary-failure.js")).toBe("forbidden");
    expect(classifyRuntimeImport("runtime/agent-io.js")).toBe("forbidden");
    expect(classifyRuntimeImport("runtime/install-locations.js")).toBe("forbidden");
    expect(classifyRuntimeImport("runtime/brand-new-login.js")).toBe("forbidden");
    expect(classifyRuntimeImport("runtime/brand-new-binary.js")).toBe("forbidden");

    const cursorHandler = join(clientSrc, "handlers/cursor/index.ts");
    function expectForbiddenRuntimeSpec(source: string, expectedSpec: string): void {
      const refs = extractModuleReferences(source);
      expect(refs.hasUnresolvableModuleReference).toBe(false);
      expect(refs.literalSpecifiers).toContain(expectedSpec);
      const resolved = resolveRuntimeImport(cursorHandler, expectedSpec);
      expect(resolved).toBe("runtime/brand-new-owner.js");
      expect(classifyRuntimeImport(resolved ?? "")).toBe("forbidden");
    }

    // Bare side-effect import (no bindings) must still be classified.
    expectForbiddenRuntimeSpec(`import "../../runtime/brand-new-owner.js";`, "../../runtime/brand-new-owner.js");

    // Literal dynamic import must still be classified.
    expectForbiddenRuntimeSpec(`await import("../../runtime/brand-new-owner.js");`, "../../runtime/brand-new-owner.js");

    // Import type query (`ImportTypeNode`) must still be classified.
    expectForbiddenRuntimeSpec(
      `type Hidden = import("../../runtime/brand-new-owner.js").Hidden;`,
      "../../runtime/brand-new-owner.js",
    );

    // External import-equals (`import x = require("…")`) must still be classified.
    expectForbiddenRuntimeSpec(
      `import Owner = require("../../runtime/brand-new-owner.js");`,
      "../../runtime/brand-new-owner.js",
    );

    // Immediate createRequire(…)("…") CommonJS load must still be classified.
    expectForbiddenRuntimeSpec(
      `import { createRequire } from "node:module";
       createRequire(import.meta.url)("../../runtime/brand-new-owner.js");`,
      "../../runtime/brand-new-owner.js",
    );

    // Aliased createRequire binder call must still be classified.
    expectForbiddenRuntimeSpec(
      `import { createRequire } from "node:module";
       const req = createRequire(import.meta.url);
       req("../../runtime/brand-new-owner.js");`,
      "../../runtime/brand-new-owner.js",
    );

    // Renamed createRequire import + binder call must still be classified.
    expectForbiddenRuntimeSpec(
      `import { createRequire as cr } from "node:module";
       const load = cr(import.meta.url);
       load("../../runtime/brand-new-owner.js");`,
      "../../runtime/brand-new-owner.js",
    );

    // Namespace import `import * as module from "node:module"` must still be classified.
    expectForbiddenRuntimeSpec(
      `import * as module from "node:module";
       const req = module.createRequire(import.meta.url);
       req("../../runtime/brand-new-owner.js");`,
      "../../runtime/brand-new-owner.js",
    );

    // Namespace import under a non-`module` local name (yzw-codex fixture).
    expectForbiddenRuntimeSpec(
      `import * as moduleApi from "node:module";
       const load = moduleApi.createRequire(import.meta.url);
       load("../../runtime/brand-new-owner.js");`,
      "../../runtime/brand-new-owner.js",
    );

    // Simple binder propagation (`const load = req`) must still be classified.
    expectForbiddenRuntimeSpec(
      `import { createRequire } from "node:module";
       const req = createRequire(import.meta.url);
       const load = req;
       load("../../runtime/brand-new-owner.js");`,
      "../../runtime/brand-new-owner.js",
    );

    // Free require("…") CommonJS load must still be classified.
    expectForbiddenRuntimeSpec(`require("../../runtime/brand-new-owner.js");`, "../../runtime/brand-new-owner.js");

    // Aliased / multiline static import continues to fail closed.
    const multilineFixture = `
      import {
        prepareManagedSession as prep,
        type ChatContext as Ctx,
      } from "../../runtime/agent-bootstrap.js";
    `;
    const multilineRefs = extractModuleReferences(multilineFixture);
    expect(multilineRefs.literalSpecifiers).toEqual(["../../runtime/agent-bootstrap.js"]);
    const resolvedMultiline = resolveRuntimeImport(cursorHandler, multilineRefs.literalSpecifiers[0] ?? "");
    expect(resolvedMultiline).toBe("runtime/agent-bootstrap.js");
    expect(classifyRuntimeImport(resolvedMultiline ?? "")).toBe("forbidden");

    // Non-literal dynamic import cannot be classified → fail closed.
    const unresolvableDynamic = extractModuleReferences(`const p = "./x.js"; await import(p);`);
    expect(unresolvableDynamic.hasUnresolvableModuleReference).toBe(true);
    expect(unresolvableDynamic.literalSpecifiers).toEqual([]);

    // Non-literal import-equals require() → fail closed.
    const unresolvableEquals = extractModuleReferences(`import Owner = require(someVar);`);
    expect(unresolvableEquals.hasUnresolvableModuleReference).toBe(true);
    expect(unresolvableEquals.literalSpecifiers).toEqual([]);

    // Non-literal createRequire binder call → fail closed.
    const unresolvableCjs = extractModuleReferences(`
      import { createRequire } from "node:module";
      const req = createRequire(import.meta.url);
      req(someVar);
    `);
    expect(unresolvableCjs.hasUnresolvableModuleReference).toBe(true);
    expect(unresolvableCjs.literalSpecifiers).toEqual(["node:module"]);

    // Unsupported `*.createRequire` (not a tracked node:module namespace) → fail closed.
    const unresolvableNsCreateRequire = extractModuleReferences(`
      const req = someApi.createRequire(import.meta.url);
      req("../../runtime/brand-new-owner.js");
    `);
    expect(unresolvableNsCreateRequire.hasUnresolvableModuleReference).toBe(true);

    // Default-import property alias is untracked → fail closed (not namespace import).
    const defaultImportPropAlias = extractModuleReferences(`
      import moduleApi from "node:module";
      const cr = moduleApi.createRequire;
      const load = cr(import.meta.url);
      load("../../runtime/brand-new-owner.js");
    `);
    expect(defaultImportPropAlias.hasUnresolvableModuleReference).toBe(true);
    expect(defaultImportPropAlias.literalSpecifiers).toEqual(["node:module"]);

    // Dynamic-import namespace property alias is untracked → fail closed.
    const dynamicImportPropAlias = extractModuleReferences(`
      const moduleApi = await import("node:module");
      const cr = moduleApi.createRequire;
      const load = cr(import.meta.url);
      load("../../runtime/brand-new-owner.js");
    `);
    expect(dynamicImportPropAlias.hasUnresolvableModuleReference).toBe(true);
    expect(dynamicImportPropAlias.literalSpecifiers).toEqual(["node:module"]);

    // Free `require` alias must still classify the literal load.
    expectForbiddenRuntimeSpec(
      `const load = require;
       load("../../runtime/brand-new-owner.js");`,
      "../../runtime/brand-new-owner.js",
    );

    // Namespace factory property alias must still classify the binder load.
    expectForbiddenRuntimeSpec(
      `import * as moduleApi from "node:module";
       const cr = moduleApi.createRequire;
       const load = cr(import.meta.url);
       load("../../runtime/brand-new-owner.js");`,
      "../../runtime/brand-new-owner.js",
    );

    // Property storage of a known binder → fail closed (unsupported escape).
    const propEscape = extractModuleReferences(`
      import { createRequire } from "node:module";
      const req = createRequire(import.meta.url);
      const box = { load: req };
      box.load("../../runtime/brand-new-owner.js");
    `);
    expect(propEscape.hasUnresolvableModuleReference).toBe(true);

    // Passing a known binder as a call argument → fail closed.
    const argEscape = extractModuleReferences(`
      import { createRequire } from "node:module";
      const req = createRequire(import.meta.url);
      consume(req);
    `);
    expect(argEscape.hasUnresolvableModuleReference).toBe(true);

    // Package-resolution `.resolve(...)` is not a direct module-edge load.
    const resolveOnly = extractModuleReferences(`
      import { createRequire } from "node:module";
      const req = createRequire(import.meta.url);
      req.resolve("../../runtime/brand-new-owner.js");
    `);
    expect(resolveOnly.hasUnresolvableModuleReference).toBe(false);
    expect(resolveOnly.literalSpecifiers).toEqual(["node:module"]);

    const mustUseProviderSupport = [
      "handlers/claude-code.ts",
      "handlers/claude-code-tui/index.ts",
      "handlers/codex/sdk.ts",
      "handlers/codex/app-server/index.ts",
      "handlers/cursor/index.ts",
      "handlers/grok/index.ts",
      "handlers/kimi-code.ts",
      "handlers/opencode/index.ts",
      "handlers/pi/index.ts",
    ] as const;
    for (const rel of mustUseProviderSupport) {
      const source = readFileSync(join(clientSrc, rel), "utf8");
      expect(source, `${rel} must import provider-support/index.js`).toMatch(/runtime\/provider-support\/index\.js/);
      expect(source, `${rel} must call prepareManagedSession`).toMatch(/\bprepareManagedSession\b/);
      expect(source, `${rel} must not call acquireAgentHome directly`).not.toMatch(/\bacquireAgentHome\s*\(/);
      expect(source, `${rel} must not call markWorkspaceInitComplete directly`).not.toMatch(
        /\bmarkWorkspaceInitComplete\s*\(/,
      );
      expect(source, `${rel} must not call ensureAgentBootstrap directly`).not.toMatch(/\bensureAgentBootstrap\s*\(/);
      expect(source, `${rel} must not deep-import provider-support groups`).not.toMatch(
        /provider-support\/(?!index\.js)[\w-]+\.js/,
      );
    }
  });

  it("pins provider-support entry and group modules to exact AST export allowlists", () => {
    /**
     * Exact `(kind, exportedName, originalName, sourceModule)` tuples — not
     * substring / banned-name predicates. Adding any seam symbol requires an
     * explicit allowlist edit in provider-support-export-allowlists.ts.
     */
    function hasExportKeyword(node: ts.Node): boolean {
      return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    }

    function hasDefaultKeyword(node: ts.Node): boolean {
      return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    }

    function extractExportTuples(source: string): {
      tuples: string[];
      violations: string[];
    } {
      const sourceFile = ts.createSourceFile("exports.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const tuples: string[] = [];
      const violations: string[] = [];

      for (const node of sourceFile.statements) {
        let handled = false;

        if (ts.isExportDeclaration(node)) {
          handled = true;
          if (node.moduleSpecifier && !ts.isStringLiteralLike(node.moduleSpecifier)) {
            violations.push("non-literal export module specifier");
          } else if (!node.exportClause && node.moduleSpecifier) {
            violations.push(
              `export * from ${ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text : "?"}`,
            );
          } else if (node.exportClause && ts.isNamespaceExport(node.exportClause)) {
            violations.push("export * as namespace");
          } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
            const sourceModule =
              node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)
                ? node.moduleSpecifier.text
                : "<local>";
            for (const el of node.exportClause.elements) {
              const kind = node.isTypeOnly || el.isTypeOnly ? "type" : "value";
              const exportedName = el.name.text;
              const originalName = el.propertyName ? el.propertyName.text : exportedName;
              tuples.push(`${kind}|${exportedName}|${originalName}|${sourceModule}`);
            }
          } else {
            violations.push("unsupported ExportDeclaration shape");
          }
        } else if (ts.isExportAssignment(node)) {
          handled = true;
          violations.push(node.isExportEquals ? "export =" : "export default");
        } else if (ts.isFunctionDeclaration(node) && hasExportKeyword(node)) {
          handled = true;
          if (hasDefaultKeyword(node)) {
            violations.push("export default function");
          } else if (!node.name) {
            violations.push("unnamed exported function");
          } else {
            tuples.push(`value|${node.name.text}|${node.name.text}|<local>`);
          }
        } else if (ts.isClassDeclaration(node) && hasExportKeyword(node)) {
          // Local class exports are unused on the seam today — fail closed rather
          // than inventing an undocumented tuple kind.
          handled = true;
          if (hasDefaultKeyword(node)) {
            violations.push("export default class");
          } else {
            violations.push("unsupported exported local class");
          }
        } else if (ts.isInterfaceDeclaration(node) && hasExportKeyword(node)) {
          handled = true;
          if (hasDefaultKeyword(node)) {
            violations.push("export default interface");
          } else {
            tuples.push(`type|${node.name.text}|${node.name.text}|<local>`);
          }
        } else if (ts.isTypeAliasDeclaration(node) && hasExportKeyword(node)) {
          handled = true;
          if (hasDefaultKeyword(node)) {
            violations.push("export default type alias");
          } else {
            tuples.push(`type|${node.name.text}|${node.name.text}|<local>`);
          }
        } else if (ts.isEnumDeclaration(node) && hasExportKeyword(node)) {
          handled = true;
          if (hasDefaultKeyword(node)) {
            violations.push("export default enum");
          } else {
            violations.push("unsupported exported local enum");
          }
        } else if (ts.isVariableStatement(node) && hasExportKeyword(node)) {
          handled = true;
          if (hasDefaultKeyword(node)) {
            violations.push("export default variable");
          } else {
            for (const decl of node.declarationList.declarations) {
              if (ts.isIdentifier(decl.name)) {
                tuples.push(`value|${decl.name.text}|${decl.name.text}|<local>`);
              } else {
                violations.push("exported binding pattern");
              }
            }
          }
        } else if (ts.isModuleDeclaration(node) && hasExportKeyword(node)) {
          handled = true;
          violations.push("exported namespace/module");
        } else if (ts.isImportEqualsDeclaration(node) && hasExportKeyword(node)) {
          handled = true;
          violations.push("unsupported export import equals");
        } else if (ts.isNamespaceExportDeclaration(node)) {
          // `export as namespace Foo;` — canHaveModifiers is false, so the
          // ExportKeyword catch-all would miss it.
          handled = true;
          violations.push("unsupported export as namespace");
        }

        // Catch-all: any ExportKeyword statement that no supported branch owned.
        if (!handled && hasExportKeyword(node)) {
          violations.push(`unsupported exported declaration ${ts.SyntaxKind[node.kind]}`);
        }
      }

      return { tuples: [...tuples].sort(), violations };
    }

    const supportDir = join(clientSrc, "runtime/provider-support");
    let totalTuples = 0;
    for (const [relKey, expected] of Object.entries(PROVIDER_SUPPORT_EXPORT_ALLOWLISTS)) {
      const fileRel = `runtime/provider-support/${relKey}.ts`;
      const absolute = join(supportDir, `${relKey}.ts`);
      expect(existsSync(absolute), `missing support module ${fileRel}`).toBe(true);
      const source = readFileSync(absolute, "utf8");
      const { tuples, violations } = extractExportTuples(source);
      expect(violations, `${fileRel} export-shape violations:\n${violations.join("\n")}`).toEqual([]);
      expect(tuples, `${fileRel} export tuple mismatch`).toEqual([...expected]);
      totalTuples += tuples.length;
    }
    expect(totalTuples).toBeGreaterThan(100);

    // Negative: registry owner named re-export on the entry must diverge.
    const entrySource = readFileSync(join(supportDir, "index.ts"), "utf8");
    const registryInjection = `${entrySource}\nexport { getChildProcessRegistry } from "../child-process-registry.js";\n`;
    const injected = extractExportTuples(registryInjection);
    expect(injected.violations).toEqual([]);
    expect(injected.tuples).not.toEqual([...PROVIDER_SUPPORT_EXPORT_ALLOWLISTS.index]);
    expect(injected.tuples).toContain(
      "value|getChildProcessRegistry|getChildProcessRegistry|../child-process-registry.js",
    );

    // Negative: extra local symbol on a group module must diverge.
    const prepSource = readFileSync(join(supportDir, "preparation.ts"), "utf8");
    const sneakyLocal = `${prepSource}\nexport function sneakyExtraHelper(): void {}\n`;
    const sneaky = extractExportTuples(sneakyLocal);
    expect(sneaky.violations).toEqual([]);
    expect(sneaky.tuples).not.toEqual([...PROVIDER_SUPPORT_EXPORT_ALLOWLISTS.preparation]);
    expect(sneaky.tuples).toContain("value|sneakyExtraHelper|sneakyExtraHelper|<local>");

    // Negative: export * fail-closed.
    const starExport = extractExportTuples(`export * from "../child-process-registry.js";`);
    expect(starExport.violations).toContain("export * from ../child-process-registry.js");

    // Negative: default exports must not be mistaken for named local tuples.
    expect(extractExportTuples(`export default function namedDefault() {}`).violations).toContain(
      "export default function",
    );
    expect(extractExportTuples(`export default class NamedDefault {}`).violations).toContain("export default class");

    // Negative: export import equals is unsupported (catch-all / dedicated branch).
    expect(extractExportTuples(`export import Owner = require("../child-process-registry.js");`).violations).toContain(
      "unsupported export import equals",
    );

    // Negative: unsupported local class/enum fail closed (not silently tupled).
    expect(extractExportTuples(`export class LocalOwner {}`).violations).toContain("unsupported exported local class");
    expect(extractExportTuples(`export enum LocalKind { A }`).violations).toContain("unsupported exported local enum");

    // Negative: `export as namespace` is NamespaceExportDeclaration (no modifiers).
    expect(extractExportTuples(`export as namespace Sneaky;`).violations).toContain("unsupported export as namespace");
  });

  it("keeps provider-support value re-exports identical to their owning group modules", async () => {
    const entry = await import("../runtime/provider-support/index.js");
    const preparation = await import("../runtime/provider-support/preparation.js");
    const hostRuntime = await import("../runtime/provider-support/host-runtime.js");
    const turnInput = await import("../runtime/provider-support/turn-input.js");
    const failurePolicy = await import("../runtime/provider-support/failure-policy.js");

    expect(entry.prepareManagedSession).toBe(preparation.prepareManagedSession);
    expect(entry.projectManagedWorkspace).toBe(preparation.projectManagedWorkspace);
    expect(entry.wellKnownBinDirs).toBe(hostRuntime.wellKnownBinDirs);
    expect(entry.acquireWorkspaceFileLock).toBe(hostRuntime.acquireWorkspaceFileLock);
    expect(entry.InputController).toBe(turnInput.InputController);
    expect(entry.recognizeProviderBinaryFailure).toBe(failurePolicy.recognizeProviderBinaryFailure);
  });

  it("keeps generic Runtime free of handler and concrete provider implementation imports", () => {
    const runtimeRoot = join(clientSrc, "runtime");
    // Scan the full runtime tree, including capabilities/; only exact
    // transitional paths are exempt — basename / directory patterns are not.
    const runtimeFiles = listFilesRecursive(runtimeRoot, (p) => p.endsWith(".ts") && !p.includes("__tests__"));
    const transitionalRelPaths = new Set<string>(TRANSITIONAL_PROVIDER_FAMILY_FILES);

    function isExplicitTransitionalProviderFamilyPath(rel: string): boolean {
      return transitionalRelPaths.has(rel);
    }

    expect(isExplicitTransitionalProviderFamilyPath("runtime/capabilities/index.ts")).toBe(true);
    expect(isExplicitTransitionalProviderFamilyPath("runtime/brand-new/index.ts")).toBe(false);
    expect(isExplicitTransitionalProviderFamilyPath("runtime/capabilities/brand-new.ts")).toBe(false);

    for (const file of runtimeFiles) {
      const rel = relative(clientSrc, file).replaceAll("\\", "/");
      if (isExplicitTransitionalProviderFamilyPath(rel)) continue;
      const source = readFileSync(file, "utf8");
      expect(source, `${rel} must not import handlers/**`).not.toMatch(CONCRETE_PROVIDER_HANDLER_IMPORT);
      if (!rel.includes("provider-support/binary-failure")) {
        // Generic runtime (except the binary-failure seam's reason-code tables)
        // must not deep-import concrete provider binary modules.
        expect(source, `${rel} must not import concrete provider binaries`).not.toMatch(
          CONCRETE_PROVIDER_BINARY_IMPORT,
        );
      }
    }
  });
});
