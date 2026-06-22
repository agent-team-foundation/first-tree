import { AGENT_VISIBILITY, type Agent } from "@first-tree/shared";
import { Pencil } from "lucide-react";
import type { ReactNode } from "react";
import { AgentChip } from "../../components/agent-chip.js";
import { Avatar } from "../../components/avatar.js";
import { Button } from "../../components/ui/button.js";
import { DenseBadge } from "../../components/ui/dense-badge.js";
import { Section } from "../../components/ui/section.js";
import { useAgentIdentityMap } from "../../lib/use-agent-name-map.js";
import { useMemberNameMap } from "../../lib/use-member-name-map.js";
import { titleWithSemantics } from "./save-semantics.js";

const VISIBILITY_COPY = {
  [AGENT_VISIBILITY.ORGANIZATION]: { label: "Visible to your team" },
  [AGENT_VISIBILITY.PRIVATE]: { label: "Private to you" },
} as const;

/**
 * Identity — a compact field summary. Editing is handled by the unified
 * ProfileEditDialog owned by the Profile tab (identity + appearance in one
 * Edit), so this component is display-only and surfaces a single Edit entry
 * via `onEdit`.
 */
export type IdentitySectionProps = {
  agent: Agent;
  canEdit?: boolean;
  /** Opens the unified Profile edit dialog; omit to hide the Edit affordance. */
  onEdit?: () => void;
  /** Flash a "Saved" tag after a successful immediate save. */
  saved?: boolean;
  title?: string;
  description?: ReactNode;
  aside?: ReactNode;
};

export function IdentitySection({
  agent,
  canEdit = true,
  onEdit,
  saved = false,
  title = "Identity",
  description,
  aside,
}: IdentitySectionProps) {
  const resolveAgent = useAgentIdentityMap();
  const resolveMember = useMemberNameMap();

  const metadata = agent.metadata as Record<string, unknown> | undefined;
  const treeMeta = metadata?.tree as Record<string, unknown> | undefined;
  const role = typeof treeMeta?.role === "string" ? treeMeta.role : null;
  const domains = Array.isArray(treeMeta?.domains)
    ? (treeMeta?.domains as unknown[]).filter((d): d is string => typeof d === "string")
    : [];
  const managerName = agent.managerId ? resolveMember(agent.managerId) : null;
  const delegateIdentity = agent.delegateMention ? resolveAgent(agent.delegateMention) : null;
  const handle = agent.name ?? agent.uuid.slice(0, 8);
  const hasOrganizationContext = role || domains.length > 0;

  const action =
    canEdit && onEdit && agent.status === "active" ? (
      <Button size="xs" variant="outline" onClick={onEdit}>
        <Pencil className="h-3 w-3" /> Edit
      </Button>
    ) : null;

  return (
    <Section title={titleWithSemantics(title, saved)} description={description} action={action}>
      <div
        className={aside ? "grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(18rem,0.85fr)] lg:gap-8" : undefined}
        style={{ padding: "var(--sp-3) 0" }}
      >
        <div className="min-w-0">
          <div className={aside ? "grid gap-0" : "grid gap-0 md:grid-cols-2 md:gap-x-8"}>
            <IdentityField label="Display name">{agent.displayName}</IdentityField>
            <IdentityField label="Agent name">
              <span className="mono">@{handle}</span>
            </IdentityField>
            <IdentityField label="Visibility">
              <VisibilityBadge visibility={agent.visibility} />
            </IdentityField>
            <IdentityField label="Owner">
              <MemberReference memberId={agent.managerId} name={managerName ?? "—"} />
            </IdentityField>
            {delegateIdentity && (
              <IdentityField label="Delegate">
                <AgentChip name={delegateIdentity.name} displayName={delegateIdentity.displayName} />
              </IdentityField>
            )}
            {hasOrganizationContext && (
              <IdentityField label="Context">
                <span className="inline-flex flex-wrap gap-1.5 align-middle">
                  {role && <DenseBadge tone="outline">{role}</DenseBadge>}
                  {domains.map((d) => (
                    <DenseBadge key={d} tone="outline">
                      {humanizeDomain(d)}
                    </DenseBadge>
                  ))}
                </span>
              </IdentityField>
            )}
          </div>
        </div>
        {aside && (
          <div
            className="min-w-0 lg:flex lg:items-center lg:border-l lg:pl-8"
            style={{ borderColor: "var(--border-faint)" }}
          >
            {aside}
          </div>
        )}
      </div>
    </Section>
  );
}

/**
 * Domain tags come from `metadata.tree.domains` and mirror the Context Tree's
 * top-level directory names. They're free-form strings, not a closed enum, so
 * we lean on a lightweight transform: kebab/snake → spaces, then capitalize.
 */
function humanizeDomain(domain: string): string {
  if (!domain) return domain;
  const spaced = domain.replace(/[-_]+/g, " ").trim();
  if (!spaced) return domain;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function VisibilityBadge({ visibility }: { visibility: Agent["visibility"] }) {
  return (
    <DenseBadge tone={visibility === AGENT_VISIBILITY.ORGANIZATION ? "accent" : "outline"}>
      {VISIBILITY_COPY[visibility].label}
    </DenseBadge>
  );
}

function IdentityField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      className="grid min-w-0 grid-cols-1 items-baseline gap-1 sm:grid-cols-[var(--agent-detail-label-col)_minmax(0,1fr)] sm:gap-4"
      style={{ padding: "var(--sp-2) 0", borderBottom: "var(--hairline) solid var(--border-faint)" }}
    >
      <div className="text-body truncate" style={{ color: "var(--fg-3)" }}>
        {label}
      </div>
      <div
        className="min-w-0 text-body font-medium"
        style={{ color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        {children}
      </div>
    </div>
  );
}

function MemberReference({ memberId, name }: { memberId: string | null | undefined; name: string }) {
  if (!memberId) return <span>—</span>;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 align-middle">
      <Avatar name={name} seed={memberId} size={18} />
      <span className="truncate">{name}</span>
    </span>
  );
}
