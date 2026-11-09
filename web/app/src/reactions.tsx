import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { Message, RoomClient } from "@chat/shared";
import { store, toast } from "./lib";
import { same } from "./feed";

// Reactions, ported from the current app: one reaction per person per
// message (set / replace / remove), chips with who-reacted titles, the
// quick bar, the full emoji picker with search and recents, the
// who-reacted popover, and hold-to-open on mouse and touch (a drag
// cancels; the click a hold produces is swallowed).

export const REACTIONS: [string, string][] = [
  ["👍", "Like"],
  ["❤️", "Love"],
  ["😂", "Haha"],
  ["😮", "Wow"],
  ["😢", "Sad"],
  ["🙏", "Thanks"],
];
const NAME2EMOJI: Record<string, string> = {};
const EMOJI2NAME: Record<string, string> = {};
REACTIONS.forEach(([e, n]) => {
  NAME2EMOJI[n] = e;
  EMOJI2NAME[e] = n;
});
export function rxLabel(e: string): string {
  return EMOJI2NAME[e] || e;
}
export function rxOrder(rx: Record<string, string[]>): string[] {
  const keys = Object.keys(rx || {}).filter((k) => (rx[k] || []).length);
  const quick = REACTIONS.map((x) => x[0]).filter((e) => keys.includes(e));
  return quick.concat(keys.filter((k) => !quick.includes(k)).sort());
}
export function myReaction(m: Message, me: string): string | null {
  if (!me) return null;
  const rx = m.reactions || {};
  for (const k of Object.keys(rx)) if ((rx[k] || []).some((w) => same(w, me))) return k;
  return null;
}

const RECENT_KEY = "chat-recent-emoji";
function recents(): string[] {
  try {
    const a = JSON.parse(store(RECENT_KEY) || "[]") as unknown;
    return Array.isArray(a) ? (a as string[]).slice(0, 24) : [];
  } catch {
    return [];
  }
}
function addRecent(e: string) {
  const a = recents().filter((x) => x !== e);
  a.unshift(e);
  store(RECENT_KEY, JSON.stringify(a.slice(0, 24)));
}

type EmojiData = [string, [string, string][]][];
let emojiCache: EmojiData | null = null;
let emojiLoading: Promise<EmojiData> | null = null;
function loadEmoji(): Promise<EmojiData> {
  if (emojiCache) return Promise.resolve(emojiCache);
  if (!emojiLoading) {
    emojiLoading = fetch("/emoji.json")
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => {
        emojiCache = Array.isArray(d) ? (d as EmojiData) : [];
        return emojiCache;
      })
      .catch(() => []);
  }
  return emojiLoading;
}

export interface RxApi {
  react: (m: Message, label: string) => void;
  openBar: (m: Message, row: HTMLElement) => void;
  openWho: (m: Message, key: string, chip: HTMLElement) => void;
}

type Pop =
  | { kind: "bar"; msg: Message; row: HTMLElement }
  | { kind: "picker"; msg: Message; row: HTMLElement }
  | { kind: "who"; msg: Message; key: string; row: HTMLElement | null };

function placeCalc(pop: HTMLElement, row: HTMLElement): { top: number; left: number } {
  const rr = row.getBoundingClientRect();
  const bw = pop.offsetWidth;
  const bh = pop.offsetHeight;
  let top = rr.top - bh - 6;
  if (top < 8) top = Math.min(rr.bottom + 6, window.innerHeight - bh - 8);
  const left = Math.max(8, Math.min(rr.left + 40, window.innerWidth - bw - 8));
  return { top: Math.max(8, top), left };
}

function Placed({
  row,
  className,
  role,
  label,
  children,
}: {
  row: HTMLElement | null;
  className: string;
  role: string;
  label: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && row) setPos(placeCalc(el, row));
  }, [row]);
  return (
    <div
      ref={ref}
      className={className}
      role={role}
      aria-label={label}
      style={pos ? { top: pos.top, left: pos.left } : { visibility: "hidden", top: 0, left: 0 }}
    >
      {children}
    </div>
  );
}

export function RxChips({ m, me, api }: { m: Message; me: string; api: RxApi }) {
  const rx = m.reactions || {};
  const keys = rxOrder(rx);
  if (!keys.length) return null;
  return (
    <>
      {keys.map((k) => {
        const who = rx[k]!;
        const mine = !!me && who.some((w) => same(w, me));
        return (
          <button
            key={k}
            type="button"
            className={"rx-chip" + (mine ? " mine" : "")}
            data-rx={k}
            title={rxLabel(k) + ": " + who.join(", ")}
            aria-label={"React " + rxLabel(k) + ", by " + who.join(", ")}
            onClick={() => api.react(m, k)}
          >
            <span className="e">{k}</span>
            <span>{who.length}</span>
          </button>
        );
      })}
    </>
  );
}

