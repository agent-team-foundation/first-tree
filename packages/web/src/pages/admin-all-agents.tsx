import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { listAllAgentsForAdmin } from "../api/agents.js";
import { DenseBadge } from "../components/ui/dense-badge.js";
import {
  DenseTable,
  DenseTableBody,
  DenseTableCell,
  DenseTableHead,
  DenseTableHeader,
  DenseTableRow,
} from "../components/ui/dense-table.js";
import { Panel } from "../components/ui/panel.js";
import { SectionHeader } from "../components/ui/section-header.js";
import { useMemberNameMap } from "../lib/use-member-name-map.js";
import { formatDate } from "../lib/utils.js";

/**
 * Admin-only view of every agent in the organization, including private ones
 * owned by other members.
 */
export function AdminAllAgentsPage() {
  const navigate = useNavigate();
  const resolveMember = useMemberNameMap();

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-all-agents"],
    queryFn: () => listAllAgentsForAdmin({ limit: 100 }),
  });

  return (
    <div>
      <p className="text-label" style={{ color: "var(--fg-3)", padding: "0 var(--sp-0_5) var(--sp-2_5)" }}>
        Every agent in the organization — including private agents owned by other members. Use this view to troubleshoot
        or reassign.
      </p>

      <Panel>
        <SectionHeader>All agents · {data?.items.length ?? 0}</SectionHeader>
        {isLoading ? (
          <div className="text-center py-8 text-body" style={{ color: "var(--fg-3)" }}>
            Loading…
          </div>
        ) : error ? (
          <div className="text-center py-8 text-body" style={{ color: "var(--state-error)" }}>
            Failed to load agents: {error instanceof Error ? error.message : "Unknown error"}
          </div>
        ) : !data || data.items.length === 0 ? (
          <div className="text-center py-8 text-body" style={{ color: "var(--fg-3)" }}>
            No agents
          </div>
        ) : (
          <DenseTable>
            <DenseTableHeader>
              <DenseTableRow>
                <DenseTableHead>Name</DenseTableHead>
                <DenseTableHead>Display</DenseTableHead>
                <DenseTableHead>Type</DenseTableHead>
                <DenseTableHead>Visibility</DenseTableHead>
                <DenseTableHead>Owner</DenseTableHead>
                <DenseTableHead>Status</DenseTableHead>
                <DenseTableHead>Created</DenseTableHead>
              </DenseTableRow>
            </DenseTableHeader>
            <DenseTableBody>
              {data.items.map((a) => (
                <DenseTableRow
                  key={a.uuid}
                  interactive
                  onClick={() => navigate(`/agents/${encodeURIComponent(a.uuid)}`)}
                >
                  <DenseTableCell>
                    <span className="mono font-medium">{a.name ?? a.uuid.slice(0, 8)}</span>
                  </DenseTableCell>
                  <DenseTableCell style={{ color: "var(--fg-2)" }}>{a.displayName ?? "—"}</DenseTableCell>
                  <DenseTableCell>
                    <DenseBadge tone={a.type === "autonomous_agent" ? "accent" : "neutral"}>{a.type}</DenseBadge>
                  </DenseTableCell>
                  <DenseTableCell>
                    <DenseBadge tone={a.visibility === "organization" ? "accent" : "outline"}>
                      {a.visibility}
                    </DenseBadge>
                  </DenseTableCell>
                  <DenseTableCell className="text-label" style={{ color: "var(--fg-2)" }}>
                    {a.managerId ? resolveMember(a.managerId) : "—"}
                  </DenseTableCell>
                  <DenseTableCell>
                    <DenseBadge tone={a.status === "active" ? "accent" : "neutral"}>{a.status}</DenseBadge>
                  </DenseTableCell>
                  <DenseTableCell className="mono text-caption" style={{ color: "var(--fg-4)" }}>
                    {formatDate(a.createdAt)}
                  </DenseTableCell>
                </DenseTableRow>
              ))}
            </DenseTableBody>
          </DenseTable>
        )}
      </Panel>
    </div>
  );
}
