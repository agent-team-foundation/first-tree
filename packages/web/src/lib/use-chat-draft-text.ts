import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";
import { loadDraft, saveDraft } from "./draft-store.js";

/**
 * In-chat composer draft text, persisted per chat in browser-local storage.
 *
 * A drop-in for `useState("")`: returns `[draft, setDraft]`. On top of plain
 * state it (a) seeds the initial value from the stored draft for `chatId`,
 * (b) writes every change back to storage, and (c) swaps to the target chat's
 * stored draft when `chatId` changes.
 *
 * The swap matters because `ChatView` is NOT remounted on chat switch (the
 * chat-detail query just refetches by id) — without it the single `draft`
 * state would leak one chat's unsent text into the next chat. An empty draft
 * removes its stored entry, so a successful send (which sets the draft to "")
 * also clears the cache.
 */
export function useChatDraftText(chatId: string): [string, Dispatch<SetStateAction<string>>] {
  const [draft, setDraft] = useState<string>(() => loadDraft(chatId)?.text ?? "");
  // The chat the current `draft` value belongs to. Lets the persist effect
  // write under the right scope and detect a chat switch (the prop changes a
  // render before the state catches up).
  const scopeRef = useRef(chatId);

  useEffect(() => {
    if (scopeRef.current === chatId) return;
    scopeRef.current = chatId;
    setDraft(loadDraft(chatId)?.text ?? "");
  }, [chatId]);

  useEffect(() => {
    saveDraft(scopeRef.current, { text: draft });
  }, [draft]);

  return [draft, setDraft];
}
