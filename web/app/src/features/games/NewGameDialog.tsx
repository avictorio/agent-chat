import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { useFeed, useMembers, useSession } from "../room/ctx";
import { CATALOG, GameFacts, GameIcon, HowToPlay, accentStyle, gameDef, initialOpts, type GameDef, type Opts } from "./shared/catalog";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";

// The New game dialog, in two steps. First a gallery of the games -
// each card says what the game is, how many play, how long it runs and
// how it suits agents - then the chosen game's setup: How to play
// (folded; one tap opens it), the players (the pick is the
// invitation), its options, and Start. Everything about a
// game comes from the catalog (./catalog), so a new game shows up here
// without touching this file. The server posts the game card to the
// feed and wakes the players; on success the arena opens on the match.

export interface NewGameDialogHandle {
  // with a game id, skip the gallery and open that game's setup
  open(game?: string): void;
}

export const NewGameDialog = forwardRef<NewGameDialogHandle>(function NewGameDialog(_, ref) {
  const session = useSession();
  const members = useMembers();
  const feed = useFeed();
  const dlgRef = useRef<HTMLDialogElement | null>(null);
  const [def, setDef] = useState<GameDef | null>(null);
  const [opts, setOpts] = useState<Opts>({});
  const [picked, setPicked] = useState<string[]>([]);
  const [howOpen, setHowOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const me = session.meName;
  const range = def ? def.players(opts) : { min: 2, max: 2 };
  const valid = !!def && picked.length >= range.min && picked.length <= range.max;

  const choose = (d: GameDef) => {
    const o = initialOpts(d);
    setDef(d);
    setOpts(o);
    setPicked((cur) => cur.slice(0, d.players(o).max));
    // folded by default: the setup leads with players and options; How
    // to play is one tap away
    setHowOpen(false);
    setNote("");
    // the setup is a new view: start it at the top
    window.setTimeout(() => {
      if (dlgRef.current) dlgRef.current.scrollTop = 0;
      dlgRef.current?.querySelector<HTMLElement>(".ng-back")?.focus();
    }, 0);
  };

  useImperativeHandle(ref, () => ({
    open(game?: string) {
      setPicked(me && members.memberSet.has(me.toLowerCase()) ? [me] : []);
      setNote("");
      setBusy(false);
      const d = gameDef(game);
      if (d) choose(d);
      else setDef(null);
      if (dlgRef.current && !dlgRef.current.open) dlgRef.current.showModal();
    },
  }));

  const close = () => dlgRef.current?.close();

  const back = () => {
    setDef(null);
    setNote("");
    window.setTimeout(() => dlgRef.current?.querySelector<HTMLElement>(".ng-game")?.focus(), 0);
  };

  const toggle = (name: string) => {
    setNote("");
    setPicked((cur) => {
      if (cur.includes(name)) return cur.filter((n) => n !== name);
      if (cur.length >= range.max) return cur;
      return [...cur, name];
    });
  };

  const setOpt = (key: string, value: string | number) => {
    if (!def) return;
    const next = { ...opts, [key]: value };
    setOpts(next);
    setNote("");
    // a variant can shrink the table (skirmish is two captains)
    setPicked((cur) => cur.slice(0, def.players(next).max));
  };

  const start = async () => {
    if (!def || !valid || busy) return;
    setBusy(true);
    setNote("");
    try {
      const d = await session.client.createGame(def.body(opts, picked));
      if (d.game && d.game.id) {
        feed.games.onFrame(d.game);
        close();
        feed.games.openGame(d.game.id, d.game.type);
      } else {
        setNote((d as { error?: string }).error || "The game was refused.");
        setBusy(false);
      }
    } catch (e) {
      setNote(e instanceof Error && e.message ? e.message : "The game did not reach the referee.");
      setBusy(false);
    }
  };

  const roster = members.names;
  const ordered = me && roster.includes(me) ? [me, ...roster.filter((n) => n !== me)] : roster;
  const need = range.min === range.max ? String(range.min) : range.min + "–" + range.max;
  const hint = !def
    ? ""
    : picked.length < range.min
      ? "Pick " + (range.min - picked.length) + " more: " + def.name + " needs " + need + " players."
      : def.summary(opts, picked);

  return (
    <Dialog className="ng-dlg" id="newGameDlg" aria-labelledby="ngTitle" ref={dlgRef}>
      {!def ? (
        <>
          <div className="vd-head">
            <span className="av-name" id="ngTitle">
              New game
            </span>
            <Button type="button" variant="quiet" size="sm" aria-label="Close" onClick={close}>
              ✕
            </Button>
          </div>
          <p className="ng-sub">Pick a game. You'll choose the players next.</p>
          <div className="ng-gallery">
            {CATALOG.map((g) => (
              <button type="button" key={g.id} className="ng-game" data-game={g.id} style={accentStyle(g)} onClick={() => choose(g)}>
                <span className="ng-game-ic">
                  <GameIcon def={g} />
                </span>
                <span className="ng-game-body">
                  <span className="ng-game-name">{g.name}</span>
                  <span className="ng-game-pitch">{g.pitch}</span>
                  <GameFacts def={g} />
                </span>
                <span className="ng-game-go" aria-hidden="true">
                  ›
                </span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <div style={accentStyle(def)} data-setup={def.id}>
          <div className="vd-head ng-setup-head">
            <Button type="button" variant="quiet" size="sm" className="ng-back" aria-label="Back to all games" onClick={back}>
              ‹
            </Button>
            <span className="ng-game-ic sm">
              <GameIcon def={def} size={18} />
            </span>
            <span className="av-name" id="ngTitle">
              {def.name}
            </span>
            <span className="sp"></span>
            <Button type="button" variant="quiet" size="sm" aria-label="Close" onClick={close}>
              ✕
            </Button>
          </div>
          <details className="ng-howto" open={howOpen} onToggle={(e) => setHowOpen(e.currentTarget.open)}>
            <summary>How to play</summary>
            <HowToPlay def={def} />
          </details>
          <div className="ng-label">
            Players
            <span className="ng-count">
              {picked.length} of {need}
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
          {def.options
            .filter((o) => !o.when || o.when(opts))
            .map((o) => (
              <div key={o.key} className="ng-opt" data-opt={o.key}>
                <div className="ng-label">{o.label}</div>
                {o.help ? <div className="ng-help">{o.help}</div> : null}
                <div className="seg full" role="group" aria-label={o.label}>
                  {o.choices.map((c) => (
                    <button key={String(c.value)} type="button" aria-pressed={opts[o.key] === c.value} onClick={() => setOpt(o.key, c.value)}>
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          <div className={"ng-note" + (note ? " bad" : "")} role="status">
            {note || hint}
          </div>
          <div className="actions">
            <Button type="button" onClick={back}>
              Back
            </Button>
            <Button type="button" variant="primary" id="ngStart" disabled={!valid || busy} onClick={start}>
              {busy ? "Starting…" : "Start " + def.name}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
});
