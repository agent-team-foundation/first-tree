import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, MessageSquare } from "lucide-react";
import { useState } from "react";
import { getChat, listChatMessages, listChats } from "../api/chats.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";
import { useAgentNameMap } from "../lib/use-agent-name-map.js";
import { formatDate } from "../lib/utils.js";

export function ChatsPage() {
  const [cursor, setCursor] = useState<string | undefined>();
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);

  if (selectedChatId) {
    return <ChatDetailView chatId={selectedChatId} onBack={() => setSelectedChatId(null)} />;
  }

  return <ChatListView cursor={cursor} setCursor={setCursor} onSelect={setSelectedChatId} />;
}

function ChatListView({
  cursor,
  setCursor,
  onSelect,
}: {
  cursor: string | undefined;
  setCursor: (c: string | undefined) => void;
  onSelect: (id: string) => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["chats", cursor],
    queryFn: () => listChats({ limit: 20, cursor }),
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">Chats</h1>
          <p className="text-sm text-muted-foreground mt-1">Browse chat history (read-only)</p>
        </div>
      </div>

      <div className="border rounded-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Topic</TableHead>
              <TableHead>Participants</TableHead>
              <TableHead>Lifecycle</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                  Loading...
                </TableCell>
              </TableRow>
            ) : error ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-destructive">
                  Failed to load chats: {error instanceof Error ? error.message : "Unknown error"}
                </TableCell>
              </TableRow>
            ) : data?.items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                  No chats
                </TableCell>
              </TableRow>
            ) : (
              data?.items.map((chat) => (
                <TableRow key={chat.id} className="cursor-pointer" onClick={() => onSelect(chat.id)}>
                  <TableCell className="font-mono text-xs max-w-[200px] truncate">{chat.id}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{chat.type}</Badge>
                  </TableCell>
                  <TableCell>{chat.topic ?? "—"}</TableCell>
                  <TableCell>{chat.participantCount}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">{chat.lifecyclePolicy ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(chat.createdAt)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {data?.nextCursor && (
        <div className="flex justify-end mt-4">
          <Button variant="outline" onClick={() => setCursor(data.nextCursor ?? undefined)}>
            Next Page
          </Button>
        </div>
      )}
    </div>
  );
}

function ChatDetailView({ chatId, onBack }: { chatId: string; onBack: () => void }) {
  const [msgCursor, setMsgCursor] = useState<string | undefined>();
  const resolveAgentName = useAgentNameMap();

  const chatQuery = useQuery({
    queryKey: ["chat", chatId],
    queryFn: () => getChat(chatId),
  });

  const messagesQuery = useQuery({
    queryKey: ["chat-messages", chatId, msgCursor],
    queryFn: () => listChatMessages(chatId, { limit: 50, cursor: msgCursor }),
  });

  const chat = chatQuery.data;
  const messagesData = messagesQuery.data;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-semibold">{chat?.topic ?? "Chat"}</h1>
          <p className="text-sm text-muted-foreground font-mono">{chatId}</p>
        </div>
      </div>

      {chat && (
        <Card>
          <CardHeader>
            <CardTitle>Participants</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {chat.participants.map((p) => (
                <Badge key={p.agentId} variant="outline">
                  {resolveAgentName(p.agentId)} ({p.role})
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4" />
            Messages
          </CardTitle>
        </CardHeader>
        <CardContent>
          {messagesQuery.isLoading ? (
            <div className="text-muted-foreground py-4 text-center">Loading messages...</div>
          ) : messagesData?.items.length === 0 ? (
            <div className="text-muted-foreground py-4 text-center">No messages</div>
          ) : (
            <div className="space-y-3">
              {messagesData?.items.map((msg) => (
                <div key={msg.id} className="border rounded-md p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-mono text-sm font-medium">{resolveAgentName(msg.senderId)}</span>
                    <span className="text-xs text-muted-foreground">{formatDate(msg.createdAt)}</span>
                  </div>
                  <div className="text-sm">
                    {msg.format === "text" ? (
                      <p className="whitespace-pre-wrap">
                        {typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)}
                      </p>
                    ) : (
                      <pre className="text-xs bg-muted p-2 rounded overflow-auto max-h-40">
                        {JSON.stringify(msg.content, null, 2)}
                      </pre>
                    )}
                  </div>
                  <div className="flex gap-2 mt-1">
                    <Badge variant="outline" className="text-xs">
                      {msg.format}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          )}

          {messagesData?.nextCursor && (
            <div className="flex justify-center mt-4">
              <Button variant="outline" size="sm" onClick={() => setMsgCursor(messagesData.nextCursor ?? undefined)}>
                Load More
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