export function useReactions(opts: {
  client: RoomClient;
  who: () => string | null;
  meName: string;
  getMessage: (id: number) => Message | undefined;
  setMessages: (fn: (arr: Message[]) => Message[]) => void;
  listRef: RefObject<HTMLDivElement | null>;
  denied: boolean;
}): {
  api: RxApi;
  targetId: number | null;
  popovers: ReactNode;
  holdProps: Record<string, (e: never) => void>;
} {
  const [pop, setPop] = useState<Pop | null>(null);
  const popRef = useRef<Pop | null>(null);
  popRef.current = pop;
  const swallowRef = useRef(false);
  const { client, who, getMessage, setMessages, listRef } = opts;
  const whoRef = useRef(who);
  whoRef.current = who;
  const deniedRef = useRef(opts.denied);
  deniedRef.current = opts.denied;
  const meRef = useRef(opts.meName);
  meRef.current = opts.meName;

  const closeAll = useCallback(() => setPop(null), []);

  const react = useCallback(
    (m: Message, label: string) => {
      const n = whoRef.current();
      if (!n) return;
      const key = NAME2EMOJI[label] || label;
      setPop(null);
      setMessages((arr) =>
        arr.map((x) => {
          if (x.id !== m.id) return x;
          const rx: Record<string, string[]> = {};
          Object.keys(x.reactions || {}).forEach((k) => (rx[k] = [...(x.reactions || {})[k]!]));
          const cur = myReaction(x, n);
          if (cur) rx[cur] = (rx[cur] || []).filter((w) => !same(w, n));
          if (cur !== key) rx[key] = [...(rx[key] || []), n];
          Object.keys(rx).forEach((k) => {
            if (!rx[k]!.length) delete rx[k];
          });
          return { ...x, reactions: rx };
        })
      );
      addRecent(key);
      void client
        .react(m.id, n, myReaction(m, n) === key ? null : key)
        .then((d) => {
          const rx = (d as { reactions?: Record<string, string[]> } | null)?.reactions;
          if (rx) {
            setMessages((arr) => arr.map((x) => (x.id === m.id ? { ...x, reactions: rx } : x)));
          }
        })
        .catch((e: Error) => toast(e.message, true));
    },
    [client, setMessages]
  );

  const openBar = useCallback((m: Message, row: HTMLElement) => {
    if (deniedRef.current) return;
    setPop({ kind: "bar", msg: m, row });
  }, []);
  const openWho = useCallback(
    (m: Message, key: string, chip: HTMLElement) => {
      const whoList = ((m.reactions || {})[key] || []).slice();
      if (!whoList.length) return;
      const row = chip.closest(".msg") as HTMLElement | null;
      setPop({ kind: "who", msg: m, key, row });
    },
    []
  );
  const apiRef = useRef<RxApi | null>(null);
  if (!apiRef.current) apiRef.current = { react, openBar, openWho };
  apiRef.current.react = react;
  apiRef.current.openBar = openBar;
  apiRef.current.openWho = openWho;
  const api = apiRef.current;

  /* document-level behavior: outside click closes, the click a hold
     produces is swallowed, Escape closes, resize/list-scroll close
     the bar and the who popover */
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (swallowRef.current) {
        swallowRef.current = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const p = popRef.current;
      if (!p) return;
      const t = e.target as HTMLElement;
      if (t.closest(".rx-bar,.rx-picker,.rx-who")) return;
      const btn = t.closest(".react-btn");
      if (btn) {
        const row = btn.closest(".msg");
        if (row && p.row && row === p.row) return;
      }
      setPop(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPop(null);
    };
    const onResize = () => {
      if (popRef.current && popRef.current.kind !== "picker") setPop(null);
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    const list = listRef.current;
    const onScroll = () => {
      if (popRef.current && popRef.current.kind !== "picker") setPop(null);
    };
    list?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      list?.removeEventListener("scroll", onScroll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* hold-to-open on the feed (mouse and touch via pointer events) */
  const holdRef = useRef<{
    t: number;
    x: number;
    y: number;
    row: HTMLElement;
    msgId: number;
    chip: HTMLElement | null;
    key: string | null;
  } | null>(null);
  const clearHold = () => {
    if (holdRef.current) {
      window.clearTimeout(holdRef.current.t);
      holdRef.current = null;
    }
  };
  const holdProps = {
    onPointerDown: (e: { button?: number; target: EventTarget | null; clientX: number; clientY: number }) => {
      if (e.button !== undefined && e.button !== 0) return;
      const t = e.target as HTMLElement | null;
      if (!t || !t.closest) return;
      if (t.closest(".rx-bar,.rx-picker,.rx-who")) return;
      const chip = t.closest(".rx-chip") as HTMLElement | null;
      const rowEl = t.closest(".msg") as HTMLElement | null;
      if (!rowEl) return;
      if (!chip && t.closest("button, a, input, textarea, .avatar")) return;
      const msgId = Number(rowEl.getAttribute("data-id"));
      const h = {
        x: e.clientX,
        y: e.clientY,
        row: rowEl,
        msgId,
        chip,
        key: chip ? chip.getAttribute("data-rx") : null,
        t: 0,
      };
      h.t = window.setTimeout(() => {
        holdRef.current = null;
        swallowRef.current = true;
        const m = getMessage(msgId);
        if (!m) return;
        if (chip && h.key) api.openWho(m, h.key, chip);
        else api.openBar(m, rowEl);
      }, 450);
      holdRef.current = h;
    },
    onPointerMove: (e: { clientX: number; clientY: number }) => {
      const h = holdRef.current;
      if (h && Math.abs(e.clientX - h.x) + Math.abs(e.clientY - h.y) > 10) clearHold();
    },
    onPointerUp: clearHold,
    onPointerCancel: clearHold,
    onPointerLeave: clearHold,
    onContextMenu: (e: { target: EventTarget | null; preventDefault(): void }) => {
      const t = e.target as HTMLElement | null;
      if (!t || !t.closest) return;
      const chip = t.closest(".rx-chip") as HTMLElement | null;
      if (chip) {
        e.preventDefault();
        const rowEl = chip.closest(".msg");
        const m = rowEl ? getMessage(Number(rowEl.getAttribute("data-id"))) : undefined;
        const key = chip.getAttribute("data-rx");
        if (m && key) api.openWho(m, key, chip);
        return;
      }
      if (t.closest(".msgs") && t.closest(".msg")) {
        e.preventDefault();
        const rowEl = t.closest(".msg") as HTMLElement;
        const m = getMessage(Number(rowEl.getAttribute("data-id")));
        if (m) {
          setPop(null);
          api.openBar(m, rowEl);
        }
      }
    },
  };

  /* popover content */
  let popovers: ReactNode = null;
  if (pop && pop.kind === "bar") {
    const cur = getMessage(pop.msg.id) || pop.msg;
    const mine = myReaction(cur, meRef.current);
    popovers = (
      <Placed row={pop.row} className="rx-bar" role="toolbar" label="Reactions">
        {REACTIONS.map(([emoji, label]) => (
          <button
            key={emoji}
            type="button"
            className={"rx" + (mine === emoji ? " on" : "")}
            title={label}
            aria-label={label + (mine === emoji ? " (yours, click to remove)" : "")}
            onClick={(e) => {
              e.stopPropagation();
              react(cur, emoji);
            }}
          >
            {emoji}
          </button>
        ))}
        <button
          type="button"
          className="rx-copy"
          aria-label="Copy message text"
          onClick={(e) => {
            e.stopPropagation();
            const text = cur.text || "";
            const done = () => {
              toast("Copied");
              setPop(null);
            };
            const failCopy = () => toast("Couldn't copy", true);
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(text).then(() => {
                done();
              }, failCopy);
            } else {
              const ta = document.createElement("textarea");
              ta.value = text;
              ta.style.position = "fixed";
              ta.style.opacity = "0";
              document.body.appendChild(ta);
              ta.focus();
              ta.select();
              let ok = false;
              try {
                ok = document.execCommand("copy");
              } catch {
                // ignored below
              }
              ta.remove();
              if (ok) done();
              else failCopy();
            }
          }}
        >
          <svg className="i" viewBox="0 0 24 24">
            <path d="M9 9.5A2.5 2.5 0 0 1 11.5 7h7A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 9 16.5z" />
            <path d="M5 15.5h-.01M5.8 19A2.3 2.3 0 0 1 3.5 16.7V7.8A2.3 2.3 0 0 1 5.8 5.5h6" />
          </svg>
          Copy
        </button>
        <button
          type="button"
          className="rx-plus"
          title="More emoji"
          aria-label="More emoji"
          onClick={(e) => {
            e.stopPropagation();
            void loadEmoji().then(() => setPop({ kind: "picker", msg: cur, row: pop.row }));
          }}
        >
          <svg className="i" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="8.2" />
            <path d="M9.2 10.2h.01M14.8 10.2h.01M8.8 13.6c.8 1.1 1.9 1.7 3.2 1.7s2.4-.6 3.2-1.7M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2" />
          </svg>
        </button>
      </Placed>
    );
  } else if (pop && pop.kind === "picker") {
    popovers = (
      <Picker
        row={pop.row}
        onPick={(emoji) => react(pop.msg, emoji)}
        onClose={closeAll}
      />
    );
  } else if (pop && pop.kind === "who") {
    const cur = getMessage(pop.msg.id) || pop.msg;
    const whoList = ((cur.reactions || {})[pop.key] || []).slice();
    const label = rxLabel(pop.key);
    popovers = (
      <Placed row={pop.row} className="rx-who" role="dialog" label="Who reacted">
        <div className="rx-who-head">
          <span className="e">{pop.key}</span>
          <span>{(label !== pop.key ? label + " · " : "") + whoList.length}</span>
        </div>
        {whoList.map((w) => {
          const mine = !!meRef.current && same(w, meRef.current);
          return (
            <div key={w} className={"rx-who-name" + (mine ? " me" : "")}>
              {mine ? "You" : w}
            </div>
          );
        })}
      </Placed>
    );
  }

  return {
    api,
    targetId: pop ? pop.msg.id : null,
    popovers,
    holdProps: holdProps as unknown as Record<string, (e: never) => void>,
  };
}

function Picker({
  row,
  onPick,
  onClose,
}: {
  row: HTMLElement;
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const [data, setData] = useState<EmojiData | null>(emojiCache);
  const [q, setQ] = useState("");
  const [recentList] = useState<string[]>(() => recents());
  const gridRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!data) {
      let live = true;
      void loadEmoji().then((d) => {
        if (live) setData(d);
      });
      return () => {
        live = false;
      };
    }
  }, [data]);
  const cats: EmojiData = data || [];
  const query = q.trim().toLowerCase();
  interface Sec {
    name: string;
    cells: [string, string][];
  }
  const secs: Sec[] = [];
  if (!query) {
    if (recentList.length) {
      secs.push({
        name: "Recently used",
        cells: recentList
          .map((e) => {
            for (const [, list] of cats) {
              const hit = list.find((c) => c[0] === e);
              if (hit) return hit;
            }
            return [e, ""] as [string, string];
          })
          .filter((c): c is [string, string] => !!c),
      });
    }
    cats.forEach(([name, list]) => secs.push({ name, cells: list }));
  }
  const matches: [string, string][] = [];
  if (query) {
    cats.forEach(([, list]) =>
      list.forEach((c) => {
        if (c[1].toLowerCase().includes(query)) matches.push(c);
      })
    );
  }
  const cell = (c: [string, string]) => (
    <button
      key={c[0] + "|" + c[1]}
      type="button"
      className="rx-cell"
      title={c[1]}
      aria-label={c[1] || c[0]}
      onClick={() => onPick(c[0])}
    >
      {c[0]}
    </button>
  );
  return (
    <Placed row={row} className="rx-picker" role="dialog" label="Pick an emoji">
      <input
        className="rx-search"
        type="search"
        placeholder="Search emoji"
        aria-label="Search emoji"
        autoComplete="off"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      />
      {!query && (
        <div className="rx-tabs">
          {secs.map((s) => (
            <button
              key={s.name}
              type="button"
              className="rx-tab"
              title={s.name}
              aria-label={s.name}
              onClick={() => {
                const grid = gridRef.current;
                if (!grid) return;
                const h = grid.querySelector('[data-sec="' + CSS.escape(s.name) + '"]');
                if (h) grid.scrollTop = (h as HTMLElement).offsetTop - grid.offsetTop;
              }}
            >
              {s.cells[0]?.[0] || ""}
            </button>
          ))}
        </div>
      )}
      <div className="rx-grid" ref={gridRef}>
        {query ? (
          matches.length ? (
            <div className="rx-cells">{matches.map(cell)}</div>
          ) : (
            <div className="rx-none">No emoji matches “{q.trim()}”.</div>
          )
        ) : (
          secs.map((s) => (
            <div key={s.name}>
              <div className="rx-sec" data-sec={s.name}>
                {s.name}
              </div>
              <div className="rx-cells">{s.cells.map(cell)}</div>
            </div>
          ))
        )}
      </div>
    </Placed>
  );
}
