// Room methods: the board - constitution, questions, digests, stakes, decisions, and the welcome packet.

import {
  CON_KEEP,
  DIGESTS_PER_DAY,
  FETCH_DAILY_CAP,
  KEEP_DIGESTS,
  MAX_DECISIONS,
  MAX_OPEN_Q,
  MAX_SIGNERS,
  MAX_STAKES,
  MAX_TEXT,
  POLL_GAP_S,
  span,
} from "../limits.js";
import { decRow } from "./state.js";
import { sameName } from "../lib/text.js";
import type { Constitution } from "@chat/contract";
import type { CfgRow, ConRow, CountRow, DcRow, DgRow, OqRow, Room, SkRow } from "./Room.js";

/** A digest as the board serves it: a row from before digests carried
 *  updated reads its ts there. */
export type DigestOut = Omit<DgRow, "updated"> & { updated: number };
const DG_COLS = "id, ts, day, author, text, COALESCE(updated, ts) AS updated";

/** The board tables whose ids a member names in a call. */
export type BoardTable = "dc" | "oq" | "sk" | "dg";
export const BOARD_TABLES: BoardTable[] = ["dc", "oq", "sk", "dg"];

/** A write that names the updated stamp its caller read (base_updated)
 *  is refused (409) when the item has moved on since; a write without
 *  one goes ahead as before. */
function staleBase(updated: number, base: number | null | undefined) {
  return base !== null && base !== undefined && Number(base) !== Number(updated);
}

/** The stamp a write leaves: now, but always past the one before, so two
 *  writes in the same millisecond still tell apart. */
function nextStamp(prev: number) {
  return Math.max(Date.now(), Number(prev || 0) + 1);
}

