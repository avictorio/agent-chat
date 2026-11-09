import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type {
  BoardData,
  Constitution,
  Decision,
  Digest,
  InviteResult,
  Member,
  MembersResponse,
  Question,
  RoomState,
  Stake,
} from "@chat/shared";
import { toast } from "./lib";
import { Avatar, KindTag, same } from "./feed";
import { daysAway, parseDay, rel, shortDate } from "./dates";

// The room board, ported from the current app: constitution,
// decisions, questions, stakes, digests, members and invites — same
// markup, same forms, same confirm prompts, same toasts. Actions run
// through who()/run() equivalents: a board action needs a name, the
// button disables while the call runs, success toasts and reloads.

export interface BoardApi {
  board: BoardData | null;
  api: <T>(path: string, method?: string, body?: unknown) => Promise<T>;
  putAvatar: (blob: Blob) => Promise<unknown>;
  who: () => string | null;
  loadAll: () => Promise<void>;
  meName: string;
  isMember: boolean;
  editingDelta: (d: number) => void;
  openAvatar: (name: string) => void;
  invite: string;
  rs: RoomState | null;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// The current app's run(): gate on a name, disable the button, toast
// the outcome, reload the board.
async function runWith(
  api: BoardApi,
  btn: HTMLButtonElement | null,
  fn: (name: string) => Promise<unknown>,
  okText?: string
): Promise<void> {
  const n = api.who();
  if (!n) return;
  if (btn) btn.disabled = true;
  try {
    await fn(n);
    if (okText) toast(okText);
    await api.loadAll();
  } catch (e) {
    toast(errText(e), true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

export function ActionButton({
  api,
  className,
  label,
  fn,
  okText,
}: {
  api: BoardApi;
  className: string;
  label: string;
  fn: (name: string) => Promise<unknown>;
  okText?: string;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  return (
    <button
      type="button"
      className={className}
      ref={ref}
      onClick={() => void runWith(api, ref.current, fn, okText)}
    >
      {label}
    </button>
  );
}

function DeleteButton({ api, path, noun }: { api: BoardApi; path: string; noun: string }) {
  const ref = useRef<HTMLButtonElement | null>(null);
  return (
    <button
      type="button"
      className="btn sm danger"
      ref={ref}
      onClick={() => {
        if (!window.confirm("Delete this " + noun + "? This cannot be undone.")) return;
        void runWith(api, ref.current, (n) => api.api(path, "DELETE", { from: n }), "Deleted");
      }}
    >
      Delete
    </button>
  );
}

// Plain-text URL linking for card titles and texts (the current app's
// linkify): bare http(s) and www. URLs become anchors, everything else
// stays a text node.
const LINK_RE = /(https?:\/\/[^\s<]+|www\.[^\s<]+)/g;
function Linkify({ text }: { text: string }) {
  const parts = String(text || "").split(LINK_RE);
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 1) {
          let url = part;
          let trail = "";
          const tm = /[.,;:!?)\]]+$/.exec(url);
          if (tm) {
            trail = tm[0];
            url = url.slice(0, url.length - trail.length);
          }
          const href = url.indexOf("www.") === 0 ? "https://" + url : url;
          return (
            <span key={i}>
              <a href={href} target="_blank" rel="noopener noreferrer">
                {url}
              </a>
              {trail}
            </span>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="empty-state">{text}</div>;
}

/* ---------- inline editing (startEdit) ---------- */

export interface FieldSpec {
  key: string;
  label: string;
  value: string;
  multiline?: boolean;
  rows?: number;
  max?: number;
  type?: string;
}

interface EditState {
  fields: FieldSpec[];
  saveLabel: string;
  context?: string;
  onSave: (name: string, vals: Record<string, string>) => Promise<unknown>;
}

function EditForm({
  api,
  edit,
  close,
}: {
  api: BoardApi;
  edit: EditState;
  close: () => void;
}) {
  const [vals, setVals] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    edit.fields.forEach((f) => (v[f.key] = f.value));
    return v;
  });
  const [busy, setBusy] = useState(false);
  const firstRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    firstRef.current?.focus();
  }, []);
  const firstFieldRef = (el: HTMLElement | null) => {
    firstRef.current = el;
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = api.who();
    if (!n) return;
    setBusy(true);
    try {
      await edit.onSave(n, vals);
      toast("Saved");
      await api.loadAll();
      close();
    } catch (err) {
      toast(errText(err), true);
      setBusy(false);
    }
  };
  return (
    <form className="edit" onSubmit={submit}>
      {edit.context ? <div className="card-title">{edit.context}</div> : null}
      {edit.fields.map((f, i) =>
        f.multiline ? (
          <label key={f.key}>
            {f.label}
            <textarea
              ref={i === 0 ? firstFieldRef : undefined}
              rows={f.rows || 4}
              maxLength={f.max}
              value={vals[f.key] || ""}
              onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))}
            />
          </label>
        ) : (
          <label key={f.key}>
            {f.label}
            <input
              ref={i === 0 ? firstFieldRef : undefined}
              type={f.type || "text"}
              maxLength={f.max}
              value={vals[f.key] || ""}
              onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))}
            />
          </label>
        )
      )}
      <div className="card-actions">
        <button type="submit" className="btn sm primary" disabled={busy}>
          {edit.saveLabel}
        </button>
        <button type="button" className="btn sm quiet" onClick={close}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// A card that can swap its content for an edit form; while any card is
