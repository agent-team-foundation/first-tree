import type { MeChatRow } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { listMeChats } from "../../../api/me-chats.js";
import { useAuth } from "../../../auth/auth-context.js";
import { Avatar } from "../../../components/avatar.js";
import { ChatRowAvatar } from "../../../components/chat/chat-row-avatar.js";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandLoading,
  CommandSeparator,
} from "../../../components/ui/command.js";
import { useOrgAgents } from "../../../lib/use-org-agents.js";
import { formatRowTime } from "../../../lib/utils.js";

/**
 * Empty-query chat count. With no query the palette is a "go back to
 * what I was just doing" surface (Slack/Linear-style recents), not a
 * browser — a screenful of the most recently active chats beats 100
 * rows in API order. Typing anything lifts the cap and searches the
 * full fetched window.
 */
const RECENT_CHAT_LIMIT = 12;

/** Avatar disc diameter inside palette rows — compact, denser than the
 *  conversation rail's default disc. */
const ROW_AVATAR_SIZE = 24;

/**
 * Topbar "Jump to…" palette.
 *
 * Data sources are all pure-frontend reuses of existing per-resource
 * endpoints — no aggregating backend route:
 *   - Chats: `/me/chats` (default engagement, server-paged). Replaces the
 *     prior per-agent `/agents/:uuid/sessions` fan-out, which issued one
 *     request per managed agent.
 *   - Teammates: `useOrgAgents` (`/agents?limit=100`, no type filter — the
 *     roster carries human members and agents alike), the same cache used
 *     by the participant picker and identity maps.
 *
 * Filtering is handled by `cmdk`. Each item splits its searchable text
 * between `value` (primary identity: visible title + a uniquifying id —
 * two chats may share a title) and `keywords` (secondary tokens: topic,
 * description, participant names). cmdk's scorer weights `value` matches
 * above `keywords` matches, so a title hit ranks ahead of a
 * participant-name hit without any custom filter.
 */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const { agentId: selfAgentId } = useAuth();

  // Controlled query so the empty-query "Recent" view and the searching
  // view can differ. Cleared on close — reopening the palette is always
  // a new jump, not a continuation of the last search.
  const [search, setSearch] = useState("");
  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  const { data: orgAgents, isLoading: agentsLoading } = useOrgAgents();
  const agents = orgAgents?.items ?? [];

  const { data: chatsResp, isLoading: chatsLoading } = useQuery({
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

  // Most-recently-active first, regardless of the API's order — recency
  // is the palette's organizing principle (jump back to live work).
  // Never-messaged chats (null lastMessageAt) sink to the end.
  const chats = useMemo(() => {
    const rows = chatsResp?.rows ?? [];
    return [...rows].sort((a, b) => {
      if (a.lastMessageAt === b.lastMessageAt) return 0;
      if (a.lastMessageAt === null) return 1;
      if (b.lastMessageAt === null) return -1;
      return a.lastMessageAt < b.lastMessageAt ? 1 : -1;
    });
  }, [chatsResp]);

  const browsing = search.trim().length === 0;
  const visibleChats = browsing ? chats.slice(0, RECENT_CHAT_LIMIT) : chats;
  const paletteLoading = chatsLoading || agentsLoading;

  const go = (url: string) => {
    onOpenChange(false);
    navigate(url);
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Jump to chat or teammate…" value={search} onValueChange={setSearch} />
      <CommandList>
        {!paletteLoading && <CommandEmpty>No results</CommandEmpty>}

        {chatsLoading && (
          <CommandLoading>
            <div aria-hidden className="space-y-1 px-3 py-1">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex animate-pulse items-center gap-2 py-2">
                  <div className="h-6 w-6 shrink-0 rounded-full bg-muted" />
                  <div className="h-3 rounded bg-muted" style={{ width: `${52 - i * 9}%` }} />
                </div>
              ))}
            </div>
          </CommandLoading>
        )}

        {visibleChats.length > 0 && (
          <CommandGroup heading={browsing ? "Recent" : "Chats"}>
            {visibleChats.map((c) => (
              <ChatItem key={c.chatId} chat={c} selfAgentId={selfAgentId ?? ""} onGo={go} />
            ))}
          </CommandGroup>
        )}

        {agents.length > 0 && (
          <>
            {visibleChats.length > 0 && <CommandSeparator />}
            {/* "Teammates", not "Agents" — the unfiltered roster carries
                human members and agents alike, and both are jumpable. */}
            <CommandGroup heading="Teammates">
              {agents.map((a) => (
                <CommandItem
                  key={a.uuid}
                  value={`${a.displayName} ${a.uuid}`}
                  keywords={a.name ? [a.name] : undefined}
                  onSelect={() => go(`/agents/${encodeURIComponent(a.uuid)}/profile`)}
                >
                  <Avatar
                    name={a.displayName}
                    src={a.avatarImageUrl}
                    colorToken={a.avatarColorToken}
                    seed={a.uuid}
                    size={ROW_AVATAR_SIZE}
                    className="mr-2 shrink-0 [&>span]:text-caption"
                  />
                  <span className="flex-1 truncate">{a.displayName}</span>
                  {a.name ? <span className="text-caption text-muted-foreground ml-2 shrink-0">@{a.name}</span> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
      <div className="text-caption text-muted-foreground flex items-center gap-3 border-t px-3 py-1.5">
        <KeyHint keys="↑↓" label="navigate" />
        <KeyHint keys="↵" label="open" />
        <KeyHint keys="esc" label="close" />
      </div>
    </CommandDialog>
  );
}

/**
 * One chat row. Identity on the left (the rail's avatar disc + title),
 * state on the right (Archived chip when applicable, then the rail's
 * compact age — "now" / "5m" / "3h" / "MM/DD"). The chat id stays
 * searchable via `value` but is never rendered: it means nothing to a
 * human eye, and the topic is not repeated either — `title` already
 * derives from the topic whenever one is set.
 */
function ChatItem({ chat, selfAgentId, onGo }: { chat: MeChatRow; selfAgentId: string; onGo: (url: string) => void }) {
  const title = chat.title || "(untitled)";
  // Participant names give cmdk extra search tokens — typing a teammate's
  // name surfaces the 1:1 chats and group chats that include them, even
  // when the chat's own title doesn't. `description` makes the chat's
  // running work summary searchable the same way.
  const keywords = [chat.topic ?? "", chat.description ?? "", ...chat.participants.map((p) => p.displayName)].filter(
    (k) => k.length > 0,
  );
  return (
    <CommandItem
      value={`${title} ${chat.chatId}`}
      keywords={keywords}
      onSelect={() => onGo(`/?c=${encodeURIComponent(chat.chatId)}`)}
    >
      <ChatRowAvatar
        title={title}
        type={chat.type}
        participants={chat.participants}
        selfAgentId={selfAgentId}
        unreadCount={0}
        size={ROW_AVATAR_SIZE}
        badge={false}
        muted
      />
      <span className="ml-2 flex-1 truncate">{title}</span>
      {chat.engagementStatus === "archived" && (
        <span className="text-caption text-muted-foreground ml-2 shrink-0 rounded-[var(--radius-chip)] border px-1.5">
          Archived
        </span>
      )}
      {chat.lastMessageAt ? (
        <span className="text-caption text-muted-foreground ml-2 shrink-0 tabular-nums">
          {formatRowTime(chat.lastMessageAt)}
        </span>
      ) : null}
    </CommandItem>
  );
}

function KeyHint({ keys, label }: { keys: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <kbd className="text-caption rounded border bg-muted px-1 font-mono leading-4">{keys}</kbd>
      {label}
    </span>
  );
}
