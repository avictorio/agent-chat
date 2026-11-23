import { useRef, useState, type FormEvent } from "react";
import { useBoardApi } from "../room/ctx";
import type { Decision, Digest, Question, Stake } from "@chat/contract";
import { Avatar } from "../feed/feed";
import { daysAway, parseDay, rel, shortDate } from "../../lib/dates";
import { same } from "../../lib/index";
import {
  ActionButton,
  DeleteButton,
  BoardPending,
  EditForm,
  EmptyState,
  Linkify,
  runWith,
  useEditing,
} from "./shared";
import { Button } from "../../ui/Button";
import { Card, CardActions, CardMeta, CardText, CardTitle } from "../../ui/Card";
import { Pill, type PillTone } from "../../ui/Pill";

// The board's five content sections: constitution, decisions,
// questions, stakes and memory.

export function ConstitutionView() {
  const api = useBoardApi();
  const board = api.board;
  const ed = useEditing();
  if (!board) return <div id="conBody"><BoardPending /></div>;
  const c = board.con.constitution;
  const older = (board.con.history || [])
    .filter((h) => !c || h.version !== c.version)
    .sort((a, b) => b.version - a.version);
  return (
    <>
      <div id="conBody">
        <Card>
          {ed.edit ? (
            <EditForm edit={ed.edit} close={ed.close} />
          ) : !c ? (
            <>
              <CardTitle>No constitution yet</CardTitle>
              <CardMeta>
                Write down what this room is for and how people here work together.
              </CardMeta>
              <CardActions>
                <Button
                  type="button"
                  variant="primary" size="sm"
                  onClick={() =>
                    ed.setEdit({
                      fields: [{ key: "text", label: "Constitution", value: "", multiline: true, rows: 10, max: 4000 }],
                      saveLabel: "Save version 1",
                      onSave: (n, v) => api.api("/constitution", "PUT", { from: n, text: v.text }),
                    })
                  }
                >
                  Write the first version
                </Button>
              </CardActions>
            </>
          ) : (
            <>
              <CardMeta style={{ marginTop: 0, marginBottom: 10 }}>
                <Pill>Version {c.version}</Pill>
                <span>
                  Edited by {c.editor} · {shortDate(c.ts)}, {new Date(c.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                </span>
              </CardMeta>
              <div className="const-text">
                <Linkify text={c.text} />
              </div>
              <CardActions>
                <Button
                  type="button"
                  size="sm"
                  onClick={() =>
                    ed.setEdit({
                      fields: [{ key: "text", label: "Constitution", value: c.text, multiline: true, rows: 12, max: 4000 }],
                      saveLabel: "Save as version " + (c.version + 1),
                      onSave: (n, v) => api.api("/constitution", "PUT", { from: n, text: v.text }),
                    })
                  }
                >
                  Edit
                </Button>
              </CardActions>
            </>
          )}
        </Card>
      </div>
      <div id="conHist">
        {older.length > 0 && (
          <>
            <div className="section-label">Earlier versions</div>
            {older.map((h) => (
              <details className="card hist" key={h.version}>
                <summary>
                  Version {h.version} · {h.editor || "unknown"} · {shortDate(h.ts)}
                </summary>
                <CardText>{h.text}</CardText>
                <CardActions>
                  <ActionButton
                    size="sm"
                    label="Restore this version"
                    okText="Restored"
                    fn={async (n) => {
                      if (!window.confirm("Save version " + h.version + "'s text as a new version?")) return false;
                      await api.api("/constitution", "PUT", { from: n, text: h.text });
                    }}
                  />
                </CardActions>
              </details>
            ))}
          </>
        )}
      </div>
    </>
  );
}

/* ---------- Decisions ---------- */

function DecisionCard({ x, avatars }: { x: Decision; avatars: Record<string, string> }) {
  const api = useBoardApi();
  const ed = useEditing();
  const signers = x.signers || [];
  const mine = !!api.meName && signers.some((s) => same(s, api.meName));
  const active = (api.board?.mb.members || []).filter((m) => m.status === "active").map((m) => m.name);
  const missing = active.filter((a) => !signers.some((s) => same(s, a)));
  return (
    <Card>
      {ed.edit ? (
        <EditForm edit={ed.edit} close={ed.close} />
      ) : (
        <>
          <CardTitle>{x.title}</CardTitle>
          {x.note ? (
            <CardText>
              <Linkify text={x.note} />
            </CardText>
          ) : null}
          <CardMeta>
            <span>
              Recorded by {x.added_by} · {shortDate(x.ts)}
            </span>
            <Pill tone={signers.length ? undefined : "muted"}>
              {signers.length ? signers.length + (signers.length === 1 ? " signature" : " signatures") : "No signatures yet"}
            </Pill>
          </CardMeta>
          {signers.length > 0 && (
            <div className="chips">
              {signers.map((s) => (
                <span className="chip" key={s}>
                  <Avatar name={s} ctx={{ avatars, invite: api.invite, onAvatar: api.openAvatar }} />
                  {s}
                </span>
              ))}
            </div>
          )}
          {missing.length > 0 && (
            <CardMeta>
              <Pill tone="warn">Waiting on {missing.join(", ")}</Pill>
            </CardMeta>
          )}
          <CardActions>
            <ActionButton
              size="sm"
              variant={mine ? undefined : "primary"}
              label={mine ? "Remove my signature" : "Sign"}
              okText={mine ? "Signature removed" : "Signed"}
              fn={async (n) => {
                const signed = signers.some((s) => same(s, n));
                await api.api("/decisions/" + x.id, "POST", { from: n, action: signed ? "unsign" : "sign" });
              }}
            />
            <span className="spacer"></span>
            <Button
              type="button"
              variant="quiet" size="sm"
              onClick={() =>
                ed.setEdit({
                  fields: [
                    { key: "title", label: "Decision", value: x.title, max: 300 },
                    { key: "note", label: "Context or reasoning (optional)", value: x.note || "", multiline: true, rows: 3, max: 1000 },
                  ],
                  saveLabel: "Save changes",
                  onSave: (n, v) => api.api("/decisions/" + x.id, "POST", { from: n, action: "edit", title: v.title, note: v.note }),
                })
              }
            >
              Edit
            </Button>
            <DeleteButton path={"/decisions/" + x.id} noun="decision" />
          </CardActions>
        </>
      )}
    </Card>
  );
}

export function DecisionsView({ avatars }: { avatars: Record<string, string> }) {
  const api = useBoardApi();
  const titleRef = useRef<HTMLInputElement | null>(null);
  const noteRef = useRef<HTMLInputElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = (titleRef.current?.value || "").trim();
    if (!t) {
      titleRef.current?.focus();
      return;
    }
    void runWith(api, btnRef.current, async (n) => {
      await api.api("/decisions", "POST", { from: n, title: t, note: (noteRef.current?.value || "").trim() });
      if (titleRef.current) titleRef.current.value = "";
      if (noteRef.current) noteRef.current.value = "";
    }, "Decision recorded");
  };
  const list = api.board ? [...api.board.dc].sort((a, b) => b.id - a.id) : null;
  return (
    <>
      <form className="card add" id="dcForm" onSubmit={submit}>
        <input className="grow" id="dcTitle" ref={titleRef} maxLength={300} placeholder="Record a decision the room has settled" aria-label="Decision" />
        <div className="row">
          <input className="grow" id="dcNote" ref={noteRef} maxLength={1000} placeholder="Context or reasoning (optional)" aria-label="Note" />
          <Button variant="primary" type="submit" ref={btnRef}>
            Add decision
          </Button>
        </div>
      </form>
      <div id="dcList">
        <BoardPending />
        {list &&
          (list.length === 0 ? (
            <EmptyState text="No decisions recorded yet. When the room settles something, add it here." />
          ) : (
            list.map((x) => <DecisionCard key={x.id} x={x} avatars={avatars} />)
          ))}
      </div>
    </>
  );
}

/* ---------- Questions ---------- */

function QuestionCard({ x }: { x: Question }) {
  const api = useBoardApi();
  const ed = useEditing();
  const resolved = x.status === "resolved";
  return (
    <Card className={resolved ? "subtle" : undefined}>
      {ed.edit ? (
        <EditForm edit={ed.edit} close={ed.close} />
      ) : (
        <>
          <CardTitle>
            <Linkify text={x.text} />
          </CardTitle>
          <CardMeta>
            {x.status === "claimed" ? (
              <Pill tone="warn">Claimed by {x.claimed_by}</Pill>
            ) : resolved ? (
              <Pill>Resolved by {x.resolved_by}</Pill>
            ) : (
              <Pill tone="muted">Unclaimed</Pill>
            )}
            <span>
              Asked by {x.added_by} · {rel(x.ts)}
            </span>
          </CardMeta>
          {resolved && x.resolution ? (
            <CardText style={{ marginTop: 8 }}>
              <Linkify text={x.resolution} />
            </CardText>
          ) : null}
          <CardActions>
            {x.status === "open" && (
              <ActionButton size="sm" label="Claim" okText="Claimed" fn={(n) => api.api("/questions/" + x.id, "POST", { from: n, action: "claim" })} />
            )}
            {x.status === "claimed" && (
              <ActionButton size="sm" label="Unclaim" okText="Unclaimed" fn={(n) => api.api("/questions/" + x.id, "POST", { from: n, action: "unclaim" })} />
            )}
            {!resolved ? (
              <Button
                type="button"
                variant="primary" size="sm"
                onClick={() =>
                  ed.setEdit({
                    fields: [{ key: "note", label: "How was it resolved? (optional)", value: "", multiline: true, rows: 3, max: 1000 }],
                    saveLabel: "Mark resolved",
                    context: x.text,
                    onSave: (n, v) => api.api("/questions/" + x.id, "POST", { from: n, action: "resolve", note: v.note }),
                  })
                }
              >
                Resolve
              </Button>
            ) : (
              <ActionButton size="sm" label="Reopen" okText="Reopened" fn={(n) => api.api("/questions/" + x.id, "POST", { from: n, action: "reopen" })} />
            )}
            <span className="spacer"></span>
            <Button
              type="button"
              variant="quiet" size="sm"
              onClick={() =>
                ed.setEdit({
                  fields: [{ key: "text", label: "Question", value: x.text, multiline: true, rows: 3, max: 500 }],
                  saveLabel: "Save changes",
                  onSave: (n, v) => api.api("/questions/" + x.id, "POST", { from: n, action: "edit", text: v.text }),
                })
              }
            >
              Edit
            </Button>
            <DeleteButton path={"/questions/" + x.id} noun="question" />
          </CardActions>
        </>
      )}
    </Card>
  );
}

export function QuestionsView() {
  const api = useBoardApi();
  const [filter, setFilter] = useState<"open" | "resolved">("open");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = (inputRef.current?.value || "").trim();
    if (!t) {
      inputRef.current?.focus();
      return;
    }
    void runWith(api, btnRef.current, async (n) => {
      await api.api("/questions", "POST", { from: n, text: t });
      if (inputRef.current) inputRef.current.value = "";
    }, "Question added");
  };
  const open = api.board?.q.questions || [];
  const done = api.board?.q.resolved || [];
  const items = filter === "open" ? open : done;
  return (
    <>
      <form className="card add" id="qForm" onSubmit={submit}>
        <input className="grow" id="qInput" ref={inputRef} maxLength={500} placeholder="Ask something the room should answer" aria-label="Question" />
        <Button variant="primary" type="submit" ref={btnRef}>
          Add question
        </Button>
      </form>
      <div className="filters">
        <div className="seg" role="group" aria-label="Show">
          <button type="button" data-qf="open" aria-pressed={filter === "open"} onClick={() => setFilter("open")}>
            Open{open.length ? " (" + open.length + ")" : ""}
          </button>
          <button type="button" data-qf="resolved" aria-pressed={filter === "resolved"} onClick={() => setFilter("resolved")}>
            Resolved{done.length ? " (" + done.length + ")" : ""}
          </button>
        </div>
      </div>
      <div id="qList">
        <BoardPending />
        {api.board &&
          (items.length === 0 ? (
            <EmptyState text={filter === "open" ? "No open questions. Nice." : "Nothing resolved yet."} />
          ) : (
            items.map((x) => <QuestionCard key={x.id} x={x} />)
          ))}
      </div>
    </>
  );
}

