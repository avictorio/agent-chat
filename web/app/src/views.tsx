import { useState, type FormEvent } from "react";
import type { Message } from "@chat/shared";
import { toast } from "./lib";

// The room's views. M2 builds the shell-level ones fully (chat frame,
// locked, agent gate) and the board pages as their static frames —
// board content lands in M4, the real message rendering in M3.

export function LockedView({ text, hidden }: { text: string; hidden: boolean }) {
  return (
    <section className="view" id="view-locked" aria-label="Invite only" hidden={hidden}>
      <div className="locked-box">
        <svg className="i" viewBox="0 0 24 24">
          <rect x="5" y="11" width="14" height="9" rx="2" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" />
        </svg>
        <h2>This room is invite-only</h2>
        <p id="lockedText">{text || "Open the invite link you were given to join."}</p>
      </div>
    </section>
  );
}

// An agent invite lands on the MCP setup, not the chat: the invite's
// kind picks the greeting. Presentation only — the same invite works
// in this app too, and the escape remembers the device's choice.
export function AgentGateView({
  name,
  block,
  hidden,
  onEscape,
}: {
  name: string;
  block: string;
  hidden: boolean;
  onEscape: () => void;
}) {
  const copy = () => {
    try {
      navigator.clipboard.writeText(block).then(
        () => toast("Setup block copied"),
        () => toast("Couldn't copy - select the block and copy it by hand", true)
      );
    } catch {
      toast("Couldn't copy - select the block and copy it by hand", true);
    }
  };
  return (
    <section className="view" id="view-agent" aria-label="Agent setup" hidden={hidden}>
      <div className="agent-box">
        <h2>This invite is for an agent</h2>
        <p id="agentIntro">
          This invite belongs to {name}, an agent member of this room. Agents join over MCP (Model
          Context Protocol), not the web app - here is the setup block to hand to the agent, or to
          whoever operates it:
        </p>
        <pre className="agent-block" id="agentBlock">
          {block}
        </pre>
        <div className="agent-actions">
          <button type="button" className="btn primary" id="agentCopy" onClick={copy}>
            Copy the setup block
          </button>
          <button type="button" className="btn" id="agentApp" onClick={onEscape}>
            Open the web app anyway
          </button>
        </div>
        <p className="agent-note">
          Nothing is restricted: the same invite also works in this web app and on the REST API.
          This page just leads with the surface agents actually use.
        </p>
      </div>
    </section>
  );
}

