import { useCallback, useEffect, useRef, useState } from "react";

// The room's tab state: which view is showing, the hash sync in
// both directions, and the tab ref the stream/board timers read.
// Switching to chat fires onChat (the shell clears the unread
// badge and closes the drawer there).

export const TABS: Record<string, string> = {
  chat: "Chat",
  constitution: "Constitution",
  decisions: "Decisions",
  questions: "Open questions",
  stakes: "Stakes",
  memory: "Memory",
  members: "Members",
};

export function useTabs(opts: { onChat: () => void }) {
  const onChatRef = useRef(opts.onChat);
  onChatRef.current = opts.onChat;
  const [tab, setTab] = useState<string>(() => {
    const h = location.hash.slice(1);
    return TABS[h] ? h : "chat";
  });
  const tabRef = useRef(tab);
  tabRef.current = tab;

  const show = useCallback((t: string, fromHash = false) => {
    const next = TABS[t] ? t : "chat";
    setTab(next);
    if (next === "chat") onChatRef.current();
    if (!fromHash) {
      try {
        history.replaceState(
          null,
          "",
          location.pathname + location.search + (next === "chat" ? "" : "#" + next)
        );
      } catch {
        // history unavailable: the tab still switched
      }
    }
  }, []);

  useEffect(() => {
    const onHash = () => show(location.hash.slice(1), true);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [show]);

  return { tab, tabRef, show };
}