// editing, the board behind it does not re-render (loadAll defers).
function useEditing(api: BoardApi) {
  const [edit, setEdit] = useState<EditState | null>(null);
  useEffect(() => {
    if (!edit) return;
    api.editingDelta(1);
    return () => api.editingDelta(-1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit]);
  return { edit, setEdit, close: () => setEdit(null) };
}

/* ---------- Constitution ---------- */

function ConstitutionView({ api }: { api: BoardApi }) {
  const board = api.board;
  const ed = useEditing(api);
  if (!board) return <div id="conBody"></div>;
  const c = board.con.constitution;
  const older = (board.con.history || [])
    .filter((h) => !c || h.version !== c.version)
    .sort((a, b) => b.version - a.version);
  return (
    <>
      <div id="conBody">
        <div className="card">
          {ed.edit ? (
            <EditForm api={api} edit={ed.edit} close={ed.close} />
          ) : !c ? (
            <>
              <div className="card-title">No constitution yet</div>
              <div className="card-meta">
                Write down what this room is for and how people here work together.
              </div>
              <div className="card-actions">
                <button
                  type="button"
                  className="btn primary sm"
                  onClick={() =>
                    ed.setEdit({
                      fields: [{ key: "text", label: "Constitution", value: "", multiline: true, rows: 10, max: 4000 }],
                      saveLabel: "Save version 1",
                      onSave: (n, v) => api.api("/constitution", "PUT", { from: n, text: v.text }),
                    })
                  }
                >
                  Write the first version
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="card-meta" style={{ marginTop: 0, marginBottom: 10 }}>
                <span className="pill">Version {c.version}</span>
                <span>
                  Edited by {c.editor} · {shortDate(c.ts)}, {new Date(c.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                </span>
              </div>
              <div className="const-text">
                <Linkify text={c.text} />
              </div>
              <div className="card-actions">
                <button
                  type="button"
                  className="btn sm"
                  onClick={() =>
                    ed.setEdit({
                      fields: [{ key: "text", label: "Constitution", value: c.text, multiline: true, rows: 12, max: 4000 }],
                      saveLabel: "Save as version " + (c.version + 1),
                      onSave: (n, v) => api.api("/constitution", "PUT", { from: n, text: v.text }),
                    })
                  }
                >
                  Edit
                </button>
              </div>
            </>
          )}
        </div>
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
                <div className="card-text">{h.text}</div>
                <div className="card-actions">
                  <ActionButton
                    api={api}
                    className="btn sm"
                    label="Restore this version"
                    okText="Restored"
                    fn={async (n) => {
                      if (!window.confirm("Save version " + h.version + "'s text as a new version?")) return false;
                      await api.api("/constitution", "PUT", { from: n, text: h.text });
                    }}
                  />
                </div>
              </details>
            ))}
          </>
        )}
      </div>
    </>
  );
}

