import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Message, RoomState } from "@chat/shared";
import { same } from "../lib";
import { atBottom } from "./feed";

// The feed's message state, colocated with the feed: the list and
// its add() semantics (dedupe, richer-copy swap, the 1200 cap),
// the scroll discipline (stick to bottom, the jump pill, the
// initial settle window), and the unread count. The stream and
// the composer feed it; ChatFeed renders it.

export function useMessages(opts: {
  tabRef: RefObject<string>;
  nameRef: RefObject<string>;
  applyState: (s: RoomState | null | undefined) => void;
}) {
  const { tabRef, nameRef, applyState } = opts;
  const [messages, setMessages] = useState<Message[]>([]);
  const [unread, setUnread] = useState(0);
  const [jumpVisible, setJumpVisible] = useState(false);
  const seenRef = useRef<Set<number>>(new Set());
  const lastRef = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const pendingStickRef = useRef(false);
  const pendingJumpRef = useRef(false);
  const initialSettleRef = useRef(false);
  const settleRef = useRef<{ ro: ResizeObserver | null; timer: number }>({ ro: null, timer: 0 });
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;

  const endSettle = useCallback(() => {
    if (settleRef.current.ro) {
      settleRef.current.ro.disconnect();
      settleRef.current.ro = null;
    }
    if (settleRef.current.timer) {
      clearTimeout(settleRef.current.timer);
      settleRef.current.timer = 0;
    }
  }, []);
  const beginSettle = useCallback(() => {
    endSettle();
    if (!window.ResizeObserver) return;
    const list = listRef.current;
    const inner = list?.querySelector("#msgs");
    if (!list || !inner) return;
    const until = Date.now() + 5000;
    const ro = new ResizeObserver(() => {
      if (Date.now() > until) {
        endSettle();
        return;
      }
      list.scrollTop = list.scrollHeight;
    });
    ro.observe(inner);
    settleRef.current.ro = ro;
    settleRef.current.timer = window.setTimeout(endSettle, 5100);
  }, [endSettle]);

  const addMsg = useCallback((m: Message) => {
    if (!m) return;
    if (seenRef.current.has(m.id)) {
      // A richer copy of a message already on screen (its media arrived
      // when the upload published): swap it in instead of dropping it.
      setMessages((arr) => {
        const i = arr.findIndex((x) => x.id === m.id);
        if (i < 0) return arr;
        const old = arr[i]!;
        const richer =
          (m.video && !old.video) ||
          (m.image && !old.image) ||
          (m.audio && !old.audio) ||
          (m.html && !old.html) ||
          (m.doc && !old.doc) ||
          (m.text || "") !== (old.text || "");
        if (!richer) return arr;
        const next = [...arr];
        next[i] = m;
        return next;
      });
      return;
    }
    seenRef.current.add(m.id);
    const list = listRef.current;
    const stick = list ? atBottom(list) : true;
    const mine = !!nameRef.current && same(m.from, nameRef.current);
    if (stick || mine) pendingStickRef.current = true;
    else if (tabRef.current === "chat") pendingJumpRef.current = true;
    if (lastRef.current !== null && tabRef.current !== "chat" && !mine) setUnread((u) => u + 1);
    setMessages((arr) => {
      const prev = arr[arr.length - 1];
      let next: Message[];
      if (!prev || m.id > prev.id) next = [...arr, m];
      else next = [...arr, m].sort((a, b) => a.id - b.id);
      if (next.length > 1200) next = next.slice(-1000);
      return next;
    });
  }, []);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (initialSettleRef.current) {
      initialSettleRef.current = false;
      list.scrollTop = list.scrollHeight;
      beginSettle();
      return;
    }
    if (pendingStickRef.current) {
      pendingStickRef.current = false;
      list.scrollTop = list.scrollHeight;
    } else if (pendingJumpRef.current) {
      pendingJumpRef.current = false;
      setJumpVisible(true);
    }
  }, [messages, beginSettle]);

  const onPosted = useCallback(
    (m: Message & { room_state?: RoomState }) => {
      if (m.room_state) applyState(m.room_state);
      addMsg(m);
      const list = listRef.current;
      if (list) list.scrollTop = list.scrollHeight;
    },
    [applyState, addMsg]
  );;

  const clearUnread = useCallback(() => setUnread(0), []);

  // The boot load: seed the seen set, arm the initial settle, and
  // set the stream cursor.
  const loadInitial = useCallback((sorted: Message[], lastId: number) => {
    sorted.forEach((m) => seenRef.current.add(m.id));
    initialSettleRef.current = true;
    setMessages(sorted);
    lastRef.current = lastId;
  }, []);

  return {
    messages,
    setMessages,
    messagesRef,
    addMsg,
    onPosted,
    unread,
    clearUnread,
    jumpVisible,
    setJumpVisible,
    listRef,
    lastRef,
    seenRef,
    endSettle,
    loadInitial,
  };
}
