import type { Agent } from "@agent-team-foundation/first-tree-hub-shared";
import type { ReactNode } from "react";

/**
 * Overview — the first section the operator sees below the ProfileHeader.
 * Surfaces the "who / what is this agent" question. Status & health moved
 * into the ProfileHeader (stats row + StateChip + Test button) so this
 * section stays focused on Profile editing + Platform bindings.
 *
 * Identity editing keeps its own Dialog (IdentitySection) so the SaveBar
 * stays config-only.
 */

export type OverviewSectionProps = {
  agent: Agent;
  profileSlot: ReactNode;
  /** Platform bindings panel (Panel component) — rendered inline inside the Profile card. */
  bindingsSlot?: ReactNode;
  isHuman: boolean;
};

export function OverviewSection(props: OverviewSectionProps) {
  return (
    <div className="space-y-3">
      {props.profileSlot}
      {props.bindingsSlot}
    </div>
  );
}