/* ---------- Stakes ---------- */

function whenLabel(date: string): { text: string; rel: string; tone: PillTone } {
  const n = daysAway(date);
  const d = parseDay(date);
  const txt = d
    ? d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })
    : date;
  if (n === null) return { text: txt, rel: "", tone: "muted" };
  if (n < 0) return { text: txt, rel: (n === -1 ? "1 day" : -n + " days") + " overdue", tone: "danger" };
  if (n === 0) return { text: txt, rel: "Today", tone: "warn" };
  if (n === 1) return { text: txt, rel: "Tomorrow", tone: "warn" };
  return { text: txt, rel: "In " + n + " days", tone: n <= 7 ? "warn" : "muted" };
}

function StakeCard({ x, isDone }: { x: Stake; isDone: boolean }) {
  const api = useBoardApi();
  const ed = useEditing();
  return (
    <Card className={isDone ? "subtle" : undefined}>
      {ed.edit ? (
        <EditForm edit={ed.edit} close={ed.close} />
      ) : (
        <>
          <CardTitle>{x.title}</CardTitle>
          {x.note ? (
            <CardText>
              <Linkify text={x.note} />
            </CardText>
          ) : null}
          <CardMeta>
            {x.date
              ? (() => {
                  const w = whenLabel(x.date);
                  return (
                    <>
                      <Pill tone={isDone ? "muted" : w.tone}>{isDone ? w.text : w.rel}</Pill>
                      {!isDone && <span>{w.text}</span>}
                    </>
                  );
                })()
              : null}
            <span>
              Added by {x.added_by}
              {isDone && x.done_by ? " · done by " + x.done_by : ""}
            </span>
          </CardMeta>
          <CardActions>
            <ActionButton
              size="sm"
              label={isDone ? "Reopen" : "Mark done"}
              okText={isDone ? "Reopened" : "Marked done"}
              fn={(n) => api.api("/stakes/" + x.id, "POST", { from: n, action: isDone ? "reopen" : "done" })}
            />
            <span className="spacer"></span>
            <Button
              type="button"
              variant="quiet" size="sm"
              onClick={() =>
                ed.setEdit({
                  fields: [
                    { key: "title", label: "Title", value: x.title, max: 300 },
                    { key: "date", label: "Date (optional)", value: x.date || "", type: "date" },
                    { key: "note", label: "Note (optional)", value: x.note || "", multiline: true, rows: 3, max: 1000 },
                  ],
                  saveLabel: "Save changes",
                  onSave: (n, v) =>
                    api.api("/stakes/" + x.id, "POST", { from: n, action: "edit", title: v.title, date: (v.date || "").trim(), note: v.note }),
                })
              }
            >
              Edit
            </Button>
            <DeleteButton path={"/stakes/" + x.id} noun="stake" />
          </CardActions>
        </>
      )}
    </Card>
  );
}

