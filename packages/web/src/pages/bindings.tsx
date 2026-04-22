import type { AdapterBotStatus } from "@agent-team-foundation/first-tree-hub-shared";
import { useQuery } from "@tanstack/react-query";
import { Link2 } from "lucide-react";
import { useMemo } from "react";
import { useNavigate } from "react-router";
import { listAdapterMappings } from "../api/adapter-mappings.js";
import { getAdapterStatuses } from "../api/adapter-status.js";
import { listAdapters } from "../api/adapters.js";
import { Button } from "../components/ui/button.js";
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
import { StateDot } from "../components/ui/state-dot.js";
import { useAgentNameMap } from "../lib/use-agent-name-map.js";
import { formatDate } from "../lib/utils.js";

export function BindingsPage() {
  const navigate = useNavigate();
  const resolveAgentName = useAgentNameMap();

  const { data: adapters, isLoading: loadingAdapters } = useQuery({
    queryKey: ["adapters"],
    queryFn: listAdapters,
  });

  const { data: mappings, isLoading: loadingMappings } = useQuery({
    queryKey: ["adapter-mappings"],
    queryFn: listAdapterMappings,
  });

  const { data: botStatuses } = useQuery({
    queryKey: ["adapter-statuses"],
    queryFn: getAdapterStatuses,
    refetchInterval: 15_000,
  });

  const isLoading = loadingAdapters || loadingMappings;

  const statusByConfigId = useMemo(() => {
    const map = new Map<number, AdapterBotStatus>();
    for (const s of botStatuses ?? []) map.set(s.configId, s);
    return map;
  }, [botStatuses]);

  const { onlineBots, offlineBots } = useMemo(() => {
    let on = 0;
    let off = 0;
    for (const a of adapters ?? []) {
      if (statusByConfigId.get(a.id)?.connected) on++;
      else off++;
    }
    return { onlineBots: on, offlineBots: off };
  }, [adapters, statusByConfigId]);

  return (
    <>
      <p style={{ fontSize: 11.5, color: "var(--fg-3)", padding: "0 2px 12px" }}>
        Overview of platform bindings for agents you can manage. Configure each binding from the Agent detail page.
      </p>

      <Panel className="mb-3.5">
        <SectionHeader
          right={
            <span className="inline-flex items-center">
              <span className="mono inline-flex items-center gap-1" style={{ color: "var(--state-idle)" }}>
                <span aria-hidden>●</span>
                {onlineBots} online
              </span>
              <span style={{ color: "var(--fg-4)", margin: "0 6px" }} aria-hidden>
                ·
              </span>
              <span className="mono inline-flex items-center gap-1" style={{ color: "var(--fg-4)" }}>
                <span aria-hidden>○</span>
                {offlineBots} offline
              </span>
            </span>
          }
        >
          Bot bindings · {adapters?.length ?? 0}
        </SectionHeader>
        {isLoading ? (
          <div className="text-center py-6" style={{ color: "var(--fg-3)", fontSize: 12 }}>
            Loading…
          </div>
        ) : !adapters?.length ? (
          <div className="text-center py-6" style={{ color: "var(--fg-3)", fontSize: 12 }}>
            No bot bindings
          </div>
        ) : (
          <DenseTable>
            <DenseTableHeader>
              <DenseTableRow>
                <DenseTableHead>Agent</DenseTableHead>
                <DenseTableHead>Platform</DenseTableHead>
                <DenseTableHead>Status</DenseTableHead>
                <DenseTableHead>Connection</DenseTableHead>
                <DenseTableHead>Created</DenseTableHead>
                <DenseTableHead />
              </DenseTableRow>
            </DenseTableHeader>
            <DenseTableBody>
              {adapters.map((a) => {
                const connected = statusByConfigId.get(a.id)?.connected ?? false;
                return (
                  <DenseTableRow key={a.id} interactive onClick={() => navigate(`/agents/${a.agentId}`)}>
                    <DenseTableCell>
                      <span className="mono" style={{ fontSize: 12, fontWeight: 500 }}>
                        {resolveAgentName(a.agentId)}
                      </span>
                    </DenseTableCell>
                    <DenseTableCell>
                      <DenseBadge>{a.platform}</DenseBadge>
                    </DenseTableCell>
                    <DenseTableCell>
                      <DenseBadge tone={a.status === "active" ? "accent" : "outline"}>{a.status}</DenseBadge>
                    </DenseTableCell>
                    <DenseTableCell>
                      <span className="inline-flex items-center gap-1.5" style={{ fontSize: 11 }}>
                        <StateDot state={connected ? "idle" : "offline"} size={7} />
                        <span style={{ color: "var(--fg-3)" }}>{connected ? "Online" : "Offline"}</span>
                      </span>
                    </DenseTableCell>
                    <DenseTableCell className="mono" style={{ fontSize: 10.5, color: "var(--fg-4)" }}>
                      {formatDate(a.createdAt)}
                    </DenseTableCell>
                    <DenseTableCell style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <Button
                        variant="ghost"
                        size="xs"
                        className="text-[11px]"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/agents/${a.agentId}`);
                        }}
                      >
                        <Link2 className="h-3 w-3" />
                        Manage
                      </Button>
                    </DenseTableCell>
                  </DenseTableRow>
                );
              })}
            </DenseTableBody>
          </DenseTable>
        )}
      </Panel>

      <Panel>
        <SectionHeader>User bindings · {mappings?.length ?? 0}</SectionHeader>
        {isLoading ? (
          <div className="text-center py-6" style={{ color: "var(--fg-3)", fontSize: 12 }}>
            Loading…
          </div>
        ) : !mappings?.length ? (
          <div className="text-center py-6" style={{ color: "var(--fg-3)", fontSize: 12 }}>
            No user bindings
          </div>
        ) : (
          <DenseTable>
            <DenseTableHeader>
              <DenseTableRow>
                <DenseTableHead>Agent</DenseTableHead>
                <DenseTableHead>Platform</DenseTableHead>
                <DenseTableHead>External user ID</DenseTableHead>
                <DenseTableHead>Display name</DenseTableHead>
                <DenseTableHead>Bound via</DenseTableHead>
                <DenseTableHead>Created</DenseTableHead>
              </DenseTableRow>
            </DenseTableHeader>
            <DenseTableBody>
              {mappings.map((m) => (
                <DenseTableRow key={m.id} interactive onClick={() => navigate(`/agents/${m.agentId}`)}>
                  <DenseTableCell>
                    <span className="mono" style={{ fontSize: 12, fontWeight: 500, color: "var(--accent-dim)" }}>
                      {resolveAgentName(m.agentId)}
                    </span>
                  </DenseTableCell>
                  <DenseTableCell>
                    <DenseBadge>{m.platform}</DenseBadge>
                  </DenseTableCell>
                  <DenseTableCell>
                    <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>
                      {m.externalUserId}
                    </span>
                  </DenseTableCell>
                  <DenseTableCell style={{ color: "var(--fg-2)" }}>{m.displayName ?? "—"}</DenseTableCell>
                  <DenseTableCell>
                    <DenseBadge tone="outline">{m.boundVia ?? "—"}</DenseBadge>
                  </DenseTableCell>
                  <DenseTableCell className="mono" style={{ fontSize: 10.5, color: "var(--fg-4)" }}>
                    {formatDate(m.createdAt)}
                  </DenseTableCell>
                </DenseTableRow>
              ))}
            </DenseTableBody>
          </DenseTable>
        )}
      </Panel>
    </>
  );
}
