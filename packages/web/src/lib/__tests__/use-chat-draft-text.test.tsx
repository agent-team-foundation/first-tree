// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDomHarness, type DomHarness } from "../../test-utils/dom-harness.js";
import { setBrowserStorageUser } from "../browser-storage-scope.js";
import { chatDraftScope, loadDraft, saveDraft } from "../draft-store.js";
import { useChatDraftText } from "../use-chat-draft-text.js";

let h: DomHarness;

beforeEach(() => {
  window.localStorage.clear();
  setBrowserStorageUser(null);
  setBrowserStorageUser("user-1");
  h = createDomHarness();
});
afterEach(() => h.cleanup());

/** Probe: surfaces the hook's draft text and buttons to mutate it. Rendering
 *  it with a changing `chatId` / `userId` (same element type at the root)
 *  reconciles in place — it does NOT remount — which is exactly how ChatView
 *  switches chats (and how a re-login swaps the user without a fresh mount). */
function Probe({ userId = "user-1", chatId }: { userId?: string; chatId: string }) {
  const [draft, setDraft] = useChatDraftText(userId, chatId);
  return (
    <div>
      <span data-testid="draft">{draft}</span>
      <button type="button" data-testid="type" onClick={() => setDraft(`body-${chatId}`)}>
        type
      </button>
      <button type="button" data-testid="clear" onClick={() => setDraft("")}>
        clear
      </button>
    </div>
  );
}

function draftText(): string {
  return h.container.querySelector('[data-testid="draft"]')?.textContent ?? "";
}

async function click(testid: string): Promise<void> {
  const btn = h.container.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`);
  if (!btn) throw new Error(`button ${testid} not found`);
  await act(async () => {
    btn.click();
    await Promise.resolve();
  });
}

describe("useChatDraftText", () => {
  it("seeds the initial value from the stored draft for the user + chat", async () => {
    saveDraft(chatDraftScope("user-1", "chat-a"), { text: "preexisting" });
    h.render(<Probe chatId="chat-a" />);
    await h.flush();
    expect(draftText()).toBe("preexisting");
  });

  it("persists typed text under the user + chat scope", async () => {
    h.render(<Probe chatId="chat-a" />);
    await click("type");
    expect(draftText()).toBe("body-chat-a");
    expect(loadDraft(chatDraftScope("user-1", "chat-a"))?.text).toBe("body-chat-a");
  });

  it("swaps drafts on chat switch without leaking across chats", async () => {
    h.render(<Probe chatId="chat-a" />);
    await click("type"); // stored under chat-a

    // Switch to a chat with no stored draft → composer is empty.
    h.render(<Probe chatId="chat-b" />);
    await h.flush();
    expect(draftText()).toBe("");

    await click("type"); // stored under chat-b
    expect(loadDraft(chatDraftScope("user-1", "chat-b"))?.text).toBe("body-chat-b");

    // Back to chat-a → its draft is restored, chat-a's text was never lost.
    h.render(<Probe chatId="chat-a" />);
    await h.flush();
    expect(draftText()).toBe("body-chat-a");
  });

  it("does not leak a draft across users on the same chat", async () => {
    h.render(<Probe userId="user-1" chatId="chat-a" />);
    await click("type"); // stored under user-1 / chat-a

    // A different account opens the same chat in the same browser → empty.
    h.render(<Probe userId="user-2" chatId="chat-a" />);
    await h.flush();
    expect(draftText()).toBe("");
  });

  it("clears the stored draft when emptied (mirrors clearing on send)", async () => {
    h.render(<Probe chatId="chat-a" />);
    await click("type");
    expect(loadDraft(chatDraftScope("user-1", "chat-a"))).not.toBeNull();
    await click("clear");
    expect(draftText()).toBe("");
    expect(loadDraft(chatDraftScope("user-1", "chat-a"))).toBeNull();
  });
});
