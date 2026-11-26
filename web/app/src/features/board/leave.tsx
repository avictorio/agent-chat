import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { ApiError, type Member } from "@chat/contract";
import { forgetRoomKeys, same } from "../../lib/index";
import { useSession } from "../room/ctx";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { errText } from "./shared";

// Leave room: the member's own row in Members opens it (people, and a
// person using an agent's invite in the web app: the row is that
// invite's). It always opens on what leaving does and sends POST /leave
// with the room's name. The server decides who is the last member: only
// its 409 last_member answer (which changes nothing, and counts the
// invites not yet opened in unopened) turns the dialog into the second
// question, whether to delete the room, and only that question's button
// sends delete_room. After a leave this device forgets the room as Home's
// Forget does (forgetRoomKeys) and goes home: the server has already
// dropped its push registrations there. When the Worker's answer says the
// person is out whatever this call did (the invite is refused, the room is
// gone) the device forgets the room too; when no answer came, or one that
// is not the Worker's, nobody knows yet and the room is kept.

export interface LeaveDialogHandle {
  open(): void;
}

/** How many invites the list on screen shows not yet opened, the caller's aside. */
function unopenedOf(members: Member[], me: string) {
  return members.filter((m) => !same(m.name, me) && m.status === "unused").length;
}

/** The refusal's code and unopened count, when the answer carried them,
 *  and whether it was the Worker's own refusal (said: JSON with its error
 *  sentence; anything else that answers in between sends none). */
function refusalOf(e: unknown): { status: number; code?: string; unopened?: number; said: boolean } | null {
  if (!(e instanceof ApiError)) return null;
  const b = e.body && typeof e.body === "object" ? (e.body as { code?: unknown; unopened?: unknown; error?: unknown }) : {};
  return {
    status: e.status,
    code: typeof b.code === "string" ? b.code : undefined,
    unopened: typeof b.unopened === "number" ? b.unopened : undefined,
    said: typeof b.error === "string",
  };
}

// ask: what leaving does; last: leaving deletes the room (the server said
// so); kept: the person left and the room stays (someone joined between the
// two calls); out: the person is no longer in the room
type Phase = "ask" | "last" | "kept" | "out";

