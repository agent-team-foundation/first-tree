import type { InvolveReason } from "@first-tree/shared";
import type { ScmAudienceTarget } from "./scm-audience-composition.js";

export type { ScmAudienceTarget } from "./scm-audience-composition.js";

export type ScmWakeEligibility = "eligible" | "actor_echo_suppressed" | "route_only";

export type ScmDeliveryEntry<TProviderContext = never> = {
  senderAgentId: string;
  humanAgentId: string | null;
  wakeAgentId: string | null;
  wakeEligibility: ScmWakeEligibility;
  reasons: Set<"follow" | InvolveReason>;
  involveReason: InvolveReason | null;
  involveLogin: string | null;
  providerContext: TProviderContext | null;
};

export type ScmPlannedChatDelivery<TProviderContext = never> = {
  chatId: string;
  created: boolean;
  entries: Map<string, ScmDeliveryEntry<TProviderContext>>;
};

export type ResolvedScmChat = {
  chatId: string;
  created: boolean;
  /** Personnel resolution re-used an exact line that predated this event. */
  personnelLineExisted?: boolean;
};

/**
 * Provider-neutral per-processing-pass audience planner.
 *
 * It keeps card routes separate from wake eligibility: actor echo suppresses
 * only an existing line's wake, while the line still contributes its route and
 * card context. Providers still own target-to-chat persistence, card content,
 * topic projection, and opaque provider task capabilities.
 */
export async function planScmChatDeliveries<TProviderContext = never>(input: {
  targets: ScmAudienceTarget<TProviderContext>[];
  actorHumanId: string | null;
  resolveChat: (target: ScmAudienceTarget<TProviderContext>) => Promise<ResolvedScmChat | null>;
  onTargetError: (target: ScmAudienceTarget<TProviderContext>, error: unknown) => void;
  onTargetDropped?: (target: ScmAudienceTarget<TProviderContext>) => void;
}): Promise<{ deliveries: Map<string, ScmPlannedChatDelivery<TProviderContext>>; failed: number }> {
  const deliveries = new Map<string, ScmPlannedChatDelivery<TProviderContext>>();
  let failed = 0;
  for (const target of input.targets) {
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
    addScmDeliveryEntry(delivery, target, input.actorHumanId, resolved);
  }
  return { deliveries, failed };
}

function addScmDeliveryEntry<TProviderContext>(
  delivery: ScmPlannedChatDelivery<TProviderContext>,
  target: ScmAudienceTarget<TProviderContext>,
  actorHumanId: string | null,
  resolved: ResolvedScmChat,
): void {
  const senderAgentId = scmTargetSenderAgentId(target);
  const humanAgentId = scmTargetHumanAgentId(target);
  const wakeAgentId = scmTargetWakeAgentId(target);
  // Only personnel evidence carries card context. A provider task contributes
  // its wake and capability, leaving the card to read `subscribed` with the
  // event's real kind unless a real person is also routed to this chat.
  const involveReason =
    target.entry.kind === "personnel_target" ? target.entry.reason : (target.directedContext?.reason ?? null);
  const involveLogin =
    target.entry.kind === "personnel_target"
      ? target.entry.externalUsername
      : (target.directedContext?.externalUsername ?? null);
  const providerContext = target.entry.kind === "provider_task_target" ? target.entry.providerContext : null;
  const wakeEligibility = scmWakeEligibility(target, actorHumanId, resolved);
  const key = `${senderAgentId}:${humanAgentId ?? "-"}:${wakeAgentId ?? "-"}`;
  const reasons = new Set<"follow" | InvolveReason>();
  if (target.entry.kind === "existing_line" || target.entry.kind === "legacy_route") reasons.add("follow");
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
    if (wakeEligibilityRank(wakeEligibility) < wakeEligibilityRank(existing.wakeEligibility)) {
      existing.wakeEligibility = wakeEligibility;
    }
    existing.providerContext ??= providerContext;
    return;
  }
  delivery.entries.set(key, {
    senderAgentId,
    humanAgentId,
    wakeAgentId,
    wakeEligibility,
    reasons,
    involveReason,
    involveLogin,
    providerContext,
  });
}

