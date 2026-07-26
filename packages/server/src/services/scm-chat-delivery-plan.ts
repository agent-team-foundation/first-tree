import type { InvolveReason, ScmAudienceEntry } from "@first-tree/shared";

export type ScmAudienceTarget = {
  entry: ScmAudienceEntry;
  directedContext?: {
    reason: InvolveReason;
    externalUsername: string;
  } | null;
};

export type ScmDeliveryEntry = {
  senderAgentId: string;
  humanAgentId: string | null;
  wakeAgentId: string | null;
  reasons: Set<"follow" | InvolveReason>;
  involveReason: InvolveReason | null;
  involveLogin: string | null;
};

export type ScmPlannedChatDelivery = {
  chatId: string;
  created: boolean;
  entries: Map<string, ScmDeliveryEntry>;
};

export type ResolvedScmChat = { chatId: string; created: boolean };

/**
 * Provider-neutral per-processing-pass audience planner.
 *
 * It owns the invariants shared by GitHub and GitLab: actor echo pruning
 * before chat creation, provider-owned target→chat resolution, and exactly one
 * accumulated delivery per chat. Providers still own their mapping stores,
 * card content, topic projection and per-chat error telemetry.
 */
export async function planScmChatDeliveries(input: {
  targets: ScmAudienceTarget[];
  actorHumanId: string | null;
  resolveChat: (target: ScmAudienceTarget) => Promise<ResolvedScmChat | null>;
  onTargetError: (target: ScmAudienceTarget, error: unknown) => void;
  onTargetDropped?: (target: ScmAudienceTarget) => void;
}): Promise<{ deliveries: Map<string, ScmPlannedChatDelivery>; failed: number }> {
  const deliveries = new Map<string, ScmPlannedChatDelivery>();
  let failed = 0;
  for (const target of input.targets) {
    const humanAgentId = scmTargetHumanAgentId(target);
    const freshDirectedSelfInvolve = target.entry.kind === "personnel_target";
    if (input.actorHumanId && humanAgentId === input.actorHumanId && !freshDirectedSelfInvolve) {
      continue;
    }

    let resolved: ResolvedScmChat | null;
    try {
      resolved = await input.resolveChat(target);
    } catch (err) {
      failed += 1;
      input.onTargetError(target, err);
      continue;
    }
    if (!resolved) {
      input.onTargetDropped?.(target);
      continue;
    }
    let delivery = deliveries.get(resolved.chatId);
    if (!delivery) {
      delivery = { chatId: resolved.chatId, created: resolved.created, entries: new Map() };
      deliveries.set(resolved.chatId, delivery);
    } else if (resolved.created) {
      delivery.created = true;
    }
    addScmDeliveryEntry(delivery, target);
  }
  return { deliveries, failed };
}

function addScmDeliveryEntry(delivery: ScmPlannedChatDelivery, target: ScmAudienceTarget): void {
  const senderAgentId = scmTargetSenderAgentId(target);
  const humanAgentId = scmTargetHumanAgentId(target);
  const wakeAgentId = scmTargetWakeAgentId(target);
  const involveReason =
    target.entry.kind === "personnel_target" ? target.entry.reason : (target.directedContext?.reason ?? null);
  const involveLogin =
    target.entry.kind === "personnel_target"
      ? target.entry.externalUsername
      : (target.directedContext?.externalUsername ?? null);
  const key = `${senderAgentId}:${humanAgentId ?? "-"}:${wakeAgentId ?? "-"}`;
  const reasons = new Set<"follow" | InvolveReason>();
  if (target.entry.kind !== "personnel_target") reasons.add("follow");
  if (involveReason) reasons.add(involveReason);
  const existing = delivery.entries.get(key);
  if (existing) {
    for (const reason of reasons) existing.reasons.add(reason);
    if (
      involveReason &&
      (!existing.involveReason || involveReasonRank(involveReason) < involveReasonRank(existing.involveReason))
    ) {
      existing.involveReason = involveReason;
      existing.involveLogin = involveLogin;
    }
    return;
  }
  delivery.entries.set(key, {
    senderAgentId,
    humanAgentId,
    wakeAgentId,
    reasons,
    involveReason,
    involveLogin,
  });
}

export function scmTargetHumanAgentId(target: ScmAudienceTarget): string | null {
  switch (target.entry.kind) {
    case "existing_line":
      return target.entry.line.humanAgentId;
    case "personnel_target":
      return target.entry.humanAgentId;
    case "legacy_route":
      return null;
  }
}

export function scmTargetWakeAgentId(target: ScmAudienceTarget): string | null {
  switch (target.entry.kind) {
    case "existing_line":
      return target.entry.line.wakeAgentId;
    case "personnel_target":
      return target.entry.wakeAgentId;
    case "legacy_route":
      return null;
  }
}

export function scmTargetSenderAgentId(target: ScmAudienceTarget): string {
  switch (target.entry.kind) {
    case "existing_line":
      return target.entry.line.humanAgentId;
    case "personnel_target":
      return target.entry.humanAgentId;
    case "legacy_route":
      return target.entry.route.senderAgentId;
  }
}

export function compareScmDeliveryEntries(a: ScmDeliveryEntry, b: ScmDeliveryEntry): number {
  return (
    (a.humanAgentId ?? a.senderAgentId).localeCompare(b.humanAgentId ?? b.senderAgentId) ||
    (a.wakeAgentId ?? "").localeCompare(b.wakeAgentId ?? "")
  );
}

export function selectScmSenderId(entries: ScmDeliveryEntry[]): string {
  const first = entries[0];
  if (!first) throw new Error("delivery plan must have at least one surviving entry");
  return first.senderAgentId;
}

export function selectScmCardContext(entries: ScmDeliveryEntry[]): {
  involveReason: InvolveReason | null;
  involveLogin: string | null;
} {
  const involved = [...entries]
    .filter((entry) => entry.involveReason)
    .sort(
      (a, b) =>
        involveReasonRank(a.involveReason) - involveReasonRank(b.involveReason) || compareScmDeliveryEntries(a, b),
    )[0];
  return { involveReason: involved?.involveReason ?? null, involveLogin: involved?.involveLogin ?? null };
}

export function scmWakeAgentIds(entries: ScmDeliveryEntry[]): string[] {
  return [...new Set(entries.flatMap((entry) => (entry.wakeAgentId ? [entry.wakeAgentId] : [])))].sort();
}

function involveReasonRank(reason: InvolveReason | null): number {
  switch (reason) {
    case "review_requested":
      return 0;
    case "mentioned":
      return 1;
    case "assigned":
      return 2;
    default:
      return 3;
  }
}
