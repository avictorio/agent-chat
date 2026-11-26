import { useState } from "react";
import { ApiError } from "@chat/contract";
import { toast } from "../../lib/index";
import { Button } from "../../ui/Button";

// The room's shell-level views: invite-only and the agent gate. The
// chat view lives in feed.tsx + composer.tsx, the board in
// features/board.

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

type StartState =
  | { at: "idle" }
  | { at: "loading" }
  | { at: "text"; text: string }
  | { at: "failed"; why: string };

// An agent invite lands on its note, not the chat: the invite's kind
// picks the greeting. Presentation only — the same invite works
// in this app too, and the escape remembers the device's choice.
// "What your agent reads first" shows the start page the note sends the
// agent to (loadStart: GET /api/rooms/ROOM with the invite's own header, a
// look that opens nothing), fetched only once the person opens it.
export function AgentGateView({
  name,
  block,
  hidden,
  onEscape,
  loadStart,
}: {
  name: string;
  block: string;
  hidden: boolean;
  onEscape: () => void;
  loadStart: () => Promise<string>;
}) {
  const [start, setStart] = useState<StartState>({ at: "idle" });
  const copy = () => {
    try {
      navigator.clipboard.writeText(block).then(
        () => toast("Note copied"),
        () => toast("Couldn't copy - select the block and copy it by hand", true)
      );
    } catch {
      toast("Couldn't copy - select the block and copy it by hand", true);
    }
  };
  const fetchStart = () => {
    setStart({ at: "loading" });
    loadStart().then(
      (text) => setStart({ at: "text", text }),
      (e: unknown) => setStart({ at: "failed", why: e instanceof ApiError ? " (HTTP " + e.status + ")" : "" })
    );
  };
  return (
    <section className="view" id="view-agent" aria-label="Agent setup" hidden={hidden}>
      <div className="agent-box">
        <h2>This invite is for an agent</h2>
        <p id="agentIntro">
          This invite belongs to {name}, an agent member of this room. Agents join through the API or MCP, with a tool
          that can send an HTTP header; an assistant that can only be given a link cannot join. Hand your agent this
          note:
        </p>
        <pre className="agent-block" id="agentBlock">
          {block}
        </pre>
        <div className="agent-actions">
          <Button type="button" variant="primary" id="agentCopy" onClick={copy}>
            Copy the note
          </Button>
          <Button type="button" id="agentApp" onClick={onEscape}>
            Open the web app anyway
          </Button>
        </div>
        <details
          className="agent-start"
          id="agentStart"
          onToggle={(e) => {
            if (e.currentTarget.open && start.at === "idle") fetchStart();
          }}
        >
          <summary>What your agent reads first</summary>
          {start.at === "loading" ? (
            <p className="agent-start-state" role="status">
              Loading the start page…
            </p>
          ) : start.at === "text" ? (
            <pre className="agent-block agent-start-page" id="agentStartPage" tabIndex={0} aria-label="The start page">
              {start.text}
            </pre>
          ) : start.at === "failed" ? (
            <div className="agent-start-state" role="alert">
              <span>Couldn't load the start page{start.why}.</span>
              <Button type="button" size="sm" id="agentStartRetry" onClick={fetchStart}>
                Try again
              </Button>
            </div>
          ) : null}
        </details>
        <p className="agent-note">
          Opening the web app with this invite acts as {name}: if {name} has not joined yet, that joins the room. The
          same invite works in the web app, on REST and over MCP.
        </p>
      </div>
    </section>
  );
}
