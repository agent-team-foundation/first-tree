import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { ProviderModelCatalog, ProviderModelOption, RuntimeProvider } from "@first-tree/shared";
import { findCursorExecutableOnPath } from "../cursor-binary.js";
import { runCommand } from "./launch-probe.js";

/** Ceiling for `agent models` — account catalog fetch can be network-bound. */
const CURSOR_MODELS_TIMEOUT_MS = 20_000;

export type DiscoverModelsDeps = {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  findCursorBinary?: (env?: Record<string, string | undefined>) => string | null;
  runCursorModels?: (binary: string, env: NodeJS.ProcessEnv) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
  readKimiConfig?: () => Promise<string | null>;
  kimiConfigPath?: string;
};

function fetchedAt(deps: DiscoverModelsDeps): string {
  return (deps.now ?? (() => new Date()))().toISOString();
}

function unavailable(provider: RuntimeProvider, error: string, deps: DiscoverModelsDeps): ProviderModelCatalog {
  return {
    provider,
    models: [],
    defaultModelId: null,
    fetchedAt: fetchedAt(deps),
    source: "unavailable",
    error,
  };
}

/**
 * Parse `agent models` / `agent --list-models` text:
 *   Available models
 *   auto - Auto (default)
 *   gpt-5.2 - GPT-5.2
 */
export function parseCursorModelsOutput(stdout: string): {
  models: ProviderModelOption[];
  defaultModelId: string | null;
} {
  const models: ProviderModelOption[] = [];
  let defaultModelId: string | null = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^available models$/i.test(line)) continue;
    const match = /^(\S+)\s+-\s+(.+)$/.exec(line);
    if (!match) continue;
    const id = match[1]!;
    const label = match[2]!.trim();
    const isDefault = /\(default\)/i.test(label);
    if (isDefault) defaultModelId = id;
    models.push({
      id,
      label: label.replace(/\s*\(default\)\s*/i, "").trim() || id,
      ...(isDefault ? { isDefault: true, hint: "default" } : {}),
    });
  }
  return { models, defaultModelId };
}

/**
 * Minimal TOML extract for Kimi's `~/.kimi-code/config.toml`:
 *   default_model = "kimi-code/k3"
 *   [models."kimi-code/k3"]
 *   display_name = "K3"
 *   model = "k3"
 *
 * Avoids adding a TOML dependency for a narrow, stable config shape.
 */
export function parseKimiConfigModels(toml: string): {
  models: ProviderModelOption[];
  defaultModelId: string | null;
} {
  const defaultMatch = /^default_model\s*=\s*"([^"]+)"/m.exec(toml);
  const defaultModelId = defaultMatch?.[1] ?? null;

  const models: ProviderModelOption[] = [];
  const sectionRe = /^\[models\."([^"]+)"\]\s*$/gm;
  const sections: Array<{ id: string; headerStart: number; bodyStart: number }> = [];
  for (const match of toml.matchAll(sectionRe)) {
    sections.push({
      id: match[1]!,
      headerStart: match.index!,
      bodyStart: match.index! + match[0].length,
    });
  }
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]!;
    const bodyEnd = i + 1 < sections.length ? sections[i + 1]!.headerStart : toml.length;
    const body = toml.slice(section.bodyStart, bodyEnd);
    const displayName = /^display_name\s*=\s*"([^"]+)"/m.exec(body)?.[1];
    const isDefault = defaultModelId === section.id;
    models.push({
      id: section.id,
      ...(displayName ? { label: displayName } : {}),
      ...(isDefault ? { isDefault: true, hint: "default" } : {}),
    });
  }
  return { models, defaultModelId };
}

async function discoverCursorModels(deps: DiscoverModelsDeps): Promise<ProviderModelCatalog> {
  const env = deps.env ?? process.env;
  const findBinary = deps.findCursorBinary ?? findCursorExecutableOnPath;
  const binary = findBinary(env);
  if (!binary) {
    return unavailable("cursor", "cursor-agent / agent binary not found on this host", deps);
  }
  const run =
    deps.runCursorModels ??
    (async (bin, processEnv) => {
      const result = await runCommand(bin, ["models"], { timeoutMs: CURSOR_MODELS_TIMEOUT_MS, env: processEnv });
      return { ok: result.ok, stdout: result.stdout, stderr: result.stderr };
    });
  const result = await run(binary, env);
  if (!result.ok) {
    const detail = (result.stderr || result.stdout || "agent models failed").trim();
    return unavailable("cursor", detail.slice(0, 500), deps);
  }
  const parsed = parseCursorModelsOutput(result.stdout);
  if (parsed.models.length === 0) {
    return unavailable("cursor", "agent models returned no parseable model rows", deps);
  }
  return {
    provider: "cursor",
    models: parsed.models,
    defaultModelId: parsed.defaultModelId,
    fetchedAt: fetchedAt(deps),
    source: "provider-cli",
    error: null,
  };
}

async function discoverKimiModels(deps: DiscoverModelsDeps): Promise<ProviderModelCatalog> {
  const path = deps.kimiConfigPath ?? join(homedir(), ".kimi-code", "config.toml");
  const read =
    deps.readKimiConfig ??
    (async () => {
      try {
        return await readFile(path, "utf8");
      } catch (err) {
        const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
        if (code === "ENOENT") return null;
        throw err;
      }
    });
  let toml: string | null;
  try {
    toml = await read();
  } catch (err) {
    return unavailable("kimi-code", err instanceof Error ? err.message : String(err), deps);
  }
  if (toml == null) {
    return unavailable("kimi-code", `Kimi config not found at ${path}`, deps);
  }
  const parsed = parseKimiConfigModels(toml);
  if (parsed.models.length === 0) {
    return unavailable("kimi-code", "Kimi config has no [models.\".\"] entries", deps);
  }
  return {
    provider: "kimi-code",
    models: parsed.models,
    defaultModelId: parsed.defaultModelId,
    fetchedAt: fetchedAt(deps),
    source: "provider-config",
    error: null,
  };
}

/**
 * Discover the model catalog for a runtime provider from the host-local
 * provider. Phase 1 implements Cursor + Kimi; other providers return
 * `source: "unavailable"` so the web can keep its curated/fallback UI.
 */
export async function discoverProviderModels(
  provider: RuntimeProvider,
  deps: DiscoverModelsDeps = {},
): Promise<ProviderModelCatalog> {
  switch (provider) {
    case "cursor":
      return discoverCursorModels(deps);
    case "kimi-code":
      return discoverKimiModels(deps);
    case "claude-code":
    case "claude-code-tui":
    case "codex":
      return unavailable(
        provider,
        `Host-local model discovery for ${provider} lands in a later phase`,
        deps,
      );
    default: {
      const _exhaustive: never = provider;
      return unavailable(_exhaustive, `Unknown provider: ${String(provider)}`, deps);
    }
  }
}
