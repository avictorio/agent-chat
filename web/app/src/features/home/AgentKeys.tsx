import { useEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import {
  AgentKeyClient,
  SignInClient,
  type AgentKeyDropped,
  type AgentKeyInfo,
  type AgentKeyLeaveKept,
  type AgentKeyRoom,
  type AgentKeyRoomLeft,
  type PersonKeyMade,
} from "@chat/contract";
import { Button, LinkButton } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { Dialog } from "../../ui/Dialog";
import { Page } from "../../ui/Page";
import { Pill } from "../../ui/Pill";
import { toast } from "../../lib/index";
import { shortDate } from "../../lib/dates";
import { AGENT_NAME_MAX, cleanAgentName } from "./agentName";
import { CHECKING, NETWORK, RoomPicker, bodyOf, copy, emptyForm, useLooks, useSeatRun, type DeviceRoom, type Look, type Refusal, type SeatForm } from "./seatForm";
import { appByKey } from "../signin/apps";
import { dropSignin, signinRecords, type SigninRecord } from "../signin/records";

export type { DeviceRoom } from "./seatForm";

// Home → Agent keys: a person makes an agent key for their agent from the
// rooms this browser holds (POST /api/agents/invite: the site invites the
// agent into each room with the person's own invite and puts the invites on
// the key), and manages a key they paste (GET /api/agent, POST
// /api/agent/rooms/invite, POST /api/agent/rooms/remove, POST
// /api/agent/rooms/leave, DELETE /api/agent). The only room calls are the
// looks of GET /invite, which open nothing. Its seat form is seatForm.tsx's,
// which the approval page (features/signin/SignInApproval.tsx) uses too.
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
//
// Its third section lists the connections the approval page approved in
// this browser (localStorage chat-signin:<id>, features/signin/records.ts,
// written there): it only reads them, disconnects one with its
// disconnect-only code (POST /api/oauth/disconnect) and removes a record.

const KEY_RE = /^\.ac1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
const KEY_LENGTH = 71;
const NOT_KEY = "That is a room invite link or token, not an agent key.";

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

/** What a failed key call made: the server's note on the invites it left unused, or "Nothing was kept." */
const keyUnmade = (what: string) => (b: Refusal) => (b.note ? what + " " + b.note : "Nothing was kept.");

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
          An existing seat may be held by another key or connection too: that one still works for it, and disconnecting this key does not cut it.
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
    noun: "key",
    rooms,
    form,
    setForm,
    call: (name, entries, check) => (check ? new AgentKeyClient(null).invite(name, entries, true) : new AgentKeyClient(null).invite(name, entries)),
    done: (r) => {
      setMade({ key: r, name: cleanAgentName(form.name) });
      setForm(emptyForm());
    },
    making: "Making the key…",
    refusal: keyRefusal,
    unmade: keyUnmade("No key was made."),
    button: "Make key",
    lost: "Couldn't reach the site, so this page can't tell whether the key was made. If it was, it is lost: nobody can see it again. Making the key again with the same name uses the same seats.",
  });
  useEffect(() => {
    if (made && cardRef.current) cardRef.current.focus();
  }, [made]);
  const settled = rooms.length > 0 && rooms.every((r) => (looks[r.room] || CHECKING).state !== "checking");
  // said only when every room's invite is an agent's: any other mix leaves the rows to say why each one can't be ticked
  const agentsOnly = settled && rooms.every((r) => (looks[r.room] || CHECKING).state === "agent");
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
          <RoomPicker id="keyRooms" noun="key" rooms={rooms} looks={looks} retry={retry} form={form} setForm={setForm} busy={run.busy} otherErr={run.otherErr} />
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

/** What a leave's answer or refusal says, in plain words: the agent's
 *  name and the room are the row's. A refusal of the seat's token is said
 *  in the refused row's own words (the room's own sentence speaks to the
 *  agent); a refusal of the key, or of its record, as the other controls
 *  say it; no answer at all (or none from the site) leaves it unknown. */