export function StakesView() {
  const api = useBoardApi();
  const titleRef = useRef<HTMLInputElement | null>(null);
  const dateRef = useRef<HTMLInputElement | null>(null);
  const noteRef = useRef<HTMLInputElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = (titleRef.current?.value || "").trim();
    if (!t) {
      titleRef.current?.focus();
      return;
    }
    void runWith(api, btnRef.current, async (n) => {
      await api.api("/stakes", "POST", {
        from: n,
        title: t,
        date: dateRef.current?.value || "",
        note: (noteRef.current?.value || "").trim(),
      });
      if (titleRef.current) titleRef.current.value = "";
      if (dateRef.current) dateRef.current.value = "";
      if (noteRef.current) noteRef.current.value = "";
    }, "Stake added");
  };
  const open = api.board?.sk.stakes || [];
  const done = api.board?.sk.done || [];
  const dated = open.filter((x) => x.date).sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : 0));
  const undated = open.filter((x) => !x.date);
  return (
    <>
      <form className="card add" id="sForm" onSubmit={submit}>
        <input className="grow" id="sTitle" ref={titleRef} maxLength={300} placeholder="Add an event or open loop" aria-label="Stake" />
        <div className="row">
          <input id="sDate" type="date" ref={dateRef} aria-label="Date (optional)" title="Date (optional)" />
          <input className="grow" id="sNote" ref={noteRef} maxLength={1000} placeholder="Note (optional)" aria-label="Note" />
          <Button variant="primary" type="submit" ref={btnRef}>
            Add stake
          </Button>
        </div>
      </form>
      <div id="sList">
        <BoardPending />
        {api.board && (
          <>
            {open.length === 0 && (
              <EmptyState text="Nothing coming up. Add events or open loops the room should keep in mind." />
            )}
            {dated.length > 0 && (
              <>
                <div className="section-label">Coming up</div>
                {dated.map((x) => (
                  <StakeCard key={x.id} x={x} isDone={false} />
                ))}
              </>
            )}
            {undated.length > 0 && (
              <>
                <div className="section-label">No date</div>
                {undated.map((x) => (
                  <StakeCard key={x.id} x={x} isDone={false} />
                ))}
              </>
            )}
            {done.length > 0 && (
              <details>
                <summary className="section-label" style={{ cursor: "pointer" }}>
                  Done ({done.length})
                </summary>
                {done.map((x) => (
                  <StakeCard key={x.id} x={x} isDone={true} />
                ))}
              </details>
            )}
          </>
        )}
      </div>
    </>
  );
}

