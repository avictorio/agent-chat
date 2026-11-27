import { useEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import {
  AgentKeyClient,
  ApiError,
  RoomClient,
  type AgentKeyDropped,
  type AgentKeyInfo,
  type AgentKeyRoom,
  type PersonKeyMade,
  type PersonSeatEntry,
  type SeatCheck,
  type SeatCheckRoom,
} from "@chat/contract";
import { Button, LinkButton } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { Dialog } from "../../ui/Dialog";
import { Page } from "../../ui/Page";
import { Pill } from "../../ui/Pill";
import { toast } from "../../lib/index";
import { shortDate } from "../../lib/dates";
import { AGENT_NAME_MAX, agentNameProblem, cleanAgentName } from "./agentName";

// Home → Agent keys: a person makes an agent key for their agent from the
// rooms this browser holds (POST /api/agents/invite: the site invites the
// agent into each room with the person's own invite and puts the invites on
// the key), and manages a key they paste (GET /api/agent, POST
// /api/agent/rooms/invite, POST /api/agent/rooms/remove, DELETE /api/agent).
// The only room calls are the looks of GET /invite, which open nothing.
//
// It stores nothing on the device: no key, no agent token, no agent name, no
// list of a key's rooms. A key lives only in this view's state, never in
// storage, a URL or the history: it goes on Done, on Close, after a
// disconnect, when the view is left (HomeApp renders it only while it is
// shown, and switches views at once) and on pagehide (the parent remounts
// the forms at once, before the page can be frozen). A key is one
// password for several rooms; the device already holds the person's own
// invites, and a key beside them in storage would put every seat on it one
// script away. Every name and sentence from the server is rendered as text.

/** A room this browser holds: the person's invite token there (localStorage chat-invite:ROOM). */
export interface DeviceRoom {
  room: string;
  token: string;
  you: string;
}

/** What the look (GET /invite) said of the device's invite in a room. */
type Look =
  | { state: "checking" }
  | { state: "person"; you: string }
  | { state: "agent" }
  | { state: "refused" }
  | { state: "gone" }
  | { state: "failed" };

const CHECKING: Look = { state: "checking" };

const REASON: Record<Exclude<Look["state"], "person">, string> = {
  checking: "Checking…",
  agent: "The invite this browser holds here is an agent's.",
  refused: "This browser's invite here no longer works.",
  gone: "This room no longer exists.",
  failed: "Couldn't check this room; try again.",
};

const KEY_RE = /^\.ac1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
const KEY_LENGTH = 71;
const CAP_FULL = "Too many agent keys were made just now, from this network, for one of these rooms or on the whole site.";
const NOT_KEY = "That is a room invite link or token, not an agent key.";
const NETWORK = "Couldn't reach the site; try again.";

/** A refusal's code and body, when the answer was the Worker's. */
function bodyOf(e: unknown): { status: number; code?: string; error?: string; room?: string; note?: string; retry_after?: number } | null {
  if (!(e instanceof ApiError)) return null;
  const b = e.body && typeof e.body === "object" ? (e.body as Record<string, unknown>) : {};
  return {
    status: e.status,
    code: typeof b.code === "string" ? b.code : undefined,
    error: typeof b.error === "string" ? b.error : undefined,
    room: typeof b.room === "string" ? b.room : undefined,
    note: typeof b.note === "string" ? b.note : undefined,
    retry_after: typeof b.retry_after === "number" ? b.retry_after : undefined,
  };
}

/** A sentence about room R, without the "Room "R": " the row already says. */
function onRow(room: string, s: string): string {
  const p = 'Room "' + room + '": ';
  return s.startsWith(p) ? s.slice(p.length) : s;
}

/** Seconds as "N minutes" (or seconds, hours). */
function inTime(sec: number): string {
  if (sec < 60) return sec === 1 ? "a second" : sec + " seconds";
  const m = Math.ceil(sec / 60);
  if (m < 60) return m === 1 ? "a minute" : m + " minutes";
  const h = Math.floor(m / 60), r = m % 60;
  return (h === 1 ? "an hour" : h + " hours") + (r ? " and " + (r === 1 ? "a minute" : r + " minutes") : "");
}

/** A key-holding call's refusal, in plain words (Open, Take off, Disconnect, Add rooms). */
function keyRefusal(e: unknown): string {
  const b = bodyOf(e);
  if (!b) return NETWORK;
  if (b.code === "agent_key_invalid" || b.code === "agent_key_missing") return "This key is not a current one: it was mistyped or disconnected.";
  if (b.code === "not_agent_key") return NOT_KEY;
  if (b.code === "agent_unreadable") return "This key's record could not be read, so its rooms can't be shown. The key itself was not refused.";
  if (b.code === "try_again") return b.room ? b.error || "Try again." : "This key was busy with another change; try again.";
  return b.error || NETWORK;
}

/** What GET /invite says of the device's invite in a room: a look, which opens nothing. */
function lookAt(r: DeviceRoom, set: (f: (l: Record<string, Look>) => Record<string, Look>) => void) {
  new RoomClient(r.room, r.token)
    .invitePreview()
    .then((pv) => set((l) => ({ ...l, [r.room]: pv.invite && pv.invite.kind === "human" ? { state: "person", you: pv.invite.name } : { state: "agent" } })))
    .catch((e: unknown) => {
      // 404: no such room (the room routes answer an unknown name so); 410: deleted meanwhile
      const s = e instanceof ApiError ? e.status : 0;
      set((l) => ({ ...l, [r.room]: s === 401 || s === 403 ? { state: "refused" } : s === 404 || s === 410 ? { state: "gone" } : { state: "failed" } }));
    });
}

/** The looks of the device's rooms, each asked once while the view is
 *  shown, and again on Try again for one that failed. */
function useLooks(rooms: DeviceRoom[]) {
  const [looks, setLooks] = useState<Record<string, Look>>({});
  const asked = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const r of rooms) {
      if (asked.current.has(r.room)) continue;
      asked.current.add(r.room);
      lookAt(r, setLooks);
    }
  }, [rooms]);
  const retry = (r: DeviceRoom) => {
    setLooks((l) => ({ ...l, [r.room]: CHECKING }));
    lookAt(r, setLooks);
  };
  return { looks, retry };
}

