import { useEffect, useRef, useState } from "react";
import { ApiError, RoomClient, type PersonSeatEntry, type SeatCheck, type SeatCheckRoom } from "@chat/contract";
import { LinkButton } from "../../ui/Button";
import { toast } from "../../lib/index";
import { AGENT_NAME_MAX, agentNameProblem, cleanAgentName } from "./agentName";

// The parts a person uses to give an agent seats in the rooms this browser
// holds: the look at each room (GET /invite, which opens nothing), the
// checkbox rows, the entries a form sends, and the run (a check first, a
// pause before a seat that already exists, then the call). The Agent keys
// view (AgentKeys.tsx) makes a key with them and the approval page
// (features/signin/SignInApproval.tsx) a connection; each passes its noun,
// which the sentences use. Every name and sentence from the server is
// rendered as text.

/** What the sentences call the thing that holds the seats. */
export type Noun = "key" | "connection";

/** A room this browser holds: the person's invite token there (localStorage chat-invite:ROOM). */
export interface DeviceRoom {
  room: string;
  token: string;
  you: string;
}

/** What the look (GET /invite) said of the device's invite in a room. */
export type Look =
  | { state: "checking" }
  | { state: "person"; you: string }
  | { state: "agent" }
  | { state: "refused" }
  | { state: "gone" }
  | { state: "failed" };

export const CHECKING: Look = { state: "checking" };

const REASON: Record<Exclude<Look["state"], "person">, string> = {
  checking: "Checking…",
  agent: "The invite this browser holds here is an agent's.",
  refused: "This browser's invite here no longer works.",
  gone: "This room no longer exists.",
  failed: "Couldn't check this room; try again.",
};

export const NETWORK = "Couldn't reach the site; try again.";

/** A refusal's code and body, when the answer was the Worker's. */
export interface Refusal {
  status: number;
  code?: string;
  error?: string;
  room?: string;
  note?: string;
  retry_after?: number;
  left_unused?: string[];
  maybe_unused?: string[];
}

const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);

/** A refusal's code and body, when the answer was the Worker's; null when there was no answer. */
export function bodyOf(e: unknown): Refusal | null {
  if (!(e instanceof ApiError)) return null;
  const b = e.body && typeof e.body === "object" ? (e.body as Record<string, unknown>) : {};
  return {
    status: e.status,
    code: typeof b.code === "string" ? b.code : undefined,
    error: typeof b.error === "string" ? b.error : undefined,
    room: typeof b.room === "string" ? b.room : undefined,
    note: typeof b.note === "string" ? b.note : undefined,
    retry_after: typeof b.retry_after === "number" ? b.retry_after : undefined,
    left_unused: strings(b.left_unused),
    maybe_unused: strings(b.maybe_unused),
  };
}

/** A sentence about room R, without the "Room "R": " the row already says. */
export function onRow(room: string, s: string): string {
  const p = 'Room "' + room + '": ';
  return s.startsWith(p) ? s.slice(p.length) : s;
}

/** Seconds as "N minutes" (or seconds, hours). */
export function inTime(sec: number): string {
  if (sec < 60) return sec === 1 ? "a second" : sec + " seconds";
  const m = Math.ceil(sec / 60);
  if (m < 60) return m === 1 ? "a minute" : m + " minutes";
  const h = Math.floor(m / 60), r = m % 60;
  return (h === 1 ? "an hour" : h + " hours") + (r ? " and " + (r === 1 ? "a minute" : r + " minutes") : "");
}