function leaveSaid(r: AgentKeyRoom, e: unknown): string {
  const b = bodyOf(e);
  if (!b || (!b.code && !b.error && b.status >= 500)) return "Couldn't reach the site, so this page can't tell whether " + r.name + " left " + r.room + ". Open the key again to see.";
  if (b.code === "last_member") return r.name + " is the last member of " + r.room + " who has joined: leaving would delete the room, and this page never deletes a room. Nothing was changed.";
  if (b.code === "not_joined") return r.name + " has not joined " + r.room + " yet, so there is nothing to leave. To keep it out of " + r.room + ", take " + r.room + " off this key.";
  if (b.code && b.room === r.room && (b.status === 403 || b.status === 404 || b.status === 410) && b.code !== "room_not_held" && b.code !== "agent_key_invalid" && b.code !== "not_agent_key") {
    return r.room + " no longer takes the key's invite (" + (REFUSED_WHY[b.code] || b.code) + "), so there was nothing to leave.";
  }
  return keyRefusal(e);
}

/** What the key still lists after a leave, said for a person with the
 *  page's own controls (the answer's note is for an agent and names API
 *  paths). code: the entry's code as the key lists it after the leave; one
 *  a room gave it before the leave's mark (room_deleted, say) is kept, so
 *  only invite_revoked, or no list to read, says "as left". */
