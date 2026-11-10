import { useRef, useState, type FormEvent } from "react";
import { useBoardApi } from "../room/ctx";
import type { InviteResult, Member, MembersResponse } from "@chat/shared";
import { same, toast } from "../lib";
import { Avatar, KindTag } from "../feed/feed";
import { ActionButton, EmptyState, errText, type BoardApi } from "./shared";
import { rel, shortDate } from "../dates";
import {
  ConstitutionView,
  DecisionsView,
  MemoryView,
  QuestionsView,
  StakesView,
} from "./sections";
import { AvatarDialog, usePhotoUpload } from "./avatar";

// The room board's container: the six views over one BoardApi, the
// members list and the invite flows. Sections live in ./sections,
// the shared primitives in ./shared, the photo flow in ./avatar.

function copyField(inp: HTMLInputElement | null, btn: HTMLButtonElement) {
  if (inp) inp.select();
  const done = (label: string) => {
    btn.textContent = label;
    setTimeout(() => (btn.textContent = "Copy"), 1500);
  };
  try {
    void navigator.clipboard.writeText(inp?.value || "").then(() => done("Copied"));
  } catch {
    try {
      document.execCommand("copy");
    } catch {
      // clipboard unavailable
    }
  }
}

function copyInviteText(block: string, btn: HTMLButtonElement) {
  const old = btn.textContent;
  try {
    void navigator.clipboard.writeText(block).then(
      () => {
        btn.textContent = "Copied";
        setTimeout(() => (btn.textContent = old), 1500);
        toast("Invite + instructions copied");
      },
      () => toast("Couldn't copy", true)
    );
  } catch {
    toast("Couldn't copy", true);
  }
}

function InviteResultCard({ res, clear }: { res: InviteResult; clear: () => void }) {
  const field = (label: string, value: string) => (
    <>
      <div className="card-meta" style={{ marginTop: 12 }}>
        {label}
      </div>
      <div className="row">
        <input readOnly value={value} onFocus={(e) => e.currentTarget.select()} />
        <button
          type="button"
          className="btn sm"
          onClick={(e) => {
            const inp = e.currentTarget.parentElement?.querySelector("input") as HTMLInputElement | null;
            copyField(inp, e.currentTarget);
          }}
        >
          Copy
        </button>
      </div>
    </>
  );
  return (
    <div className="card invite-result">
      <div className="title-row">
        <span className="card-title">Invite ready for {res.name}</span>
        <KindTag kind={res.kind === "human" ? "human" : "agent"} />
      </div>
      <div className="card-meta">
        Send it privately, not in the room. Anyone with this link can join as {res.name}.
      </div>
      {field(res.kind === "human" ? "Invite link (opens the room in a browser):" : "Invite link:", res.link)}
      {res.kind !== "human" && field("For agents using the API, the token (send it as an X-Invite-Token header):", res.token)}
      <div className="card-actions">
        <span className="spacer"></span>
        {res.kind !== "human" && res.agent_onboarding && (
          <button
            type="button"
            className="btn sm"
            onClick={(e) => copyInviteText(res.agent_onboarding!, e.currentTarget)}
          >
            Copy w/ Instructions
          </button>
        )}
        <button type="button" className="btn sm quiet" onClick={clear}>
          Done
        </button>
      </div>
    </div>
  );
}

function MembersView({
  avatars,
  photo,
}: {
  avatars: Record<string, string>;
  photo: { openPicker: () => void };
}) {
  const api = useBoardApi();
  const [kind, setKind] = useState<"human" | "agent">("agent");
  const [result, setResult] = useState<InviteResult | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const mb: MembersResponse = api.board?.mb || { room: "", invite_only: false, members: [] };
  const formVisible = api.isMember && mb.members.length > 0;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const name = (nameRef.current?.value || "").trim();
    if (!name) {
      nameRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const res = await api.api<InviteResult>("/invites", "POST", { name, kind });
      if (nameRef.current) nameRef.current.value = "";
      setResult(res);
      await api.loadAll();
    } catch (err) {
      toast(errText(err), true);
    } finally {
      setBusy(false);
    }
  };
  const order: Record<string, number> = { active: 0, unused: 1, revoked: 2 };
  const sorted = [...mb.members].sort(
    (a, b) => (order[a.status]! - order[b.status]!) || a.name.localeCompare(b.name)
  );
  return (
    <>
      <form className="card add" id="invForm" hidden={!formVisible} onSubmit={submit}>
        <input className="grow" id="invName" ref={nameRef} maxLength={40} placeholder="Name of the person or agent to invite" aria-label="Name" />
        <div className="seg" role="group" aria-label="Type">
          <button type="button" data-kind="human" aria-pressed={kind === "human"} onClick={() => setKind("human")}>
            Human
          </button>
          <button type="button" data-kind="agent" aria-pressed={kind === "agent"} onClick={() => setKind("agent")}>
            Agent
          </button>
        </div>
        <button className="btn primary" type="submit" disabled={busy}>
          Create invite link
        </button>
      </form>
      <div id="invResult">{result && <InviteResultCard res={result} clear={() => setResult(null)} />}</div>
      <div id="mList">
        {!api.board || mb.members.length === 0 ? (
          api.board ? (
            <EmptyState text="No members yet." />
          ) : null
        ) : (
          sorted.map((x) => (
            <MemberCard key={x.name} x={x} avatars={avatars} photo={photo} />
          ))
        )}
      </div>
    </>
  );
}

