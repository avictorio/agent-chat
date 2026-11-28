import { useEffect, useRef, useState } from "react";
import { ApiError, SignInClient, type PersonSeatEntry, type SeatCheck, type SignInApproved, type SignInRedirect } from "@chat/contract";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { ToastHost } from "../shell/ToastHost";
import { AGENT_NAME_MAX, cleanAgentName } from "../home/agentName";
import { CHECKING, NETWORK, RoomPicker, bodyOf, copy, emptyForm, useLooks, useSeatRun, type DeviceRoom, type Refusal, type SeatForm } from "../home/seatForm";
import { OAUTH_IDLE_DAYS, SIGNIN_SCOPE_TEXT, SIGNIN_WARNING, appById, type SigninApp } from "./apps";
import { saveSignin } from "./records";
import "../home/home.css";
import "./signin.css";

// /oauth/authorize: a person approves an app's sign-in (the Worker's
// routes/oauth.ts has checked the request before it served this page). The
// page reads the request from its own URL and the rooms this browser holds
// (chat-invite:ROOM, chat-you:ROOM), looks at each room once (GET /invite,
// which opens nothing), and sends POST /api/oauth/decide with the URL's raw
// query string: Don't connect sends a decline, Connect a check and then the
// approval, through the Agent keys view's own seat form (seatForm.tsx). The
// app is named from the pinned list (apps.ts), never from the request. It
// stores nothing but, after an approval that gives one, the connection's
// disconnect-only code (records.ts); a connection whose record this browser
// cannot keep is never handed to the app, since nothing here could then
// disconnect it. It follows only an http or https address: this origin
// holds the browser's invites. Nothing is ticked at first, focus starts on
// the heading, and no key press chooses a button, so the page declines
// unless the person acts. Every name and sentence from the server is
// rendered as text.

const NEVER = "Agent Chat never sends you a link to approve a connection: approve only one you started yourself, in your own app, a moment before.";
const AGREE =
  "It joins each room you tick as its own member: an agent named as you choose below, never as you. Members of those rooms see a new agent invited by you. It can read and post there like any agent member, until it leaves, the site's owner removes it, or this connection is disconnected. It holds no invite link: it reaches the rooms only through this connection. If it already has a seat in a room, that seat stays as it is; a Muse wake an earlier connection or key set up there stays that one's, and goes when it ends, unless this connection registers it too. Unused for " +
  OAUTH_IDLE_DAYS +
  " days, the connection stops (its seats stay); you can disconnect it sooner under Agent keys in this browser.";
const UNKNOWN = "This app isn't known to Agent Chat yet, so it can't connect here. Nothing was shared. If you run this site, SIGNING IN at chat.victorio.cloud/api says how an app is added.";
const WRONG = "This sign-in link doesn't match the app it names, so it was stopped. Nothing was shared. Start again from the app.";
const USED =
  "This sign-in link has already been used. If you just approved it and the app didn't connect, start again from your own app: approving again uses the same seats. If you didn't approve it yourself, someone else may have sent you this link.";
// the app gets a connection only by this page following decide's answer, so with that answer lost the app has nothing;
// a request that did not approve is given back, and one that did is spent, so the next Connect's check says "already used"
const LOST =
  "The site's answer didn't arrive, so this page can't tell whether the connection was made. If it was, the app never received it and nothing can use it. Choose Connect to try again: if the page then says this link was already used, start again from the app. Approving again with the same name uses the same seats.";
const UNKEPT =
  "This browser couldn't keep the record that lets you disconnect this connection, so the page stopped before the app received it: nothing is connected. The seats made stay unused, and approving again with the same name uses them. Free up this site's storage in your browser, then start again from the app.";
const UNFOLLOWED = "The site's answer can't be followed from this page. Start again from the app.";
/** What a call throws when the page stopped short of an answer it will not follow (its state already says so). */
const STOPPED_CODE = "page_stopped";
const STOPPED = new ApiError(0, UNFOLLOWED, { code: STOPPED_CODE });
const AGENTS_ONLY = "Your rooms in this browser are all agents' invites. Only a person's own invite can let an agent in.";
const NO_ROOMS =
  "This browser holds none of your rooms. If this page opened inside another app (WhatsApp, Muse, a mail app), open it in the browser you use for Agent Chat: Copy link. Otherwise, open one of your invite links in this browser first, then start the connection again.";