/** Copies text, with the toasts "Copied" / "Couldn't copy". */
function copy(text: string) {
  try {
    void navigator.clipboard.writeText(text).then(
      () => toast("Copied"),
      () => toast("Couldn't copy", true)
    );
  } catch {
    toast("Couldn't copy", true);
  }
}

/** The form for seats on a key: the agent's name, the rooms ticked, a
 *  name of its own in a room, the rooms where the person said to use the
 *  agent's seat already in use, and the last check's answer. */
interface SeatForm {
  name: string;
  ticked: string[];
  other: Record<string, string>;
  useSeat: string[];
  check: SeatCheck | null;
  /** a refusal the check did not see, on its room */
  failed: { room: string; error: string } | null;
}
const emptyForm = (name = ""): SeatForm => ({ name, ticked: [], other: {}, useSeat: [], check: null, failed: null });

/** The entries a form sends, in the device's order; null with the first name problem. */
function entriesOf(f: SeatForm, rooms: DeviceRoom[]): { name: string; entries: PersonSeatEntry[] } | { problem: string; room?: string } {
  const name = cleanAgentName(f.name);
  const top = agentNameProblem(name);
  if (top) return { problem: top };
  const entries: PersonSeatEntry[] = [];
  for (const r of rooms) {
    if (!f.ticked.includes(r.room)) continue;
    const e: PersonSeatEntry = { room: r.room, inviter_token: r.token };
    if (r.room in f.other) {
      const own = cleanAgentName(f.other[r.room] || "");
      const p = agentNameProblem(own);
      if (p) return { problem: p, room: r.room };
      e.name = own;
    }
    if (f.useSeat.includes(r.room)) e.reuse = "any";
    entries.push(e);
  }
  return { name, entries };
}

/** The device's rooms as checkbox rows: each with its look, a name of its
 *  own once asked for, and the last check's word on it. */
