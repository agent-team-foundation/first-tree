import { lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { persistedAgentNameSchema } from "@first-tree/shared";
import { defaultConfigDir, defaultHome } from "@first-tree/shared/config";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * Why a local alias is no longer usable from this client. Surfaced to
 * operators in `client doctor` and `agent prune` — knowing *why* a dir is
 * stale changes the next action (delete vs. go run it on the other machine).
 *
 * - `unreadable`        — agent.yaml missing, malformed, or has no agentId.
 * - `unowned`           — server doesn't return this agentId at all under
 *                         the current user (deleted, or never owned).
 * - `pinned-elsewhere`  — agentId belongs to the user but is pinned to a
 *                         *different* client. R-RUN would reject `bind`
 *                         on this machine; the agent is alive on the other.
 *
 * Suspended agents pinned to this client are not stale. The server still
 * returns them from `/me/pinned-agents` with `status: "suspended"` so prune
 * keeps their local config/workspace/session state for future reactivation.
 */
export type StaleAliasReason =
  | { kind: "unreadable"; error: string }
  | { kind: "unowned" }
  | { kind: "pinned-elsewhere"; clientId: string };

export type StaleAlias = {
  name: string;
  /** Null when the YAML couldn't be parsed enough to extract an agentId. */
  agentId: string | null;
  reason: StaleAliasReason;
};

export type PinnedAgent = { agentId: string; clientId: string; status?: string };

const minimalAgentYamlSchema = z
  .object({
    agentId: z.string().min(1),
  })
  .passthrough();

const SAFE_ERRNO_CODES: ReadonlySet<string> = new Set([
  "EACCES",
  "EBUSY",
  "EIO",
  "ELOOP",
  "ENOENT",
  "ENOTDIR",
  "ENOTEMPTY",
  "EPERM",
  "EROFS",
]);

export const INVALID_LOCAL_AGENT_NAME_MESSAGE =
  "Agent name must contain 1-100 lowercase ASCII letters, digits, hyphens, or underscores.";
export const UNKNOWN_LOCAL_AGENT_REMOVAL_MESSAGE = "Unable to remove local agent data safely.";

export type LocalAgentRemovalErrorCode =
  | "INVALID_AGENT_NAME"
  | "LOCAL_AGENT_PATH_CHECK_FAILED"
  | "LOCAL_AGENT_REMOVE_FAILED"
  | "UNSAFE_LOCAL_AGENT_PATH";

export class LocalAgentRemovalError extends Error {
  readonly code: LocalAgentRemovalErrorCode;

  constructor(code: LocalAgentRemovalErrorCode, message: string) {
    super(message);
    this.name = "LocalAgentRemovalError";
    this.code = code;
  }
}

type PathContainmentApi = {
  isAbsolute(path: string): boolean;
  relative(from: string, to: string): string;
  sep: string;
};

const nativePathContainment: PathContainmentApi = { isAbsolute, relative, sep };

export function isStrictPathDescendant(
  root: string,
  target: string,
  pathApi: PathContainmentApi = nativePathContainment,
): boolean {
  const relativePath = pathApi.relative(root, target);
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${pathApi.sep}`) &&
    !pathApi.isAbsolute(relativePath)
  );
}

function errnoCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = error.code;
  return typeof code === "string" && SAFE_ERRNO_CODES.has(code) ? code : null;
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

export function sanitizedFsMessage(summary: string, error: unknown): string {
  const code = errnoCode(error);
  return code === null ? `${summary}.` : `${summary} (${code}).`;
}

function quoteAsciiForDisplay(value: string): string {
  let quoted = '"';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22) quoted += '\\"';
    else if (code === 0x5c) quoted += "\\\\";
    else if (code === 0x08) quoted += "\\b";
    else if (code === 0x09) quoted += "\\t";
    else if (code === 0x0a) quoted += "\\n";
    else if (code === 0x0c) quoted += "\\f";
    else if (code === 0x0d) quoted += "\\r";
    else if (code >= 0x20 && code <= 0x7e) quoted += value[index];
    else quoted += `\\u${code.toString(16).padStart(4, "0")}`;
  }
  return `${quoted}"`;
}

export function formatLocalAliasName(name: string): string {
  if (persistedAgentNameSchema.safeParse(name).success) return name;
  const escaped = quoteAsciiForDisplay(name);
  return escaped.length <= 80 ? escaped : `${escaped.slice(0, 77)}...`;
}

/**
 * Cross-reference local `agents/<name>/agent.yaml` files against the
 * server's pinned-agent set, returning every alias that won't bind on
 * THIS client.
 *
 * Why we don't use `loadAgents`:
 * `shared/config/loader.loadAgents` is fail-fast — one malformed
 * agent.yaml throws and the whole scan dies. The dominant prune target
 * IS the malformed dir (typo `agent add d`, half-written yaml, missing
 * agentId), so we walk dirs ourselves and degrade per-entry instead.
 *
 * Why we filter by clientId, not just userId:
 * `listPinnedAgents` (`/api/v1/me/pinned-agents`) returns every agent
 * pinned to ANY client this user owns (cross-machine). For prune the
 * relevant question is "will R-RUN accept it on THIS machine", which
 * needs `agents.client_id === current client.id`. Anything pinned on
 * another client is reported with `pinned-elsewhere` so the operator
 * can either re-pin or delete the local alias deliberately.
 */
export async function findStaleAliases(opts: {
  clientId: string;
  listPinnedAgents: () => Promise<PinnedAgent[]>;
  /** Override for tests; defaults to `$FIRST_TREE_HOME/config/agents`. */
  agentsDir?: string;
}): Promise<StaleAlias[]> {
  const agentsDir = opts.agentsDir ?? join(defaultConfigDir(), "agents");
  let agentsDirEntry: ReturnType<typeof lstatSync>;
  try {
    agentsDirEntry = lstatSync(agentsDir);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return [];
    throw new Error(sanitizedFsMessage("Unable to inspect the local agent alias directory", error));
  }
  if (agentsDirEntry.isSymbolicLink() || !agentsDirEntry.isDirectory()) {
    throw new Error("Unable to inspect the local agent alias directory safely.");
  }

  const remote = await opts.listPinnedAgents();
  const pinnedHere = new Set<string>();
  const pinnedElsewhere = new Map<string, string>();
  for (const r of remote) {
    if (r.clientId === opts.clientId) pinnedHere.add(r.agentId);
    else pinnedElsewhere.set(r.agentId, r.clientId);
  }

  let entries: string[];
  try {
    entries = readdirSync(agentsDir);
  } catch (error) {
    throw new Error(sanitizedFsMessage("Unable to read the local agent alias directory", error));
  }

  const stale: StaleAlias[] = [];
  for (const entry of entries) {
    const agentDir = join(agentsDir, entry);
    let agentDirEntry: ReturnType<typeof lstatSync>;
    try {
      agentDirEntry = lstatSync(agentDir);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) {
        stale.push({
          name: entry,
          agentId: null,
          reason: { kind: "unreadable", error: sanitizedFsMessage("cannot inspect alias", error) },
        });
      }
      continue;
    }
    if (agentDirEntry.isSymbolicLink()) {
      stale.push({
        name: entry,
        agentId: null,
        reason: { kind: "unreadable", error: "alias directory must not be a symlink" },
      });
      continue;
    }
    if (!agentDirEntry.isDirectory()) continue;
    if (!persistedAgentNameSchema.safeParse(entry).success) {
      stale.push({ name: entry, agentId: null, reason: { kind: "unreadable", error: "invalid local alias name" } });
      continue;
    }

    const yamlPath = join(agentDir, "agent.yaml");
    let yamlEntry: ReturnType<typeof lstatSync>;
    try {
      yamlEntry = lstatSync(yamlPath);
    } catch (error) {
      const reason = isErrno(error, "ENOENT")
        ? "missing agent.yaml"
        : sanitizedFsMessage("cannot inspect agent.yaml", error);
      stale.push({ name: entry, agentId: null, reason: { kind: "unreadable", error: reason } });
      continue;
    }
    if (yamlEntry.isSymbolicLink() || !yamlEntry.isFile()) {
      stale.push({
        name: entry,
        agentId: null,
        reason: { kind: "unreadable", error: "agent.yaml must be a regular file" },
      });
      continue;
    }

    let agentId: string;
    let yamlText: string;
    try {
      yamlText = readFileSync(yamlPath, "utf-8");
    } catch (error) {
      stale.push({
        name: entry,
        agentId: null,
        reason: { kind: "unreadable", error: sanitizedFsMessage("cannot read agent.yaml", error) },
      });
      continue;
    }
    try {
      const raw = parseYaml(yamlText) as unknown;
      const parsed = minimalAgentYamlSchema.safeParse(raw);
      if (!parsed.success) {
        stale.push({ name: entry, agentId: null, reason: { kind: "unreadable", error: "invalid agent.yaml" } });
        continue;
      }
      agentId = parsed.data.agentId;
    } catch {
      stale.push({ name: entry, agentId: null, reason: { kind: "unreadable", error: "invalid agent.yaml" } });
      continue;
    }

    if (pinnedHere.has(agentId)) continue;

    const otherClient = pinnedElsewhere.get(agentId);
    if (otherClient !== undefined) {
      stale.push({ name: entry, agentId, reason: { kind: "pinned-elsewhere", clientId: otherClient } });
    } else {
      stale.push({ name: entry, agentId, reason: { kind: "unowned" } });
    }
  }

  return stale;
}