/** The rooms this browser holds, as Your rooms reads them. */
function deviceRooms(): DeviceRoom[] {
  const out: DeviceRoom[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("chat-invite:")) {
        const room = k.slice("chat-invite:".length);
        out.push({ room, token: localStorage.getItem(k) || "", you: localStorage.getItem("chat-you:" + room) || "" });
      }
    }
  } catch {
    // storage unavailable: no rooms
  }
  out.sort((a, b) => (a.room < b.room ? -1 : 1));
  return out;
}

/** The heading: who asks, as pinned (a program on this computer named
 *  after a comma, any other app's host in brackets). */
function Heading({ app }: { app: SigninApp }) {
  return app.page === "claude-code" ? (
    <>
      <strong>{app.name}</strong>, {app.host}, wants to join rooms of yours as an agent
    </>
  ) : (
    <>
      <strong>{app.name}</strong> ({app.host}) wants to join rooms of yours as an agent
    </>
  );
}

/** What a failed approval made: nothing connected, and the seats it left unused. */
function unmade(b: Refusal): string {
  const left = b.left_unused || [], maybe = b.maybe_unused || [];
  let s = "Nothing was connected.";
  if (left.length === 1) s += " The seat made in " + left[0] + " stays unused; approving again with the same name uses it.";
  else if (left.length) s += " The seats made in " + left.join(", ") + " stay unused; approving again with the same names uses them.";
  if (maybe.length) s += " A seat may have been made in " + maybe.join(", ") + ": the room's answer was lost. Approving again with the same name uses it if so.";
  return s;
}

/** A refusal that is not on a room, in plain words. */
function refusal(e: unknown): string {
  const b = bodyOf(e);
  return b && b.error ? b.error : NETWORK;
}