function keptSaid(room: string, kept: AgentKeyLeaveKept | undefined, code?: string): string {
  const asLeft = code === undefined || code === "invite_revoked" ? ", as left" : "";
  if (kept === "marked") return room + " is still listed on this key" + asLeft + ": Take off this key takes it off.";
  if (kept === "marked_wake") return "This key could not yet confirm that it has let go of the Muse wake it set up in " + room + ", so " + room + " is still listed on this key" + asLeft + ": Take off this key tries again.";
  if (kept === "listed") return "This key could not record the leave yet, so " + room + " still shows as on this key: Take off this key takes it off.";
  if (kept === "cut") return "This key was disconnected meanwhile.";
  if (kept === "other") return room + " is on this key again, with another invite.";
  return room + " is still listed on this key: Take off this key takes it off.";
}

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
  // a disconnect that left Muse wakes: the cut key, kept in this view's memory only, so DELETE can be sent again
  const [again, setAgain] = useState<string | null>(null);
  const [retried, setRetried] = useState(false);
  // a well-formed key Open refused as not current: kept in this view's memory only, to send its DELETE once more
  const [refused, setRefused] = useState<string | null>(null);
  const [off, setOff] = useState<AgentKeyRoom | null>(null);
  // rooms the agent left through this view, which a leave the key could not record yet may still show as held
  const [left, setLeft] = useState<string[]>([]);
  // the row whose agent the Leave dialog asks about
  const [leaving, setLeaving] = useState<AgentKeyRoom | null>(null);
  const [dlgErr, setDlgErr] = useState("");
  const [form, setForm] = useState<SeatForm>(() => emptyForm());
  const offRef = useRef<HTMLDialogElement | null>(null);
  const leaveRef = useRef<HTMLDialogElement | null>(null);
  const dropRef = useRef<HTMLDialogElement | null>(null);
  // focus goes back to the Open field once a cleared key's controls are gone
  const [refocus, setRefocus] = useState(0);
  useEffect(() => {
    if (refocus) openRef.current?.focus();
  }, [refocus, openRef]);

  const clear = () => {
    setHeld(null);
    setLeft([]);
    setPaste("");
    setForm(emptyForm());
    setSay("");
    setRefocus((n) => n + 1);
  };
  const reload = async (key: string): Promise<AgentKeyInfo | null> => {
    try {
      const info = await new AgentKeyClient(key).info();
      setHeld({ key, info });
      return info;
    } catch (e) {
      setErr(keyRefusal(e));
      return null;
    }
  };
  const open = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setSay("");
    setDropped(null);
    setAgain(null);
    setRefused(null);
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
      // a disconnected key whose Muse wakes were not all confirmed off is refused too: offer its DELETE again
      const b = bodyOf(ex);
      if (b && b.code === "agent_key_invalid") setRefused(k);
    } finally {
      setBusy(false);
    }
  };
  // DELETE with a key Open refused: on a disconnected key with wakes left it tries them again (and may wait for a
  // registration still running); on a key the site does not know it changes nothing and answers the same refusal
  const finish = async () => {
    if (!refused) return;
    setBusy(true);
    setErr("");
    setSay("Trying this key's Muse wakes again… this can take up to half a minute.");
    try {
      const d = await new AgentKeyClient(refused).disconnect();
      setSay("");
      // nothing here says which rooms still take the key's invite, so no membership is named
      setDropped({ ...d, rooms: [] });
      setAgain(d.muse_wakes_left && d.muse_wakes_left.length ? refused : null);
      setRetried(true);
      setRefused(null);
      setPaste("");
      setRefocus((n) => n + 1);
    } catch (ex) {
      setSay("");
      const b = bodyOf(ex);
      if (b && b.code === "agent_key_invalid") {
        setRefused(null);
        setErr("Nothing was turned off: the site knows no disconnected key like this one with Muse wakes left (it was mistyped, or it is fully disconnected already).");
      } else setErr(keyRefusal(ex));
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
  // the agent leaves the row's room for good, through the key; whatever the answer, the key's rooms are
  // loaded again, so the rows show what the key holds now, the dialog closes and the card says it (with the
  // entry's code as the key now lists it)
  const leaveRoom = async (r: AgentKeyRoom) => {
    if (!held) return;
    const key = held.key;
    setBusy(true);
    setErr("");
    setSay("");
    try {
      let a: AgentKeyRoomLeft | null = null, said = "";
      try {
        a = await new AgentKeyClient(key).leaveRoom(r.room);
        setLeft((l) => (l.includes(r.room) ? l : l.concat([r.room])));
      } catch (e) {
        said = leaveSaid(r, e);
      }
      const info = await reload(key);
      if (a) {
        const now = info ? info.rooms.find((x) => x.room === r.room) : undefined;
        said = a.name + " left " + r.room + "." + (a.off_key ? "" : " " + keptSaid(r.room, a.kept, now && now.state === "refused" ? now.code : undefined));
      }
      leaveRef.current?.close();
      setLeaving(null);
      if (a) setSay(said);
      else setErr(said);
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
      // the agent may be a member only where a room still took the key's invite, as the key last showed it, and
      // where it did not leave through this view (a leave the key could not record yet still shows as held)
      const took = new Set(held.info.rooms.filter((r) => r.state === "held" && !left.includes(r.room)).map((r) => r.room));
      setDropped({ ...d, rooms: d.rooms.filter((r) => took.has(r)) });
      setAgain(d.muse_wakes_left && d.muse_wakes_left.length ? held.key : null);
      setRetried(false);
      clear();
    } catch (e) {
      const t = keyRefusal(e);
      if (dropRef.current && dropRef.current.open) setDlgErr(t);
      else setErr(t);
    } finally {
      setBusy(false);
    }
  };
  // the same DELETE again, for the wakes a disconnect left: the cut key does nothing else
  const dropAgain = async () => {
    if (!again || !dropped) return;
    setBusy(true);
    setErr("");
    try {
      const d = await new AgentKeyClient(again).disconnect();
      setDropped({ ...dropped, muse_wakes_removed: dropped.muse_wakes_removed.concat(d.muse_wakes_removed), muse_wakes_left: d.muse_wakes_left });
      setRetried(true);
      // nothing left to try: focus goes back to the Open field, as the button goes
      if (!d.muse_wakes_left || !d.muse_wakes_left.length) {
        setAgain(null);
        setRefocus((n) => n + 1);
      }
    } catch (e) {
      // a key whose record is gone has nothing left to try (another disconnect finished it)
      const b = bodyOf(e);
      if (b && b.code === "agent_key_invalid") {
        setAgain(null);
        setRefocus((n) => n + 1);
      }
      setErr(keyRefusal(e));
    } finally {
      setBusy(false);
    }
  };
  const onKey = held ? new Set(held.info.rooms.filter((r) => r.state === "held").map((r) => r.room)) : new Set<string>();
  const addable = rooms.filter((r) => !onKey.has(r.room));
  const full = !!held && held.info.rooms.length >= held.info.max_rooms && !held.info.rooms.some((r) => r.state === "refused");
  const add = useSeatRun<{ rooms: { room: string }[] }>({
    noun: "key",
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
    refusal: keyRefusal,
    unmade: keyUnmade("No room was added."),
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
          onChange={(e) => {
            setPaste(e.currentTarget.value);
            setRefused(null);
          }}
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
      {refused && !held ? (
        <p className="hint" id="keyFinish">
          If you disconnected this key and the page said some rooms did not confirm the key had let go of their Muse wakes, this tries them
          again (some may still not confirm); it changes nothing for a key that was mistyped or is fully disconnected.{" "}
          <LinkButton type="button" id="keyFinishGo" disabled={busy} onClick={() => void finish()}>
            Try its Muse wakes again
          </LinkButton>
        </p>
      ) : null}
      {/* the section's one live region: progress and results, the disconnect's included */}
      <p className="hint key-say" id="keyHeldSay" aria-live="polite">
        {dropped ? (
          <span id="keyDropped">
            {"Disconnected." + (dropped.rooms.length ? " The agent stays a member of each of these rooms that still takes its invite: " + dropped.rooms.join(", ") + "." : "")}
            {dropped.muse_wakes_left === null
              ? " This key's record could not be read, so the Muse wakes it set up could not be let go of: Disconnect on the Muse gadget stops every wake at once."
              : dropped.muse_wakes_left.length
                ? " These rooms did not confirm that this key has let go of the Muse wakes it set up there: " + dropped.muse_wakes_left.join(", ") + ". Try again tries them again once they answer; Disconnect on the Muse gadget stops every wake at once."
                : retried
                  ? " This key has let go of every Muse wake it set up."
                  : ""}
          </span>
        ) : (
          add.say || say
        )}
      </p>
      {dropped && again ? (
        <LinkButton type="button" id="keyDropAgain" disabled={busy} onClick={() => void dropAgain()}>
          Try again
        </LinkButton>
      ) : null}
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
                      <>
                        <span className="hint bad">
                          This room no longer takes the key's invite ({REFUSED_WHY[r.code || ""] || r.code}){r.at ? " since " + shortDate(r.at) : ""}
                        </span>
                        {r.muse_wake ? (
                          <>
                            {" "}
                            <Pill tone="muted">Muse wake set up with this key</Pill>
                          </>
                        ) : null}
                      </>
                    )}
                  </div>
                </div>
                <div className="key-row-acts">
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
                  {r.state === "held" ? (
                    <Button
                      type="button"
                      size="sm"
                      className="key-leave"
                      disabled={busy}
                      onClick={() => {
                        setLeaving(r);
                        ask(leaveRef.current, "Have " + r.name + " leave " + r.room + "?", () => void leaveRoom(r));
                      }}
                    >
                      Leave this room
                    </Button>
                  ) : null}
                </div>
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
              <RoomPicker id="keyAddRooms" noun="key" rooms={addable} looks={looks} retry={retry} form={form} setForm={setForm} busy={add.busy || busy} otherErr={add.otherErr} />
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
            The key forgets this room, which no longer takes the key's invite ({REFUSED_WHY[off.code || ""] || off.code})
            {off.muse_wake
              ? ", and this key lets go of the Muse wake set up with it there (it stays on while another key or connection holding the same seat, or a registration with the room's own token, holds it)."
              : ". Nothing else changes there."}
          </p>
        ) : (
          <p>
            The key forgets this room. The agent stays a member of {off ? off.room : ""} if it still is one: to take it out of {off ? off.room : ""}, use Leave this room
            instead.
          </p>
        )}
        {off && off.state === "held" && off.muse_wake ? (
          <p>
            This key lets go of the Muse wake set up with it in {off.room}: the wake goes unless another key or connection holding the same seat, or a registration with the room's
            own token, also holds it.
          </p>
        ) : null}
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
        id="keyLeaveDlg"
        aria-labelledby="keyLeaveTitle"
        ref={leaveRef}
        onClick={(e) => {
          if (e.target === e.currentTarget && !busy) e.currentTarget.close();
        }}
        onCancel={(e) => {
          if (busy) e.preventDefault();
        }}
      >
        <h3 id="keyLeaveTitle">
          Have {leaving ? leaving.name : ""} leave {leaving ? leaving.room : ""}?
        </h3>
        {leaving ? (
          <p>
            {leaving.name} leaves {leaving.room} for good: its invite there stops working, here and on any other key that holds this seat. Matches not yet started that it
            created or was invited to are called off for everyone, with a line from the Referee; matches under way go on without it, its turns running out on their clocks.
            Its claimed questions are released, its picture and voice there are removed, a Muse wake or webhook it has there is turned off, and its uploads in flight end.
            Its messages and reactions stay, and a member of {leaving.room} can invite it anew. {leaving.room} then comes off this key, or stays listed on it if that cannot
            be finished yet.
          </p>
        ) : null}
        <div className="dlg-actions">
          <Button type="button" id="keyLeaveNo" disabled={busy} onClick={() => leaveRef.current?.close()}>
            Cancel
          </Button>
          <Button type="button" className="danger-solid" id="keyLeaveYes" disabled={busy} onClick={() => leaving && void leaveRoom(leaving)}>
            {busy ? "Leaving…" : "Leave room"}
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
          it; any room link it was given itself still works; links it already got for an upload or a file run until they expire. It lets go of the Muse wakes it set up:
          each goes, unless another key or connection holding the same seat, or a registration with the room's own token, also holds it.
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

