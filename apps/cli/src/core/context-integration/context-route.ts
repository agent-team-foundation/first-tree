import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type ContextIntegrationProject,
  type ContextIntegrationProvider,
  type ContextTreeActiveBinding,
  contextIntegrationProjectSchema,
  contextIntegrationProviderSchema,
  contextRouteCandidatesResponseSchema,
  contextTreeActiveBindingSchema,
  credentialFreeRepositoryUrlSchema,
  parseContextTreeScopeMarkdown,
} from "@first-tree/shared";
import { defaultHome } from "@first-tree/shared/config";
import { z } from "zod";
import { readActiveContextAccountClientId } from "./account-state-guard.js";
import { assertContextAdapterReadyForRouting } from "./adapter-observation.js";
import { resolveContextGrantCandidates } from "./context-binding-store.js";
import { fetchExactScope } from "./exact-root-scope.js";

const ROUTE_RECEIPT_TTL_MS = 24 * 60 * 60_000;
const EXACT_COMMIT_RE = /^[0-9a-f]{40,64}$/u;

export type ContextRouteReader = {
  validateMemberContextRouteCandidates?(
    request: { schemaVersion: 1; organizationIds: string[] },
    options: { retry: false; timeoutMs: number },
  ): Promise<unknown>;
  validateMemberContextActivation(
    teamId: string,
    request: { schemaVersion: 2 },
    options: { retry: false; timeoutMs: number },
  ): Promise<unknown>;
  validateMemberContextSessionCandidate?(
    request: {
      schemaVersion: 1;
      provider: ContextIntegrationProvider;
      project: ContextIntegrationProject;
      receipt: string;
    },
    options: { retry: false; timeoutMs: number },
  ): Promise<unknown>;
  getMemberContextTreeSetting(teamId: string, options: { retry: false }): Promise<unknown>;
};

export type ContextRouteCandidate = {
  candidateId: string;
  accountClientId: string;
  provider: ContextIntegrationProvider;
  project: ContextIntegrationProject;
  organizationId: string;
  team: { displayName: string; role: string };
  source: "session" | "directory" | "global";
  binding: ContextTreeActiveBinding;
  commit: string;
  scope: { schemaVersion: 1; relatedRepositories: string[]; body: string };
  createdAt: string;
};

export type ContextRouteResult = {
  schemaVersion: 1;
  consumerKind: "byo";
  provider: ContextIntegrationProvider;
  project: ContextIntegrationProject;
  candidates: ContextRouteCandidate[];
  unavailable: Array<{ organizationId: string; reason: string }>;
  selectionBlocked: boolean;
  instruction: string;
};

const contextRouteCandidateSchema = z
  .object({
    candidateId: z.uuid(),
    accountClientId: z.string().regex(/^client_[a-f0-9]{8}$/u),
    provider: contextIntegrationProviderSchema,
    project: contextIntegrationProjectSchema,
    organizationId: z.string().min(1),
    team: z.object({ displayName: z.string().min(1), role: z.enum(["admin", "member"]) }).strict(),
    source: z.enum(["session", "directory", "global"]),
    binding: contextTreeActiveBindingSchema,
    commit: z.string().regex(EXACT_COMMIT_RE),
    scope: z
      .object({
        schemaVersion: z.literal(1),
        relatedRepositories: z.array(credentialFreeRepositoryUrlSchema).max(64),
        body: z.string().min(1),
      })
      .strict(),
    createdAt: z.iso.datetime(),
  })
  .strict();