/** The page's own route: the request in its URL, the rooms in this browser. */
export function SignInApproval() {
  // the query string exactly as the page got it: decide parses it as the authorize check did
  const [params] = useState(() => location.search.replace(/^\?/, ""));
  const [app] = useState(() => appById(new URLSearchParams(params).get("client_id")));
  // an app the page does not know asks no room anything
  const [rooms] = useState(() => (app ? deviceRooms() : []));
  const { looks, retry } = useLooks(rooms);
  const [form, setFormRaw] = useState<SeatForm>(() => emptyForm(app ? app.name : ""));
  const [edited, setEdited] = useState(false);
  // the page's other states: the link spent already, the request refused as wrong, a connection whose record
  // this browser could not keep, an answer the page will not follow; or on the way back to the app
  const [mode, setMode] = useState<"form" | "used" | "wrong" | "unkept" | "stopped">("form");
  const [leaving, setLeaving] = useState("");
  const [declining, setDeclining] = useState(false);
  const [declineErr, setDeclineErr] = useState("");
  const [after, setAfter] = useState(0);
  const headRef = useRef<HTMLHeadingElement | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);

  // the name starts as APP (YOU), YOU the person's name in the first ticked room, until the person types one
  const nameFor = (f: SeatForm): string => {
    if (!app) return "";
    const first = rooms.find((r) => f.ticked.includes(r.room));
    const look = first ? looks[first.room] || CHECKING : CHECKING;
    return look.state === "person" && look.you ? cleanAgentName(app.name + " (" + look.you + ")") : app.name;
  };
  const setForm = (f: SeatForm) => setFormRaw(edited || f.name !== form.name ? f : { ...f, name: nameFor(f) });

  /** Goes to the site's answer, when it is an http or https address (a loopback callback is http); false, and the page stops, otherwise. */
  const leave = (to: string, said: string): boolean => {
    let ok = false;
    try {
      const u = new URL(to);
      ok = u.protocol === "https:" || u.protocol === "http:";
    } catch {
      // not an address
    }
    if (!ok) {
      setMode("stopped");
      return false;
    }
    setLeaving(said);
    location.assign(to);
    return true;
  };
  const run = useSeatRun<SignInApproved>({
    noun: "connection",
    rooms,
    form,
    setForm: setFormRaw,
    call: async (name: string, entries: PersonSeatEntry[], check: boolean) => {
      const c = new SignInClient();
      const r: SeatCheck | SignInApproved | SignInRedirect = check ? await c.decide(params, true, name, entries, true) : await c.decide(params, true, name, entries);
      if ("rooms" in r) return r;
      // the site sends the request back to the app with its error: the page goes with it
      if (!leave(r.redirect, "Returning you to " + (app ? app.name : "the app") + "…")) throw STOPPED;
      return new Promise<never>(() => {});
    },
    done: (r) => {
      if (r.disconnect_code && app && !saveSignin(app.key, cleanAgentName(form.name), r.rooms.map((x) => x.room), r.disconnect_code)) {
        // the app never receives this connection, so it can never be used: it is disconnected once, as best it can be, and the code is not kept
        void new SignInClient().disconnect(r.disconnect_code).catch(() => undefined);
        setMode("unkept");
        return;
      }
      leave(r.redirect, "Returning you to " + (app ? app.name : "the app") + "…");
    },
    making: "Connecting…",
    lost: LOST,
    refusal,
    unmade,
    button: "Connect",
    taken: (b) => {
      if (b.code === STOPPED_CODE) return true;
      if (b.code === "request_used") setMode("used");
      else if (b.status === 400 && b.code === "invalid_request" && !b.room) setMode("wrong");
      else return false;
      return true;
    },
  });

  const decline = async () => {
    setDeclining(true);
    setDeclineErr("");
    try {
      const r = await new SignInClient().decide(params, false);
      if (!leave(r.redirect, "Not connected. Returning you to " + (app ? app.name : "the app") + "…")) setDeclining(false);
    } catch (e) {
      const b = bodyOf(e);
      if (b && b.status === 400 && b.code === "invalid_request") setMode("wrong");
      else setDeclineErr(refusal(e));
      setDeclining(false);
    }
  };
  const connect = async () => {
    await run.run();
    setAfter((n) => n + 1);
  };

  // focus on the heading at first, so no key press chooses a button
  useEffect(() => {
    headRef.current?.focus();
  }, []);
  // after a check or a call that stopped, focus goes to the first problem: a room's, else the page's; the
  // pause before a reused seat is brought into view and leaves focus where it is
  useEffect(() => {
    if (!after || !pageRef.current) return;
    const row = pageRef.current.querySelector<HTMLElement>(".key-room .hint.bad");
    const input = row ? row.closest(".key-room")?.querySelector<HTMLInputElement>(".key-pick input") : null;
    const alert = pageRef.current.querySelector<HTMLElement>("#signinErr");
    if (input || alert) (input || alert)!.focus();
    else pageRef.current.querySelector<HTMLElement>("#signinReuse")?.scrollIntoView({ block: "nearest" });
  }, [after]);

  const settled = rooms.length > 0 && rooms.every((r) => (looks[r.room] || CHECKING).state !== "checking");
  const person = rooms.some((r) => (looks[r.room] || CHECKING).state === "person");
  // said only when every room's invite is an agent's: any other mix shows the form, whose rows say why each one can't be ticked
  const agentsOnly = settled && !person && rooms.every((r) => (looks[r.room] || CHECKING).state === "agent");
  const busy = run.busy || declining || !!leaving;
  const showForm = !!app && mode === "form" && rooms.length > 0 && !agentsOnly;
  const canDecline = !!app && mode !== "wrong";

  return (
    <div className="homeApp signin">
      <div className="signin-frame">
        <div className="signin-scroll">
          <main className="page-inner signin-inner" ref={pageRef}>
            <div className="signin-brand">
              <img src="/icons/icon-192.png" alt="" />
              <span>Agent Chat</span>
            </div>
            <h1 className="signin-head" id="signinHead" tabIndex={-1} ref={headRef}>
              {app ? <Heading app={app} /> : UNKNOWN}
            </h1>
            {app ? (
              <>
                <p className="signin-why" id="signinWhy">
                  Someone asked {app.name} to connect to Agent Chat. Agent Chat can't tell who: only you know whether it was you.
                </p>
                <div className="signin-warn" id="signinWarn">
                  <p>{SIGNIN_WARNING[app.page]}</p>
                  <p className="hint">{NEVER}</p>
                </div>
              </>
            ) : null}
            {app && mode === "wrong" ? (
              <p className="hint bad signin-state" id="signinWrong" role="alert">
                {WRONG}
              </p>
            ) : null}
            {app && mode === "used" ? (
              <p className="hint bad signin-state" id="signinUsed" role="alert">
                {USED}
              </p>
            ) : null}
            {app && mode === "unkept" ? (
              <p className="hint bad signin-state" id="signinUnkept" role="alert">
                {UNKEPT}
              </p>
            ) : null}
            {app && mode === "form" && rooms.length === 0 ? (
              <Card className="signin-card" id="signinNoRooms">
                <p>{NO_ROOMS}</p>
                <Button type="button" id="signinCopy" onClick={() => copy(location.href)}>
                  Copy link
                </Button>
              </Card>
            ) : null}
            {app && mode === "form" && agentsOnly ? (
              <p className="hint signin-state" id="signinAgentsOnly">
                {AGENTS_ONLY}
              </p>
            ) : null}
            {showForm ? (
              <>
                <Card className="signin-card" id="signinAgree">
                  <h2>What you agree to</h2>
                  <p id="signinScope">{SIGNIN_SCOPE_TEXT}</p>
                  <p id="signinAgreeMore">{AGREE}</p>
                </Card>
                <Card className="signin-card" id="signinForm">
                  <label className="field">
                    The agent's name
                    <input
                      type="text"
                      id="signinName"
                      maxLength={AGENT_NAME_MAX}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={busy}
                      value={form.name}
                      onChange={(e) => {
                        setEdited(true);
                        setFormRaw({ ...form, name: e.currentTarget.value, check: null, failed: null });
                      }}
                    />
                    <span className="hint">Its name in each room you tick. Members see it as an agent invited by you.</span>
                  </label>
                  {run.nameErr ? (
                    <p className="hint bad" id="signinNameErr" role="alert">
                      {run.nameErr}
                    </p>
                  ) : null}
                  <div className="list-label">Rooms on this browser</div>
                  <RoomPicker id="signinRooms" noun="connection" rooms={rooms} looks={looks} retry={retry} form={form} setForm={setForm} busy={busy} otherErr={run.otherErr} />
                  {run.alert ? (
                    <p className="hint bad" id="signinErr" role="alert" tabIndex={-1}>
                      {run.alert}
                    </p>
                  ) : null}
                  {run.pause ? (
                    <p className="hint key-pause" id="signinReuse" role="status" tabIndex={-1}>
                      {run.pause}
                    </p>
                  ) : null}
                </Card>
              </>
            ) : null}
            {agentsOnly && mode === "form" ? (
              <Card className="signin-card">
                <div className="list-label">Rooms on this browser</div>
                <RoomPicker id="signinRooms" noun="connection" rooms={rooms} looks={looks} retry={retry} form={form} setForm={setForm} busy={busy} otherErr={null} />
              </Card>
            ) : null}
          </main>
        </div>
        {app && mode !== "wrong" ? (
          <div className="signin-bar">
            <div className="signin-bar-inner">
              <p className="hint signin-say" id="signinSay" aria-live="polite">
                {leaving || run.say}
              </p>
              {mode === "stopped" ? (
                <p className="hint bad" id="signinStopped" role="alert">
                  {UNFOLLOWED}
                </p>
              ) : null}
              {declineErr ? (
                <p className="hint bad" id="signinDeclineErr" role="alert">
                  {declineErr}
                </p>
              ) : null}
              <div className="signin-buttons">
                <Button type="button" id="signinDeny" disabled={busy || !canDecline} onClick={() => void decline()}>
                  Don't connect
                </Button>
                {showForm ? (
                  <Button type="button" id="signinConnect" disabled={busy || run.waiting || !form.name.trim() || !form.ticked.length} onClick={() => void connect()}>
                    Connect
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </div>
      <ToastHost />
    </div>
  );
}
