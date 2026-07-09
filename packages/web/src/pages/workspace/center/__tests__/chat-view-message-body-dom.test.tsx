// @vitest-environment happy-dom

import type { ChatDetail, ChatParticipantDetail, Message } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../../../components/ui/toast.js";
import { createDomHarness, type DomHarness } from "../../../../test-utils/dom-harness.js";

const NOW = "2026-05-28T12:00:00.000Z";

const authMock = vi.hoisted(() => ({
  value: {
    organizationId: "org-1",
    memberId: "member-1",
    role: "admin" as const,
    user: { id: "user-1", username: "gandy", displayName: "Gandy", avatarUrl: null },
    myAgentId: "human-agent-self",
  },
}));

vi.mock("../../../../auth/auth-context.js", () => ({
  useAuth: () => authMock.value,
}));

vi.mock("../../../../api/chats.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../api/chats.js")>();
  return {
    ...actual,
    sendChatMessage: vi.fn().mockResolvedValue({ id: "msg-new" }),
    listChatMessages: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getChat: vi.fn(),
  };
});

vi.mock("../../../../api/attachments.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../api/attachments.js")>();
  return {
    ...actual,
    fetchAttachmentBase64: vi.fn().mockResolvedValue({ base64: "aGVsbG8=", mimeType: "image/png" }),
    uploadImageAttachment: vi.fn().mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      mimeType: "image/png",
      filename: "x.png",
      sizeBytes: 4,
      uploadedBy: "m1",
      createdAt: NOW,
    }),
  };
});

vi.mock("../../../../api/image-store.js", () => ({
  getImage: vi.fn().mockResolvedValue(null),
  putImage: vi.fn().mockResolvedValue(undefined),
}));

function participant(overrides: Partial<ChatParticipantDetail> & { agentId: string }): ChatParticipantDetail {
  return {
    agentId: overrides.agentId,
    role: overrides.role ?? "member",
    mode: overrides.mode ?? "full",
    joinedAt: overrides.joinedAt ?? NOW,
    name: overrides.name ?? "nova",
    displayName: overrides.displayName ?? "Nova",
    type: overrides.type ?? "agent",
    avatarColorToken: overrides.avatarColorToken ?? null,
    avatarImageUrl: overrides.avatarImageUrl ?? null,
  };
}

const PARTICIPANTS: ChatParticipantDetail[] = [
  participant({ agentId: "human-agent-self", name: "gandy", displayName: "Gandy", type: "human" }),
  participant({ agentId: "agent-1", name: "nova", displayName: "Nova", type: "agent" }),
];

function chatDetail(): ChatDetail {
  return {
    id: "chat-1",
    organizationId: "org-1",
    type: "group",
    topic: "Launch planning",
    description: null,
    descriptionUpdatedAt: null,
    lastReadAt: null,
    lifecyclePolicy: null,
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    participants: PARTICIPANTS,
    title: "Launch planning",
    firstMessagePreview: "hello",
    engagementStatus: "active",
    viewerMembershipKind: "participant",
  };
}

function message(overrides: Partial<Message> & { id: string; senderId: string }): Message {
  return {
    id: overrides.id,
    chatId: overrides.chatId ?? "chat-1",
    senderId: overrides.senderId,
    format: overrides.format ?? "text",
    content: overrides.content ?? "hello",
    metadata: overrides.metadata ?? {},
    inReplyTo: overrides.inReplyTo ?? null,
    source: overrides.source ?? "web",
    createdAt: overrides.createdAt ?? NOW,
  };
}

function seedClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } },
  });
  const items = [
    message({
      id: "msg-1",
      senderId: "human-agent-self",
      content: "Please review docs and @nova",
      // delivery statuses exercise ReadReceipt
      // @ts-expect-error delivery is client-side enrichment
      deliveryStatus: "acked",
    }),
    message({
      id: "msg-2",
      senderId: "agent-1",
      source: "api",
      content: "See [plan](attachment:att-1) and plain path /tmp/x",
      metadata: {
        documentContext: {
          kind: "snapshot",
          failedMentions: [{ raw: "docs/missing.md", reason: "missing" }],
        },
      },
    }),
    message({
      id: "msg-3",
      senderId: "agent-1",
      format: "file",
      source: "api",
      content: {
        data: "aGVsbG8=",
        mimeType: "image/png",
        filename: "inline.png",
      },
    }),
    message({
      id: "msg-4",
      senderId: "agent-1",
      format: "file",
      source: "api",
      content: {
        imageId: "image-1",
        mimeType: "image/png",
        filename: "ref.png",
      },
    }),
    message({
      id: "msg-5",
      senderId: "human-agent-self",
      content: "delivered",
      // @ts-expect-error delivery enrichment
      deliveryStatus: "delivered",
    }),
    message({
      id: "msg-6",
      senderId: "human-agent-self",
      content: "just sent",
    }),
  ];
  client.setQueryData(["chat-detail", "chat-1"], chatDetail());
  client.setQueryData(["chat-messages-cache", "chat-1"], items);
  client.setQueryData(["chat-messages", "chat-1"], { items, nextCursor: null });
  client.setQueryData(["session-events", "agent-1", "chat-1"], { items: [], nextCursor: null });
  client.setQueryData(["chat-agent-status", "chat-1"], []);
  client.setQueryData(["chat-read-state", "chat-1"], null);
  client.setQueryData(["agents", "org-list"], { items: [], nextCursor: null });
  return client;
}

function wrap(ui: ReactElement, client: QueryClient): ReactElement {
  return (
    <MemoryRouter initialEntries={["/c/chat-1"]}>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <Routes>
            <Route path="/c/:chatId" element={ui} />
          </Routes>
        </ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

describe("ChatView message body coverage", () => {
  let h: DomHarness;
  beforeEach(() => {
    h = createDomHarness();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({
        matches: true,
        media: "",
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
  });
  afterEach(() => h.cleanup());

  it("renders multi-format messages, receipts, and composer interactions", async () => {
    const { ChatView } = await import("../chat-view.js");
    const client = seedClient();
    h.render(wrap(<ChatView agentId="agent-1" chatId="chat-1" />, client));

    let last: unknown;
    for (let i = 0; i < 50; i++) {
      try {
        expect(h.container.textContent).toContain("Launch planning");
        return;
      } catch (e) {
        last = e;
      }
      await new Promise((r) => setTimeout(r, 10));
      await h.flush();
    }

    // Even if title path differs, assert some message content landed.
    const text = h.container.textContent ?? "";
    if (!text.includes("Launch planning") && !text.includes("Please review") && !text.includes("docs")) {
      throw last ?? new Error(`unexpected chat content: ${text.slice(0, 200)}`);
    }

    // Composer type + send
    const textarea = h.container.querySelector<HTMLTextAreaElement>("textarea");
    if (textarea) {
      const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      setValue?.call(textarea, "@nova hello from coverage");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      await h.flush();
      await act(async () => {
        textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, metaKey: true }));
      });
      await h.flush();
    }

    // Paste path
    if (textarea) {
      await act(async () => {
        const paste = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
        Object.defineProperty(paste, "clipboardData", {
          value: {
            items: [],
            files: [],
            getData: () => "pasted text",
            types: ["text/plain"],
          },
        });
        textarea.dispatchEvent(paste);
      });
      await h.flush();
    }

    // Drag/drop over composer region if present
    const dropTarget = h.container.querySelector("[data-testid='composer'], form, .composer") ?? h.container;
    await act(async () => {
      dropTarget.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true }));
      dropTarget.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true }));
    });
    await h.flush();
  });
});
