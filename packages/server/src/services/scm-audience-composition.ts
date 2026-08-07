import type { InvolveReason, ScmAudienceEntry } from "@first-tree/shared";

type ExistingScmAudienceEntry = Exclude<ScmAudienceEntry, { kind: "personnel_target" }>;
export type ScmPersonnelTarget = Extract<ScmAudienceEntry, { kind: "personnel_target" }>;

export type ScmDirectedContext = {
  reason: InvolveReason;
  requiresPersistentLine: boolean;
  externalUsername: string;
};

/**
 * A provider-owned automatic capability route. Deliberately carries no
 * `reason` / `externalUsername`: the task exists because the provider decided
 * this entity belongs to a role, not because a person was named. Personnel card
 * context stays with real `personnel_target` evidence, so a task-only chat
 * cannot show an invented mention or assignment.
 */
export type ScmProviderTaskTarget<TProviderContext> = {
  kind: "provider_task_target";
  humanAgentId: string;
  wakeAgentId: string;
  providerContext: TProviderContext;
};

export type ScmAudienceTarget<TProviderContext = never> =
  | {
      entry: ExistingScmAudienceEntry | ScmPersonnelTarget;
      directedContext?: ScmDirectedContext | null;
    }
  | {
      entry: ScmProviderTaskTarget<TProviderContext>;
      directedContext?: never;
    };

/**
 * Compose provider-resolved attention lines and directed targets once for all
 * SCM providers. Existing and legacy routes retain their distinct chat lines;
 * only an exact human/wake pair can carry personnel context.
 */
export function composeScmAudience<TProviderContext = never>(input: {
  existingEntries: ExistingScmAudienceEntry[];
  personnelTargets: ScmPersonnelTarget[];
  providerTaskTargets?: ScmProviderTaskTarget<TProviderContext>[];
}): ScmAudienceTarget<TProviderContext>[] {
  const targets: ScmAudienceTarget<TProviderContext>[] = [];
  const existingKeys = new Set<string>();
  for (const entry of input.existingEntries) {
    const key = existingEntryKey(entry);
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);
    targets.push({ entry });
  }

  const personnelByPair = new Map<string, ScmPersonnelTarget>();
  for (const target of input.personnelTargets) {
    const pair = attentionPairKey(target.humanAgentId, target.wakeAgentId);
    const current = personnelByPair.get(pair);
    if (!current) {
      personnelByPair.set(pair, target);
      continue;
    }
    const displayTarget = comparePersonnelTargets(target, current) < 0 ? target : current;
    personnelByPair.set(pair, {
      ...displayTarget,
      requiresPersistentLine: current.requiresPersistentLine || target.requiresPersistentLine,
    });
  }

  for (const [pair, personnelTarget] of [...personnelByPair.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    let matched = false;
    for (const target of targets) {
      if (target.entry.kind !== "existing_line") continue;
      if (attentionPairKey(target.entry.line.humanAgentId, target.entry.line.wakeAgentId) !== pair) {
        continue;
      }
      matched = true;
      target.directedContext = {
        reason: personnelTarget.reason,
        requiresPersistentLine: personnelTarget.requiresPersistentLine,
        externalUsername: personnelTarget.externalUsername,
      };
    }
    if (!matched) targets.push({ entry: personnelTarget });
  }

  for (const providerTaskTarget of input.providerTaskTargets ?? []) {
    targets.push({ entry: providerTaskTarget });
  }
  return targets;
}

function existingEntryKey(entry: ExistingScmAudienceEntry): string {
  if (entry.kind === "existing_line") {
    const line = entry.line;
    return ["line", line.humanAgentId, line.wakeAgentId, line.chatId, line.provenance].join(":");
  }
  const route = entry.route;
  return ["legacy", route.chatId, route.senderAgentId, route.provenance].join(":");
}

function attentionPairKey(humanAgentId: string, wakeAgentId: string): string {
  return `${humanAgentId}\u0000${wakeAgentId}`;
}

function comparePersonnelTargets(a: ScmPersonnelTarget, b: ScmPersonnelTarget): number {
  return (
    involveReasonRank(a.reason) - involveReasonRank(b.reason) || a.externalUsername.localeCompare(b.externalUsername)
  );
}

function involveReasonRank(reason: InvolveReason): number {
  switch (reason) {
    case "review_requested":
      return 0;
    case "mentioned":
      return 1;
    case "assigned":
      return 2;
  }
}
