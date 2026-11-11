import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { useFeed, useMembers, useSession } from "../room/ctx";

// The New game dialog: pick a game (Duel, Light Cycles, Battleship), pick its
// players from the room roster — that pick is the invitation — set
// the one option that matters, and start. The server posts the game
// card to the feed and wakes the players; on success the arena opens
// on the new match, like a rematch does.

export interface NewGameDialogHandle {
  open(): void;
}

type GameType = "duel" | "lightcycles" | "battleship";

const BEST_OF = [3, 5, 7, 9];
const TICKS: { secs: number; label: string }[] = [
  { secs: 30, label: "30 sec" },
  { secs: 60, label: "1 min" },
  { secs: 120, label: "2 min" },
  { secs: 300, label: "5 min" },
];
const TURNS: { secs: number; label: string }[] = [
  { secs: 300, label: "5 min" },
  { secs: 900, label: "15 min" },
  { secs: 3600, label: "1 hour" },
  { secs: 21600, label: "6 hours" },
  { secs: 86400, label: "24 hours" },
];

export const NewGameDialog = forwardRef<NewGameDialogHandle>(function NewGameDialog(_, ref) {
  const session = useSession();
  const members = useMembers();
  const feed = useFeed();
  const dlgRef = useRef<HTMLDialogElement | null>(null);
  const [type, setType] = useState<GameType>("duel");
  const [picked, setPicked] = useState<string[]>([]);
  const [bestOf, setBestOf] = useState(5);
  const [tick, setTick] = useState(120);
  const [lcMode, setLcMode] = useState<"async" | "live">("async");
  const [bsVariant, setBsVariant] = useState<"classic" | "salvo" | "skirmish">("classic");
  const [turn, setTurn] = useState(3600);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const me = session.meName;
  const max = type === "lightcycles" ? 4 : 2;
  const valid = type === "lightcycles" ? picked.length >= 2 && picked.length <= 4 : picked.length === 2;

  useImperativeHandle(ref, () => ({
    open() {
      setType("duel");
      setPicked(me && members.memberSet.has(me.toLowerCase()) ? [me] : []);
      setBestOf(5);
      setTick(120);
      setLcMode("async");
      setBsVariant("classic");
      setTurn(3600);
      setNote("");
      setBusy(false);
      if (dlgRef.current && !dlgRef.current.open) dlgRef.current.showModal();
    },
  }));

  const close = () => dlgRef.current?.close();

  const toggle = (name: string) => {
    setNote("");
    setPicked((cur) => {
      if (cur.includes(name)) return cur.filter((n) => n !== name);
      if (cur.length >= max) return cur;
      return [...cur, name];
    });
  };

  const switchType = (t: GameType) => {
    setType(t);
    setNote("");
    setPicked((cur) => cur.slice(0, t === "lightcycles" ? 4 : 2));
  };

  const start = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setNote("");
    const body: Record<string, unknown> = { players: picked };
    if (type === "duel") {
      body.game = "duel";
      body.best_of = bestOf;
    } else if (type === "battleship") {
      body.game = "battleship";
      body.tick_seconds = turn;
      if (bsVariant !== "classic") body.variant = bsVariant;
    } else {
      body.mode = lcMode;
      if (lcMode === "live") body.tick_seconds = tick;
    }
    try {
      const d = await session.client.createGame(body);
      if (d.game && d.game.id) {
        feed.games.onFrame(d.game);
        close();
        feed.games.openGame(d.game.id, d.game.type);
      } else {
        setNote((d as { error?: string }).error || "The game was refused.");
        setBusy(false);
      }
    } catch {
      setNote("The game did not reach the referee.");
      setBusy(false);
    }
  };

  const hint = !valid
    ? type === "lightcycles"
      ? "Pick " + (2 - picked.length) + " more — Light Cycles needs 2 to 4 players."
      : picked.length < 2
        ? "Pick one more player — this game is exactly 2."
        : "This game is exactly 2 players."
    : type === "duel"
      ? "First to " + (Math.floor(bestOf / 2) + 1) + ". Starts when both players accept; rounds are a minute once under way."
      : type === "battleship"
        ? bsVariant === "salvo"
          ? "Salvo on the 10×10 board: each turn fires one shot per ship you still have afloat. Starts when both captains accept."
          : bsVariant === "skirmish"
            ? "Skirmish: a tight 8×8 board, fleets of four (4, 3, 3, 2) — the same hunt, compressed. Starts when both captains accept."
            : "Hidden fleets on a 10×10 board, one shot per turn. Starts when both captains accept; the slow game — built to breathe between wakes."
        : lcMode === "async"
          ? "Starts when every rider accepts their seat; each tick resolves the moment everyone has ridden — a 1 h stall cap covers a vanished rider."
          : "Starts when every rider accepts their seat; miss a tick and the clock rides straight for you.";

  // The roster list carries the room's bot identity ("claude") for
  // mentions and rendering; it holds no invite and cannot play, so
  // the picker leaves it out.
  const roster = members.names.filter((n) => n.toLowerCase() !== "claude");
  const ordered = me && roster.includes(me) ? [me, ...roster.filter((n) => n !== me)] : roster;

  return (
    <dialog className="av-dlg ng-dlg" id="newGameDlg" aria-labelledby="ngTitle" ref={dlgRef}>
      <div className="vd-head">
        <span className="av-name" id="ngTitle">
          New game
        </span>
        <button type="button" className="btn sm quiet" aria-label="Close" onClick={close}>
          ✕
        </button>
      </div>
      <div className="seg full" role="group" aria-label="Game type">
        <button type="button" aria-pressed={type === "duel"} onClick={() => switchType("duel")}>
          ⚔️ Duel
        </button>
        <button type="button" aria-pressed={type === "lightcycles"} onClick={() => switchType("lightcycles")}>
          🏍️ Light Cycles
        </button>
        <button type="button" aria-pressed={type === "battleship"} onClick={() => switchType("battleship")}>
          🚢 Battleship
        </button>
      </div>
      <div className="ng-label">
        Players
        <span className="ng-count">
          {picked.length} of {type === "lightcycles" ? "2–4" : "2"}
        </span>
      </div>
      <div className="ng-players">
        {ordered.map((name) => {
          const sel = picked.includes(name);
          return (
            <button
              type="button"
              key={name}
              className={"ng-player" + (sel ? " on" : "")}
              aria-pressed={sel}
              data-player={name}
              onClick={() => toggle(name)}
            >
              <span className="ng-check">{sel ? "✓" : ""}</span>
              <span className="ng-name">{name}</span>
              {name === me ? <span className="ng-you">you</span> : null}
              <span className="ng-kind">{members.kindOf(name) || ""}</span>
            </button>
          );
        })}
      </div>
      {type === "duel" ? (
        <>
          <div className="ng-label">Best of</div>
          <div className="seg full" role="group" aria-label="Best of">
            {BEST_OF.map((n) => (
              <button key={n} type="button" aria-pressed={bestOf === n} onClick={() => setBestOf(n)}>
                {n}
              </button>
            ))}
          </div>
        </>
      ) : type === "battleship" ? (
        <>
          <div className="ng-label">Variant</div>
          <div className="seg full" role="group" aria-label="Battleship variant">
            <button type="button" aria-pressed={bsVariant === "classic"} onClick={() => setBsVariant("classic")}>
              Classic 10×10
            </button>
            <button type="button" aria-pressed={bsVariant === "salvo"} onClick={() => setBsVariant("salvo")}>
              Salvo
            </button>
            <button type="button" aria-pressed={bsVariant === "skirmish"} onClick={() => setBsVariant("skirmish")}>
              Skirmish 8×8
            </button>
          </div>
          <div className="ng-label">Turn clock — how long each captain gets per shot</div>
          <div className="seg full" role="group" aria-label="Turn clock">
            {TURNS.map((t) => (
              <button key={t.secs} type="button" aria-pressed={turn === t.secs} onClick={() => setTurn(t.secs)}>
                {t.label}
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="ng-label">Pace — how ticks resolve</div>
          <div className="seg full" role="group" aria-label="Pace">
            <button type="button" aria-pressed={lcMode === "async"} onClick={() => setLcMode("async")}>
              Async · on everyone's move
            </button>
            <button type="button" aria-pressed={lcMode === "live"} onClick={() => setLcMode("live")}>
              Live · fixed tick
            </button>
          </div>
          {lcMode === "live" ? (
            <>
              <div className="ng-label">Tick — how long each rider gets per move</div>
              <div className="seg full" role="group" aria-label="Tick length">
                {TICKS.map((t) => (
                  <button key={t.secs} type="button" aria-pressed={tick === t.secs} onClick={() => setTick(t.secs)}>
                    {t.label}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </>
      )}
      <div className="ng-note" role="status">
        {note || hint}
      </div>
      <div className="actions">
        <button type="button" className="btn" onClick={close}>
          Cancel
        </button>
        <button type="button" className="btn primary" id="ngStart" disabled={!valid || busy} onClick={start}>
          {busy ? "Starting…" : "Start game"}
        </button>
      </div>
    </dialog>
  );
});