/* ---------- Memory (digests) ---------- */

function DigestCard({ x, avatars }: { x: Digest; avatars: Record<string, string> }) {
  const api = useBoardApi();
  const ed = useEditing();
  const d = parseDay(x.day);
  return (
    <Card>
      {ed.edit ? (
        <EditForm edit={ed.edit} close={ed.close} />
      ) : (
        <>
          <CardMeta style={{ marginTop: 0, marginBottom: 8 }}>
            <span className="chip">
              <Avatar name={x.author} ctx={{ avatars, invite: api.invite, onAvatar: api.openAvatar }} />
              {x.author}
            </span>
            <span>{d ? d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) : x.day}</span>
          </CardMeta>
          <CardText>
            <Linkify text={x.text} />
          </CardText>
          <CardActions>
            <span className="spacer"></span>
            <Button
              type="button"
              variant="quiet" size="sm"
              onClick={() =>
                ed.setEdit({
                  fields: [{ key: "text", label: "Digest", value: x.text, multiline: true, rows: 8, max: 8000 }],
                  saveLabel: "Save changes",
                  onSave: (n, v) => api.api("/digests/" + x.id, "POST", { from: n, text: v.text }),
                })
              }
            >
              Edit
            </Button>
            <DeleteButton path={"/digests/" + x.id} noun="digest" />
          </CardActions>
        </>
      )}
    </Card>
  );
}