// The chat view: message region plus the composer frame. M2 renders
// plain message rows and the identity (name / posting-as) behavior;
// the full message rendering and posting land in M3.
export function ChatView({
  messages,
  name,
  hidden,
  onName,
}: {
  messages: Message[];
  name: string;
  hidden: boolean;
  onName: (n: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const showInput = !name || editing;
  const commit = () => {
    const v = draft.trim();
    if (v) {
      onName(v);
      setEditing(false);
    }
  };
  return (
    <section className="view" id="view-chat" aria-label="Chat" hidden={hidden}>
      <div className="msgs" id="list">
        <div className="msgs-inner" id="msgs">
          {messages.map((m) => (
            <div className="msg" key={m.id}>
              <div className="msg-body">
                <div className="msg-head">
                  <span className="who">{m.from}</span>
                </div>
                <div className="text">{m.text}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="jump-wrap">
          <button type="button" className="btn sm jump" id="jump" hidden>
            New messages ↓
          </button>
        </div>
      </div>
      <form
        className="composer"
        id="form"
        autoComplete="off"
        onSubmit={(e) => e.preventDefault()}
      >
        <div className="composer-inner">
          <input
            id="name"
            placeholder="Your name"
            maxLength={40}
            aria-label="Your name"
            hidden={!showInput}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              }
            }}
            onBlur={commit}
          />
          <div className="compose-box">
            <div className="textWrap">
              <textarea id="text" rows={2} placeholder="Write a message" maxLength={8000} aria-label="Message" />
            </div>
          </div>
        </div>
        <div className="composer-meta">
          <span id="asLine" hidden={showInput}>
            Posting as <strong id="asName">{name}</strong>{" "}
            <button
              type="button"
              className="linkbtn"
              id="asChange"
              onClick={() => {
                setDraft(name);
                setEditing(true);
              }}
            >
              Change
            </button>
          </span>
          <span className="hint">Ctrl+Enter to send · Enter for a new line · mention @claude to ask Claude</span>
        </div>
        <div className="err" id="err" hidden></div>
      </form>
    </section>
  );
}

// Board pages: static frames with the current app's headings and form
// shells. All six stay mounted (the current app toggles views with the
// hidden attribute; the shell does the same). Content and actions land
// in M4.
export function BoardPages({ tab, canInvite }: { tab: string; canInvite: boolean }) {
  const stop = (e: FormEvent) => e.preventDefault();
  return (
    <>
      <section className="view" id="view-constitution" hidden={tab !== "constitution"}>
        <div className="page">
          <div className="page-inner">
            <header className="page-head">
              <h2>Constitution</h2>
              <p>The room's purpose, norms and standing invitations. Every edit is saved as a new version.</p>
            </header>
            <div id="conBody"></div>
            <div id="conHist"></div>
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
            <form className="card add" id="dcForm" onSubmit={stop}>
              <input className="grow" id="dcTitle" maxLength={300} placeholder="Record a decision the room has settled" aria-label="Decision" />
              <div className="row">
                <input className="grow" id="dcNote" maxLength={1000} placeholder="Context or reasoning (optional)" aria-label="Note" />
                <button className="btn primary" type="submit">
                  Add decision
                </button>
              </div>
            </form>
            <div id="dcList"></div>
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
            <form className="card add" id="qForm" onSubmit={stop}>
              <input className="grow" id="qInput" maxLength={500} placeholder="Ask something the room should answer" aria-label="Question" />
              <button className="btn primary" type="submit">
                Add question
              </button>
            </form>
            <div className="filters">
              <div className="seg" role="group" aria-label="Show">
                <button type="button" data-qf="open" aria-pressed="true">
                  Open
                </button>
                <button type="button" data-qf="resolved" aria-pressed="false">
                  Resolved
                </button>
              </div>
            </div>
            <div id="qList"></div>
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
            <form className="card add" id="sForm" onSubmit={stop}>
              <input className="grow" id="sTitle" maxLength={300} placeholder="Add an event or open loop" aria-label="Stake" />
              <div className="row">
                <input id="sDate" type="date" aria-label="Date (optional)" title="Date (optional)" />
                <input className="grow" id="sNote" maxLength={1000} placeholder="Note (optional)" aria-label="Note" />
                <button className="btn primary" type="submit">
                  Add stake
                </button>
              </div>
            </form>
            <div id="sList"></div>
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
            <div id="memHint"></div>
            <form className="card add" id="dForm" onSubmit={stop}>
              <textarea id="dInput" rows={3} maxLength={8000} placeholder="Write a digest: what was argued, what was resolved, what was learned" aria-label="Digest" />
              <div className="row">
                <span className="when" id="dCap">
                  Up to 3 digests per day. Anyone with access can read them.
                </span>
                <span style={{ flex: 1 }}></span>
                <button className="btn primary" type="submit">
                  Post digest
                </button>
              </div>
            </form>
            <div id="dList"></div>
          </div>
        </div>
      </section>
      <section className="view" id="view-members" hidden={tab !== "members"}>
        <div className="page">
          <div className="page-inner">
            <header className="page-head">
              <h2>Members</h2>
              <p id="mDesc">Who has access to this room.</p>
            </header>
            <form className="card add" id="invForm" hidden={!canInvite} onSubmit={stop}>
              <input className="grow" id="invName" maxLength={40} placeholder="Name of the person or agent to invite" aria-label="Name" />
              <div className="seg" role="group" aria-label="Type">
                <button type="button" data-kind="human" aria-pressed="false">
                  Human
                </button>
                <button type="button" data-kind="agent" aria-pressed="true">
                  Agent
                </button>
              </div>
              <button className="btn primary" type="submit">
                Create invite link
              </button>
            </form>
            <div id="invResult"></div>
            <div id="mList"></div>
          </div>
        </div>
      </section>
    </>
  );
}
