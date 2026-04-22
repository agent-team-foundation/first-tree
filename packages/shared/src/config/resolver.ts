import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { setConfig } from "./singleton.js";
import type {
  AutoGenerator,
  FieldDef,
  InferConfig,
  InitConfigOptions,
  OptionalGroupDef,
  ResolvedFieldInfo,
} from "./types.js";

export const DEFAULT_HOME_DIR = process.env.FIRST_TREE_HUB_HOME ?? join(homedir(), ".first-tree", "hub");
export const DEFAULT_CONFIG_DIR = join(DEFAULT_HOME_DIR, "config");
export const DEFAULT_DATA_DIR = join(DEFAULT_HOME_DIR, "data");

// ── Type guards ──────────────────────────────────────────────────────

function isFieldDef(value: unknown): value is FieldDef {
  return typeof value === "object" && value !== null && "_tag" in value && (value as FieldDef)._tag === "field";
}

function isOptionalGroup(value: unknown): value is OptionalGroupDef {
  return (
    typeof value === "object" && value !== null && "_tag" in value && (value as OptionalGroupDef)._tag === "optional"
  );
}

// ── Path utilities ───────────────────────────────────────────────────

function getByPath(obj: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = obj;
  for (const key of path) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function setByPath(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let current = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (key === undefined) continue;
    if (!(key in current) || typeof current[key] !== "object" || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  const lastKey = path.at(-1);
  if (lastKey !== undefined) {
    current[lastKey] = value;
  }
}

// ── Env coercion ─────────────────────────────────────────────────────

/** Unwrap ZodDefault / ZodOptional to get the inner type for coercion. */
function unwrapZodType(schema: z.ZodType): z.ZodType {
  // Zod internal API (ZodDefault._def.innerType) — verified working with zod@4.3.6
  if (schema instanceof z.ZodDefault) {
    return unwrapZodType(schema._def.innerType as z.ZodType);
  }
  if (schema instanceof z.ZodOptional) {
    return unwrapZodType(schema._def.innerType as z.ZodType);
  }
  return schema;
}

/** Coerce a string env var to the JS type expected by the Zod schema. */
function coerceEnvValue(value: string, schema: z.ZodType): unknown {
  const inner = unwrapZodType(schema);
  if (inner instanceof z.ZodNumber) {
    const num = Number(value);
    return Number.isNaN(num) ? value : num;
  }
  if (inner instanceof z.ZodBoolean) {
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
    return value;
  }
  return value;
}

// ── Auto-generation ──────────────────────────────────────────────────

function builtinAutoGenerate(strategy: string): string {
  if (strategy === "client-id") {
    return `client_${randomBytes(4).toString("hex")}`;
  }
  const match = /^random:(\w+):(\d+)$/.exec(strategy);
  if (!match) {
    throw new Error(`Unknown auto-generation strategy: ${strategy}`);
  }
  const encoding = match[1];
  const bytes = Number(match[2]);
  if (!encoding) throw new Error(`Invalid auto-generation strategy: ${strategy}`);
  if (encoding === "base64url") return randomBytes(bytes).toString("base64url");
  if (encoding === "hex") return randomBytes(bytes).toString("hex");
  throw new Error(`Unknown random encoding: ${encoding}`);
}

// ── FS helpers ───────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function deepFreeze<T>(obj: T): T {
  if (typeof obj !== "object" || obj === null) return obj;
  Object.freeze(obj);
  for (const value of Object.values(obj as Record<string, unknown>)) {
    deepFreeze(value);
  }
  return obj;
}

// ── Shape walking ────────────────────────────────────────────────────

type FieldInfo = {
  path: string[];
  fieldDef: FieldDef;
  optionalGroupPath: string[] | null;
};

function collectFields(
  shape: Record<string, unknown>,
  path: string[] = [],
  optionalGroupPath: string[] | null = null,
): FieldInfo[] {
  const fields: FieldInfo[] = [];
  for (const [key, value] of Object.entries(shape)) {
    const currentPath = [...path, key];
    if (isFieldDef(value)) {
      fields.push({ path: currentPath, fieldDef: value, optionalGroupPath });
    } else if (isOptionalGroup(value)) {
      fields.push(...collectFields(value.shape as Record<string, unknown>, currentPath, currentPath));
    } else if (typeof value === "object" && value !== null) {
      fields.push(...collectFields(value as Record<string, unknown>, currentPath, optionalGroupPath));
    }
  }
  return fields;
}

/** Build a Zod object schema from the config shape for validation. */
export function buildZodSchema(shape: Record<string, unknown>): z.ZodType {
  const zodShape: Record<string, z.ZodType> = {};
  for (const [key, value] of Object.entries(shape)) {
    if (isFieldDef(value)) {
      zodShape[key] = value.schema;
    } else if (isOptionalGroup(value)) {
      const inner = buildZodSchema(value.shape as Record<string, unknown>);
      zodShape[key] = inner.optional();
    } else if (typeof value === "object" && value !== null) {
      // Required group — .prefault({}) lets Zod apply child defaults when group is absent
      zodShape[key] = buildZodSchema(value as Record<string, unknown>).prefault({});
    }
  }
  return z.object(zodShape);
}

// ── Config metadata (for `config list`) ──────────────────────────────

export type ConfigMeta = Map<string, ResolvedFieldInfo>;

let _configMeta: ConfigMeta | undefined;

export function getConfigMeta(): ConfigMeta {
  if (!_configMeta) {
    throw new Error("Config not initialized. Call initConfig() first.");
  }
  return _configMeta;
}

export function resetConfigMeta(): void {
  _configMeta = undefined;
}

// ── initConfig ───────────────────────────────────────────────────────

const CONFIG_HEADER =
  "# Generated by first-tree-hub. Edit as needed.\n# https://github.com/agent-team-foundation/first-tree-hub\n\n";

/**
 * Initialize config from the priority chain:
 *   CLI args > env vars > YAML file > auto-generated > Zod defaults
 *
 * Auto-generated values are written back to the YAML file.
 * Result is frozen and stored as a singleton accessible via getConfig().
 */
export async function initConfig<T extends Record<string, unknown>>(
  options: InitConfigOptions<T>,
): Promise<InferConfig<T>> {
  const { schema, role, cliArgs = {}, autoGenerators = {} } = options;
  const configDir = options.configDir ?? DEFAULT_CONFIG_DIR;
  const configPath = join(configDir, `${role}.yaml`);

  // 1. Read YAML config file
  let fileValues: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    const raw: unknown = parseYaml(readFileSync(configPath, "utf-8"));
    if (typeof raw === "object" && raw !== null) {
      fileValues = raw as Record<string, unknown>;
    }
  }

  // 2. Collect all field definitions from the schema
  const fields = collectFields(schema as Record<string, unknown>);
  const resolved: Record<string, unknown> = {};
  const meta: ConfigMeta = new Map();
  const autoGenerated: Record<string, unknown> = {};

  // 3. Determine which optional groups are active
  //    A group is active if ANY field within it has an explicit value (CLI/env/file)
  const activeOptionalGroups = new Set<string>();

  for (const { path, fieldDef, optionalGroupPath } of fields) {
    if (!optionalGroupPath) continue;
    const groupKey = optionalGroupPath.join(".");
    if (activeOptionalGroups.has(groupKey)) continue;

    const cliValue = getByPath(cliArgs as Record<string, unknown>, path);
    if (cliValue !== undefined) {
      activeOptionalGroups.add(groupKey);
      continue;
    }
    if (fieldDef.options.env) {
      const envValue = process.env[fieldDef.options.env];
      if (envValue !== undefined && envValue !== "") {
        activeOptionalGroups.add(groupKey);
        continue;
      }
    }
    const fileValue = getByPath(fileValues, path);
    if (fileValue !== undefined) {
      activeOptionalGroups.add(groupKey);
    }
  }

  // 4. Resolve each field through the priority chain
  for (const { path, fieldDef, optionalGroupPath } of fields) {
    const dotPath = path.join(".");

    // Skip fields in inactive optional groups
    if (optionalGroupPath && !activeOptionalGroups.has(optionalGroupPath.join("."))) {
      continue;
    }

    // CLI args (highest priority)
    const cliValue = getByPath(cliArgs as Record<string, unknown>, path);
    if (cliValue !== undefined) {
      setByPath(resolved, path, cliValue);
      meta.set(dotPath, { value: cliValue, source: "cli", secret: fieldDef.options.secret ?? false });
      continue;
    }

    // Environment variable
    if (fieldDef.options.env) {
      const envValue = process.env[fieldDef.options.env];
      if (envValue !== undefined && envValue !== "") {
        const coerced = coerceEnvValue(envValue, fieldDef.schema);
        setByPath(resolved, path, coerced);
        meta.set(dotPath, { value: coerced, source: "env", secret: fieldDef.options.secret ?? false });
        continue;
      }
    }

    // Config file
    const fileValue = getByPath(fileValues, path);
    if (fileValue !== undefined) {
      setByPath(resolved, path, fileValue);
      meta.set(dotPath, { value: fileValue, source: "file", secret: fieldDef.options.secret ?? false });
      continue;
    }

    // Auto-generation
    if (fieldDef.options.auto) {
      const strategy = fieldDef.options.auto;
      const customGen = autoGenerators[strategy] as AutoGenerator | undefined;
      let generated: string;
      if (customGen) {
        generated = await customGen();
      } else {
        generated = builtinAutoGenerate(strategy);
      }
      setByPath(resolved, path, generated);
      setByPath(autoGenerated, path, generated);
      meta.set(dotPath, { value: generated, source: "auto", secret: fieldDef.options.secret ?? false });
      continue;
    }

    // Will rely on Zod default (or fail validation if no default)
    meta.set(dotPath, { value: undefined, source: "default", secret: fieldDef.options.secret ?? false });
  }

  // 5. Validate with Zod — applies defaults for fields without explicit values
  const zodSchema = buildZodSchema(schema as Record<string, unknown>);
  const result = zodSchema.safeParse(resolved);

  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Configuration validation failed:\n${issues}`);
  }

  // Type assertion: Zod validates the shape matches InferConfig<T>
  const config = result.data as InferConfig<T>;

  // 6. Update meta for fields that received Zod defaults
  for (const { path, fieldDef } of fields) {
    const dotPath = path.join(".");
    const entry = meta.get(dotPath);
    if (entry?.value === undefined) {
      const val = getByPath(config as Record<string, unknown>, path);
      if (val !== undefined) {
        meta.set(dotPath, {
          value: val,
          source: "default",
          secret: fieldDef.options.secret ?? false,
        });
      }
    }
  }

  // 7. Write back auto-generated values to YAML file
  if (Object.keys(autoGenerated).length > 0) {
    const merged = deepMerge(fileValues, autoGenerated);
    ensureDir(dirname(configPath));
    writeFileSync(configPath, CONFIG_HEADER + stringifyYaml(merged), { mode: 0o600 });
  }

  // 8. Freeze and store as singleton
  const frozen = deepFreeze(config);
  setConfig(frozen);
  _configMeta = meta;

  return frozen as InferConfig<T>;
}

// ── File operations (for `config set/get/list` commands) ─────────────

/** Set a value in a YAML config file by dot-path. */
export function setConfigValue(configPath: string, dotPath: string, value: unknown): void {
  let fileValues: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    const raw: unknown = parseYaml(readFileSync(configPath, "utf-8"));
    if (typeof raw === "object" && raw !== null) {
      fileValues = raw as Record<string, unknown>;
    }
  }
  setByPath(fileValues, dotPath.split("."), value);
  ensureDir(dirname(configPath));
  writeFileSync(configPath, CONFIG_HEADER + stringifyYaml(fileValues), { mode: 0o600 });
}

/** Get a value from a YAML config file by dot-path. */
export function getConfigValue(configPath: string, dotPath: string): unknown {
  if (!existsSync(configPath)) return undefined;
  const raw: unknown = parseYaml(readFileSync(configPath, "utf-8"));
  if (typeof raw !== "object" || raw === null) return undefined;
  return getByPath(raw as Record<string, unknown>, dotPath.split("."));
}

/** Read all values from a YAML config file. */
export function readConfigFile(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  const raw: unknown = parseYaml(readFileSync(configPath, "utf-8"));
  if (typeof raw !== "object" || raw === null) return {};
  return raw as Record<string, unknown>;
}

// ── Missing prompt detection ─────────────────────────────────────────

type MissingPromptField = {
  dotPath: string;
  prompt: import("./types.js").PromptDef;
};

/**
 * Scan a config schema and return fields that:
 * 1. Have a `prompt` definition
 * 2. Don't have a value from CLI args, env vars, or the config file
 * 3. Don't have an `auto` strategy (auto-gen fields don't need prompting)
 *
 * Used by CLI to show interactive prompts before calling initConfig().
 */
export function collectMissingPrompts(options: {
  schema: Record<string, unknown>;
  role: string;
  configDir?: string;
  cliArgs?: Record<string, unknown>;
}): MissingPromptField[] {
  const { schema, role, cliArgs = {} } = options;
  const configDir = options.configDir ?? DEFAULT_CONFIG_DIR;
  const configPath = join(configDir, `${role}.yaml`);

  let fileValues: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    const raw: unknown = parseYaml(readFileSync(configPath, "utf-8"));
    if (typeof raw === "object" && raw !== null) {
      fileValues = raw as Record<string, unknown>;
    }
  }

  const fields = collectFields(schema);
  const missing: MissingPromptField[] = [];

  for (const { path, fieldDef, optionalGroupPath } of fields) {
    // Skip fields in optional groups — they're not required
    if (optionalGroupPath) continue;

    // Skip fields without prompt definition
    if (!fieldDef.options.prompt) continue;

    // If a field has both `auto` and `prompt`, the prompt takes priority —
    // this lets users choose (e.g., Docker vs manual URL) before auto-gen kicks in.
    // Fields with only `auto` (no prompt) are never prompted.

    // Check if value exists from CLI args
    if (getByPath(cliArgs as Record<string, unknown>, path) !== undefined) continue;

    // Check if value exists from env
    if (fieldDef.options.env) {
      const envValue = process.env[fieldDef.options.env];
      if (envValue !== undefined && envValue !== "") continue;
    }

    // Check if value exists from file
    if (getByPath(fileValues, path) !== undefined) continue;

    // Field is missing and has a prompt — needs user input
    missing.push({ dotPath: path.join("."), prompt: fieldDef.options.prompt });
  }

  return missing;
}

// ── Read-only config resolution (for doctor / diagnostics) ──────────

/**
 * Resolve config values through the same priority chain as initConfig()
 * (env vars > YAML file > Zod defaults), but **without side effects**:
 * - No auto-generation
 * - No file writes
 * - No singleton mutation
 * - Partial results (unresolvable fields are omitted, no validation error)
 *
 * Returns the best-effort resolved config as a plain object.
 */
export function resolveConfigReadonly<T extends Record<string, unknown>>(options: {
  schema: T;
  role: string;
  configDir?: string;
}): Record<string, unknown> {
  const { schema, role } = options;
  const configDir = options.configDir ?? DEFAULT_CONFIG_DIR;
  const configPath = join(configDir, `${role}.yaml`);

  // Read YAML config file
  let fileValues: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    const raw: unknown = parseYaml(readFileSync(configPath, "utf-8"));
    if (typeof raw === "object" && raw !== null) {
      fileValues = raw as Record<string, unknown>;
    }
  }

  const fields = collectFields(schema as Record<string, unknown>);
  const resolved: Record<string, unknown> = {};

  for (const { path, fieldDef } of fields) {
    // Environment variable (highest priority for readonly resolution)
    if (fieldDef.options.env) {
      const envValue = process.env[fieldDef.options.env];
      if (envValue !== undefined && envValue !== "") {
        setByPath(resolved, path, coerceEnvValue(envValue, fieldDef.schema));
        continue;
      }
    }

    // Config file
    const fileValue = getByPath(fileValues, path);
    if (fileValue !== undefined) {
      setByPath(resolved, path, fileValue);
      continue;
    }

    // Zod default (if any)
    const defaultResult = fieldDef.schema.safeParse(undefined);
    if (defaultResult.success && defaultResult.data !== undefined) {
      setByPath(resolved, path, defaultResult.data);
    }
  }

  return resolved;
}
