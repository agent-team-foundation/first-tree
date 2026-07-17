import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderModelCatalog, ProviderModelOption, RuntimeProvider } from "@first-tree/shared";
import { findCursorExecutableOnPath } from "../cursor-binary.js";
import { runCommand } from "./launch-probe.js";

/** Ceiling for `agent models` — account catalog fetch can be network-bound. */
const CURSOR_MODELS_TIMEOUT_MS = 20_000;

export type DiscoverModelsDeps = {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  findCursorBinary?: (env?: Record<string, string | undefined>) => string | null;
  runCursorModels?: (
    binary: string,
    env: NodeJS.ProcessEnv,
  ) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
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
 *
 * Uses indexOf/slice instead of `\s+` / `.+` regexes so CodeQL does not flag
 * polynomial-time matching on CLI stdout.
 */
export function parseCursorModelsOutput(stdout: string): {
  models: ProviderModelOption[];
  defaultModelId: string | null;
} {
  const models: ProviderModelOption[] = [];
  let defaultModelId: string | null = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.toLowerCase() === "available models") continue;
    const sep = line.indexOf(" - ");
    if (sep <= 0) continue;
    const id = line.slice(0, sep);
    // Model ids are single tokens (`auto`, `gpt-5.2`); reject spaced ids.
    if (!id || id.includes(" ") || id.includes("\t")) continue;
    let label = line.slice(sep + 3).trim();
    const defaultMarker = "(default)";
    const defaultAt = label.toLowerCase().indexOf(defaultMarker);
    const isDefault = defaultAt >= 0;
    if (isDefault) {
      defaultModelId = id;
      label = `${label.slice(0, defaultAt)}${label.slice(defaultAt + defaultMarker.length)}`.trim();
    }
    models.push({
      id,
      label: label || id,
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
  let defaultModelId: string | null = null;
  const models: ProviderModelOption[] = [];
  const sections: Array<{ id: string; headerStart: number; bodyStart: number }> = [];

  // Line-oriented scan avoids `\s*` / `.+` regexes that CodeQL flags as
  // polynomial on untrusted host config text.
  let cursor = 0;
  while (cursor <= toml.length) {
    const nextNl = toml.indexOf("\n", cursor);
    const lineEnd = nextNl === -1 ? toml.length : nextNl;
    const line = toml.slice(cursor, lineEnd).replace(/\r$/, "");
    const trimmed = line.trim();

    if (trimmed.startsWith("default_model")) {
      const eq = trimmed.indexOf("=");
      if (eq > 0) {
        const raw = trimmed.slice(eq + 1).trim();
        if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
          defaultModelId = raw.slice(1, -1);
        }
      }
    }

    if (trimmed.startsWith('[models."') && trimmed.endsWith('"]')) {
      const id = trimmed.slice('[models."'.length, -'"]'.length);
      if (id.length > 0) {
        const bodyStart = nextNl === -1 ? toml.length : nextNl + 1;
        sections.push({ id, headerStart: cursor, bodyStart });
      }
    }

    if (nextNl === -1) break;
    cursor = nextNl + 1;
  }

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    if (!section) continue;
    const next = sections[i + 1];
    const bodyEnd = next ? next.headerStart : toml.length;
    const body = toml.slice(section.bodyStart, bodyEnd);
    let displayName: string | undefined;
    for (const bodyLine of body.split("\n")) {
      const t = bodyLine.replace(/\r$/, "").trim();
      if (!t.startsWith("display_name")) continue;
      const eq = t.indexOf("=");
      if (eq <= 0) continue;
      const raw = t.slice(eq + 1).trim();
      if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
        displayName = raw.slice(1, -1);
      }
      break;
    }
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
    return unavailable("kimi-code", 'Kimi config has no [models."."] entries', deps);
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
      return unavailable(provider, `Host-local model discovery for ${provider} lands in a later phase`, deps);
    default: {
      const _exhaustive: never = provider;
      return unavailable(_exhaustive, `Unknown provider: ${String(provider)}`, deps);
    }
  }
}