/* ---------- Decisions ---------- */

function DecisionCard({ api, x, avatars }: { api: BoardApi; x: Decision; avatars: Record<string, string> }) {
  const ed = useEditing(api);
  const signers = x.signers || [];
  const mine = !!api.meName && signers.some((s) => same(s, api.meName));
  const active = (api.board?.mb.members || []).filter((m) => m.status === "active").map((m) => m.name);
  const missing = active.filter((a) => !signers.some((s) => same(s, a)));
  return (
    <div className="card">
      {ed.edit ? (
        <EditForm api={api} edit={ed.edit} close={ed.close} />
      ) : (
        <>
          <div className="card-title">{x.title}</div>
          {x.note ? (
            <div className="card-text">
              <Linkify text={x.note} />
            </div>
          ) : null}
          <div className="card-meta">
            <span>
              Recorded by {x.added_by} · {shortDate(x.ts)}
            </span>
            <span className={signers.length ? "pill" : "pill muted"}>
              {signers.length ? signers.length + (signers.length === 1 ? " signature" : " signatures") : "No signatures yet"}
            </span>
          </div>
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
            <div className="card-meta">
              <span className="pill warn">Waiting on {missing.join(", ")}</span>
            </div>
          )}
          <div className="card-actions">
            <ActionButton
              api={api}
              className={mine ? "btn sm" : "btn sm primary"}
              label={mine ? "Remove my signature" : "Sign"}
              okText={mine ? "Signature removed" : "Signed"}
              fn={async (n) => {
                const signed = signers.some((s) => same(s, n));
                await api.api("/decisions/" + x.id, "POST", { from: n, action: signed ? "unsign" : "sign" });
              }}
            />
            <span className="spacer"></span>
            <button
              type="button"
              className="btn sm quiet"
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
            </button>
            <DeleteButton api={api} path={"/decisions/" + x.id} noun="decision" />
          </div>
        </>
      )}
    </div>
  );
}

function DecisionsView({ api, avatars }: { api: BoardApi; avatars: Record<string, string> }) {
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
          <button className="btn primary" type="submit" ref={btnRef}>
            Add decision
          </button>
        </div>
      </form>
      <div id="dcList">
        {list &&
          (list.length === 0 ? (
            <EmptyState text="No decisions recorded yet. When the room settles something, add it here." />
          ) : (
            list.map((x) => <DecisionCard key={x.id} api={api} x={x} avatars={avatars} />)
          ))}
      </div>
    </>
  );
}

/* ---------- Questions ---------- */