export async function resolveContextRoute(
  reader: ContextRouteReader,
  input: {
    provider: ContextIntegrationProvider;
    project: ContextIntegrationProject;
    sessionCandidateReceipt?: string;
  },
  dependencies: {
    fetchScope?: typeof fetchExactScope;
    readAccountClientId?: typeof readActiveContextAccountClientId;
    assertAdapterReady?: typeof assertContextAdapterReadyForRouting;
  } = {},
): Promise<ContextRouteResult> {
  const readScope = dependencies.fetchScope ?? fetchExactScope;
  const accountClientId = (dependencies.readAccountClientId ?? readActiveContextAccountClientId)();
  if (input.sessionCandidateReceipt) {
    if (!reader.validateMemberContextSessionCandidate) {
      throw new Error("This First Tree client cannot validate a session-only Context candidate.");
    }
    const response = contextRouteCandidatesResponseSchema.parse(
      await reader.validateMemberContextSessionCandidate(
        {
          schemaVersion: 1,
          provider: input.provider,
          project: input.project,
          receipt: input.sessionCandidateReceipt,
        },
        { retry: false, timeoutMs: 10_000 },
      ),
    );
    if (response.candidates.length !== 1 || !response.candidates[0]) {
      throw new Error("The Server returned an invalid session-only Context candidate set.");
    }
    return materializeValidatedCandidates(
      input,
      response,
      new Map([[response.candidates[0].organizationId, "session"]]),
      readScope,
      accountClientId,
    );
  }
  (dependencies.assertAdapterReady ?? assertContextAdapterReadyForRouting)(input.provider);
  const localCandidates = resolveContextGrantCandidates(input.provider, input.project).map((match) => ({
    organizationId: match.grant.organizationId,
    source: match.priority,
  }));
  const candidates: ContextRouteCandidate[] = [];
  const unavailable: ContextRouteResult["unavailable"] = [];
  if (reader.validateMemberContextRouteCandidates && localCandidates.length > 0) {
    const response = contextRouteCandidatesResponseSchema.parse(
      await reader.validateMemberContextRouteCandidates(
        { schemaVersion: 1, organizationIds: localCandidates.map((candidate) => candidate.organizationId) },
        { retry: false, timeoutMs: 10_000 },
      ),
    );
    const sources = new Map(localCandidates.map((candidate) => [candidate.organizationId, candidate.source]));
    assertExactCandidateIdentities(
      localCandidates.map((candidate) => candidate.organizationId),
      response,
    );
    return materializeValidatedCandidates(input, response, sources, readScope, accountClientId);
  }
  for (const local of localCandidates) {
    try {
      const activation = parseConnectedActivation(
        await reader.validateMemberContextActivation(
          local.organizationId,
          { schemaVersion: 2 },
          { retry: false, timeoutMs: 5_000 },
        ),
      );
      const binding = contextTreeActiveBindingSchema.parse(
        await reader.getMemberContextTreeSetting(local.organizationId, { retry: false }),
      );
      const exact = readScope(binding);
      const candidate: ContextRouteCandidate = {
        candidateId: randomUUID(),
        accountClientId,
        provider: input.provider,
        project: input.project,
        organizationId: local.organizationId,
        team: { displayName: activation.team.displayName, role: activation.team.role },
        source: local.source,
        binding,
        commit: exact.commit,
        scope: exact.scope,
        createdAt: new Date().toISOString(),
      };
      writeRouteReceipt(candidate);
      candidates.push(candidate);
    } catch (error) {
      unavailable.push({ organizationId: local.organizationId, reason: message(error) });
    }
  }
  return routeResult(input, candidates, unavailable);
}

function routeResult(
  input: { provider: ContextIntegrationProvider; project: ContextIntegrationProject },
  candidates: ContextRouteCandidate[],
  unavailable: ContextRouteResult["unavailable"],
): ContextRouteResult {
  return {
    schemaVersion: 1,
    consumerKind: "byo",
    provider: input.provider,
    project: input.project,
    candidates,
    unavailable,
    selectionBlocked: unavailable.length > 0,
    instruction:
      unavailable.length > 0
        ? "Automatic selection is blocked because at least one highest-priority authorized candidate is unavailable. Ask the user; unavailable candidates cannot be selected, and no remaining candidate may be selected automatically. Do not read a full Tree before selection."
        : "Read each candidate's complete SCOPE body as routing information only. Select a candidate only when exactly one clearly matches the current task; otherwise ask the user. Do not read a full Tree before selection.",
  };
}

function assertExactCandidateIdentities(
  requestedOrganizationIds: string[],
  response: ReturnType<typeof contextRouteCandidatesResponseSchema.parse>,
): void {
  const returned = response.candidates.map((candidate) => candidate.organizationId);
  if (
    returned.length !== requestedOrganizationIds.length ||
    returned.some((organizationId, index) => organizationId !== requestedOrganizationIds[index])
  ) {
    throw new Error("The Server's Context candidate response did not exactly match the locally authorized Team set.");
  }
}

