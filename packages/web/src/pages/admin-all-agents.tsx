import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { listAllAgentsForAdmin } from "../api/agents.js";
import { Badge } from "../components/ui/badge.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";
import { useMemberNameMap } from "../lib/use-member-name-map.js";
import { formatDate } from "../lib/utils.js";

/**
 * Admin-only view of every agent in the organization, including private ones
 * owned by other members. The default `/agents` list still applies the
 * visibility filter (Rule: visibility != manageability); this page is the
 * manageability-oriented view used to troubleshoot or reassign.
 */
export function AdminAllAgentsPage() {
  const navigate = useNavigate();
  const resolveMember = useMemberNameMap();

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-all-agents"],
    queryFn: () => listAllAgentsForAdmin({ limit: 200 }),
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Every agent in the organization, including private agents owned by other members. Use this view to troubleshoot
        or reassign — the regular Agents page still hides private agents you don't manage.
      </p>

      <div className="border rounded-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Display Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Visibility</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                  Loading...
                </TableCell>
              </TableRow>
            ) : error ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-8 text-destructive">
                  Failed to load agents: {error instanceof Error ? error.message : "Unknown error"}
                </TableCell>
              </TableRow>
            ) : !data || data.items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                  No agents
                </TableCell>
              </TableRow>
            ) : (
              data.items.map((a) => (
                <TableRow
                  key={a.uuid}
                  className="cursor-pointer"
                  onClick={() => navigate(`/agents/${encodeURIComponent(a.uuid)}`)}
                >
                  <TableCell className="font-mono text-sm">{a.name ?? a.uuid.slice(0, 8)}</TableCell>
                  <TableCell>{a.displayName ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{a.type}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={a.visibility === "organization" ? "default" : "outline"}>{a.visibility}</Badge>
                  </TableCell>
                  <TableCell className="text-sm">{a.managerId ? resolveMember(a.managerId) : "—"}</TableCell>
                  <TableCell>
                    <Badge variant={a.status === "active" ? "default" : "secondary"}>{a.status}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">{formatDate(a.createdAt)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
