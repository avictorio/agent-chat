import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { ApiError, type Member } from "@chat/contract";
import { forgetRoomKeys, same } from "../../lib/index";
import { useSession } from "../room/ctx";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { errText } from "./shared";

// Leave room: the member's own row in Members opens it (people, and a
// person using an agent's invite in the web app: the row is that
// invite's). It says what leaving does, then sends POST /leave with the
// room's name. When the caller is the last member who has joined, leaving
// deletes the room, so the dialog says that instead and asks for it with a
// second, separately worded button; the server decides who is last (a
// 409 last_member answer to the first button switches the dialog to that
// question, and changes nothing). After a leave this device forgets the
// room as Home's Forget does (forgetRoomKeys) and goes home: the server
// has already dropped its push registrations for the room.

export interface LeaveDialogHandle {
  open(): void;
}

/** Who else has joined, and how many invites wait unopened, as the list on screen has them. */
function roomCounts(members: Member[], me: string) {
  const others = members.filter((m) => !same(m.name, me));
  return { joined: others.filter((m) => m.status === "active").length, unopened: others.filter((m) => m.status === "unused").length };
}

export const LeaveDialog = forwardRef<LeaveDialogHandle, { members: Member[]; reload: () => Promise<void> }>(function LeaveDialog(
  { members, reload },
  ref
) {
  const { client, room, meName } = useSession();
  const dlgRef = useRef<HTMLDialogElement | null>(null);
  // "ask": what leaving does; "last": leaving deletes the room
  const [phase, setPhase] = useState<"ask" | "last">("ask");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const counts = roomCounts(members, meName);
  useImperativeHandle(ref, () => ({
    open() {
      setPhase(counts.joined ? "ask" : "last");
      setErr("");
      if (dlgRef.current && !dlgRef.current.open) dlgRef.current.showModal();
    },
  }));
  const close = () => {
    if (busy) return;
    dlgRef.current?.close();
  };
  const leave = async (deleteRoom: boolean) => {
    setBusy(true);
    setErr("");
    try {
      await client.leave(deleteRoom);
    } catch (e) {
      setBusy(false);
      const code = e instanceof ApiError && e.body && typeof e.body === "object" ? (e.body as { code?: string }).code : undefined;
      if (code === "last_member") {
        // nothing changed: ask the second question, on a fresh list
        setPhase("last");
        try {
          await reload();
        } catch {
          // the list on screen stays; the question is the same
        }
        return;
      }
      setErr("Couldn't leave the room (" + errText(e) + "). Nothing was changed.");
      return;
    }
    forgetRoomKeys(room);
    location.href = "/";
  };
  const invites = counts.unopened === 1 ? "The 1 invite not yet opened stops working too." : "The " + counts.unopened + " invites not yet opened stop working too.";
  return (
    <Dialog
      className="leave-dlg"
      id="leaveDlg"
      aria-labelledby="leaveTitle"
      ref={dlgRef}
      onCancel={(e) => {
        if (busy) e.preventDefault();
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
      ) : (
        <>
          <h3 id="leaveTitle">Delete {room}?</h3>
          <p id="leaveLast">
            You are the last member of {room} who has joined. Leaving deletes the room and everything in it, for good:
            every message, file, board item and game.
            {counts.unopened ? " " + invites : ""}
          </p>
          <p>This can't be undone.</p>
        </>
      )}
      {err ? (
        <p className="leave-err" id="leaveErr" role="alert">
          {err}
        </p>
      ) : null}
      <div className="dlg-actions">
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
      </div>
    </Dialog>
  );
});