export const LeaveDialog = forwardRef<LeaveDialogHandle, { members: Member[]; reload: () => Promise<void> }>(function LeaveDialog(
  { members, reload },
  ref
) {
  const { client, room, meName } = useSession();
  const dlgRef = useRef<HTMLDialogElement | null>(null);
  const [phase, setPhase] = useState<Phase>("ask");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // the server's count of unopened invites (last_member's unopened), else the list's
  const [unopened, setUnopened] = useState<number | null>(null);
  const [outText, setOutText] = useState("");
  useImperativeHandle(ref, () => ({
    open() {
      setPhase("ask");
      setErr("");
      setUnopened(null);
      if (dlgRef.current && !dlgRef.current.open) dlgRef.current.showModal();
    },
  }));
  const done = phase === "kept" || phase === "out";
  const close = () => {
    if (busy || done) return;
    dlgRef.current?.close();
  };
  const goHome = () => {
    location.href = "/";
  };
  const leave = async (deleteRoom: boolean) => {
    setBusy(true);
    setErr("");
    let res;
    try {
      res = await client.leave(deleteRoom);
    } catch (e) {
      setBusy(false);
      const r = refusalOf(e);
      if (r && r.status === 409 && r.code === "last_member" && !deleteRoom) {
        // nothing changed: ask the second question, with the server's count
        // (else the list's), and read the list again behind it, since
        // the others it showed have gone
        setPhase("last");
        if (r.unopened !== undefined) setUnopened(r.unopened);
        try {
          await reload();
        } catch {
          // the list on screen stays; the question is the same
        }
        return;
      }
      // refused as no member, or the room is gone: out either way. Only the
      // Worker's own refusal counts (its code, or for a room that does not
      // exist its JSON sentence): a 403 or 404 from anything else (an edge
      // rule, a build without this route) says nothing about the invite, and
      // forgetting the room there would lose this device its only key to it.
      const out =
        r &&
        ((r.status === 403 && (r.code === "invite_revoked" || r.code === "invite_invalid")) ||
          (r.status === 410 && r.code === "room_deleted") ||
          (r.status === 404 && r.said));
      if (out) {
        forgetRoomKeys(room);
        setOutText(errText(e));
        setPhase("out");
        return;
      }
      if (r && (r.status === 400 || r.status === 409)) {
        // the server refused with nothing changed (its sentence may say so already)
        const said = errText(e);
        setErr("Couldn't leave the room: " + said + (/Nothing was changed\.\s*$/.test(said) ? "" : " Nothing was changed."));
        return;
      }
      setErr(
        "Couldn't tell whether you left the room (" +
          errText(e) +
          "). Try again: if you did leave, this device then forgets the room."
      );
      return;
    }
    forgetRoomKeys(room);
    if (deleteRoom && !res.room_deleted) {
      setBusy(false);
      setPhase("kept");
      return;
    }
    goHome();
  };
  const n = unopened !== null ? unopened : unopenedOf(members, meName);
  const invites = n === 1 ? "The 1 invite not yet opened stops working too." : "The " + n + " invites not yet opened stop working too.";
  return (
    <Dialog
      className="leave-dlg"
      id="leaveDlg"
      aria-labelledby="leaveTitle"
      ref={dlgRef}
      onCancel={(e) => {
        if (busy || done) e.preventDefault();
      }}
    >
      {phase === "ask" ? (
        <>
          <h3 id="leaveTitle">Leave {room}?</h3>
          <p>You leave the room for good, as {meName}. This can't be undone.</p>
          <ul id="leaveWhat">
            <li>Your invite link stops working, on every device.</li>
            <li>Your notifications, wake setups and pending uploads for this room stop.</li>
            <li>Your picture and your voice are deleted.</li>
            <li>Your messages and what you wrote on the board stay.</li>
            <li>Questions you claimed go back to open, and matches waiting for you to accept are called off.</li>
            <li>Games in progress play out on the clock.</li>
            <li>Your name can be invited again.</li>
          </ul>
        </>
      ) : phase === "last" ? (
        <>
          <h3 id="leaveTitle">Delete {room}?</h3>
          <p id="leaveLast">
            Nobody else has joined {room}, so leaving deletes the room and everything in it, for good: every message,
            file, board item and game.
            {n ? " " + invites : ""}
          </p>
          <p>Nothing has changed yet. This can't be undone.</p>
        </>
      ) : phase === "kept" ? (
        <>
          <h3 id="leaveTitle">You left {room}</h3>
          <p id="leaveKept">
            The room was not deleted: someone else joined it in the meantime, so it stays for them. This device no
            longer keeps it.
          </p>
        </>
      ) : (
        <>
          <h3 id="leaveTitle">You are no longer in {room}</h3>
          <p id="leaveOut">{outText}</p>
          <p>This device no longer keeps the room.</p>
        </>
      )}
      {err ? (
        <p className="leave-err" id="leaveErr" role="alert">
          {err}
        </p>
      ) : null}
      <div className="dlg-actions">
        {done ? (
          <Button type="button" variant="primary" id="leaveHome" onClick={goHome}>
            Go to your rooms
          </Button>
        ) : (
          <>
            <Button type="button" id="leaveNo" disabled={busy} onClick={close}>
              Cancel
            </Button>
            {phase === "ask" ? (
              <Button type="button" className="danger-solid" id="leaveYes" disabled={busy} onClick={() => void leave(false)}>
                {busy ? "Leaving…" : "Leave room"}
              </Button>
            ) : (
              <Button type="button" className="danger-solid" id="leaveDelete" disabled={busy} onClick={() => void leave(true)}>
                {busy ? "Deleting…" : "Leave and delete the room"}
              </Button>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
});