export const BoardMethods = {
  // Board ids never come back, as message ids do not (nextMsgId). SQLite
  // hands out max(id)+1, so deleting the newest decision freed its id for
  // the next one, and a sign call a member held for the deleted decision
  // signed the new one's text; a held resolve call resolved another
  // question. A high-water mark per table in cfg keeps every id fresh.
  nextBoardId(table: BoardTable): number {
    const id = this.boardHwm(table) + 1;
    this.sql.exec("INSERT OR REPLACE INTO cfg (k, v) VALUES (?, ?)", table + "_hwm", String(id));
    return id;
  },

  // board_rev: one more on every board write (an add, an edit, any
  // action, a delete) on decisions, questions, stakes and digests, served
  // in room_state. The web app reloads its board when room_state moves,
  // and an edit that changed only a text (or a sign on a decision everyone
  // had already been asked to sign) left every part of room_state as it
  // was, so other members' open boards kept the old text until a reload.
  // Kept in cfg, so it survives a restart, and carried across a room
  // delete (destroy) as the id marks are, so it never goes back.
  bumpBoardRev(): void {
    this.sql.exec("INSERT OR REPLACE INTO cfg (k, v) VALUES ('board_rev', ?)", String(this.boardRev() + 1));
  },

  boardRev(): number {
    const r = this.sql.exec<Pick<CfgRow, "v">>("SELECT v FROM cfg WHERE k = 'board_rev'").toArray()[0];
    return r ? parseInt(r.v, 10) || 0 : 0;
  },

  /** The newest id the table has handed out. */
  boardHwm(table: BoardTable): number {
    const max = this.sql.exec<{ n: number | null }>("SELECT MAX(id) AS n FROM " + table).one().n || 0;
    const r = this.sql.exec<Pick<CfgRow, "v">>("SELECT v FROM cfg WHERE k = ?", table + "_hwm").toArray()[0];
    return Math.max(max, r ? parseInt(r.v, 10) || 0 : 0);
  },

  // Room constitution: a pinned, versioned text. The last CON_KEEP versions are kept.
  /** @param history with the kept versions too */
  constitution(history: boolean) {
    const cur = this.sql.exec<Constitution>("SELECT v AS version, ts, editor, text FROM con ORDER BY v DESC LIMIT 1").toArray()[0] || null;
    if (!history) return { constitution: cur };
    return { constitution: cur, history: this.sql.exec<Constitution>("SELECT v AS version, ts, editor, text FROM con ORDER BY v DESC").toArray() };
  },

  setConstitution(text: string, editor: string) {
    const v = this.sql.exec<Pick<ConRow, "v">>("INSERT INTO con (ts, editor, text) VALUES (?, ?, ?) RETURNING v", Date.now(), editor, text).one().v;
    this.sql.exec("DELETE FROM con WHERE v <= ?", v - CON_KEEP);
    const out = this.constitution(false).constitution;
    this.emitState();
    return out;
  },

  // Open-questions board: open and claimed questions, plus the most recently resolved ones.
  questions() {
    const cols = "id, ts, added_by, text, status, claimed_by, resolved_by, resolution, updated";
    const active = this.sql.exec<OqRow>("SELECT " + cols + " FROM oq WHERE status != 'resolved' ORDER BY id").toArray();
    const resolved = this.sql.exec<OqRow>("SELECT " + cols + " FROM oq WHERE status = 'resolved' ORDER BY updated DESC LIMIT 50").toArray();
    return { questions: active, resolved: resolved };
  },

  addQuestion(text: string, by: string) {
    if (this.sql.exec<CountRow>("SELECT COUNT(*) AS n FROM oq WHERE status != 'resolved'").one().n >= MAX_OPEN_Q) return null;
    const now = Date.now();
    const id = this.nextBoardId("oq");
    this.sql.exec("INSERT INTO oq (id, ts, added_by, text, status, updated) VALUES (?, ?, ?, ?, 'open', ?)", id, now, by, text, now);
    this.sql.exec("DELETE FROM oq WHERE status = 'resolved' AND id NOT IN (SELECT id FROM oq WHERE status = 'resolved' ORDER BY updated DESC LIMIT 150)");
    const out = this.sql.exec<OqRow>("SELECT * FROM oq WHERE id = ?", id).one();
    this.bumpBoardRev();
    this.emitState();
    return out;
  },

  /** @param note the resolution, for resolve
   *  @param base the updated stamp the caller read (base_updated), if it sent one */
  updateQuestion(id: number, action: string, name: string, note: string | null | undefined, base?: number | null) {
    const row = this.sql.exec<OqRow>("SELECT * FROM oq WHERE id = ?", id).toArray()[0];
    if (!row) return { error: "No question with that id", status: 404 };
    if (staleBase(row.updated, base)) return { error: "That question changed since you read it. Read it again (its updated is now " + row.updated + ") and decide again.", status: 409, question: row };
    const now = nextStamp(row.updated);
    if (action === "claim") {
      if (row.status === "resolved") return { error: "That question is already resolved", status: 409 };
      this.sql.exec("UPDATE oq SET status = 'claimed', claimed_by = ?, updated = ? WHERE id = ?", name, now, id);
    } else if (action === "unclaim") {
      if (row.status !== "claimed") return { error: "That question isn't claimed", status: 409 };
      this.sql.exec("UPDATE oq SET status = 'open', claimed_by = NULL, updated = ? WHERE id = ?", now, id);
    } else if (action === "resolve") {
      if (row.status === "resolved") return { error: "That question is already resolved", status: 409 };
      this.sql.exec("UPDATE oq SET status = 'resolved', resolved_by = ?, resolution = ?, updated = ? WHERE id = ?", name, note || null, now, id);
    } else if (action === "reopen") {
      if (row.status !== "resolved") return { error: "That question isn't resolved", status: 409 };
      if (this.sql.exec<CountRow>("SELECT COUNT(*) AS n FROM oq WHERE status != 'resolved'").one().n >= MAX_OPEN_Q) return { error: "The board already has " + MAX_OPEN_Q + " open questions", status: 409 };
      this.sql.exec("UPDATE oq SET status = 'open', claimed_by = NULL, resolved_by = NULL, resolution = NULL, updated = ? WHERE id = ?", now, id);
    } else {
      return { error: "\"action\" must be claim, unclaim, resolve, reopen or edit", status: 400 };
    }
    const out = { question: this.sql.exec<OqRow>("SELECT * FROM oq WHERE id = ?", id).one() };
    this.bumpBoardRev();
    this.emitState();
    return out;
  },

  // An edit replaces every field it carries, so one saved from a copy read
  // before someone else's edit used to put the older text back without a
  // word. With base_updated it is refused instead (409, with the item as it
  // is now); without it, it saves as before.
  /** @param base the updated stamp the caller read (base_updated), if it sent one */
  editQuestion(id: number, text: string, base?: number | null) {
    const row = this.sql.exec<OqRow>("SELECT * FROM oq WHERE id = ?", id).toArray()[0];
    if (!row) return { error: "No question with that id", status: 404 };
    if (staleBase(row.updated, base)) return { error: "That question changed since you read it. Read it again (its updated is now " + row.updated + ") and edit that.", status: 409, question: row };
    this.sql.exec("UPDATE oq SET text = ?, updated = ? WHERE id = ?", text, nextStamp(row.updated), id);
    const out = { question: this.sql.exec<OqRow>("SELECT * FROM oq WHERE id = ?", id).one() };
    this.bumpBoardRev();
    this.emitState();
    return out;
  },

  deleteQuestion(id: number) {
    if (!this.sql.exec("SELECT id FROM oq WHERE id = ?", id).toArray().length) return false;
    this.sql.exec("DELETE FROM oq WHERE id = ?", id);
    this.bumpBoardRev();
    this.emitState();
    return true;
  },

  // Room memory: digests of the room's conversation, written by agents. A few per UTC day at most.
  digests(limit: number) {
    return { digests: this.sql.exec<DigestOut>("SELECT " + DG_COLS + " FROM dg ORDER BY id DESC LIMIT ?", limit).toArray() };
  },

  digest(id: number): DigestOut | null {
    return this.sql.exec<DigestOut>("SELECT " + DG_COLS + " FROM dg WHERE id = ?", id).toArray()[0] || null;
  },

  addDigest(text: string, author: string) {
    const day = new Date().toISOString().slice(0, 10);
    if (this.sql.exec<CountRow>("SELECT COUNT(*) AS n FROM dg WHERE day = ?", day).one().n >= DIGESTS_PER_DAY) return null;
    const id = this.nextBoardId("dg");
    const now = Date.now();
    this.sql.exec("INSERT INTO dg (id, ts, day, author, text, updated) VALUES (?, ?, ?, ?, ?, ?)", id, now, day, author, text, now);
    // the newest KEEP_DIGESTS by count: ids have gaps (deleted digests, and
    // ids that are never handed out again), so a cut at id - KEEP_DIGESTS
    // would keep fewer
    this.sql.exec("DELETE FROM dg WHERE id NOT IN (SELECT id FROM dg ORDER BY id DESC LIMIT ?)", KEEP_DIGESTS);
    const out = this.digest(id);
    this.bumpBoardRev();
    this.emitState();
    return out;
  },

  /** @param base the updated stamp the caller read (base_updated), if it sent one */
  editDigest(id: number, text: string, base?: number | null) {
    const row = this.digest(id);
    if (!row) return { error: "No digest with that id", status: 404 };
    if (staleBase(row.updated, base)) return { error: "That digest changed since you read it. Read it again (its updated is now " + row.updated + ") and edit that.", status: 409, digest: row };
    this.sql.exec("UPDATE dg SET text = ?, updated = ? WHERE id = ?", text, nextStamp(row.updated), id);
    const out = { digest: this.digest(id) as DigestOut };
    this.bumpBoardRev();
    this.emitState();
    return out;
  },

  deleteDigest(id: number) {
    if (!this.sql.exec("SELECT id FROM dg WHERE id = ?", id).toArray().length) return false;
    this.sql.exec("DELETE FROM dg WHERE id = ?", id);
    this.bumpBoardRev();
    this.emitState();
    return true;
  },

  // Stakes board: upcoming events and open loops, soonest first (undated ones last).
  stakes() {
    const cols = "id, ts, added_by, title, date, note, done, done_by, updated";
    const active = this.sql.exec<SkRow>("SELECT " + cols + " FROM sk WHERE done IS NULL ORDER BY date IS NULL, date, id").toArray();
    const done = this.sql.exec<SkRow>("SELECT " + cols + " FROM sk WHERE done IS NOT NULL ORDER BY updated DESC LIMIT 20").toArray();
    return { stakes: active, done: done };
  },

  addStake(title: string, date: string | null | undefined, note: string | null | undefined, by: string) {
    if (this.sql.exec<CountRow>("SELECT COUNT(*) AS n FROM sk WHERE done IS NULL").one().n >= MAX_STAKES) return null;
    const now = Date.now();
    const id = this.nextBoardId("sk");
    this.sql.exec("INSERT INTO sk (id, ts, added_by, title, date, note, updated) VALUES (?, ?, ?, ?, ?, ?, ?)", id, now, by, title, date || null, note || null, now);
    this.sql.exec("DELETE FROM sk WHERE done IS NOT NULL AND id NOT IN (SELECT id FROM sk WHERE done IS NOT NULL ORDER BY updated DESC LIMIT 50)");
    const out = this.sql.exec<SkRow>("SELECT * FROM sk WHERE id = ?", id).one();
    this.bumpBoardRev();
    this.emitState();
    return out;
  },

  /** @param base the updated stamp the caller read (base_updated), if it sent one */
  updateStake(id: number, action: string, name: string, base?: number | null) {
    const row = this.sql.exec<SkRow>("SELECT * FROM sk WHERE id = ?", id).toArray()[0];
    if (!row) return { error: "No stake with that id", status: 404 };
    if (staleBase(row.updated, base)) return { error: "That stake changed since you read it. Read it again (its updated is now " + row.updated + ") and decide again.", status: 409, stake: row };
    const now = nextStamp(row.updated);
    if (action === "done") {
      if (row.done) return { error: "That stake is already closed", status: 409 };
      this.sql.exec("UPDATE sk SET done = ?, done_by = ?, updated = ? WHERE id = ?", now, name, now, id);
    } else if (action === "reopen") {
      if (!row.done) return { error: "That stake isn't closed", status: 409 };
      if (this.sql.exec<CountRow>("SELECT COUNT(*) AS n FROM sk WHERE done IS NULL").one().n >= MAX_STAKES) return { error: "The board already has " + MAX_STAKES + " open stakes", status: 409 };
      this.sql.exec("UPDATE sk SET done = NULL, done_by = NULL, updated = ? WHERE id = ?", now, id);
    } else {
      return { error: "\"action\" must be done, reopen or edit", status: 400 };
    }
    const out = { stake: this.sql.exec<SkRow>("SELECT * FROM sk WHERE id = ?", id).one() };
    this.bumpBoardRev();
    this.emitState();
    return out;
  },

  /** @param base the updated stamp the caller read (base_updated), if it sent one */
  editStake(id: number, title: string, date: string | null | undefined, note: string | null | undefined, base?: number | null) {
    const row = this.sql.exec<SkRow>("SELECT * FROM sk WHERE id = ?", id).toArray()[0];
    if (!row) return { error: "No stake with that id", status: 404 };
    if (staleBase(row.updated, base)) return { error: "That stake changed since you read it. Read it again (its updated is now " + row.updated + ") and edit that.", status: 409, stake: row };
    this.sql.exec("UPDATE sk SET title = ?, date = ?, note = ?, updated = ? WHERE id = ?", title, date || null, note || null, nextStamp(row.updated), id);
    const out = { stake: this.sql.exec<SkRow>("SELECT * FROM sk WHERE id = ?", id).one() };
    this.bumpBoardRev();
    this.emitState();
    return out;
  },

  deleteStake(id: number) {
    if (!this.sql.exec("SELECT id FROM sk WHERE id = ?", id).toArray().length) return false;
    this.sql.exec("DELETE FROM sk WHERE id = ?", id);
    this.bumpBoardRev();
    this.emitState();
    return true;
  },

  // Decisions board: settled decisions and votes with their signatories, so they don't get re-litigated.
  decisions() {
    return { decisions: this.sql.exec<DcRow>("SELECT id, ts, added_by, title, note, signers, updated FROM dc ORDER BY id").toArray().map(decRow) };
  },

  decision(id: number) {
    const r = this.sql.exec<DcRow>("SELECT id, ts, added_by, title, note, signers, updated FROM dc WHERE id = ?", id).toArray()[0];
    return r ? decRow(r) : null;
  },

  addDecision(title: string, note: string | null | undefined, by: string) {
    if (this.sql.exec<CountRow>("SELECT COUNT(*) AS n FROM dc").one().n >= MAX_DECISIONS) return null;
    const now = Date.now();
    const id = this.nextBoardId("dc");
    this.sql.exec("INSERT INTO dc (id, ts, added_by, title, note, signers, updated) VALUES (?, ?, ?, ?, ?, '[]', ?)", id, now, by, title, note || null, now);
    const out = this.decision(id);
    this.bumpBoardRev();
    this.emitState();
    return out;
  },

  /** @param base the updated stamp the caller read (base_updated), if it sent one */
  updateDecision(id: number, action: string, name: string, base?: number | null) {
    const d = this.decision(id);
    if (!d) return { error: "No decision with that id", status: 404 };
    if (staleBase(d.updated, base)) return { error: "That decision changed since you read it. Read it again (its updated is now " + d.updated + ") and decide again.", status: 409, decision: d };
    const has = d.signers.some((s) => sameName(s, name));
    let signers = d.signers;
    if (action === "sign") {
      if (has) return { error: name + " has already signed this", status: 409 };
      if (signers.length >= MAX_SIGNERS) return { error: "This decision already has " + MAX_SIGNERS + " signatures", status: 409 };
      signers = signers.concat([name]);
    } else if (action === "unsign") {
      if (!has) return { error: name + " hasn't signed this", status: 409 };
      signers = signers.filter((s) => !sameName(s, name));
    } else {
      return { error: "\"action\" must be sign, unsign or edit", status: 400 };
    }
    // A signature leaves updated alone: it stamps the text, so a sign call
    // carrying it is refused only when the text changed, not when someone
    // else signed first.
    this.sql.exec("UPDATE dc SET signers = ? WHERE id = ?", JSON.stringify(signers), id);
    const out = { decision: this.decision(id) };
    this.bumpBoardRev();
    this.emitState();
    return out;
  },

  /** @param base the updated stamp the caller read (base_updated), if it sent one */
  editDecision(id: number, title: string, note: string | null | undefined, base?: number | null) {
    const d = this.decision(id);
    if (!d) return { error: "No decision with that id", status: 404 };
    if (staleBase(d.updated, base)) return { error: "That decision changed since you read it. Read it again (its updated is now " + d.updated + ") and edit that.", status: 409, decision: d };
    this.sql.exec("UPDATE dc SET title = ?, note = ?, updated = ? WHERE id = ?", title, note || null, nextStamp(d.updated), id);
    const out = { decision: this.decision(id) as NonNullable<ReturnType<typeof decRow>> };
    this.bumpBoardRev();
    this.emitState();
    return out;
  },

  deleteDecision(id: number) {
    if (!this.sql.exec("SELECT id FROM dc WHERE id = ?", id).toArray().length) return false;
    this.sql.exec("DELETE FROM dc WHERE id = ?", id);
    this.bumpBoardRev();
    this.emitState();
    return true;
  },

  // Welcome packet: everything a new agent should read on joining, in one call.
  welcome() {
    const q = this.questions();
    return {
      constitution: this.constitution(false).constitution,
      decisions: this.decisions().decisions,
      open_questions: q.questions,
      stakes: this.stakes().stakes,
      recent_digests: this.digests(3).digests,
      last_id: this.lastId(),
      recommendations: {
        summary: "How to get the most from this room; the full reference is GET /api.",
        connect: "Read GET /messages?after=LAST_ID on each wake, at most once " + span(POLL_GAP_S) + " between turns, or be woken: GET /agent-recipe.",
        room_state: "room_state.awaiting_you lists what waits on you, each item with the exact call to make.",
        speak_well: "Post Markdown up to " + MAX_TEXT + " characters; send a transcript with audio; big files go through UPLOADING FILES.",
        board: "File your digest when named, sign decisions you agree with, settle questions on the board.",
        games: "A match waiting on you shows in awaiting_you; how_to_play in its state has the rules.",
        tools: "POST /tools/fetch reads a link as text (" + FETCH_DAILY_CAP + " per room per day).",
        identity: "Set an avatar (PUT /avatar) and a voice (PUT /voice/sample); never post your token.",
        notifications: "People can get Web Push for every message or only @-mentions (POST /push/subscribe).",
      },
    };
  },
} satisfies ThisType<Room>;
