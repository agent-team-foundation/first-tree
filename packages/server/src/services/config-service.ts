import {
  type AgentRuntimeConfig,
  type AgentRuntimeConfigDryRunResult,
  type AgentRuntimeConfigPatch,
  type AgentRuntimeConfigPayload,
  agentRuntimeConfigPayloadSchema,
  ENV_REDACTED_PLACEHOLDER,
  type EnvEntry,
  isRedactedEnvValue,
  type RuntimeProvider,
  type UpdateAgentRuntimeConfig,
} from "@first-tree/shared";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agentConfigs } from "../db/schema/agent-configs.js";
import { agents } from "../db/schema/agents.js";
import { BadRequestError, ConflictError, NotFoundError } from "../errors.js";
import { decryptValue, encryptValue, isEncryptedValue } from "./crypto.js";
import type { Notifier } from "./notifier.js";

const DEBOUNCE_WINDOW_MS = 300;
const LEGACY_MCP_WRITE_DISABLED_MESSAGE =
  "Legacy per-agent MCP config writes are disabled. MCP configuration will be managed by Team MCP Resources.";
const RESOURCES_WRITE_DISABLED_MESSAGE =
  "Legacy per-agent prompt, Git repo, and MCP config writes are disabled. Use Agent Resources or Team Resources.";

type PendingWrite = {
  /** All callers waiting on the aggregated write. Each carries its own
   *  `patch` + `expectedVersion` so conflicts are surfaced per-caller. */
  awaiters: Array<{
    resolve: (cfg: AgentRuntimeConfig) => void;
    reject: (err: unknown) => void;
    patch: AgentRuntimeConfigPatch;
    expectedVersion: number;
    updatedBy: string;
  }>;
  timer: ReturnType<typeof setTimeout> | null;
};

export type ConfigService = {
  get(agentId: string): Promise<AgentRuntimeConfig>;
  /** Get with sensitive env values decrypted — for runtime injection only. */
  getDecrypted(agentId: string): Promise<AgentRuntimeConfig>;
  update(agentId: string, patch: UpdateAgentRuntimeConfig, updatedBy: string): Promise<AgentRuntimeConfig>;
  dryRun(agentId: string, patch: AgentRuntimeConfigPatch): Promise<AgentRuntimeConfigDryRunResult>;
  /** For tests: flush pending debounced writes immediately. */
  flush(agentId?: string): Promise<void>;
};

export type ConfigServiceOptions = {
  db: Database;
  notifier: Notifier;
  encryptionKey: string;
  /** Override debounce window for tests. */
  debounceMs?: number;
};

/**
 * Configuration service for per-agent runtime config.
 *
 * Concurrency model (M1 single-instance server):
 *   - Optimistic lock via `version` column.
 *   - Per-agent debounce: writes within `debounceMs` of the previous write
 *     are coalesced into a single UPDATE that bumps version once.
 *   - First write applies immediately; bursts within the window queue and
 *     flush together — see plan §11.5 for the "first immediate + rest
 *     aggregated" budget of 2 writes per burst.
 *
 * Multi-instance caveat (documented limitation): in-memory debounce splits
 * across replicas; future work would lower this to PG-side `FOR UPDATE`.
 */
