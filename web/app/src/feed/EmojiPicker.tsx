import { useEffect, useRef, useState, type ReactNode } from "react";
import { emojiCache, loadEmoji, recents, type EmojiData } from "./emoji";

// The full emoji picker: categories, search, recents. Rendered by
// useReactions inside its positioned wrapper.

function placeCalc(pop: HTMLElement, row: HTMLElement): { top: number; left: number } {
  const rr = row.getBoundingClientRect();
  const bw = pop.offsetWidth;
  const bh = pop.offsetHeight;
  let top = rr.top - bh - 6;
  if (top < 8) top = Math.min(rr.bottom + 6, window.innerHeight - bh - 8);
  const left = Math.max(8, Math.min(rr.left + 40, window.innerWidth - bw - 8));
  return { top: Math.max(8, top), left };
}

export function Placed({
  row,
  className,
  role,
  label,
  focusRx,
  children,
}: {
  row: HTMLElement | null;
  className: string;
  role: string;
  label: string;
  focusRx?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && row) setPos(placeCalc(el, row));
    if (el && focusRx) {
      const t =
        el.querySelector<HTMLButtonElement>("button.rx.on") ||
        el.querySelector<HTMLButtonElement>("button.rx");
      if (t) t.focus({ preventScroll: true });
    }
  }, [row, focusRx]);
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

export function Picker({
  row,
  onPick,
  onClose,
  mine,
}: {
  row: HTMLElement;
  onPick: (emoji: string) => void;
  onClose: () => void;
  mine?: string | null;
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
      className={"rx-cell" + (mine === c[0] ? " on" : "")}
      title={c[1]}
      aria-label={c[1] || c[0]}
      onClick={() => onPick(c[0])}
    >
      {c[0]}
    </button>
  );
  return (
    <Placed row={row} className="rx-picker" role="dialog" label="Choose a reaction">
      <input
        ref={(el) => {
          if (el && window.matchMedia && window.matchMedia("(hover: hover)").matches) {
            el.focus({ preventScroll: true });
          }
        }}
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