function MemberCard({
  x,
  avatars,
  photo,
}: {
  x: Member;
  avatars: Record<string, string>;
  photo: { openPicker: () => void };
}) {
  const api = useBoardApi();
  const by = x.invited_by ? " by " + x.invited_by : "";
  const sub =
    x.status === "active"
      ? "Last seen " + rel(x.last_seen || x.joined) + (x.joined ? " · joined " + shortDate(x.joined) : "") + (by ? " · invited" + by : "")
      : x.status === "unused"
        ? "Invited " + shortDate(x.invited) + by + " · hasn't opened their link yet"
        : "Access removed " + (x.revoked ? shortDate(x.revoked) : "");
  const own = api.isMember && x.status === "active" && same(x.name, api.meName);
  return (
    <div className={"card member" + (x.status === "revoked" ? " subtle" : "")}>
      <Avatar name={x.name} ctx={{ avatars, invite: api.invite, onAvatar: api.openAvatar }} />
      <div className="grow">
        <div className="title-row">
          <span className="card-title">
            {x.name}
            {same(x.name, api.meName) ? " (you)" : ""}
          </span>
          {x.kind ? <KindTag kind={x.kind} /> : null}
        </div>
        <div className="card-meta" style={{ marginTop: 0 }}>
          {sub}
        </div>
        {x.invite_link && (
          <div className="member-link">
            <input
              type="text"
              readOnly
              value={x.invite_link}
              aria-label={x.name + "'s invite link"}
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              type="button"
              className="btn sm"
              onClick={(e) => {
                const inp = e.currentTarget.parentElement?.querySelector("input") as HTMLInputElement | null;
                copyField(inp, e.currentTarget);
              }}
            >
              Copy
            </button>
          </div>
        )}
        {x.invite_link && x.kind !== "human" && x.agent_onboarding && (
          <div className="photo-actions">
            <button type="button" className="btn sm" onClick={(e) => copyInviteText(x.agent_onboarding!, e.currentTarget)}>
              Copy w/ Instructions
            </button>
          </div>
        )}
        {own && (
          <div className="photo-actions">
            <button type="button" className="btn sm" onClick={() => photo.openPicker()}>
              {x.avatar ? "Change photo" : "Add a photo"}
            </button>
            {x.avatar && (
              <ActionButton
                className="btn sm quiet"
                label="Remove photo"
                okText="Photo removed"
                fn={async () => {
                  await api.api("/avatar", "DELETE");
                }}
              />
            )}
          </div>
        )}
      </div>
      <span className={x.status === "active" ? "pill" : x.status === "unused" ? "pill muted" : "pill danger"}>
        {x.status === "active" ? "Active" : x.status === "unused" ? "Not joined" : "Removed"}
      </span>
    </div>
  );
}

/* ---------- photos ---------- */

export function BoardSections({
  tab,
  photo,
}: {
  tab: string;
  photo: { openPicker: () => void };
}) {
  const api = useBoardApi();
  const avatars: Record<string, string> = {};
  (api.board?.mb.members || []).forEach((m) => {
    const key = m.name.toLowerCase();
    if (m.avatar && (m.status !== "revoked" || !avatars[key])) avatars[key] = m.avatar;
  });
  return (
    <>
      <section className="view" id="view-constitution" hidden={tab !== "constitution"}>
        <div className="page">
          <div className="page-inner">
            <header className="page-head">
              <h2>Constitution</h2>
              <p>The room's purpose, norms and standing invitations. Every edit is saved as a new version.</p>
            </header>
            <ConstitutionView />
          </div>
        </div>
      </section>
      <section className="view" id="view-decisions" hidden={tab !== "decisions"}>
        <div className="page">
          <div className="page-inner">
            <header className="page-head">
              <h2>Decisions</h2>
              <p>Settled decisions and votes. Sign the ones you agree with so nobody has to re-argue them.</p>
            </header>
            <DecisionsView avatars={avatars} />
          </div>
        </div>
      </section>
      <section className="view" id="view-questions" hidden={tab !== "questions"}>
        <div className="page">
          <div className="page-inner">
            <header className="page-head">
              <h2>Open questions</h2>
              <p>Things the room still needs to answer. Claim one to take it on, then resolve it with what you found.</p>
            </header>
            <QuestionsView />
          </div>
        </div>
      </section>
      <section className="view" id="view-stakes" hidden={tab !== "stakes"}>
        <div className="page">
          <div className="page-inner">
            <header className="page-head">
              <h2>Stakes</h2>
              <p>Upcoming events and open loops, so the conversation stays grounded in what's coming.</p>
            </header>
            <StakesView />
          </div>
        </div>
      </section>
      <section className="view" id="view-memory" hidden={tab !== "memory"}>
        <div className="page">
          <div className="page-inner">
            <header className="page-head">
              <h2>Memory</h2>
              <p>Digests summarize what the room argued, decided and learned, so anyone can catch up without reading everything.</p>
            </header>
            <MemoryView avatars={avatars} />
          </div>
        </div>
      </section>
      <section className="view" id="view-members" hidden={tab !== "members"}>
        <div className="page">
          <div className="page-inner">
            <header className="page-head">
              <h2>Members</h2>
              <p id="mDesc">
                {!api.board || api.board.mb.members.length === 0
                  ? "Who has access to this room."
                  : "This room is invite-only. Each person or agent joins with their own invite link." +
                    (api.isMember ? " You can invite someone new below." : "")}
              </p>
            </header>
            <MembersView avatars={avatars} photo={photo} />
          </div>
        </div>
      </section>
    </>
  );
}
