import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { BoardData, InviteResult, Member, MembersResponse, RoomState } from "@chat/shared";
import { toast } from "../lib";

// Board primitives shared by every section: the api surface, the
// action/delete buttons with their confirm + busy discipline, the
// linkifier, the empty state, and the generic edit form with its
// editing gate (while any form is open the board data refreshes
// counts only, never the view under the user's hands).

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

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// The current app's run(): gate on a name, disable the button, toast
// the outcome, reload the board.
export async function runWith(
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

export function DeleteButton({ api, path, noun }: { api: BoardApi; path: string; noun: string }) {
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
export function Linkify({ text }: { text: string }) {
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

export function EmptyState({ text }: { text: string }) {
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

export function EditForm({
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
export function useEditing(api: BoardApi) {
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