function QuestionCard({ api, x }: { api: BoardApi; x: Question }) {
  const ed = useEditing(api);
  const resolved = x.status === "resolved";
  return (
    <div className={"card" + (resolved ? " subtle" : "")}>
      {ed.edit ? (
        <EditForm api={api} edit={ed.edit} close={ed.close} />
      ) : (
        <>
          <div className="card-title">
            <Linkify text={x.text} />
          </div>
          <div className="card-meta">
            {x.status === "claimed" ? (
              <span className="pill warn">Claimed by {x.claimed_by}</span>
            ) : resolved ? (
              <span className="pill">Resolved by {x.resolved_by}</span>
            ) : (
              <span className="pill muted">Unclaimed</span>
            )}
            <span>
              Asked by {x.added_by} · {rel(x.ts)}
            </span>
          </div>
          {resolved && x.resolution ? (
            <div className="card-text" style={{ marginTop: 8 }}>
              <Linkify text={x.resolution} />
            </div>
          ) : null}
          <div className="card-actions">
            {x.status === "open" && (
              <ActionButton api={api} className="btn sm" label="Claim" okText="Claimed" fn={(n) => api.api("/questions/" + x.id, "POST", { from: n, action: "claim" })} />
            )}
            {x.status === "claimed" && (
              <ActionButton api={api} className="btn sm" label="Unclaim" okText="Unclaimed" fn={(n) => api.api("/questions/" + x.id, "POST", { from: n, action: "unclaim" })} />
            )}
            {!resolved ? (
              <button
                type="button"
                className="btn sm primary"
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
              </button>
            ) : (
              <ActionButton api={api} className="btn sm" label="Reopen" okText="Reopened" fn={(n) => api.api("/questions/" + x.id, "POST", { from: n, action: "reopen" })} />
            )}
            <span className="spacer"></span>
            <button
              type="button"
              className="btn sm quiet"
              onClick={() =>
                ed.setEdit({
                  fields: [{ key: "text", label: "Question", value: x.text, multiline: true, rows: 3, max: 500 }],
                  saveLabel: "Save changes",
                  onSave: (n, v) => api.api("/questions/" + x.id, "POST", { from: n, action: "edit", text: v.text }),
                })
              }
            >
              Edit
            </button>
            <DeleteButton api={api} path={"/questions/" + x.id} noun="question" />
          </div>
        </>
      )}
    </div>
  );
}

function QuestionsView({ api }: { api: BoardApi }) {
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
        <button className="btn primary" type="submit" ref={btnRef}>
          Add question
        </button>
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
        {api.board &&
          (items.length === 0 ? (
            <EmptyState text={filter === "open" ? "No open questions. Nice." : "Nothing resolved yet."} />
          ) : (
            items.map((x) => <QuestionCard key={x.id} api={api} x={x} />)
          ))}
      </div>
    </>
  );
}

/* ---------- Stakes ---------- */

function whenLabel(date: string): { text: string; rel: string; cls: string } {
  const n = daysAway(date);
  const d = parseDay(date);
  const txt = d
    ? d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })
    : date;
  if (n === null) return { text: txt, rel: "", cls: "pill muted" };
  if (n < 0) return { text: txt, rel: (n === -1 ? "1 day" : -n + " days") + " overdue", cls: "pill danger" };
  if (n === 0) return { text: txt, rel: "Today", cls: "pill warn" };
  if (n === 1) return { text: txt, rel: "Tomorrow", cls: "pill warn" };
  return { text: txt, rel: "In " + n + " days", cls: n <= 7 ? "pill warn" : "pill muted" };
}

function StakeCard({ api, x, isDone }: { api: BoardApi; x: Stake; isDone: boolean }) {
  const ed = useEditing(api);
  return (
    <div className={"card" + (isDone ? " subtle" : "")}>
      {ed.edit ? (
        <EditForm api={api} edit={ed.edit} close={ed.close} />
      ) : (
        <>
          <div className="card-title">{x.title}</div>
          {x.note ? (
            <div className="card-text">
              <Linkify text={x.note} />
            </div>
          ) : null}
          <div className="card-meta">
            {x.date
              ? (() => {
                  const w = whenLabel(x.date);
                  return (
                    <>
                      <span className={isDone ? "pill muted" : w.cls}>{isDone ? w.text : w.rel}</span>
                      {!isDone && <span>{w.text}</span>}
                    </>
                  );
                })()
              : null}
            <span>
              Added by {x.added_by}
              {isDone && x.done_by ? " · done by " + x.done_by : ""}
            </span>
          </div>
          <div className="card-actions">
            <ActionButton
              api={api}
              className="btn sm"
              label={isDone ? "Reopen" : "Mark done"}
              okText={isDone ? "Reopened" : "Marked done"}
              fn={(n) => api.api("/stakes/" + x.id, "POST", { from: n, action: isDone ? "reopen" : "done" })}
            />
            <span className="spacer"></span>
            <button
              type="button"
              className="btn sm quiet"
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
            </button>
            <DeleteButton api={api} path={"/stakes/" + x.id} noun="stake" />
          </div>
        </>
      )}
    </div>
  );
}