/** Copies text, with the toasts "Copied" / "Couldn't copy". */
export function copy(text: string) {
  try {
    void navigator.clipboard.writeText(text).then(
      () => toast("Copied"),
      () => toast("Couldn't copy", true)
    );
  } catch {
    toast("Couldn't copy", true);
  }
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
export function useLooks(rooms: DeviceRoom[]) {
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

/** The form for an agent's seats: the agent's name, the rooms ticked, a
 *  name of its own in a room, the rooms where the person said to use the
 *  agent's seat already in use, and the last check's answer. */
export interface SeatForm {
  name: string;
  ticked: string[];
  other: Record<string, string>;
  useSeat: string[];
  check: SeatCheck | null;
  /** a refusal the check did not see, on its room */
  failed: { room: string; error: string } | null;
}
export const emptyForm = (name = ""): SeatForm => ({ name, ticked: [], other: {}, useSeat: [], check: null, failed: null });

/** The entries a form sends, in the device's order; null with the first name problem. */
export function entriesOf(f: SeatForm, rooms: DeviceRoom[]): { name: string; entries: PersonSeatEntry[] } | { problem: string; room?: string } {
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
export function RoomPicker(props: {
  id: string;
  noun: Noun;
  rooms: DeviceRoom[];
  looks: Record<string, Look>;
  retry: (r: DeviceRoom) => void;
  form: SeatForm;
  setForm: (f: SeatForm) => void;
  busy: boolean;
  otherErr: { room: string; text: string } | null;
}) {
  const { id, noun, rooms, looks, retry, form, setForm, busy, otherErr } = props;
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
                    Uses {res.name}'s unused invite here (invited by you). Anyone you gave that invite's link can still use it, and another key or connection that holds this
                    seat still works for it: disconnecting this {noun} does not cut that one.
                  </p>
                ) : null}
                {res && res.seat === "reused" && res.opened ? (
                  <p className="hint">
                    Uses {res.name}'s seat here (already a member, invited by you). Another key or connection that holds this seat still works for it: disconnecting this {noun} does
                    not cut that one.
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

/** The creation counters are full: what was made too often just now. */
export function capFull(noun: Noun): string {
  return "Too many " + (noun === "key" ? "agent keys" : "connections") + " were made just now, from this network, for one of these rooms or on the whole site.";
}

/** Runs a form's check, then, when nothing stands in the way, the call
 *  itself at once. say: the live region; alert: the error line. */
export function useSeatRun<T>(o: {
  noun: Noun;
  rooms: DeviceRoom[];
  form: SeatForm;
  setForm: (f: SeatForm) => void;
  call: (name: string, entries: PersonSeatEntry[], check: boolean) => Promise<SeatCheck | T>;
  done: (r: T) => void;
  making: string;
  lost: string;
  /** a refusal in plain words, when it is not on a row */
  refusal: (e: unknown) => string;
  /** what a failed call made or did not make, from its refusal */
  unmade: (b: Refusal) => string;
  /** the button, as the pause before a reused seat names it */
  button: string;
  /** a refusal the page answers itself (true: nothing more is said here) */
  taken?: (b: Refusal) => boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [say, setSay] = useState("");
  const [alert, setAlert] = useState("");
  const [nameErr, setNameErr] = useState("");
  const [otherErr, setOtherErr] = useState<{ room: string; text: string } | null>(null);
  // the creation counters are full: the button waits until their window ends
  const [waiting, setWaiting] = useState(false);
  // the check that paused before reusing seats: the next run with the form unchanged (the same check) goes ahead
  const [pauseFor, setPauseFor] = useState<SeatCheck | null>(null);
  const paused = pauseFor !== null && o.form.check === pauseFor;
  const wait = (sec: number) => {
    setWaiting(true);
    window.setTimeout(() => setWaiting(false), Math.max(1, sec) * 1000);
  };
  const full = capFull(o.noun);
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
        const b = bodyOf(e);
        if (b && o.taken && o.taken(b)) return;
        setAlert(o.refusal(e));
        return;
      }
    }
    if (!check.ok) {
      setBusy(false);
      setSay("");
      o.setForm({ ...o.form, check, failed: null });
      if (check.retry_after) {
        wait(check.retry_after);
        setAlert(full + " Try again in " + inTime(check.retry_after) + ".");
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
      // a room the check called new is made new or not at all: a seat of that name that appeared since is a refusal, never a silent reuse
      const sent = got.entries.map((e) => (check.rooms.some((x) => x.room === e.room && x.seat === "new") ? { ...e, reuse: "none" as const } : e));
      const r = (await o.call(got.name, sent, false)) as T;
      setBusy(false);
      setSay("");
      o.done(r);
    } catch (e) {
      setBusy(false);
      setSay("");
      const b = bodyOf(e);
      // no answer, or the platform's own page in place of the Worker's (a 5xx with neither a sentence nor a code): what was made is not known
      if (!b || (b.status >= 500 && !b.error && !b.code)) {
        setAlert(o.lost);
        return;
      }
      if (o.taken && o.taken(b)) return;
      if (b.code === "rate_limited" && !b.room) {
        if (b.retry_after) wait(b.retry_after);
        setAlert(full + (b.retry_after ? " Try again in " + inTime(b.retry_after) + "." : " Try again later."));
        return;
      }
      if (b.room && o.form.ticked.includes(b.room)) o.setForm({ ...o.form, check, failed: { room: b.room, error: b.error || "" } });
      const head = b.room && o.form.ticked.includes(b.room) ? "" : o.refusal(e) + " ";
      setAlert(head + o.unmade(b));
    }
  };
  const reuse = paused && pauseFor ? reusedUnasked(pauseFor, o.form) : [];
  const pause = reuse.length
    ? (reuse.length === 1 ? reuse[0] + " reuses a seat that already exists. " : "These rooms reuse a seat that already exists: " + reuse.join(", ") + ". ") +
      "Another key or connection that holds such a seat keeps working for it. " + o.button + " goes ahead."
    : "";
  return { busy, say, alert, nameErr, otherErr, waiting, run, pause };
}

/** The rooms a check would give a seat that already exists, unless the person ticked to use that seat. */
function reusedUnasked(check: SeatCheck, form: SeatForm): string[] {
  return check.rooms.filter((r) => r.seat === "reused" && !form.useSeat.includes(r.room)).map((r) => r.room);
}
