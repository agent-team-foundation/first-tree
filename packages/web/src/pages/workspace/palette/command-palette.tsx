import { useQuery } from "@tanstack/react-query";
import { Bot, LayoutDashboard, MessageSquare } from "lucide-react";
import { useNavigate } from "react-router";
import { getActivityOverview } from "../../../api/activity.js";
import { listAgentSessions, type SessionListItem } from "../../../api/sessions.js";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "../../../components/ui/command.js";
import { useAgentNameMap } from "../../../lib/use-agent-name-map.js";

const STATIC_ROUTES = [
  { path: "/", label: "Workspace" },
  { path: "/context", label: "Context" },
  { path: "/team", label: "Team" },
  { path: "/settings", label: "Settings" },
];

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const agentName = useAgentNameMap();

  const { data: activity } = useQuery({
    queryKey: ["activity"],
    queryFn: getActivityOverview,
    enabled: open,
    staleTime: 30_000,
  });

  const agents = activity?.agents ?? [];

  const sessionQueries = useQuery({
    queryKey: ["palette-sessions", agents.map((a) => a.agentId).join(",")],
    queryFn: async () => {
      const results: Array<{ agentId: string; session: SessionListItem }> = [];
      for (const a of agents) {
        try {
          const list = await listAgentSessions(a.agentId);
          for (const s of list) results.push({ agentId: a.agentId, session: s });
        } catch {
          // per-agent failure is fine — skip
        }
      }
      return results;
    },
    enabled: open && agents.length > 0,
    staleTime: 30_000,
  });

  const sessions = sessionQueries.data ?? [];

  const go = (url: string) => {
    onOpenChange(false);
    navigate(url);
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Jump to agent, chat, or page…" />
      <CommandList>
        <CommandEmpty>No results</CommandEmpty>

        {agents.length > 0 && (
          <CommandGroup heading="Agents">
            {agents.map((a) => {
              const name = agentName(a.agentId);
              return (
                <CommandItem
                  key={a.agentId}
                  value={`agent ${name} ${a.agentId}`}
                  onSelect={() => go(`/?a=${a.agentId}`)}
                >
                  <Bot className="mr-2 h-4 w-4 shrink-0 opacity-70" />
                  <span className="flex-1 truncate">{name}</span>
                  <span className="text-caption text-muted-foreground font-mono ml-2">{a.agentId.slice(0, 8)}</span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}

        {sessions.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Chats">
              {sessions.map(({ agentId, session }) => {
                const name = agentName(agentId);
                return (
                  <CommandItem
                    key={`${agentId}-${session.chatId}`}
                    value={`chat ${name} ${session.chatId}`}
                    onSelect={() => go(`/?a=${agentId}&c=${session.chatId}`)}
                  >
                    <MessageSquare className="mr-2 h-4 w-4 shrink-0 opacity-70" />
                    <span className="flex-1 truncate">{name}</span>
                    <span className="text-caption text-muted-foreground font-mono ml-2">
                      {session.chatId.slice(0, 8)}
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </>
        )}

        <CommandSeparator />
        <CommandGroup heading="Pages">
          {STATIC_ROUTES.map((r) => (
            <CommandItem key={r.path} value={`page ${r.label}`} onSelect={() => go(r.path)}>
              <LayoutDashboard className="mr-2 h-4 w-4 shrink-0 opacity-70" />
              <span>{r.label}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