function StakesView({ api }: { api: BoardApi }) {
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
          <button className="btn primary" type="submit" ref={btnRef}>
            Add stake
          </button>
        </div>
      </form>
      <div id="sList">
        {api.board && (
          <>
            {open.length === 0 && (
              <EmptyState text="Nothing coming up. Add events or open loops the room should keep in mind." />
            )}
            {dated.length > 0 && (
              <>
                <div className="section-label">Coming up</div>
                {dated.map((x) => (
                  <StakeCard key={x.id} api={api} x={x} isDone={false} />
                ))}
              </>
            )}
            {undated.length > 0 && (
              <>
                <div className="section-label">No date</div>
                {undated.map((x) => (
                  <StakeCard key={x.id} api={api} x={x} isDone={false} />
                ))}
              </>
            )}
            {done.length > 0 && (
              <details>
                <summary className="section-label" style={{ cursor: "pointer" }}>
                  Done ({done.length})
                </summary>
                {done.map((x) => (
                  <StakeCard key={x.id} api={api} x={x} isDone={true} />
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

function DigestCard({ api, x, avatars }: { api: BoardApi; x: Digest; avatars: Record<string, string> }) {
  const ed = useEditing(api);
  const d = parseDay(x.day);
  return (
    <div className="card">
      {ed.edit ? (
        <EditForm api={api} edit={ed.edit} close={ed.close} />
      ) : (
        <>
          <div className="card-meta" style={{ marginTop: 0, marginBottom: 8 }}>
            <span className="chip">
              <Avatar name={x.author} ctx={{ avatars, invite: api.invite, onAvatar: api.openAvatar }} />
              {x.author}
            </span>
            <span>{d ? d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) : x.day}</span>
          </div>
          <div className="card-text">
            <Linkify text={x.text} />
          </div>
          <div className="card-actions">
            <span className="spacer"></span>
            <button
              type="button"
              className="btn sm quiet"
              onClick={() =>
                ed.setEdit({
                  fields: [{ key: "text", label: "Digest", value: x.text, multiline: true, rows: 8, max: 8000 }],
                  saveLabel: "Save changes",
                  onSave: (n, v) => api.api("/digests/" + x.id, "POST", { from: n, text: v.text }),
                })
              }
            >
              Edit
            </button>
            <DeleteButton api={api} path={"/digests/" + x.id} noun="digest" />
          </div>
        </>
      )}
    </div>
  );
}

function MemoryView({ api, avatars }: { api: BoardApi; avatars: Record<string, string> }) {
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
          <button className="btn primary" type="submit" ref={btnRef}>
            Post digest
          </button>
        </div>
      </form>
      <div id="dList">
        {api.board &&
          (api.board.dg.length === 0 ? (
            <EmptyState text="No digests yet." />
          ) : (
            api.board.dg.map((x) => <DigestCard key={x.id} api={api} x={x} avatars={avatars} />)
          ))}
      </div>
    </>
  );
}

/* ---------- Members and invites ---------- */

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
  api,
  avatars,
  photo,
}: {
  api: BoardApi;
  avatars: Record<string, string>;
  photo: { openPicker: () => void };
}) {
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
            <MemberCard key={x.name} api={api} x={x} avatars={avatars} photo={photo} />
          ))
        )}
      </div>
    </>
  );
}

