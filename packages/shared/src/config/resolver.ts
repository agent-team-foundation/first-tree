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

// ⚠️ DO NOT assign these functions' return values to a top-level const.
//
//   // BANNED — every variant below silently breaks multi-env isolation
//   const HOME = defaultHome();
//   const CFG  = join(defaultConfigDir(), "client.yaml");
//   export const DATA_DIR = defaultDataDir();
//
//   // OK — wrap in a function so the lookup defers to call time
//   function home() { return defaultHome(); }
//   function cfg()  { return join(defaultConfigDir(), "client.yaml"); }
//
// `apps/cli/src/__tests__/no-toplevel-default-home-const.test.ts` is
// the regression guard that scans for this pattern and fails CI.
//
// Why: tsdown bundles the workspace into chunks. ESM evaluates every
// imported chunk's top-level statements BEFORE the importing module's
// body runs — so the CLI's `channel-env.ts` side-effect that sets
// `FIRST_TREE_HOME` from `channelConfig.defaultHome` runs AFTER any
// top-level `default*Dir()` call has already locked to the prod
// fallback. staging / dev daemons end up writing into `~/.first-tree`
// (prod home). The original multi-env incident: PR
// `feat/multi-env-isolation` (May 2026); review pass 1 caught the
// global pattern, review pass 2 (B2) caught `onboard.ts STATE_FILE`
// that the cleanup sweep missed.
//
// Lazy functions push the env read to call time. CLI entry sets the
// env during boot via `apps/cli/src/core/channel-env.ts`; downstream
// callers read it whenever they ask. Server processes don't set
// `FIRST_TREE_HOME` and fall through to `~/.first-tree`, which is the
// prod home — fine for SaaS deployments that mount their own volume
// anyway.
//
// Pre-multi-env note: the fallback used to be `~/.first-tree/hub`. The
// `hub` subdirectory is gone — see `packages/shared/src/channel/` and
// `MIGRATION.md` Phase 2.

export function defaultHome(): string {
  return process.env.FIRST_TREE_HOME ?? join(homedir(), ".first-tree");
}

export function defaultConfigDir(): string {
  return join(defaultHome(), "config");
}

export function defaultDataDir(): string {
  return join(defaultHome(), "data");
}

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
  optionalGroupPaths: string[][];
};

type OptionalGroupInfo = {
  path: string[];
  groupDef: OptionalGroupDef;
};

function collectFields(
  shape: Record<string, unknown>,
  path: string[] = [],
  optionalGroupPaths: string[][] = [],
): FieldInfo[] {
  const fields: FieldInfo[] = [];
  for (const [key, value] of Object.entries(shape)) {
    const currentPath = [...path, key];
    if (isFieldDef(value)) {
      fields.push({ path: currentPath, fieldDef: value, optionalGroupPaths });
    } else if (isOptionalGroup(value)) {
      fields.push(
        ...collectFields(value.shape as Record<string, unknown>, currentPath, [...optionalGroupPaths, currentPath]),
      );
    } else if (typeof value === "object" && value !== null) {
      fields.push(...collectFields(value as Record<string, unknown>, currentPath, optionalGroupPaths));
    }
  }
  return fields;
}

function collectOptionalGroups(shape: Record<string, unknown>, path: string[] = []): OptionalGroupInfo[] {
  const groups: OptionalGroupInfo[] = [];
  for (const [key, value] of Object.entries(shape)) {
    const currentPath = [...path, key];
    if (isOptionalGroup(value)) {
      groups.push({ path: currentPath, groupDef: value });
      groups.push(...collectOptionalGroups(value.shape as Record<string, unknown>, currentPath));
    } else if (typeof value === "object" && value !== null && !isFieldDef(value)) {
      groups.push(...collectOptionalGroups(value as Record<string, unknown>, currentPath));
    }
  }
  return groups;
}

function pathKey(path: readonly string[]): string {
  return path.join(".");
}

function pathsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((segment, index) => segment === b[index]);
}

function parseRelativePath(path: string): string[] {
  return path.split(".").filter((segment) => segment.length > 0);
}