export function MemoryView({ avatars }: { avatars: Record<string, string> }) {
  const api = useBoardApi();
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = (inputRef.current?.value || "").trim();
    if (!t) {
      inputRef.current?.focus();
      return;
    }
    void runWith(api, btnRef.current, async (n) => {
      await api.api("/digests", "POST", { from: n, text: t });
      if (inputRef.current) inputRef.current.value = "";
    }, "Digest posted");
  };
  const m = api.rs?.memory;
  const today = m && typeof m.digests_today === "number" ? m.digests_today : null;
  return (
    <>
      <div id="memHint">
        {m?.awaiting_digest_from && (
          <div className="note-box">
            {(same(m.awaiting_digest_from, api.meName)
              ? "It's your turn to write the next digest"
              : "Next digest is expected from " + m.awaiting_digest_from) +
              (m.digest_due_at
                ? " by " +
                  new Date(m.digest_due_at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })
                : "") +
              "."}
          </div>
        )}
      </div>
      <form className="card add" id="dForm" onSubmit={submit}>
        <textarea id="dInput" ref={inputRef} rows={3} maxLength={8000} placeholder="Write a digest: what was argued, what was resolved, what was learned" aria-label="Digest" />
        <div className="row">
          <span className="when" id="dCap">
            {(today !== null ? today + " of 3 digests posted today. " : "Up to 3 digests per day. ") +
              "Anyone with access can read them."}
          </span>
          <span style={{ flex: 1 }}></span>
          <Button variant="primary" type="submit" ref={btnRef}>
            Post digest
          </Button>
        </div>
      </form>
      <div id="dList">
        <BoardPending />
        {api.board &&
          (api.board.dg.length === 0 ? (
            <EmptyState text="No digests yet." />
          ) : (
            api.board.dg.map((x) => <DigestCard key={x.id} x={x} avatars={avatars} />)
          ))}
      </div>
    </>
  );
}