export function createConfigService(opts: ConfigServiceOptions): ConfigService {
  const { db, notifier, encryptionKey } = opts;
  const debounceMs = opts.debounceMs ?? DEBOUNCE_WINDOW_MS;
  const pending = new Map<string, PendingWrite>();
  /** Tracks per-agent "first write of the burst already applied" — guards the budget at 2. */
  const burstFirstApplied = new Map<string, NodeJS.Timeout>();

  function rowToConfig(row: typeof agentConfigs.$inferSelect): AgentRuntimeConfig {
    return {
      agentId: row.agentId,
      version: row.version,
      payload: row.payload,
      updatedAt: row.updatedAt.toISOString(),
      updatedBy: row.updatedBy,
    };
  }

  /** Mask sensitive env values when echoing config back to admin clients. */
  function redact(payload: AgentRuntimeConfigPayload): AgentRuntimeConfigPayload {
    return {
      ...payload,
      env: payload.env.map((e) => (e.sensitive ? { ...e, value: ENV_REDACTED_PLACEHOLDER } : e)),
    };
  }

  /** Decrypt sensitive env values for runtime injection. */
  function decryptPayload(payload: AgentRuntimeConfigPayload): AgentRuntimeConfigPayload {
    return {
      ...payload,
      env: payload.env.map((e) =>
        e.sensitive && isEncryptedValue(e.value) ? { ...e, value: decryptValue(e.value, encryptionKey) } : e,
      ),
    };
  }

  /**
   * Merge a patch onto the current payload. Special handling:
   *   - `env[i].value === "***"` for a key that already exists → keep the
   *     existing ciphertext (admin only re-saved metadata, not the value).
   *   - `env[i].value` non-redacted + `sensitive=true` → re-encrypt.
   *   - `env[i].value` non-redacted + `sensitive=false` → store as plaintext.
   *   - Each list field (`mcpServers`, `env`, `gitRepos`) is fully replaced
   *     when present in the patch; partial-list edits are an explicit non-goal
   *     for M1 (admins resend the full list — matches the Web form).
   */
  function applyPatch(current: AgentRuntimeConfigPayload, patch: AgentRuntimeConfigPatch): AgentRuntimeConfigPayload {
    rejectLegacyMcpWrite(patch);
    // Not every variant carries `reasoningEffort` (cursor has no effort
    // channel). Reject an effort patch against such a variant explicitly:
    // zod's re-parse would otherwise STRIP the unknown key and report a
    // successful no-op write (version bump, config-change notification,
    // nothing changed) — the operator must learn the field does not apply.
    if (patch.reasoningEffort !== undefined && !("reasoningEffort" in current)) {
      throw new BadRequestError(
        "reasoningEffort is not supported by this agent's runtime provider (Cursor encodes effort in the model id)",
        { code: "reasoning_effort_unsupported" },
      );
    }
    const currentEffort = "reasoningEffort" in current ? current.reasoningEffort : undefined;
    const nextEffort = patch.reasoningEffort ?? currentEffort;
    const next = {
      // `kind` is pinned to `agents.runtime_provider` and never patchable
      // from the config side; preserve the current value here and let
      // `commitWrite` re-sync it against the authoritative source.
      kind: current.kind,
      prompt: patch.prompt ?? current.prompt,
      model: patch.model ?? current.model,
      mcpServers: patch.mcpServers ?? current.mcpServers,
      env: patch.env ? mergeEnv(current.env, patch.env) : current.env,
      gitRepos: patch.gitRepos ?? current.gitRepos,
      ...(nextEffort !== undefined ? { reasoningEffort: nextEffort } : {}),
    } as AgentRuntimeConfigPayload;
    return next;
  }

  function rejectLegacyMcpWrite(patch: AgentRuntimeConfigPatch): void {
    if (Object.hasOwn(patch, "mcpServers")) {
      throw new BadRequestError(LEGACY_MCP_WRITE_DISABLED_MESSAGE, { code: "legacy_mcp_config_disabled" });
    }
    if (Object.hasOwn(patch, "gitRepos") || Object.hasOwn(patch, "prompt")) {
      throw new BadRequestError(RESOURCES_WRITE_DISABLED_MESSAGE, { code: "legacy_resource_config_disabled" });
    }
  }

  function mergeEnv(currentEnv: EnvEntry[], patchEnv: EnvEntry[]): EnvEntry[] {
    const currentByKey = new Map(currentEnv.map((e) => [e.key, e]));
    return patchEnv.map((entry) => {
      if (!entry.sensitive) {
        // Non-sensitive: store plaintext as-is.
        return { ...entry };
      }
      const previous = currentByKey.get(entry.key);
      if (isRedactedEnvValue(entry.value) && previous?.sensitive) {
        // Admin echoed back the placeholder — keep the existing ciphertext.
        return { ...previous, sensitive: true };
      }
      return { ...entry, value: encryptValue(entry.value, encryptionKey) };
    });
  }

  async function readRow(agentId: string) {
    const [row] = await db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agentId)).limit(1);
    if (!row) {
      throw new NotFoundError(`Agent config "${agentId}" not found`);
    }
    // Parse via zod so legacy payloads written before 0026 (no `kind`)
    // are normalized to claude-code by preprocess. The authoritative kind
    // is re-synced on every commit from agents.runtime_provider; the
    // read-side default is a back-compat conversion only.
    const payload = agentRuntimeConfigPayloadSchema.parse(row.payload);
    return { ...row, payload };
  }

  async function readRuntimeProviderFor(agentId: string): Promise<RuntimeProvider> {
    const [row] = await db
      .select({ runtimeProvider: agents.runtimeProvider })
      .from(agents)
      .where(eq(agents.uuid, agentId))
      .limit(1);
    if (!row) {
      throw new NotFoundError(`Agent "${agentId}" not found`);
    }
    return row.runtimeProvider as RuntimeProvider;
  }

  async function commitWrite(
    agentId: string,
    patch: AgentRuntimeConfigPatch,
    expectedVersion: number,
    updatedBy: string,
  ): Promise<AgentRuntimeConfig> {
    const current = await readRow(agentId);
    if (current.version !== expectedVersion) {
      throw new ConflictError(
        `Agent config "${agentId}" version mismatch: expected ${expectedVersion}, got ${current.version}`,
      );
    }
    // Re-stamp `kind` from the authoritative agents.runtime_provider on every
    // commit so the discriminator stays in lockstep with the provider and any
    // legacy row that predates `kind` is backfilled on its next write. Generic
    // config writes do not choose providers; the managed switch-runtime flow
    // retags the stored payload when it changes the authoritative provider.
    const provider = await readRuntimeProviderFor(agentId);
    const merged = applyPatch(current.payload, patch);
    const synced = { ...merged, kind: provider } as AgentRuntimeConfigPayload;
    // Validate the fully-merged payload — guards against e.g. duplicate env keys
    // introduced by the merge that the patch alone wouldn't catch.
    const validated = agentRuntimeConfigPayloadSchema.parse(synced);

    const [updated] = await db
      .update(agentConfigs)
      .set({
        version: sql`${agentConfigs.version} + 1`,
        payload: validated,
        updatedAt: new Date(),
        updatedBy,
      })
      .where(and(eq(agentConfigs.agentId, agentId), eq(agentConfigs.version, expectedVersion)))
      .returning();

    if (!updated) {
      // A racing writer beat us between SELECT and UPDATE.
      throw new ConflictError(`Agent config "${agentId}" version mismatch (lost race during commit)`);
    }

    notifier.notifyConfigChange(`agent:${agentId}`).catch(() => {});
    return rowToConfig(updated);
  }

  async function flushAgent(agentId: string): Promise<void> {
    const slot = pending.get(agentId);
    if (!slot) return;
    pending.delete(agentId);
    if (slot.timer) clearTimeout(slot.timer);

    if (slot.awaiters.length === 0) return;

    // Each awaiter submitted its own `expectedVersion`. The burst's first
    // commit bumped the DB, so awaiters whose expectedVersion equals the
    // current version are legitimate coalescence candidates; any whose
    // expectedVersion differs raced a concurrent writer and must receive
    // their own 409 rather than silently merging into the aggregated patch.
    let current: AgentRuntimeConfig;
    try {
      current = rowToConfig(await readRow(agentId));
    } catch (err) {
      for (const a of slot.awaiters) a.reject(err);
      return;
    }

    const valid: typeof slot.awaiters = [];
    for (const a of slot.awaiters) {
      if (a.expectedVersion === current.version) {
        valid.push(a);
      } else {
        a.reject(
          new ConflictError(
            `Agent config "${agentId}" version mismatch: expected ${a.expectedVersion}, got ${current.version}`,
          ),
        );
      }
    }
    if (valid.length === 0) return;

    // Re-build the aggregated patch from only the valid awaiters' patches,
    // so a rejected caller's edit never leaks into the committed payload.
    const aggregated: AgentRuntimeConfigPatch = {};
    for (const a of valid) Object.assign(aggregated, a.patch);

    try {
      const last = valid[valid.length - 1];
      if (!last) return;
      const result = await commitWrite(agentId, aggregated, current.version, last.updatedBy);
      for (const a of valid) a.resolve(result);
    } catch (err) {
      for (const a of valid) a.reject(err);
    }
  }

  return {
    async get(agentId) {
      const row = await readRow(agentId);
      return { ...rowToConfig(row), payload: redact(row.payload) };
    },

    async getDecrypted(agentId) {
      const row = await readRow(agentId);
      return { ...rowToConfig(row), payload: decryptPayload(row.payload) };
    },

    async update(agentId, patch, updatedBy) {
      const expectedVersion = patch.expectedVersion;
      const incomingPatch = patch.payload;

      // Atomically claim "first-of-burst" before any await.
      const burstActive = burstFirstApplied.has(agentId);
      if (!burstActive) {
        // Reserve the slot synchronously to block parallel callers from
        // also entering the immediate-commit path. The actual cleanup timer
        // is installed once we know we will commit; until then the dummy
        // handle keeps the burst marker alive for the rest of this turn.
        const placeholder = setTimeout(() => {}, 0);
        burstFirstApplied.set(agentId, placeholder);
        try {
          const result = await commitWrite(agentId, incomingPatch, expectedVersion, updatedBy);
          // Replace the placeholder with the real window timer.
          clearTimeout(placeholder);
          const handle = setTimeout(() => {
            burstFirstApplied.delete(agentId);
            // Drain any pending writes accumulated during the window.
            flushAgent(agentId).catch(() => {});
          }, debounceMs);
          burstFirstApplied.set(agentId, handle);
          return { ...result, payload: redact(result.payload) };
        } catch (err) {
          // First-of-burst failed (e.g. 409). Release the slot so the next
          // caller gets a clean shot.
          clearTimeout(placeholder);
          burstFirstApplied.delete(agentId);
          throw err;
        }
      }

      // Queue into the pending slot. Each awaiter keeps its own patch +
      // expectedVersion so flushAgent can reject stale callers with 409 and
      // only coalesce the ones that actually race-safely build on the
      // current DB version.
      let slot = pending.get(agentId);
      if (!slot) {
        slot = { awaiters: [], timer: null };
        pending.set(agentId, slot);
      }
      const promise = new Promise<AgentRuntimeConfig>((resolve, reject) => {
        slot?.awaiters.push({ resolve, reject, patch: incomingPatch, expectedVersion, updatedBy });
      });
      // Reset the per-slot timer so we wait for a quiet window.
      if (slot.timer) clearTimeout(slot.timer);
      slot.timer = setTimeout(() => {
        flushAgent(agentId).catch(() => {});
      }, debounceMs);

      const result = await promise;
      return { ...result, payload: redact(result.payload) };
    },

    async dryRun(agentId, patch) {
      const row = await readRow(agentId);
      const provider = await readRuntimeProviderFor(agentId);
      const merged = applyPatch(row.payload, patch);
      const synced = { ...merged, kind: provider } as AgentRuntimeConfigPayload;
      const next = agentRuntimeConfigPayloadSchema.parse(synced);
      const diff = computeDiff(row.payload, next);
      return {
        current: { ...rowToConfig(row), payload: redact(row.payload) },
        next: redact(next),
        diff,
      };
    },

    async flush(agentId) {
      if (agentId) {
        const burstHandle = burstFirstApplied.get(agentId);
        if (burstHandle) {
          clearTimeout(burstHandle);
          burstFirstApplied.delete(agentId);
        }
        await flushAgent(agentId);
        return;
      }
      for (const id of Array.from(burstFirstApplied.keys())) {
        const h = burstFirstApplied.get(id);
        if (h) clearTimeout(h);
        burstFirstApplied.delete(id);
      }
      for (const id of Array.from(pending.keys())) {
        await flushAgent(id);
      }
    },
  };
}

/** Coarse field-level diff between two payloads — sufficient for dry-run UI. */
function computeDiff(
  a: AgentRuntimeConfigPayload,
  b: AgentRuntimeConfigPayload,
): AgentRuntimeConfigDryRunResult["diff"] {
  const out: AgentRuntimeConfigDryRunResult["diff"] = [];
  const fields = ["prompt", "model", "mcpServers", "env", "gitRepos", "reasoningEffort"] as const;
  for (const f of fields) {
    // `reasoningEffort` is absent on variants without an effort channel
    // (cursor) — diff it as undefined rather than indexing the union.
    const before = f === "reasoningEffort" ? ("reasoningEffort" in a ? a.reasoningEffort : undefined) : a[f];
    const after = f === "reasoningEffort" ? ("reasoningEffort" in b ? b.reasoningEffort : undefined) : b[f];
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      out.push({ path: f, op: "replace", before, after });
    }
  }
  return out;
}
