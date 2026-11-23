import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, type BoardData, type RoomState } from "@chat/contract";
import { toast } from "../../lib/index";
import { linkLength } from "../feed/mdlines";
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
  /** why the board has not loaded yet, after a failed load */
  boardError: string | null;
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

// Run a board action: gate on a name, disable the button, toast the
// outcome, reload the board. An fn that resolves to exactly false
// was called off (a cancelled confirm): no toast, no reload. onStale
// takes a refusal first: when it returns true the card has already said
// what happened (a stale write), so no error toast, and the board
// reloads to the item as it is now.
export async function runWith(
  api: BoardApi,
  btn: HTMLButtonElement | null,
  fn: (name: string) => Promise<unknown>,
  okText?: string,
  onStale?: (e: unknown) => boolean
): Promise<void> {
  const n = api.who();
  if (!n) return;
  if (btn) btn.disabled = true;
  try {
    if ((await fn(n)) === false) return;
    if (okText) toast(okText);
    await api.loadAll();
  } catch (e) {
    if (onStale && onStale(e)) void api.loadAll();
    else toast(errText(e), true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

export function ActionButton({
  label,
  fn,
  okText,
  onStale,
  ...look
}: {
  label: string;
  fn: (name: string) => Promise<unknown>;
  okText?: string;
  onStale?: (e: unknown) => boolean;
} & Pick<ButtonProps, "variant" | "size" | "danger">) {
  const api = useBoardApi();
  const ref = useRef<HTMLButtonElement | null>(null);
  return (
    <Button type="button" {...look} ref={ref} onClick={() => void runWith(api, ref.current, fn, okText, onStale)}>
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

// Plain-text URL linking for card titles and texts: bare http(s) and
// www. URLs become anchors, everything else stays a text node.
const LINK_RE = /(https?:\/\/[^\s<]+|www\.[^\s<]+)/g;
export function Linkify({ text }: { text: string }) {
  const parts = String(text || "").split(LINK_RE);
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 1) {
          // the chat's rule (linkLength): a ")" that closes a "(" in the
          // address stays, so .../Mercury_(planet) is no longer cut short
          const n = linkLength(part);
          if (!n) return <span key={i}>{part}</span>;
          const url = part.slice(0, n);
          const trail = part.slice(n);
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

// What a board list shows before the board has loaded: a loading line,
// or, after a failed load, the reason and a Retry. Without it a failed
// first load left every tab blank, and the empty Decisions page invited
// recording a decision a second time.
export function BoardPending() {
  const api = useBoardApi();
  if (api.board) return null;
  if (!api.boardError) return <div className="empty-state board-pending">Loading the board…</div>;
  return (
    <div className="empty-state board-pending" role="alert">
      <p>Couldn't load the board: {api.boardError}</p>
      <Button type="button" size="sm" onClick={() => void api.loadAll()}>
        Retry
      </Button>
    </div>
  );
}

/* ---------- writes from the copy on screen (base_updated) ---------- */

export type BoardKey = "decision" | "question" | "stake" | "digest";
type Stamped = { id: number; updated?: number };

/** The item a refused write handed back as it is now: every board write
 *  sends the updated of the copy on screen as base_updated, and when
 *  someone else changed the item first the answer is 409 with it under
 *  its kind's key. null for any other failure. */
export function staleItem<T extends Stamped>(e: unknown, key: BoardKey): T | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const b = e.body as Record<string, unknown> | null | undefined;
  const it = b && typeof b === "object" ? (b[key] as T | undefined) : undefined;
  return it && typeof it === "object" && typeof it.updated === "number" ? it : null;
}

/** A card's item, newer than the board's copy when a refused write
 *  brought it back first. Before, every form and button wrote from the
 *  copy the board showed with no check, so a member who opened an edit
 *  before someone else's edit saved over it unseen (and a sign went on
 *  a text the signer never read). Now the server refuses the stale write
 *  and the card shows what it refused it for; the board reload that
 *  follows catches up, and its newer copy wins again. */
export function useFresh<T extends Stamped>(x: T, key: BoardKey) {
  const [over, setOver] = useState<T | null>(null);
  const [changed, setChanged] = useState(false);
  const cur = over && over.id === x.id && (over.updated ?? 0) > (x.updated ?? 0) ? over : x;
  const take = (e: unknown): T | null => {
    const it = staleItem<T>(e, key);
    if (!it) return null;
    setOver(it);
    setChanged(true);
    return it;
  };
  return {
    cur,
    /** the line on the card: the last write was refused as stale */
    changed,
    clear: () => setChanged(false),
    /** for ActionButton's onStale */
    onStale: (e: unknown) => !!take(e),
    take,
  };
}

/** The card's line after a refused action. */
export function StaleLine() {
  return (
    <div className="stale-note" role="status">
      Someone else changed this first, so that did not go through. This is how it reads now.
    </div>
  );
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
  /** the updated of the copy the form was opened on, sent as base_updated */
  base?: number;
  /** A refusal because someone else changed the item first: its new
   *  updated and how it reads now (null for any other failure). */
  onStale?: (e: unknown) => { updated?: number; theirs: string } | null;
  onSave: (name: string, vals: Record<string, string>, base: number | undefined) => Promise<unknown>;
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
  // The base moves to the item a stale save brought back, and the form
  // keeps what was typed: saving again puts it on top of the other
  // person's change, which the form shows, instead of losing either.
  const [base, setBase] = useState(edit.base);
  const [theirs, setTheirs] = useState<string | null>(null);
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
      await edit.onSave(n, vals, base);
      toast("Saved");
      await api.loadAll();
      close();
    } catch (err) {
      const s = edit.onStale ? edit.onStale(err) : null;
      if (s) {
        setBase(s.updated);
        setTheirs(s.theirs);
        void api.loadAll();
      } else toast(errText(err), true);
      setBusy(false);
    }
  };
  return (
    <form className="edit" onSubmit={submit}>
      {edit.context ? <CardTitle>{edit.context}</CardTitle> : null}
      {theirs !== null ? (
        <div className="stale-note" role="status">
          <p>Someone else changed this while you were editing. It now reads:</p>
          <div className="stale-theirs">{theirs}</div>
          <p>Your text is still in the form. Save again to put it in place of theirs, or cancel to keep theirs.</p>
        </div>
      ) : null}
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
  // Only the stable editingDelta, never the whole api: the api object is
  // rebuilt on every room_state change (a game tick, a reaction), and
  // each rebuild ran this cleanup, dropped the count to zero and let the
  // held board through, so a card resolved or deleted by someone else
  // vanished from under its open form with the typed text.
  const { editingDelta } = useBoardApi();
  const [edit, setEdit] = useState<EditState | null>(null);
  useEffect(() => {
    if (!edit) return;
    editingDelta(1);
    return () => editingDelta(-1);
  }, [edit, editingDelta]);
  return { edit, setEdit, close: () => setEdit(null) };
}

/* ---------- Constitution ---------- */
