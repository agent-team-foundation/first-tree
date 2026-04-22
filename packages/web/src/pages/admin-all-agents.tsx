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
      <p style={{ fontSize: 11.5, color: "var(--fg-3)", padding: "0 2px 10px" }}>
        Every agent in the organization — including private agents owned by other members. Use this view to troubleshoot
        or reassign.
      </p>

      <Panel>
        <SectionHeader>All agents · {data?.items.length ?? 0}</SectionHeader>
        {isLoading ? (
          <div className="text-center py-8" style={{ color: "var(--fg-3)", fontSize: 12 }}>
            Loading…
          </div>
        ) : error ? (
          <div className="text-center py-8" style={{ color: "var(--state-error)", fontSize: 12 }}>
            Failed to load agents: {error instanceof Error ? error.message : "Unknown error"}
          </div>
        ) : !data || data.items.length === 0 ? (
          <div className="text-center py-8" style={{ color: "var(--fg-3)", fontSize: 12 }}>
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
                    <span className="mono" style={{ fontSize: 12, fontWeight: 500 }}>
                      {a.name ?? a.uuid.slice(0, 8)}
                    </span>
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
                  <DenseTableCell style={{ fontSize: 11.5, color: "var(--fg-2)" }}>
                    {a.managerId ? resolveMember(a.managerId) : "—"}
                  </DenseTableCell>
                  <DenseTableCell>
                    <DenseBadge tone={a.status === "active" ? "accent" : "neutral"}>{a.status}</DenseBadge>
                  </DenseTableCell>
                  <DenseTableCell className="mono" style={{ fontSize: 10.5, color: "var(--fg-4)" }}>
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