/** Human-readable suffix for the per-alias listing. */
export function formatStaleReason(reason: StaleAliasReason): string {
  switch (reason.kind) {
    case "unreadable":
      return `unreadable: ${reason.error}`;
    case "unowned":
      return "no longer owned by you (deleted or transferred)";
    case "pinned-elsewhere":
      return `pinned to another client: ${reason.clientId}`;
  }
}

type LocalAgentStateRegion = "configuration" | "session state" | "workspace";

type RemovalSpec = {
  leaf: string;
  recursive: boolean;
  region: LocalAgentStateRegion;
  regionPath: string;
};

type RemovalProof = RemovalSpec & {
  canonicalHome: string;
  canonicalRegion: string;
  canonicalTarget: string;
  operand: string;
};

function pathCheckError(region: LocalAgentStateRegion | "state home", error: unknown): LocalAgentRemovalError {
  return new LocalAgentRemovalError(
    "LOCAL_AGENT_PATH_CHECK_FAILED",
    sanitizedFsMessage(`Unable to verify the local agent ${region} safely`, error),
  );
}

function unsafePathError(region: LocalAgentStateRegion, detail = "target failed its managed-directory safety check") {
  return new LocalAgentRemovalError("UNSAFE_LOCAL_AGENT_PATH", `Refusing to remove local agent ${region}: ${detail}.`);
}