function fieldHasExplicitValue(options: {
  path: string[];
  fieldDef: FieldDef;
  cliArgs?: Record<string, unknown>;
  fileValues: Record<string, unknown>;
}): boolean {
  const { path, fieldDef, cliArgs, fileValues } = options;
  if (cliArgs && getByPath(cliArgs, path) !== undefined) return true;
  if (fieldDef.options.env) {
    const envValue = process.env[fieldDef.options.env];
    if (envValue !== undefined && envValue !== "") return true;
  }
  return getByPath(fileValues, path) !== undefined;
}

function determineActiveOptionalGroups(options: {
  fields: FieldInfo[];
  optionalGroups: OptionalGroupInfo[];
  cliArgs?: Record<string, unknown>;
  fileValues: Record<string, unknown>;
}): Set<string> {
  const { fields, optionalGroups, cliArgs, fileValues } = options;
  const active = new Set<string>();
  const fieldsByPath = new Map(fields.map((fieldInfo) => [pathKey(fieldInfo.path), fieldInfo]));

  for (const groupInfo of optionalGroups) {
    const groupKey = pathKey(groupInfo.path);
    const activationPaths = groupInfo.groupDef.options.activateBy;
    const activationFields =
      activationPaths === undefined
        ? fields.filter((fieldInfo) =>
            fieldInfo.optionalGroupPaths.some((optionalPath) => pathsEqual(optionalPath, groupInfo.path)),
          )
        : activationPaths.map((relativePath) => {
            const absolutePath = [...groupInfo.path, ...parseRelativePath(relativePath)];
            const fieldInfo = fieldsByPath.get(pathKey(absolutePath));
            if (!fieldInfo) {
              throw new Error(`Unknown activateBy field "${relativePath}" for optional group "${groupKey}"`);
            }
            return fieldInfo;
          });

    if (activationFields.some(({ path, fieldDef }) => fieldHasExplicitValue({ path, fieldDef, cliArgs, fileValues }))) {
      active.add(groupKey);
    }
  }

  return active;
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

// ── Config metadata (for `client config show`) ───────────────────────

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
  "# Generated by First Tree. Edit as needed.\n# https://github.com/agent-team-foundation/first-tree\n\n";

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
  const configDir = options.configDir ?? defaultConfigDir();
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
  const activeOptionalGroups = determineActiveOptionalGroups({
    fields,
    optionalGroups: collectOptionalGroups(schema as Record<string, unknown>),
    cliArgs: cliArgs as Record<string, unknown>,
    fileValues,
  });

  // 4. Resolve each field through the priority chain
  for (const { path, fieldDef, optionalGroupPaths } of fields) {
    const dotPath = path.join(".");

    // Skip fields unless every optional ancestor is active.
    if (optionalGroupPaths.some((optionalPath) => !activeOptionalGroups.has(pathKey(optionalPath)))) {
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
  const configDir = options.configDir ?? defaultConfigDir();
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

  for (const { path, fieldDef, optionalGroupPaths } of fields) {
    // Skip fields in optional groups — they're not required
    if (optionalGroupPaths.length > 0) continue;

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
  const configDir = options.configDir ?? defaultConfigDir();
  const configPath = join(configDir, `${role}.yaml`);

  // Read YAML config file
  let fileValues: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    const raw: unknown = parseYaml(readFileSync(configPath, "utf-8"));
    if (typeof raw === "object" && raw !== null) {
      fileValues = raw as Record<string, unknown>;
    }
  }

  const schemaShape = schema as Record<string, unknown>;
  const fields = collectFields(schemaShape);
  const activeOptionalGroups = determineActiveOptionalGroups({
    fields,
    optionalGroups: collectOptionalGroups(schemaShape),
    fileValues,
  });
  const resolved: Record<string, unknown> = {};

  for (const { path, fieldDef, optionalGroupPaths } of fields) {
    if (optionalGroupPaths.some((optionalPath) => !activeOptionalGroups.has(pathKey(optionalPath)))) {
      continue;
    }

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