function scmWakeEligibility<TProviderContext>(
  target: ScmAudienceTarget<TProviderContext>,
  actorHumanId: string | null,
  resolved: ResolvedScmChat,
): ScmWakeEligibility {
  if (target.entry.kind === "legacy_route") return "route_only";
  if (
    (target.entry.kind === "existing_line" || resolved.personnelLineExisted === true) &&
    actorHumanId !== null &&
    scmTargetHumanAgentId(target) === actorHumanId
  ) {
    return "actor_echo_suppressed";
  }
  return "eligible";
}

export function scmTargetHumanAgentId<TProviderContext>(target: ScmAudienceTarget<TProviderContext>): string | null {
  switch (target.entry.kind) {
    case "existing_line":
      return target.entry.line.humanAgentId;
    case "personnel_target":
    case "provider_task_target":
      return target.entry.humanAgentId;
    case "legacy_route":
      return null;
  }
}

export function scmTargetWakeAgentId<TProviderContext>(target: ScmAudienceTarget<TProviderContext>): string | null {
  switch (target.entry.kind) {
    case "existing_line":
      return target.entry.line.wakeAgentId;
    case "personnel_target":
    case "provider_task_target":
      return target.entry.wakeAgentId;
    case "legacy_route":
      return null;
  }
}

export function scmTargetSenderAgentId<TProviderContext>(target: ScmAudienceTarget<TProviderContext>): string {
  switch (target.entry.kind) {
    case "existing_line":
      return target.entry.line.humanAgentId;
    case "personnel_target":
    case "provider_task_target":
      return target.entry.humanAgentId;
    case "legacy_route":
      return target.entry.route.senderAgentId;
  }
}

export function compareScmDeliveryEntries<TProviderContext>(
  a: ScmDeliveryEntry<TProviderContext>,
  b: ScmDeliveryEntry<TProviderContext>,
): number {
  return (
    (a.humanAgentId ?? a.senderAgentId).localeCompare(b.humanAgentId ?? b.senderAgentId) ||
    (a.wakeAgentId ?? "").localeCompare(b.wakeAgentId ?? "")
  );
}

export function selectScmSenderId<TProviderContext>(entries: ScmDeliveryEntry<TProviderContext>[]): string {
  const first = [...entries].sort(
    (a, b) =>
      wakeEligibilityRank(a.wakeEligibility) - wakeEligibilityRank(b.wakeEligibility) ||
      compareScmDeliveryEntries(a, b),
  )[0];
  if (!first) throw new Error("delivery plan must have at least one routed entry");
  return first.senderAgentId;
}

export function selectScmCardContext<TProviderContext>(entries: ScmDeliveryEntry<TProviderContext>[]): {
  involveReason: InvolveReason | null;
  involveLogin: string | null;
} {
  const involved = [...entries]
    .filter((entry) => entry.involveReason)
    .sort(
      (a, b) =>
        involveReasonRank(a.involveReason) - involveReasonRank(b.involveReason) || compareScmDeliveryEntries(a, b),
    )[0];
  return {
    involveReason: involved?.involveReason ?? null,
    involveLogin: involved?.involveLogin ?? null,
  };
}

export function scmProviderContextEntries<TProviderContext>(
  entries: ScmDeliveryEntry<TProviderContext>[],
): Array<ScmDeliveryEntry<TProviderContext> & { providerContext: TProviderContext }> {
  return entries.filter(
    (entry): entry is ScmDeliveryEntry<TProviderContext> & { providerContext: TProviderContext } =>
      entry.providerContext !== null,
  );
}

export function scmWakeAgentIds<TProviderContext>(entries: ScmDeliveryEntry<TProviderContext>[]): string[] {
  return [
    ...new Set(
      entries.flatMap((entry) =>
        entry.wakeEligibility === "eligible" && entry.wakeAgentId ? [entry.wakeAgentId] : [],
      ),
    ),
  ].sort();
}

function wakeEligibilityRank(eligibility: ScmWakeEligibility): number {
  switch (eligibility) {
    case "eligible":
      return 0;
    case "actor_echo_suppressed":
      return 1;
    case "route_only":
      return 2;
  }
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
