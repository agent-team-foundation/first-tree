import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Bot, LayoutDashboard, MessageSquare } from "lucide-react";
import { useNavigate } from "react-router";
import { listMyAttentions, myAttentionsQueryKey } from "../../../api/attention.js";
import { listMeChats } from "../../../api/me-chats.js";
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
import { useOrgAgents } from "../../../lib/use-org-agents.js";

const STATIC_ROUTES = [
  { path: "/", label: "Workspace" },
  { path: "/context", label: "Context" },
  { path: "/team", label: "Team" },
  { path: "/settings", label: "Settings" },
];

/**
 * Topbar "Jump to…" palette.
 *
 * Data sources are all pure-frontend reuses of existing per-resource
 * endpoints — no aggregating backend route:
 *   - Chats: `/me/chats` (default engagement, server-paged). Replaces the
 *     prior per-agent `/agents/:uuid/sessions` fan-out, which issued one
 *     request per managed agent.
 *   - Agents: `useOrgAgents` (`/agents?limit=100`), the same cache used by
 *     the participant picker and identity maps.
 *   - NHA: `GET /attention?state=open` (no chat filter), which the
 *     user-JWT route already scopes to the caller's human agent identities.
 *
 * Filtering is handled by `cmdk` — each item's `value` is a space-joined
 * string of every searchable token, and cmdk fuzzy-matches against it.
 */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const agentName = useAgentNameMap();

  const { data: orgAgents } = useOrgAgents();
  const agents = orgAgents?.items ?? [];

  const { data: chatsResp } = useQuery({
    // Prefix-aligned with conversations-page invalidations
    // (`["me", "chats"]` is the family every chat mutation invalidates —
    // new-chat-draft, row-engagement-menu, etc.) so creating / archiving
    // a chat refreshes the palette without waiting on staleTime.
    // `"palette"` keeps this fetch's cache distinct from the multi-filter
    // entries the conversations rail writes.
    //
    // `engagement: "all"` lets jump-to reach archived chats too — finding
    // an old conversation is a common reason to open the palette.
    queryKey: ["me", "chats", "palette"],
    queryFn: () => listMeChats({ limit: 100, engagement: "all" }),
    enabled: open,
    staleTime: 30_000,
  });
  const chats = chatsResp?.rows ?? [];

  const { data: attentions } = useQuery({
    queryKey: myAttentionsQueryKey,
    queryFn: listMyAttentions,
    enabled: open,
    staleTime: 30_000,
  });
  const nhas = attentions ?? [];

  const go = (url: string) => {
    onOpenChange(false);
    navigate(url);
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Jump to chat, agent, or NHA…" />
      <CommandList>
        <CommandEmpty>No results</CommandEmpty>

        {chats.length > 0 && (
          <CommandGroup heading="Chats">
            {chats.map((c) => {
              // Participant names give cmdk extra search tokens — typing a
              // teammate's name surfaces the 1:1 chats and group chats that
              // include them, even when the chat's own title doesn't.
              const participantNames = c.participants.map((p) => p.displayName).join(" ");
              return (
                <CommandItem
                  key={c.chatId}
                  value={`chat ${c.title} ${c.topic ?? ""} ${participantNames} ${c.chatId}`}
                  onSelect={() => go(`/?c=${encodeURIComponent(c.chatId)}`)}
                >
                  <MessageSquare className="mr-2 h-4 w-4 shrink-0 opacity-70" />
                  <span className="flex-1 truncate">{c.title || "(untitled)"}</span>
                  {c.topic ? (
                    <span className="text-caption text-muted-foreground ml-2 truncate max-w-[40%]">{c.topic}</span>
                  ) : null}
                  <span className="text-caption text-muted-foreground font-mono ml-2">{c.chatId.slice(0, 8)}</span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}

        {agents.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Agents">
              {agents.map((a) => (
                <CommandItem
                  key={a.uuid}
                  value={`agent ${a.displayName} ${a.name ?? ""} ${a.uuid}`}
                  onSelect={() => go(`/agents/${encodeURIComponent(a.uuid)}/profile`)}
                >
                  <Bot className="mr-2 h-4 w-4 shrink-0 opacity-70" />
                  <span className="flex-1 truncate">{a.displayName}</span>
                  {a.name ? <span className="text-caption text-muted-foreground ml-2">@{a.name}</span> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {nhas.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Needs your reply">
              {nhas.map((n) => {
                const from = agentName(n.originAgentId);
                return (
                  <CommandItem
                    key={n.id}
                    value={`nha attention ${n.subject} ${n.body} ${from} ${n.id}`}
                    onSelect={() => go(`/?c=${encodeURIComponent(n.originChatId)}`)}
                  >
                    <AlertCircle className="mr-2 h-4 w-4 shrink-0 text-warn" />
                    <span className="flex-1 truncate">{n.subject}</span>
                    <span className="text-caption text-muted-foreground ml-2 truncate max-w-[35%]">from {from}</span>
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