function RoomPicker(props: {
  id: string;
  rooms: DeviceRoom[];
  looks: Record<string, Look>;
  retry: (r: DeviceRoom) => void;
  form: SeatForm;
  setForm: (f: SeatForm) => void;
  busy: boolean;
  otherErr: { room: string; text: string } | null;
}) {
  const { id, rooms, looks, retry, form, setForm, busy, otherErr } = props;
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : list.concat([v]));
  return (
    <ul className="key-rooms" id={id}>
      {rooms.map((r) => {
        const look = looks[r.room] || CHECKING;
        const ok = look.state === "person";
        const ticked = ok && form.ticked.includes(r.room);
        const res: SeatCheckRoom | undefined = form.check ? form.check.rooms.find((x) => x.room === r.room) : undefined;
        const failed = form.failed && form.failed.room === r.room ? form.failed.error : "";
        const own = r.room in form.other;
        const cid = id + "-" + r.room;
        return (
          <li className={"key-room" + (ok ? "" : " off")} key={r.room} data-room={r.room}>
            <label className="key-pick" htmlFor={cid}>
              <input
                type="checkbox"
                id={cid}
                disabled={!ok || busy}
                checked={ticked}
                onChange={() => setForm({ ...form, ticked: toggle(form.ticked, r.room), check: null, failed: null })}
              />
              <span className="key-room-text">
                <span className="rn">{r.room}</span>
                <span className="who">{ok ? "as " + look.you : REASON[look.state]}</span>
              </span>
            </label>
            {look.state === "failed" ? (
              <LinkButton type="button" className="key-retry" disabled={busy} onClick={() => retry(r)}>
                Try again
              </LinkButton>
            ) : null}
            {ticked ? (
              <div className="key-room-more">
                {own ? (
                  <>
                    <label className="field key-own">
                      The agent's name in {r.room}
                      <input
                        type="text"
                        maxLength={AGENT_NAME_MAX}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={busy}
                        value={form.other[r.room] || ""}
                        onChange={(e) => setForm({ ...form, other: { ...form.other, [r.room]: e.currentTarget.value }, check: null, failed: null })}
                      />
                    </label>
                    {otherErr && otherErr.room === r.room ? (
                      <p className="hint bad" role="alert">
                        {otherErr.text}
                      </p>
                    ) : null}
                    <LinkButton
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        const o = { ...form.other };
                        delete o[r.room];
                        setForm({ ...form, other: o, check: null, failed: null });
                      }}
                    >
                      Use the name above here
                    </LinkButton>
                  </>
                ) : (
                  <LinkButton type="button" disabled={busy} onClick={() => setForm({ ...form, other: { ...form.other, [r.room]: "" }, check: null, failed: null })}>
                    Use another name in this room
                  </LinkButton>
                )}
                {res && res.problem ? (
                  <p className="hint bad" role="alert">
                    {onRow(r.room, res.problem.error)}
                  </p>
                ) : null}
                {res && res.problem && res.problem.code === "seat_in_use" ? (
                  <label className="key-seat">
                    <input type="checkbox" disabled={busy} checked={form.useSeat.includes(r.room)} onChange={() => setForm({ ...form, useSeat: toggle(form.useSeat, r.room) })} />
                    <span>Use {res.name}'s seat here (already a member, invited by you)</span>
                  </label>
                ) : null}
                {res && res.seat === "reused" && !res.opened ? (
                  <p className="hint">
                    Uses {res.name}'s unused invite here (invited by you). Anyone you gave that invite's link can still use it, and another key that holds this seat still works
                    for it: disconnecting this key does not cut that one.
                  </p>
                ) : null}
                {res && res.seat === "reused" && res.opened ? (
                  <p className="hint">
                    Uses {res.name}'s seat here (already a member, invited by you). Another key that holds this seat still works for it: disconnecting this key does not cut
                    that one.
                  </p>
                ) : null}
                {failed ? (
                  <p className="hint bad" role="alert">
                    {onRow(r.room, failed)}
                  </p>
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Runs a form's check, then, when nothing stands in the way, the call
 *  itself at once. say: the live region; alert: the error line. */
function useSeatRun<T>(o: {
  rooms: DeviceRoom[];
  form: SeatForm;
  setForm: (f: SeatForm) => void;
  call: (name: string, entries: PersonSeatEntry[], check: boolean) => Promise<SeatCheck | T>;
  done: (r: T) => void;
  making: string;
  lost: string;
  /** what did not happen, before a failure's note on the invites it left unused */
  unmade: string;
  /** the button, as the pause before a reused seat names it */
  button: string;
}) {
  const [busy, setBusy] = useState(false);
  const [say, setSay] = useState("");
  const [alert, setAlert] = useState("");
  const [nameErr, setNameErr] = useState("");
  const [otherErr, setOtherErr] = useState<{ room: string; text: string } | null>(null);
  // the new keys' counters are full: the button waits until their window ends
  const [waiting, setWaiting] = useState(false);
  // the check that paused before reusing seats: the next run with the form unchanged (the same check) goes ahead
  const [pauseFor, setPauseFor] = useState<SeatCheck | null>(null);
  const paused = pauseFor !== null && o.form.check === pauseFor;
  const wait = (sec: number) => {
    setWaiting(true);
    window.setTimeout(() => setWaiting(false), Math.max(1, sec) * 1000);
  };
  const run = async () => {
    setAlert("");
    setNameErr("");
    setOtherErr(null);
    const got = entriesOf(o.form, o.rooms);
    if ("problem" in got) {
      if (got.room) setOtherErr({ room: got.room, text: got.problem });
      else setNameErr(got.problem);
      return;
    }
    setBusy(true);
    let check: SeatCheck;
    if (paused && o.form.check) check = o.form.check;
    else {
      setPauseFor(null);
      setSay("Checking the rooms…");
      try {
        check = (await o.call(got.name, got.entries, true)) as SeatCheck;
      } catch (e) {
        setBusy(false);
        setSay("");
        setAlert(keyRefusal(e));
        return;
      }
    }
    if (!check.ok) {
      setBusy(false);
      setSay("");
      o.setForm({ ...o.form, check, failed: null });
      if (check.retry_after) {
        wait(check.retry_after);
        setAlert(CAP_FULL + " Try again in " + inTime(check.retry_after) + ".");
      } else if (check.problem) setAlert(check.problem.error);
      else setAlert("Some rooms can't take the agent as it is: each one above says why.");
      return;
    }
    // a seat that already exists, not asked for: pause, say so, and let the next tap go ahead
    if (!paused && reusedUnasked(check, o.form).length) {
      setBusy(false);
      setSay("");
      o.setForm({ ...o.form, check, failed: null });
      setPauseFor(check);
      return;
    }
    setPauseFor(null);
    o.setForm({ ...o.form, check, failed: null });
    setSay(o.making);
    try {
      const r = (await o.call(got.name, got.entries, false)) as T;
      setBusy(false);
      setSay("");
      o.done(r);
    } catch (e) {
      setBusy(false);
      setSay("");
      const b = bodyOf(e);
      if (!b) {
        setAlert(o.lost);
        return;
      }
      if (b.code === "rate_limited" && !b.room) {
        if (b.retry_after) wait(b.retry_after);
        setAlert(CAP_FULL + (b.retry_after ? " Try again in " + inTime(b.retry_after) + "." : " Try again later."));
        return;
      }
      if (b.room && o.form.ticked.includes(b.room)) o.setForm({ ...o.form, check, failed: { room: b.room, error: b.error || "" } });
      const head = b.room && o.form.ticked.includes(b.room) ? "" : keyRefusal(e) + " ";
      // the note says which invites stay unused, or may have been made: "Nothing was kept." only when nothing was
      setAlert(head + (b.note ? o.unmade + " " + b.note : "Nothing was kept."));
    }
  };
  const reuse = paused && pauseFor ? reusedUnasked(pauseFor, o.form) : [];
  const pause = reuse.length
    ? (reuse.length === 1 ? reuse[0] + " reuses a seat that already exists. " : "These rooms reuse a seat that already exists: " + reuse.join(", ") + ". ") +
      "Another key that holds such a seat keeps working for it. " + o.button + " goes ahead."
    : "";
  return { busy, say, alert, nameErr, otherErr, waiting, run, pause };
}

/** The rooms a check would give a seat that already exists, unless the person ticked to use that seat. */
function reusedUnasked(check: SeatCheck, form: SeatForm): string[] {
  return check.rooms.filter((r) => r.seat === "reused" && !form.useSeat.includes(r.room)).map((r) => r.room);
}

/** The new key, shown once: the key and what to give the agent. The page
 *  fills the key into Claude Code's two texts, which go into a file or a
 *  terminal; the hand-off, which goes into a chat, keeps the word KEY. */
function KeyMade({ made, name, onDone, cardRef }: { made: PersonKeyMade; name: string; onDone: () => void; cardRef: RefObject<HTMLDivElement | null> }) {
  const fill = (s: string) => s.split("Bearer KEY").join("Bearer " + made.key);
  const settings = fill(made.mcp_json);
  const line = fill(made.claude_code);
  const handoff = made.handoff;
  return (
    <Card className="key-made" id="keyMade" tabIndex={-1} ref={cardRef} aria-labelledby="keyMadeTitle">
      <h2 id="keyMadeTitle">{name}'s agent key</h2>
      <div className="row">
        <input type="text" id="keyMadeKey" readOnly value={made.key} aria-label="Agent key" autoComplete="off" spellCheck={false} autoCapitalize="off" />
        <Button type="button" id="keyMadeCopyKey" onClick={() => copy(made.key)}>
          Copy
        </Button>
      </div>
      <h3 className="key-sub">For Claude Code</h3>
      <p className="hint">Put this in the .mcp.json file of the folder you run Claude Code in, which keeps the key off command lines. Keep that file out of version control.</p>
      <pre className="key-text" id="keyMadeSettings">{settings}</pre>
      <Button type="button" size="sm" id="keyMadeCopySettings" onClick={() => copy(settings)}>
        Copy
      </Button>
      <p className="hint">Or add it with one line. The line stays in your shell's history.</p>
      <pre className="key-text" id="keyMadeLine">{line}</pre>
      <Button type="button" size="sm" id="keyMadeCopyLine" onClick={() => copy(line)}>
        Copy
      </Button>
      <h3 className="key-sub">For Muse</h3>
      <p className="hint" id="keyMadeMuse">
        In Muse, ask it to add a custom connector for {made.address}, then paste the key into the "API Key" box it shows, never into the chat.
      </p>
      <h3 className="key-sub">For your agent</h3>
      <p className="hint" id="keyMadeHandoffHint">
        Send this to your agent in a chat. It says KEY where the key goes: the key itself goes only into the agent's MCP settings or its secure credential field, never
        into a chat.
      </p>
      <pre className="key-text" id="keyMadeHandoff">{handoff}</pre>
      <Button type="button" size="sm" id="keyMadeCopyHandoff" onClick={() => copy(handoff)}>
        Copy
      </Button>
      <h3 className="key-sub">Rooms</h3>
      <ul className="key-list" id="keyMadeRooms">
        {made.rooms.map((r) => (
          <li key={r.room}>
            <span className="rn">{r.room}</span> <span className="who">as {r.name}</span> <Pill tone={r.seat === "new" ? undefined : "muted"}>{r.seat === "new" ? "new invite" : "existing seat"}</Pill>
          </li>
        ))}
      </ul>
      {made.rooms.some((r) => r.seat === "reused") ? (
        <p className="hint" id="keyMadeShared">
          An existing seat may be held by another key too: that key still works for it, and disconnecting this one does not cut it.
        </p>
      ) : null}
      <p className="hint" id="keyMadeNote">{made.note}</p>
      <div className="dlg-actions">
        <Button type="button" variant="primary" id="keyMadeDone" onClick={onDone}>
          Done
        </Button>
      </div>
    </Card>
  );
}

/** Section 1: make a key for an agent from rooms this browser holds. */
function MakeKey(props: { rooms: DeviceRoom[]; looks: Record<string, Look>; retry: (r: DeviceRoom) => void; focusOpen: () => void }) {
  const { rooms, looks, retry, focusOpen } = props;
  const [form, setForm] = useState<SeatForm>(() => emptyForm());
  const [made, setMade] = useState<{ key: PersonKeyMade; name: string } | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const run = useSeatRun<PersonKeyMade>({
    rooms,
    form,
    setForm,
    call: (name, entries, check) => (check ? new AgentKeyClient(null).invite(name, entries, true) : new AgentKeyClient(null).invite(name, entries)),
    done: (r) => {
      setMade({ key: r, name: cleanAgentName(form.name) });
      setForm(emptyForm());
    },
    making: "Making the key…",
    unmade: "No key was made.",
    button: "Make key",
    lost: "Couldn't reach the site, so this page can't tell whether the key was made. If it was, it is lost: nobody can see it again. Making the key again with the same name uses the same seats.",
  });
  useEffect(() => {
    if (made && cardRef.current) cardRef.current.focus();
  }, [made]);
  const settled = rooms.length > 0 && rooms.every((r) => (looks[r.room] || CHECKING).state !== "checking");
  const person = rooms.some((r) => (looks[r.room] || CHECKING).state === "person");
  const agentsOnly = settled && !person && rooms.some((r) => (looks[r.room] || CHECKING).state === "agent");
  if (made) {
    return (
      <KeyMade
        made={made.key}
        name={made.name}
        cardRef={cardRef}
        onDone={() => {
          setMade(null);
          focusOpen();
        }}
      />
    );
  }
  return (
    <Card className="key-make" id="keyMake">
      <h2>Make a key for an agent</h2>
      {rooms.length === 0 ? (
        <p className="hint key-lead" id="keyEmpty">
          This browser holds none of your rooms yet. Open one of your invite links here first; then you can make a key for an agent in that room.
        </p>
      ) : (
        <>
          {agentsOnly ? (
            <p className="hint key-lead" id="keyAgentsOnly">
              Every invite this browser holds is an agent's. A key is made with a person's own invite: open your own invite link here first.
            </p>
          ) : null}
          <label className="field">
            The agent's name
            <input
              type="text"
              id="keyName"
              maxLength={AGENT_NAME_MAX}
              autoComplete="off"
              spellCheck={false}
              disabled={run.busy}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.currentTarget.value, check: null, failed: null })}
            />
            <span className="hint">Its name in each room you tick. Members see it as an agent invited by you.</span>
          </label>
          {run.nameErr ? (
            <p className="hint bad" id="keyNameErr" role="alert">
              {run.nameErr}
            </p>
          ) : null}
          <div className="list-label">Rooms on this browser</div>
          <RoomPicker id="keyRooms" rooms={rooms} looks={looks} retry={retry} form={form} setForm={setForm} busy={run.busy} otherErr={run.otherErr} />
          {run.alert ? (
            <p className="hint bad" id="keyErr" role="alert">
              {run.alert}
            </p>
          ) : null}
          {run.pause ? (
            <p className="hint key-pause" id="keyReuse" role="status">
              {run.pause}
            </p>
          ) : null}
          <p className="hint" id="keySay" aria-live="polite">
            {run.say}
          </p>
          <Button type="button" variant="primary" id="keyGo" disabled={run.busy || run.waiting || !form.name.trim() || !form.ticked.length} onClick={() => void run.run()}>
            Make key
          </Button>
        </>
      )}
    </Card>
  );
}

/** What the refused state's code means, in words. */
const REFUSED_WHY: Record<string, string> = {
  invite_revoked: "revoked, or the agent left",
  invite_invalid: "no longer valid there",
  room_deleted: "the room was deleted",
};

/** The most common of the agent's names on a key. */
function commonName(rooms: AgentKeyRoom[]): string {
  const n = new Map<string, number>();
  for (const r of rooms) n.set(r.name, (n.get(r.name) || 0) + 1);
  let best = "", most = 0;
  for (const [k, v] of n) if (v > most) { best = k; most = v; }
  return best;
}

/** Section 2: a key the person holds, pasted here to see its rooms, add
 *  rooms, take one off, or disconnect it. */
function HeldKey(props: { rooms: DeviceRoom[]; looks: Record<string, Look>; retry: (r: DeviceRoom) => void; openRef: RefObject<HTMLInputElement | null> }) {
  const { rooms, looks, retry, openRef } = props;
  const [paste, setPaste] = useState("");
  const [held, setHeld] = useState<{ key: string; info: AgentKeyInfo } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [say, setSay] = useState("");
  const [dropped, setDropped] = useState<AgentKeyDropped | null>(null);
  const [off, setOff] = useState<AgentKeyRoom | null>(null);
  const [dlgErr, setDlgErr] = useState("");
  const [form, setForm] = useState<SeatForm>(() => emptyForm());
  const offRef = useRef<HTMLDialogElement | null>(null);
  const dropRef = useRef<HTMLDialogElement | null>(null);
  // focus goes back to the Open field once a cleared key's controls are gone
  const [refocus, setRefocus] = useState(0);
  useEffect(() => {
    if (refocus) openRef.current?.focus();
  }, [refocus, openRef]);

  const clear = () => {
    setHeld(null);
    setPaste("");
    setForm(emptyForm());
    setSay("");
    setRefocus((n) => n + 1);
  };
  const reload = async (key: string) => {
    try {
      const info = await new AgentKeyClient(key).info();
      setHeld({ key, info });
    } catch (e) {
      setErr(keyRefusal(e));
    }
  };
  const open = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setSay("");
    setDropped(null);
    const k = paste.trim();
    if (!k) return;
    if (k.charAt(0) !== ".") return setErr(NOT_KEY);
    if (!KEY_RE.test(k)) return setErr("That is not an agent key: one starts with .ac1. and is " + KEY_LENGTH + " characters long.");
    setBusy(true);
    try {
      const info = await new AgentKeyClient(k).info();
      setHeld({ key: k, info });
      setForm(emptyForm(commonName(info.rooms)));
    } catch (ex) {
      setErr(keyRefusal(ex));
    } finally {
      setBusy(false);
    }
  };
  const ask = (dlg: HTMLDialogElement | null, question: string, go: () => void) => {
    setDlgErr("");
    if (dlg && dlg.showModal) dlg.showModal();
    else if (window.confirm(question)) go();
  };
  const takeOff = async (r: AgentKeyRoom) => {
    if (!held) return;
    setBusy(true);
    setDlgErr("");
    try {
      await new AgentKeyClient(held.key).removeRoom(r.room);
      offRef.current?.close();
      setOff(null);
      toast(r.room + " is off the key.");
      await reload(held.key);
    } catch (e) {
      const t = keyRefusal(e);
      if (offRef.current && offRef.current.open) setDlgErr(t);
      else setErr(t);
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    if (!held) return;
    setBusy(true);
    setDlgErr("");
    try {
      const d = await new AgentKeyClient(held.key).disconnect();
      dropRef.current?.close();
      // the agent is a member only where a room still took the key's invite, as the key last showed it
      const took = new Set(held.info.rooms.filter((r) => r.state === "held").map((r) => r.room));
      setDropped({ ...d, rooms: d.rooms.filter((r) => took.has(r)) });
      clear();
    } catch (e) {
      const t = keyRefusal(e);
      if (dropRef.current && dropRef.current.open) setDlgErr(t);
      else setErr(t);
    } finally {
      setBusy(false);
    }
  };
  const onKey = held ? new Set(held.info.rooms.filter((r) => r.state === "held").map((r) => r.room)) : new Set<string>();
  const addable = rooms.filter((r) => !onKey.has(r.room));
  const full = !!held && held.info.rooms.length >= held.info.max_rooms && !held.info.rooms.some((r) => r.state === "refused");
  const add = useSeatRun<{ rooms: { room: string }[] }>({
    rooms: addable,
    form,
    setForm,
    call: (name, entries, check) => {
      const c = new AgentKeyClient(held ? held.key : null);
      return check ? c.addRooms(name, entries, true) : c.addRooms(name, entries);
    },
    done: (r) => {
      setSay("Added: " + r.rooms.map((x) => x.room).join(", ") + ".");
      setForm(emptyForm(form.name));
      if (held) void reload(held.key);
    },
    making: "Adding the rooms…",
    unmade: "No room was added.",
    button: "Add rooms",
    lost: "Couldn't reach the site, so this page can't tell whether the rooms were added. Open the key again to see; adding them again with the same name uses the same seats.",
  });

  return (
    <Card className="key-held" id="keyHeld">
      <h2>A key you hold</h2>
      <form className="row" id="keyOpen" onSubmit={(e) => void open(e)}>
        <input
          type="text"
          id="keyPaste"
          ref={openRef}
          aria-label="Agent key"
          placeholder="Agent key"
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          disabled={busy}
          value={paste}
          onChange={(e) => setPaste(e.currentTarget.value)}
        />
        <Button type="submit" disabled={busy || !paste.trim()}>
          Open
        </Button>
      </form>
      {err ? (
        <p className="hint bad" id="keyHeldErr" role="alert">
          {err}
        </p>
      ) : null}
      {/* the section's one live region: progress and results, the disconnect's included */}
      <p className="hint key-say" id="keyHeldSay" aria-live="polite">
        {dropped ? (
          <span id="keyDropped">
            {"Disconnected." + (dropped.rooms.length ? " The agent is still a member of: " + dropped.rooms.join(", ") + "." : "")}
            {dropped.muse_wakes_left === null
              ? " This key's record could not be read, so the Muse wakes it set up could not be turned off: Disconnect on the Muse gadget stops every wake at once."
              : dropped.muse_wakes_left.length
                ? " These rooms did not confirm that the Muse wakes this key set up there are off: " + dropped.muse_wakes_left.join(", ") + ". Disconnect on the Muse gadget stops every wake at once."
                : ""}
          </span>
        ) : (
          add.say || say
        )}
      </p>
      {held ? (
        <div className="key-open" id="keyOpened">
          <p className="hint" id="keyMeta">
            Made {shortDate(held.info.created)} · {held.info.rooms.length} of {held.info.max_rooms} rooms
          </p>
          <ul className="key-list" id="keyHeldRooms">
            {held.info.rooms.map((r) => (
              <li key={r.room} data-room={r.room}>
                <div className="key-row-main">
                  <span className="rn">{r.room}</span> <span className="who">as {r.name}, added {shortDate(r.added)}</span>
                  <div className="key-state">
                    {r.state === "held" ? (
                      <>
                        <Pill>On this key</Pill>
                        {r.muse_wake ? (
                          <>
                            {" "}
                            <Pill tone="muted">Muse wake set up with this key</Pill>
                          </>
                        ) : null}
                      </>
                    ) : (
                      <span className="hint bad">
                        This room no longer takes the key's invite ({REFUSED_WHY[r.code || ""] || r.code}){r.at ? " since " + shortDate(r.at) : ""}
                      </span>
                    )}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setOff(r);
                    ask(offRef.current, "Take " + r.room + " off this key?", () => void takeOff(r));
                  }}
                >
                  Take off this key
                </Button>
              </li>
            ))}
          </ul>
          <h3 className="key-sub">Add rooms</h3>
          {full ? (
            <p className="hint" id="keyFull">
              This key holds the most rooms it can ({held.info.max_rooms}): take one off before you add another.
            </p>
          ) : addable.length === 0 ? (
            <p className="hint" id="keyNoMore">
              Every room this browser holds is on this key already.
            </p>
          ) : (
            <>
              <label className="field">
                The agent's name
                <input
                  type="text"
                  id="keyAddName"
                  maxLength={AGENT_NAME_MAX}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={add.busy || busy}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.currentTarget.value, check: null, failed: null })}
                />
              </label>
              {add.nameErr ? (
                <p className="hint bad" role="alert">
                  {add.nameErr}
                </p>
              ) : null}
              <RoomPicker id="keyAddRooms" rooms={addable} looks={looks} retry={retry} form={form} setForm={setForm} busy={add.busy || busy} otherErr={add.otherErr} />
              {add.alert ? (
                <p className="hint bad" id="keyAddErr" role="alert">
                  {add.alert}
                </p>
              ) : null}
              {add.pause ? (
                <p className="hint key-pause" id="keyAddReuse" role="status">
                  {add.pause}
                </p>
              ) : null}
              <Button type="button" id="keyAdd" disabled={add.busy || busy || add.waiting || !form.name.trim() || !form.ticked.length} onClick={() => void add.run()}>
                Add rooms
              </Button>
            </>
          )}
          <div className="dlg-actions">
            <Button type="button" id="keyClose" disabled={busy || add.busy} onClick={clear}>
              Close
            </Button>
            <Button type="button" className="danger-solid" id="keyDrop" disabled={busy || add.busy} onClick={() => ask(dropRef.current, "Disconnect this key everywhere?", () => void disconnect())}>
              Disconnect everywhere
            </Button>
          </div>
        </div>
      ) : null}
      <Dialog
        className="key-dlg"
        id="keyOffDlg"
        aria-labelledby="keyOffTitle"
        ref={offRef}
        onClick={(e) => {
          if (e.target === e.currentTarget && !busy) e.currentTarget.close();
        }}
        onCancel={(e) => {
          if (busy) e.preventDefault();
        }}
      >
        <h3 id="keyOffTitle">Take {off ? off.room : ""} off this key?</h3>
        {off && off.state !== "held" ? (
          <p>
            The key forgets this room, which no longer takes the key's invite ({REFUSED_WHY[off.code || ""] || off.code}). Nothing else changes there.
          </p>
        ) : (
          <p>
            The key forgets this room. The agent stays a member of {off ? off.room : ""}. Once it is off the key, the agent cannot leave {off ? off.room : ""} through the
            key: to take it out of {off ? off.room : ""}, have it leave first (leave_room), or add {off ? off.room : ""} back later.
          </p>
        )}
        {off && off.muse_wake ? <p>The Muse wake set up with this key in {off.room} is turned off.</p> : null}
        {dlgErr ? (
          <p className="forget-err" role="alert">
            {dlgErr}
          </p>
        ) : null}
        <div className="dlg-actions">
          <Button type="button" id="keyOffNo" disabled={busy} onClick={() => offRef.current?.close()}>
            Cancel
          </Button>
          <Button type="button" className="danger-solid" id="keyOffYes" disabled={busy} onClick={() => off && void takeOff(off)}>
            {busy ? "Taking it off…" : "Take it off"}
          </Button>
        </div>
      </Dialog>
      <Dialog
        className="key-dlg"
        id="keyDropDlg"
        aria-labelledby="keyDropTitle"
        ref={dropRef}
        onClick={(e) => {
          if (e.target === e.currentTarget && !busy) e.currentTarget.close();
        }}
        onCancel={(e) => {
          if (busy) e.preventDefault();
        }}
      >
        <h3 id="keyDropTitle">Disconnect this key everywhere?</h3>
        <p>
          It stops working at once, in every room. The agent stays a member of each room that still takes this key's invite until it leaves or the site's owner removes
          it; any room link it was given itself still works; links it already got for an upload or a file run until they expire. The Muse wakes this key set up are
          turned off.
        </p>
        {dlgErr ? (
          <p className="forget-err" role="alert">
            {dlgErr}
          </p>
        ) : null}
        <div className="dlg-actions">
          <Button type="button" id="keyDropNo" disabled={busy} onClick={() => dropRef.current?.close()}>
            Cancel
          </Button>
          <Button type="button" className="danger-solid" id="keyDropYes" disabled={busy} onClick={() => void disconnect()}>
            {busy ? "Disconnecting…" : "Disconnect"}
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}