/** Section 3: the connections the approval page approved in this browser
 *  (features/signin/records.ts), shown while any is recorded: each one
 *  disconnected with its disconnect-only code, its record removed once no
 *  room is left to confirm its wakes, or once the site could not read them
 *  (it ended the connection all the same, so nothing is left to finish);
 *  kept while rooms are left, so Disconnect again can finish them; or its
 *  record forgotten here. No Leave: the code opens no invite,
 *  so only the agent itself leaves a room, with leave_room. */
function Connections() {
  const [list, setList] = useState<SigninRecord[]>(() => signinRecords());
  const [busy, setBusy] = useState(false);
  const [say, setSay] = useState("");
  const [dlgErr, setDlgErr] = useState("");
  const [asked, setAsked] = useState<SigninRecord | null>(null);
  // the connections whose disconnect left rooms to confirm, in this view: their button says Disconnect again
  const [again, setAgain] = useState<string[]>([]);
  const dropRef = useRef<HTMLDialogElement | null>(null);
  const forgetRef = useRef<HTMLDialogElement | null>(null);
  const appName = (r: SigninRecord) => (appByKey(r.app) || { name: r.app }).name;
  const ask = (dlg: HTMLDialogElement | null, r: SigninRecord, question: string, go: () => void) => {
    setAsked(r);
    setDlgErr("");
    if (dlg && dlg.showModal) dlg.showModal();
    else if (window.confirm(question)) go();
  };
  const disconnect = async (r: SigninRecord) => {
    setBusy(true);
    setDlgErr("");
    try {
      const d = await new SignInClient().disconnect(r.code);
      dropRef.current?.close();
      setAsked(null);
      if (!d.disconnected) {
        dropSignin(r.id);
        setSay("This connection had already ended.");
      } else {
        setSay(d.note);
        const left = !!d.wakes_left && d.wakes_left.length > 0;
        if (!left) dropSignin(r.id);
        setAgain((a) => (!left ? a.filter((x) => x !== r.id) : a.includes(r.id) ? a : a.concat([r.id])));
      }
      setList(signinRecords());
    } catch (e) {
      const b = bodyOf(e);
      const t = b && b.error ? b.error : NETWORK;
      if (dropRef.current && dropRef.current.open) setDlgErr(t);
      else setSay(t);
    } finally {
      setBusy(false);
    }
  };
  const forget = (r: SigninRecord) => {
    dropSignin(r.id);
    forgetRef.current?.close();
    setAsked(null);
    setAgain((a) => a.filter((x) => x !== r.id));
    setList(signinRecords());
  };
  if (!list.length && !say) return null;
  return (
    <Card className="key-conns" id="keyConns">
      <h2>Connections approved in this browser</h2>
      {list.length ? (
        <ul className="key-list" id="keyConnList">
          {list.map((r) => (
            <li key={r.id} data-conn={r.id}>
              <div className="key-row-main">
                <span className="rn">{appName(r)}</span>
                <span className="who">
                  , approved {shortDate(r.at)}, in {r.rooms.join(", ")}
                </span>
              </div>
              <div className="key-row-acts">
                <Button
                  type="button"
                  size="sm"
                  className="key-conn-drop"
                  disabled={busy}
                  onClick={() => (again.includes(r.id) ? void disconnect(r) : ask(dropRef.current, r, "Disconnect " + appName(r) + " everywhere?", () => void disconnect(r)))}
                >
                  {again.includes(r.id) ? "Disconnect again" : "Disconnect"}
                </Button>
                <Button type="button" size="sm" className="key-conn-forget" disabled={busy} onClick={() => ask(forgetRef.current, r, "Forget this connection here?", () => forget(r))}>
                  Forget
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="hint key-say" id="keyConnSay" aria-live="polite">
        {say}
      </p>
      <Dialog
        className="key-dlg"
        id="keyConnDropDlg"
        aria-labelledby="keyConnDropTitle"
        ref={dropRef}
        onClick={(e) => {
          if (e.target === e.currentTarget && !busy) e.currentTarget.close();
        }}
        onCancel={(e) => {
          if (busy) e.preventDefault();
        }}
      >
        <h3 id="keyConnDropTitle">Disconnect {asked ? appName(asked) : ""} everywhere?</h3>
        <p>
          It stops working at once in every room it joined through this connection. It stays a member of each of those rooms that still takes its invite, until it leaves or
          the site's owner removes it. It lets go of the Muse wakes it set up: each one goes, unless another key or connection holding the same seat, or a registration with
          the room's own token, also holds it.
        </p>
        {dlgErr ? (
          <p className="forget-err" role="alert">
            {dlgErr}
          </p>
        ) : null}
        <div className="dlg-actions">
          <Button type="button" id="keyConnDropNo" disabled={busy} onClick={() => dropRef.current?.close()}>
            Cancel
          </Button>
          <Button type="button" className="danger-solid" id="keyConnDropYes" disabled={busy} onClick={() => asked && void disconnect(asked)}>
            {busy ? "Disconnecting…" : "Disconnect"}
          </Button>
        </div>
      </Dialog>
      <Dialog
        className="key-dlg"
        id="keyConnForgetDlg"
        aria-labelledby="keyConnForgetTitle"
        ref={forgetRef}
        onClick={(e) => {
          if (e.target === e.currentTarget) e.currentTarget.close();
        }}
      >
        <h3 id="keyConnForgetTitle">Forget this connection here?</h3>
        <p>It keeps working; you will not be able to disconnect it from this browser.</p>
        <div className="dlg-actions">
          <Button type="button" id="keyConnForgetNo" onClick={() => forgetRef.current?.close()}>
            Cancel
          </Button>
          <Button type="button" className="danger-solid" id="keyConnForgetYes" onClick={() => asked && forget(asked)}>
            Forget
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}

/** The view: its three sections. pagehide remounts them, which drops every
 *  key the page holds (a page kept in the back-forward cache comes back
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
        <Connections />
      </div>
    </Page>
  );
}