function canonicalExistingDirectory(path: string, region: LocalAgentStateRegion | "state home"): string | null {
  try {
    lstatSync(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw pathCheckError(region, error);
  }

  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(path);
  } catch (error) {
    // lstat succeeded, so ENOENT here is a dangling link or a race. It must
    // not be treated as the force/no-op case.
    throw pathCheckError(region, error);
  }

  let canonicalEntry: ReturnType<typeof lstatSync>;
  try {
    canonicalEntry = lstatSync(canonicalPath);
  } catch (error) {
    throw pathCheckError(region, error);
  }
  if (!canonicalEntry.isDirectory()) {
    if (region === "state home") {
      throw new LocalAgentRemovalError(
        "UNSAFE_LOCAL_AGENT_PATH",
        "Refusing to remove local agent data: the local state home is not a directory.",
      );
    }
    throw unsafePathError(region, "managed region is not a directory");
  }
  return canonicalPath;
}

function inspectRemovalTarget(
  homePath: string,
  spec: RemovalSpec,
  expectedIdentity?: { canonicalHome: string; canonicalRegion?: string },
): RemovalProof | null {
  const lexicalHome = resolve(homePath);
  const lexicalRegion = resolve(spec.regionPath);
  if (!isStrictPathDescendant(lexicalHome, lexicalRegion)) {
    throw unsafePathError(spec.region, "managed region failed its state-home safety check");
  }

  const canonicalHome = canonicalExistingDirectory(lexicalHome, "state home");
  if (canonicalHome === null) return null;
  if (expectedIdentity && canonicalHome !== expectedIdentity.canonicalHome) {
    throw unsafePathError(spec.region, "local state home identity changed during safety verification");
  }

  const canonicalRegion = canonicalExistingDirectory(lexicalRegion, spec.region);
  if (canonicalRegion === null) return null;
  if (!isStrictPathDescendant(canonicalHome, canonicalRegion)) {
    throw unsafePathError(spec.region, "managed region resolves outside the local state home");
  }
  const expectedCanonicalRegion = resolve(canonicalHome, relative(lexicalHome, lexicalRegion));
  if (relative(expectedCanonicalRegion, canonicalRegion) !== "") {
    throw unsafePathError(spec.region, "managed region resolves away from its expected state-home location");
  }
  if (expectedIdentity?.canonicalRegion && canonicalRegion !== expectedIdentity.canonicalRegion) {
    throw unsafePathError(spec.region, "managed region identity changed during safety verification");
  }

  const operand = resolve(canonicalRegion, spec.leaf);
  if (!isStrictPathDescendant(canonicalRegion, operand)) {
    throw unsafePathError(spec.region);
  }

  try {
    lstatSync(operand);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw pathCheckError(spec.region, error);
  }

  let canonicalTarget: string;
  try {
    canonicalTarget = realpathSync(operand);
  } catch (error) {
    // As above, lstat already proved that an entry existed. ENOENT from
    // realpath is therefore a dangling link or a concurrent replacement.
    throw pathCheckError(spec.region, error);
  }
  if (!isStrictPathDescendant(canonicalRegion, canonicalTarget)) {
    throw unsafePathError(spec.region);
  }

  return { ...spec, canonicalHome, canonicalRegion, canonicalTarget, operand };
}

