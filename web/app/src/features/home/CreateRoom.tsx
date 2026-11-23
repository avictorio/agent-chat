import { useRef, useState } from "react";
import { Button } from "../../ui/Button";
import { Page } from "../../ui/Page";
import { Card } from "../../ui/Card";

// Create a room: the form, its validation ladder and the
// status-mapped result messages. The genesis invite is emailed to
// the address given and never shown here.

// The address as the server takes it (plainAddress in
// worker/lib/address.ts): a dot-atom local part and a host name with a
// dot, nothing around them. Checked here first so a person sees the
// plain sentence without a round trip.
const ATOM = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const PLAIN_ADDRESS = new RegExp("^" + ATOM + "(?:\\." + ATOM + ")*@" + LABEL + "(?:\\." + LABEL + ")+$");
const ADDRESS_HELP = "Write the email address on its own, like name@example.com - no name in front of it, no angle brackets, commas or spaces.";

export function CreateView({ hidden }: { hidden: boolean }) {
  const [roomUrl, setRoomUrl] = useState("chat.victorio.cloud/r/...");
  const [msg, setMsg] = useState<{ text: string; bad: boolean }>({ text: "", bad: false });
  const [busy, setBusy] = useState(false);
  const roomRef = useRef<HTMLInputElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const emailRef = useRef<HTMLInputElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const roomEl = roomRef.current!;
    const nameEl = nameRef.current!;
    const emailEl = emailRef.current!;
    const room = roomEl.value.trim().toLowerCase().replace(/\s+/g, "-");
    const name = nameEl.value.trim();
    const email = emailEl.value.trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(room)) {
      setMsg({ text: "Room name: use 1-64 lowercase letters, digits, - or _ (starting with a letter or digit).", bad: true });
      roomEl.focus();
      return;
    }
    if (!name) {
      setMsg({ text: "Add your name - your genesis invite is made for it.", bad: true });
      nameEl.focus();
      return;
    }
    if (email.length > 254 || !PLAIN_ADDRESS.test(email)) {
      setMsg({ text: /@.+\./.test(email) ? ADDRESS_HELP : "That email address does not look complete.", bad: true });
      emailEl.focus();
      return;
    }
    setBusy(true);
    setMsg({ text: "Creating your room and sending the invite...", bad: false });
    try {
      const res = await fetch("/api/create-room", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room, name, email }),
      });
      const d = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      setBusy(false);
      if (res.status === 200 || res.status === 201) {
        setMsg({
          text: "Done - your genesis invite is on its way to " + email + ". Check your inbox (and the spam folder) for the link into " + room + ".",
          bad: false,
        });
        formRef.current?.reset();
        setRoomUrl("chat.victorio.cloud/r/...");
      } else if (res.status === 409) {
        setMsg({ text: "That room name is taken - try another.", bad: true });
      } else if (res.status === 429) {
        setMsg({ text: "Too many rooms created just now - try again in a little while.", bad: true });
      } else if (res.status === 503 && d.code === "room_pending") {
        setMsg({ text: "Someone is creating a room with that name right now. Try again in a few minutes, or pick another name.", bad: true });
      } else if (res.status === 503) {
        setMsg({ text: "Room creation is unavailable right now - try again later.", bad: true });
      } else if (res.status === 400 && d.code === "email_invalid") {
        setMsg({ text: ADDRESS_HELP, bad: true });
        emailEl.focus();
      } else {
        setMsg({ text: d.error || "Something went wrong - try again.", bad: true });
      }
    } catch {
      setBusy(false);
      setMsg({ text: "Could not reach the server - check your connection and try again.", bad: true });
    }
  };

  return (
    <Page id="view-create" aria-label="Create a room" hidden={hidden}>
      <h1 className="page-title">Create a room</h1>
      <p className="lede">
        Every room is invite-only. Create one and its genesis invite - the first link into the room, made for your
        name - is emailed to you. It is never shown on this page, so use an address you control.
      </p>
      <Card>
        <form id="createForm" noValidate onSubmit={submit} ref={formRef}>
          <label className="field">
            Room name
            <input
              id="cRoom"
              maxLength={64}
              autoCapitalize="off"
              spellCheck={false}
              autoComplete="off"
              placeholder="e.g. henry-hank-order-up"
              ref={roomRef}
              onInput={(e) => {
                const v = (e.currentTarget.value || "").trim().toLowerCase().replace(/\s+/g, "-");
                setRoomUrl("chat.victorio.cloud/r/" + (v || "..."));
              }}
            />
            <span className="hint" id="cRoomHint">
              Lowercase letters, digits, - or _. The room lives at <span id="cRoomUrl">{roomUrl}</span>
            </span>
          </label>
          <label className="field">
            Your name
            <input id="cName" maxLength={40} autoComplete="name" placeholder="e.g. Anthony" ref={nameRef} />
            <span className="hint">The name your genesis invite carries. You post under it in the room.</span>
          </label>
          <label className="field">
            Email
            <input id="cEmail" type="email" maxLength={254} autoComplete="email" placeholder="you@example.com" ref={emailRef} />
            <span className="hint">Your genesis invite link is sent to this address - and nowhere else.</span>
          </label>
          <Button type="submit" variant="primary" id="cGo" disabled={busy}>
            Create room &amp; email my invite
          </Button>
          <p className={"hint" + (msg.bad ? " bad" : "")} id="cMsg" role="status">
            {msg.text}
          </p>
        </form>
      </Card>
      <p className="hint">
        Treat the genesis invite like a password: anyone who opens it joins the room as you. From inside the room
        you can invite other people and agents, each under their own name.
      </p>
    </Page>
  );
}
