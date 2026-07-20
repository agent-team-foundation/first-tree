import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";
import { captureBrowserStorageScope } from "./browser-storage-scope.js";
import { chatDraftScope, loadDraft, saveDraft } from "./draft-store.js";

/**
 * In-chat composer draft text, persisted per user + chat in browser-local
 * storage.
 *
 * A drop-in for `useState("")`: returns `[draft, setDraft]`. On top of plain
 * state it (a) seeds the initial value from the stored draft for this user +
 * chat, (b) writes every change back to storage, and (c) swaps to the target
 * chat's stored draft when the chat (or the signed-in user) changes.
 *
 * The swap matters because `ChatView` is NOT remounted on chat switch (the
 * chat-detail query just refetches by id) — without it the single `draft`
 * state would leak one chat's unsent text into the next chat. An empty draft
 * removes its stored entry, so a successful send (which sets the draft to "")
 * also clears the cache. Keys are user-scoped so a shared browser never
 * restores another account's unsent text.
 */
export function useChatDraftText(userId: string | null, chatId: string): [string, Dispatch<SetStateAction<string>>] {
  const scope = chatDraftScope(userId, chatId);
  const browserScopeRef = useRef(captureBrowserStorageScope());
  const [draft, setDraft] = useState<string>(() => loadDraft(scope, browserScopeRef.current)?.text ?? "");
  // The scope the current `draft` value belongs to. Lets the persist effect
  // write under the right scope and detect a switch (the scope changes a
  // render before the state catches up).
  const scopeRef = useRef(scope);

  useEffect(() => {
    if (scopeRef.current === scope) return;
    scopeRef.current = scope;
    setDraft(loadDraft(scope, browserScopeRef.current)?.text ?? "");
  }, [scope]);

  useEffect(() => {
    saveDraft(scopeRef.current, { text: draft }, Date.now(), browserScopeRef.current);
  }, [draft]);

  return [draft, setDraft];
}
