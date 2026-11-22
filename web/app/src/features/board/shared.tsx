import { useEffect, useRef, useState, type FormEvent } from "react";
import type { BoardData, RoomState } from "@chat/contract";
import { toast } from "../../lib/index";
import { useBoardApi } from "../room/ctx";
import { Button, type ButtonProps } from "../../ui/Button";
import { CardTitle } from "../../ui/Card";

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
// the outcome, reload the board. An fn that resolves to exactly false
// was called off (a cancelled confirm): no toast, no reload.
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
    if ((await fn(n)) === false) return;
    if (okText) toast(okText);
    await api.loadAll();
  } catch (e) {
    toast(errText(e), true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

export function ActionButton({
  label,
  fn,
  okText,
  ...look
}: {
  label: string;
  fn: (name: string) => Promise<unknown>;
  okText?: string;
} & Pick<ButtonProps, "variant" | "size" | "danger">) {
  const api = useBoardApi();
  const ref = useRef<HTMLButtonElement | null>(null);
  return (
    <Button type="button" {...look} ref={ref} onClick={() => void runWith(api, ref.current, fn, okText)}>
      {label}
    </Button>
  );
}

export function DeleteButton({ path, noun }: { path: string; noun: string }) {
  const api = useBoardApi();
  const ref = useRef<HTMLButtonElement | null>(null);
  return (
    <Button
      type="button"
      variant="quiet" size="sm" danger
      ref={ref}
      onClick={() => {
        if (!window.confirm("Delete this " + noun + " for everyone? This can't be undone.")) return;
        void runWith(api, ref.current, (n) => api.api(path, "DELETE", { from: n }), "Deleted");
      }}
    >
      Delete
    </Button>
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
  edit,
  close,
}: {
  edit: EditState;
  close: () => void;
}) {
  const api = useBoardApi();
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
      {edit.context ? <CardTitle>{edit.context}</CardTitle> : null}
      {edit.fields.map((f, i) =>
        f.multiline ? (
          <label key={f.key} className="field">
            <span>{f.label}</span>
            <textarea
              ref={i === 0 ? firstFieldRef : undefined}
              rows={f.rows || 4}
              maxLength={f.max}
              value={vals[f.key] || ""}
              onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))}
            />
          </label>
        ) : (
          <label key={f.key} className="field">
            <span>{f.label}</span>
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
      <div className="actions">
        <Button type="submit" variant="primary" size="sm" disabled={busy}>
          {edit.saveLabel}
        </Button>
        <Button type="button" size="sm" onClick={close}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// A card that can swap its content for an edit form; while any card is
// editing, the board behind it does not re-render (loadAll defers).
export function useEditing() {
  const api = useBoardApi();
  const [edit, setEdit] = useState<EditState | null>(null);
  useEffect(() => {
    if (!edit) return;
    api.editingDelta(1);
    return () => api.editingDelta(-1);
  }, [edit, api]);
  return { edit, setEdit, close: () => setEdit(null) };
}

/* ---------- Constitution ---------- */
