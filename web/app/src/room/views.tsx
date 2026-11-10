import type { FormEvent } from "react";
import { toast } from "../lib";

// The room's shell-level views (locked, agent gate) and the board
// pages as their static frames — board content lands in M4. The chat
// view itself lives in feed.tsx + composer.tsx.

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

// Board pages: static frames with the current app's headings and form
// shells. All six stay mounted (the current app toggles views with the
// hidden attribute; the shell does the same). Content and actions land
// in M4.