function MemberCard({
  api,
  x,
  avatars,
  photo,
}: {
  api: BoardApi;
  x: Member;
  avatars: Record<string, string>;
  photo: { openPicker: () => void };
}) {
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
                api={api}
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

const AVATAR_MAX = 2000000;

function prepPhoto(f: File): Promise<Blob> {
  if (f.type === "image/gif") {
    return f.size > AVATAR_MAX
      ? Promise.reject(new Error("That GIF is too large. Photos can be up to 2 MB."))
      : Promise.resolve(f);
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(f);
    const im = new Image();
    im.onload = () => {
      URL.revokeObjectURL(url);
      const side = Math.min(im.naturalWidth, im.naturalHeight);
      const size = Math.min(256, side);
      if (!side) {
        reject(new Error("Couldn't read that image."));
        return;
      }
      const c = document.createElement("canvas");
      c.width = c.height = size;
      c.getContext("2d")!.drawImage(im, (im.naturalWidth - side) / 2, (im.naturalHeight - side) / 2, side, side, 0, 0, size, size);
      c.toBlob((b) => {
        if (b && b.type === "image/webp") {
          resolve(b);
          return;
        }
        const j = document.createElement("canvas");
        j.width = j.height = size;
        const ctx = j.getContext("2d")!;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, size, size);
        ctx.drawImage(c, 0, 0);
        j.toBlob((jb) => (jb ? resolve(jb) : reject(new Error("Couldn't read that image."))), "image/jpeg", 0.88);
      }, "image/webp", 0.86);
    };
    im.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Couldn't read that image. Use a PNG, JPEG, WebP or GIF."));
    };
    im.src = url;
  });
}

// The hidden file input + upload flow (the current app creates the
// input the same way). Render `el` once; openPicker clicks it.
export function usePhotoUpload(api: Pick<BoardApi, "putAvatar" | "loadAll">) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const el = (
    <input
      ref={inputRef}
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif"
      hidden
      onChange={async (e) => {
        const f = e.currentTarget.files && e.currentTarget.files[0];
        e.currentTarget.value = "";
        if (!f) return;
        try {
          const blob = await prepPhoto(f);
          await api.putAvatar(blob);
          toast("Photo updated");
          await api.loadAll();
        } catch (err) {
          toast(errText(err), true);
        }
      }}
    />
  );
  return {
    el,
    openPicker: () => inputRef.current?.click(),
  };
}

/* ---------- avatar dialog ---------- */

export function AvatarDialog({
  name,
  mb,
  invite,
  onClose,
}: {
  name: string | null;
  mb: MembersResponse | null;
  invite: string;
  onClose: () => void;
}) {
  const dlgRef = useRef<HTMLDialogElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const dlg = dlgRef.current;
    if (!dlg) return;
    if (name && !dlg.open) {
      dlg.showModal();
      closeRef.current?.focus();
    }
    if (!name && dlg.open) dlg.close();
  }, [name]);
  const member = name ? (mb?.members || []).find((m) => same(m.name, name)) : undefined;
  const avatars: Record<string, string> = {};
  (mb?.members || []).forEach((m) => {
    if (m.avatar) avatars[m.name.toLowerCase()] = m.avatar;
  });
  const isClaude = !!name && same(name, "claude");
  const kind = isClaude ? null : member?.kind;
  return (
    <dialog
      className="av-dlg"
      id="avDlg"
      ref={dlgRef}
      aria-label="Member picture"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) e.currentTarget.close();
      }}
    >
      {name && (
        <>
          <div className="av-big" id="avBig">
            <Avatar
              name={name}
              ctx={{ avatars, invite, onAvatar: () => {}, xl: true }}
            />
          </div>
          <div className="av-name" id="avName">
            {name}
          </div>
          <div className="av-kind" id="avKind">
            {isClaude ? (
              <span className="tag k-agent">Bot</span>
            ) : kind ? (
              <KindTag kind={kind} />
            ) : null}
          </div>
          <button type="button" className="btn sm" id="avClose" ref={closeRef} onClick={() => dlgRef.current?.close()}>
            Close
          </button>
        </>
      )}
    </dialog>
  );
}

/* ---------- the six pages ---------- */

export function BoardSections({
  tab,
  api,
  photo,
}: {
  tab: string;
  api: BoardApi;
  photo: { openPicker: () => void };
}) {
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
            <ConstitutionView api={api} />
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
            <DecisionsView api={api} avatars={avatars} />
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
            <QuestionsView api={api} />
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
            <StakesView api={api} />
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
            <MemoryView api={api} avatars={avatars} />
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
            <MembersView api={api} avatars={avatars} photo={photo} />
          </div>
        </div>
      </section>
    </>
  );
}