/** The view: both sections. pagehide remounts them, which drops every key
 *  the page holds (a page kept in the back-forward cache comes back
 *  without it). */
export function AgentKeysView({ rooms }: { rooms: DeviceRoom[] }) {
  const { looks, retry } = useLooks(rooms);
  const [gen, setGen] = useState(0);
  const openRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    // at once, inside the event: a page frozen into the back-forward cache keeps no key in its DOM or state
    const drop = () => flushSync(() => setGen((g) => g + 1));
    window.addEventListener("pagehide", drop);
    return () => window.removeEventListener("pagehide", drop);
  }, []);
  return (
    <Page id="view-keys" aria-label="Agent keys">
      <h1 className="page-title">Agent keys</h1>
      <p className="lede">
        One key lets an agent use several of your rooms through one connection. Pick the rooms here: the site invites the agent into each with your invite and puts the
        invites on the key, so the site never gives the agent a new seat's own link (a person in the room can still see it in the members list). Where it reuses a seat
        the agent already had, anyone you gave that invite's link can still use it, and so can another key that holds that seat.
      </p>
      <div key={gen}>
        <MakeKey rooms={rooms} looks={looks} retry={retry} focusOpen={() => openRef.current?.focus()} />
        <HeldKey rooms={rooms} looks={looks} retry={retry} openRef={openRef} />
      </div>
    </Page>
  );
}