function removalIdentityMatches(preflight: RemovalProof, current: RemovalProof): boolean {
  return (
    preflight.canonicalHome === current.canonicalHome &&
    preflight.canonicalRegion === current.canonicalRegion &&
    preflight.canonicalTarget === current.canonicalTarget &&
    preflight.operand === current.operand
  );
}

function removePreflightedTarget(homePath: string, preflight: RemovalProof): void {
  const current = inspectRemovalTarget(homePath, preflight, {
    canonicalHome: preflight.canonicalHome,
    canonicalRegion: preflight.canonicalRegion,
  });
  if (current === null) return;
  if (!removalIdentityMatches(preflight, current)) {
    throw unsafePathError(preflight.region, "managed state identity changed during safety verification");
  }

  try {
    rmSync(preflight.operand, { recursive: preflight.recursive, force: true });
  } catch (error) {
    throw new LocalAgentRemovalError(
      "LOCAL_AGENT_REMOVE_FAILED",
      sanitizedFsMessage(`Unable to remove the local agent ${preflight.region}`, error),
    );
  }
}

/**
 * Remove an agent's local footprint: the YAML alias dir, the workspace
 * tree under `data/workspaces/<name>`, and the session-mapping file under
 * `data/sessions/<name>.json`. Mirrors what `agent remove` does, exposed
 * separately so prune and the post-rotation override cleanup can share it.
 * Returns whether the configuration alias existed at preflight time so the
 * direct remove command can preserve its not-found result without probing an
 * untrusted path outside this safety boundary.
 */
export function removeLocalAgent(name: string): boolean {
  const parsedName = persistedAgentNameSchema.safeParse(name);
  if (!parsedName.success) {
    throw new LocalAgentRemovalError("INVALID_AGENT_NAME", INVALID_LOCAL_AGENT_NAME_MESSAGE);
  }

  const homePath = resolve(defaultHome());
  const specs: RemovalSpec[] = [
    {
      leaf: parsedName.data,
      recursive: true,
      region: "configuration",
      regionPath: resolve(homePath, "config", "agents"),
    },
    {
      leaf: parsedName.data,
      recursive: true,
      region: "workspace",
      regionPath: resolve(homePath, "data", "workspaces"),
    },
    {
      leaf: `${parsedName.data}.json`,
      recursive: false,
      region: "session state",
      regionPath: resolve(homePath, "data", "sessions"),
    },
  ];

  // Prove every existing target before the first mutation. This prevents a
  // later known-unsafe target from leaving an earlier region partially
  // removed. Each present target is then proved again immediately before rm.
  const operationCanonicalHome = canonicalExistingDirectory(homePath, "state home");
  if (operationCanonicalHome === null) return false;
  const preflight = specs.map((spec) =>
    inspectRemovalTarget(homePath, spec, { canonicalHome: operationCanonicalHome }),
  );
  for (const proof of preflight) {
    if (proof !== null) removePreflightedTarget(homePath, proof);
  }
  return preflight[0] !== null;
}