function materializeValidatedCandidates(
  input: { provider: ContextIntegrationProvider; project: ContextIntegrationProject },
  response: ReturnType<typeof contextRouteCandidatesResponseSchema.parse>,
  sources: Map<string, "session" | "directory" | "global">,
  readScope: typeof fetchExactScope,
  accountClientId: string,
): ContextRouteResult {
  const candidates: ContextRouteCandidate[] = [];
  const unavailable: ContextRouteResult["unavailable"] = [];
  for (const resolved of response.candidates) {
    const source = sources.get(resolved.organizationId);
    if (!source) throw new Error("The Server returned a Context Team that was not locally authorized.");
    if (resolved.outcome !== "connected") {
      unavailable.push({ organizationId: resolved.organizationId, reason: resolved.message });
      continue;
    }
    try {
      const exact = readScope(resolved.binding);
      const candidate: ContextRouteCandidate = {
        candidateId: randomUUID(),
        accountClientId,
        provider: input.provider,
        project: input.project,
        organizationId: resolved.organizationId,
        team: { displayName: resolved.team.displayName, role: resolved.team.role },
        source,
        binding: resolved.binding,
        commit: exact.commit,
        scope: exact.scope,
        createdAt: new Date().toISOString(),
      };
      writeRouteReceipt(candidate);
      candidates.push(candidate);
    } catch (error) {
      unavailable.push({ organizationId: resolved.organizationId, reason: message(error) });
    }
  }
  return routeResult(input, candidates, unavailable);
}

export function readContextRouteReceipt(
  candidateId: string,
  expectedAccountClientId = readActiveContextAccountClientId(),
): ContextRouteCandidate {
  if (!/^[0-9a-f-]{36}$/iu.test(candidateId)) throw new Error("Invalid Context route candidate id.");
  const path = routeReceiptPath(candidateId);
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isFile() || (process.platform !== "win32" && (entry.mode & 0o077) !== 0)) {
    throw new Error("Context route candidate receipt is not a private regular file. Run context route again.");
  }
  const parsed = contextRouteCandidateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  if (
    parsed.candidateId !== candidateId ||
    parsed.accountClientId !== expectedAccountClientId ||
    !Number.isFinite(Date.parse(parsed.createdAt)) ||
    Date.now() - Date.parse(parsed.createdAt) > ROUTE_RECEIPT_TTL_MS ||
    !EXACT_COMMIT_RE.test(parsed.commit)
  ) {
    throw new Error("Context route candidate receipt is invalid or expired. Run context route again.");
  }
  parseContextTreeScopeMarkdown(
    `---\nschemaVersion: 1${parsed.scope.relatedRepositories.length ? `\nrelatedRepositories:\n${parsed.scope.relatedRepositories.map((url) => `  - ${url}`).join("\n")}` : ""}\n---\n${parsed.scope.body}`,
  );
  return parsed;
}

function writeRouteReceipt(candidate: ContextRouteCandidate): void {
  const path = routeReceiptPath(candidate.candidateId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(candidate)}\n`, { mode: 0o600, flag: "wx" });
}

function routeReceiptPath(candidateId: string): string {
  return join(defaultHome(), "state", "context", "route-receipts", `${candidateId}.json`);
}

function parseConnectedActivation(value: unknown): { team: { displayName: string; role: string } } {
  if (typeof value !== "object" || value === null || Reflect.get(value, "outcome") !== "connected") {
    const nextAction = typeof value === "object" && value !== null ? Reflect.get(value, "nextAction") : null;
    const reason =
      typeof nextAction === "object" && nextAction !== null && typeof Reflect.get(nextAction, "message") === "string"
        ? String(Reflect.get(nextAction, "message"))
        : "Team activation is not connected.";
    throw new Error(reason);
  }
  const team = Reflect.get(value, "team");
  if (
    typeof team !== "object" ||
    team === null ||
    typeof Reflect.get(team, "displayName") !== "string" ||
    typeof Reflect.get(team, "role") !== "string"
  ) {
    throw new Error("Team activation response is incomplete.");
  }
  return { team: { displayName: String(Reflect.get(team, "displayName")), role: String(Reflect.get(team, "role")) } };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
