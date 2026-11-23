import { useCallback, useRef, useState, type RefObject } from "react";
import type { MediaRef, Message, RoomState } from "@chat/contract";
import { same } from "../../lib/index";
import { atBottom } from "./feed";
import { useLatest } from "../../lib/useLatest";
import { useOnChange } from "../../lib/useOnChange";

// The feed's message state, colocated with the feed: the list and
// its add() semantics (dedupe, the swap to a changed copy, the 1200 cap),
// the scroll discipline (stick to bottom, the jump pill, the
// initial settle window), and the unread count. The stream and
// the composer feed it; ChatFeed renders it.

// The fields that carry a signed media link (MEDIA LINKS in docs.txt).
export const MEDIA_FIELDS = ["image", "audio", "video", "speak", "html", "doc", "file"] as const;

// Whether two media refs name the same stored file. The url's path names
// the message and kind and its v= the file's version, which the server
// changes when the file is replaced. exp and sig say nothing about the
// file: they move on the hour, and a replacement within the same hour
// keeps them, so a replaced file of the same type and size differs from
// the old one only in v=.
function fileKey(r: MediaRef): string {
  const url = r.url || "";
  const i = url.indexOf("?");
  const v = i < 0 ? null : new URLSearchParams(url.slice(i + 1)).get("v");
  return (i < 0 ? url : url.slice(0, i)) + "|" + (v ?? "");
}
function sameFile(a: MediaRef | undefined, b: MediaRef | undefined): boolean {
  if (!a || !b) return a === b;
  return a.type === b.type && a.bytes === b.bytes && (a.name ?? null) === (b.name ?? null) && fileKey(a) === fileKey(b);
}

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
  const messagesRef = useLatest(messages);
  // When the server last handed out each row's media links (Date.now()).
  // Signed links die one to two hours after they are minted, and the feed
  // gets a row once, so useMediaRenewal re-reads the rows whose links
  // are getting old.
  const linksAtRef = useRef<Map<number, number>>(new Map());

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
      // A message already on screen comes again, whole, when media lands
      // on it, a second file of a kind it already had included. Before,
      // only a copy with a media field the shown one lacked was taken, so
      // an image replaced on a live message kept the old one until a
      // reload. A copy that differs in nothing a person sees keeps the
      // shown object, so the row does not re-render.
      setMessages((arr) => {
        const i = arr.findIndex((x) => x.id === m.id);
        if (i < 0) return arr;
        const old = arr[i]!;
        if ((m.text || "") === (old.text || "") && MEDIA_FIELDS.every((k) => !m[k] || sameFile(m[k], old[k]))) return arr;
        // A field the new copy lacks is kept: a lighter copy of the row (a
        // post's own answer racing its stream frame) never takes media away.
        let row: Message = m;
        for (const k of MEDIA_FIELDS) if (!m[k] && old[k]) row = { ...row, [k]: old[k] };
        linksAtRef.current.set(m.id, Date.now());
        const next = [...arr];
        next[i] = row;
        return next;
      });
      return;
    }
    seenRef.current.add(m.id);
    linksAtRef.current.set(m.id, Date.now());
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
  }, [tabRef, nameRef]);

  // after the list renders new messages: keep the bottom pinned, or offer the jump
  useOnChange([messages, beginSettle], () => {
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
  });

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

  // Bulk-merge older history (the media view's jump-to-message pages
  // it in): seeds the seen set and splices the rows in id order,
  // keeping the memory cap. No unread or scroll side effects - the
  // caller steers the scroll afterwards.
  const mergeHistory = useCallback((rows: Message[]) => {
    if (!rows.length) return;
    const at = Date.now();
    rows.forEach((m) => {
      seenRef.current.add(m.id);
      if (!linksAtRef.current.has(m.id)) linksAtRef.current.set(m.id, at);
    });
    setMessages((arr) => {
      const byId = new Map<number, Message>(arr.map((m) => [m.id, m] as const));
      for (const m of rows) if (!byId.has(m.id)) byId.set(m.id, m);
      const next = [...byId.values()].sort((a, b) => a.id - b.id);
      return next.length > 1200 ? next.slice(-1200) : next;
    });
  }, []);

  // The boot load: seed the seen set, arm the initial settle, and
  // set the stream cursor.
  const loadInitial = useCallback((sorted: Message[], lastId: number) => {
    const at = Date.now();
    sorted.forEach((m) => {
      seenRef.current.add(m.id);
      linksAtRef.current.set(m.id, at);
    });
    initialSettleRef.current = true;
    setMessages(sorted);
    lastRef.current = lastId;
  }, []);

  // Fresh links from a re-read (useMediaRenewal): swap the media fields
  // of the rows on screen and nothing else (text, reactions and new rows
  // are the stream's). A row whose links did not change keeps its object,
  // and an unchanged list keeps its array, so React leaves those rows and
  // the scroll position alone. `covered` is every id the re-read reached,
  // returned or not: a row the server no longer has cannot be renewed,
  // and asking again every minute would not change that.
  const renewLinks = useCallback((rows: Message[], covered: number[]) => {
    const at = Date.now();
    covered.forEach((id) => linksAtRef.current.set(id, at));
    if (!rows.length) return;
    const fresh = new Map<number, Message>(rows.map((m) => [m.id, m] as const));
    setMessages((arr) => {
      let changed = false;
      const next = arr.map((old) => {
        const m = fresh.get(old.id);
        if (!m) return old;
        let row = old;
        for (const k of MEDIA_FIELDS) {
          const ref = m[k];
          if (ref && ref.url && (!old[k] || old[k]!.url !== ref.url)) row = { ...row, [k]: ref };
        }
        if (row !== old) changed = true;
        return row;
      });
      return changed ? next : arr;
    });
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
    mergeHistory,
    linksAtRef,
    renewLinks,
  };
}
